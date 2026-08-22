// Purpose: Appearance-lane main-process bridge. Enumerates installed font
// families by reading font files' sfnt `name` tables straight off disk with
// node builtins - no npm dependency, no shell-out. Results are cached for the
// process lifetime unless a refresh is forced.
//
// Seam note: ipc.js owns the domain allowlist and this lane may not edit that
// file, so these handlers register under the pre-approved `shell` domain with
// appearance-prefixed names (`shell:appearance-*`). Renderer callers must use
// those exact channels.
// Owned by Appearance lane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHandler } from '../ipc.js';

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc']);
// The sfnt table directory always lives in the first bytes of the file.
const HEAD_BYTES = 4096;
const MAX_NAME_TABLE_BYTES = 1024 * 1024;
const SCAN_BUDGET_MS = 4000;
const MAX_FILES = 6000;

let cache = null;

/** One shared deadline so a slow disk can never hang an invoke forever. */
class Deadline {
  constructor(ms) {
    this.end = Date.now() + ms;
    this.expired = false;
  }

  check(stage) {
    if (Date.now() > this.end) {
      this.expired = true;
      const err = new Error(`font scan timed out at "${stage}"`);
      err.code = 'DEADLINE_EXCEEDED';
      throw err;
    }
  }
}

/**
 * Two-pass targeted read: the sfnt table directory sits in the file's first
 * bytes, so locate the `name` table there and read only that byte range.
 * (A fixed-size prefix read is wrong: real system fonts place their name
 * tables anywhere - arial.ttf's sits past offset 880KB.)
 */
function readFamilyFromFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const headBytes = fs.readSync(fd, head, 0, head.length, 0);
    head = head.subarray(0, headBytes);

    let baseOffset = 0;
    if (head.length >= 16 && head.toString('latin1', 0, 4) === 'ttcf') {
      baseOffset = head.readUInt32BE(12);
    }
    if (head.length < baseOffset + 12) return '';
    const numTables = head.readUInt16BE(baseOffset + 4);
    const tableDirStart = baseOffset + 12;
    if (tableDirStart + numTables * 16 > head.length) return '';

    let nameOffset = -1;
    let nameLength = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = tableDirStart + i * 16;
      if (head.toString('latin1', rec, rec + 4) === 'name') {
        nameOffset = head.readUInt32BE(rec + 8);
        nameLength = head.readUInt32BE(rec + 12);
        break;
      }
    }
    if (nameOffset < 0 || nameOffset >= size) return '';
    nameLength = Math.min(nameLength, size - nameOffset, MAX_NAME_TABLE_BYTES);
    if (nameLength < 6) return '';

    const buffer = Buffer.alloc(nameLength);
    const bytes = fs.readSync(fd, buffer, 0, nameLength, nameOffset);
    return readFamilyName(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the human family name (nameID 1 / preferred family 16) out of a
 * TrueType/OpenType font's `name` table buffer. Prefers the Windows UTF-16
 * English record, falls back to any Unicode record, then to Macintosh Roman.
 * Returns '' when nothing usable is found rather than guessing from a
 * filename.
 */
function readFamilyName(buffer) {
  // `buffer` holds exactly one font face's `name` table:
  //   u16 format, u16 count, u16 stringOffset, then count x 12-byte records
  //   (platformID, encodingID, languageID, nameID, length, offset).
  if (buffer.length < 6) return '';
  const count = buffer.readUInt16BE(2);
  const storageOffset = buffer.readUInt16BE(4);

  const found = { utf16be: '', macroman: '' };

  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > buffer.length) break;
    const platformID = buffer.readUInt16BE(rec);
    const encodingID = buffer.readUInt16BE(rec + 2);
    const nameID = buffer.readUInt16BE(rec + 6);
    if (nameID !== 1 && nameID !== 16) continue; // family / preferred family
    const length = buffer.readUInt16BE(rec + 8);
    const strOffset = storageOffset + buffer.readUInt16BE(rec + 10);
    if (length === 0 || strOffset + length > buffer.length) continue;

    // Copy before decoding: swap16() mutates in place and the view shares
    // memory with the whole file buffer.
    const raw = Buffer.from(buffer.subarray(strOffset, strOffset + length));
    let tier = null;
    let text = '';
    if (platformID === 3 && (encodingID === 1 || encodingID === 10)) {
      tier = 'utf16be';
      try { text = raw.swap16().toString('utf16le'); } catch { text = ''; }
    } else if (platformID === 0 || platformID === 3) {
      tier = 'utf16be';
      try { text = raw.swap16().toString('utf16le'); } catch { text = ''; }
    } else if (platformID === 1 && encodingID === 0) {
      tier = 'macroman';
      text = raw.toString('latin1');
    }
    text = text.replace(/\u0000+$/g, '').trim();
    if (!text || !tier) continue;
    // Preferred family (16) outranks family (1) within the same tier.
    if (nameID === 16) return text;
    if (!found[tier]) found[tier] = text;
  }
  return found.utf16be || found.macroman || '';
}

function fontDirectories() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const windir = process.env.WINDIR || 'C:\\Windows';
      return [
        path.join(windir, 'Fonts'),
        path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'),
      ];
    }
    case 'darwin':
      return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
    default:
      return [
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        path.join(home, '.local', 'share', 'fonts'),
        '/run/host/fonts',
      ];
  }
}

/** Depth-limited recursive collect of font files under every known directory. */
function listFontFiles(deadline) {
  /** @type {string[]} */
  const files = [];
  let skippedDirs = 0;

  const walk = (dir, depth) => {
    if (deadline.expired || files.length >= MAX_FILES) return;
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skippedDirs += 1; // missing/unreadable font dir is normal on many systems
      return;
    }
    for (const child of children) {
      if (deadline.expired || files.length >= MAX_FILES) return;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (depth < 4) walk(full, depth + 1); // Linux nests by foundry/variant
      } else if (child.isFile() && FONT_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        files.push(full);
      }
    }
  };

  for (const dir of fontDirectories()) walk(dir, 0);
  return { files, skippedDirs };
}

function scanFonts() {
  const startedAt = Date.now();
  const deadline = new Deadline(SCAN_BUDGET_MS);
  const families = new Set();
  let unreadable = 0;
  let unnamedFiles = 0;

  const { files, skippedDirs } = listFontFiles(deadline);
  let scanned = 0;
  for (const file of files) {
    scanned += 1;
    if (scanned % 64 === 0) deadline.check('reading font files');
    let family = '';
    try {
      family = readFamilyFromFile(file);
    } catch {
      unreadable += 1;
      continue;
    }
    if (family) families.add(family);
    else unnamedFiles += 1;
  }

  return {
    families: [...families].sort((a, b) => a.localeCompare(b)),
    scanned,
    unreadable,
    unnamedFiles,
    skippedDirs,
    truncated: deadline.expired,
    durationMs: Date.now() - startedAt,
    source: 'native-font-files',
    platform: process.platform,
  };
}

export function register(ctx) {
  void ctx; // settings/vault/providers stores are not needed on this surface

  registerHandler('shell', 'appearance-fonts', ({ force } = {}) => {
    if (cache && !force) return { ...cache, cached: true };
    cache = scanFonts();
    return { ...cache, cached: false };
  });
}
