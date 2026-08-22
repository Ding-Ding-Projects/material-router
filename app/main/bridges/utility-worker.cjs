// Purpose: the Toolbox converter's sandboxed worker. Spawned by
// bridges/utility.js as a plain Node child (ELECTRON_RUN_AS_NODE) with exactly
// one argv entry: the path to a JSON job file. All parameters travel inside the
// job file, never on the command line. The worker performs no network I/O and
// imports only Node builtins. It writes a JSON result beside the job file and
// exits; the parent enforces the wall-clock deadline and kills on overrun.
//
// NOTE: this file intentionally uses the .cjs extension so the lane bridge
// loader (which imports every .js sibling and requires a register export)
// skips it. It is a child-process entry point, not an IPC bridge.
//
// Owned by the Utility (Toolbox) lane.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const IN_MEMORY_LIMIT = 64 * 1024 * 1024; // honest cap for whole-buffer adapters
const HEAD_BYTES = 64 * 1024; // detection probe
const TAIL_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function fail(code, message) {
  return { ok: false, code, error: String(message).slice(0, 500) };
}

function readJob(jobPath) {
  const raw = fs.readFileSync(jobPath, 'utf8');
  const job = JSON.parse(raw);
  if (!job || typeof job.op !== 'string') throw new Error('job file must carry an op');
  return job;
}

function writeResult(jobPath, result) {
  const outPath = `${jobPath}.result`;
  fs.writeFileSync(outPath, JSON.stringify(result));
  return outPath;
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function assertReadableFile(p) {
  const st = statSafe(p);
  if (!st || !st.isFile()) throw Object.assign(new Error(`source is not a readable file: ${path.basename(String(p))}`), { code: 'NO_SOURCE' });
  return st;
}

/** Refuse to buffer more than the honest in-memory cap. */
function assertBufferable(size, what) {
  if (size > IN_MEMORY_LIMIT) {
    throw Object.assign(
      new Error(`${what} is ${size} bytes; this adapter holds the whole input in memory and is capped at ${IN_MEMORY_LIMIT} bytes. Use a streaming adapter for larger files.`),
      { code: 'TOO_BIG' },
    );
  }
}

// ---------------------------------------------------------------------------
// byte-signature detection
// ---------------------------------------------------------------------------

const ASCII = (b) => b.toString('latin1');

function detectFromBytes(head, tail, size, ext) {
  const reasons = [];
  const has = (sig, offset = 0) => {
    if (head.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
      if (head[offset + i] !== sig[i]) return false;
    }
    return true;
  };
  const asciiAt = (offset) => ASCII(head.subarray(offset, offset + 8));

  // Containers first (RIFF family shares the first four bytes).
  if (has([0x52, 0x49, 0x46, 0x46]) && head.length >= 12) {
    const kind = asciiAt(8);
    if (kind.startsWith('WAVE')) { reasons.push('RIFF/WAVE header'); return { format: 'wav', family: 'audio', confidence: 'high', reasons }; }
    if (kind.startsWith('AVI ')) { reasons.push('RIFF/AVI header'); return { format: 'avi', family: 'video', confidence: 'high', reasons }; }
    if (kind.startsWith('WEBP')) { reasons.push('RIFF/WEBP header'); return { format: 'webp', family: 'image', confidence: 'high', reasons }; }
    reasons.push('RIFF container of unknown subtype');
    return { format: 'riff-unknown', family: 'binary', confidence: 'low', reasons };
  }
  if (has([0x00, 0x00, 0x01, 0x00]) && head[4] === 0 && head[5] <= 1) {
    reasons.push('ICO icon directory header');
    return { format: 'ico', family: 'image', confidence: 'high', reasons };
  }
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    reasons.push('PNG signature');
    return { format: 'png', family: 'image', confidence: 'high', reasons };
  }
  if (has([0xff, 0xd8, 0xff])) {
    reasons.push('JPEG SOI marker');
    return { format: 'jpeg', family: 'image', confidence: 'high', reasons };
  }
  if (has([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || has([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    reasons.push('GIF signature');
    return { format: 'gif', family: 'image', confidence: 'high', reasons };
  }
  if (has([0x42, 0x4d]) && size >= 14) {
    reasons.push('BMP header (BM)');
    return { format: 'bmp', family: 'image', confidence: 'medium', reasons };
  }
  if (has([0x25, 0x50, 0x44, 0x46, 0x2d])) {
    reasons.push('%PDF- header');
    return { format: 'pdf', family: 'document', confidence: 'high', reasons };
  }
  if (has([0x50, 0x4b, 0x03, 0x04]) || has([0x50, 0x4b, 0x05, 0x06]) || has([0x50, 0x4b, 0x07, 0x08])) {
    reasons.push('ZIP local header / EOCD');
    return { format: 'zip', family: 'archive', confidence: 'high', reasons };
  }
  if (has([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    reasons.push('7z signature (no bundled 7z engine)');
    return { format: '7z', family: 'archive', confidence: 'high', reasons };
  }
  if (has([0x1f, 0x8b])) {
    reasons.push('gzip magic');
    return { format: 'gzip', family: 'archive', confidence: 'high', reasons };
  }
  if (has([0x1a, 0x45, 0xdf, 0xa3])) {
    reasons.push('EBML header (Matroska family)');
    return { format: 'matroska', family: 'video', confidence: 'high', reasons };
  }
  if (head.length >= 12 && ASCII(head.subarray(4, 8)) === 'ftyp') {
    const brand = ASCII(head.subarray(8, 12));
    const family = /^(qt)/.test(brand) ? 'video' : 'video';
    reasons.push(`ISO-BMFF container, brand ${JSON.stringify(brand)}`);
    return { format: brand === 'qt  ' ? 'mov' : 'mp4', family, confidence: 'high', reasons };
  }
  if (has([0x4f, 0x67, 0x67, 0x53])) { reasons.push('Ogg container'); return { format: 'ogg', family: 'audio', confidence: 'high', reasons }; }
  if (has([0x66, 0x4c, 0x61, 0x43])) { reasons.push('FLAC marker'); return { format: 'flac', family: 'audio', confidence: 'high', reasons }; }
  if (has([0x49, 0x44, 0x33]) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
    reasons.push('MP3 frame/ID3 marker');
    return { format: 'mp3', family: 'audio', confidence: 'medium', reasons };
  }
  if (has([0x42, 0x5a, 0x68])) { reasons.push('bzip2 magic'); return { format: 'bzip2', family: 'archive', confidence: 'medium', reasons }; }
  if (has([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) { reasons.push('xz magic'); return { format: 'xz', family: 'archive', confidence: 'high', reasons }; }

  // Text-ish formats: BOMs and parse probes.
  if (has([0xef, 0xbb, 0xbf])) { reasons.push('UTF-8 BOM'); return { format: 'text', family: 'text', confidence: 'medium', reasons }; }
  if (has([0xff, 0xfe]) || has([0xfe, 0xff])) {
    reasons.push('UTF-16 BOM');
    return { format: 'text', family: 'text', confidence: 'medium', reasons };
  }
  const e = (ext || '').toLowerCase();
  if (['.json', '.geojson', '.jsonl', '.ndjson'].includes(e) && looksLikeText(head)) {
    reasons.push(`extension ${e} and text content`);
    return { format: 'json', family: 'structured', confidence: 'medium', reasons };
  }
  if (['.csv'].includes(e) && looksLikeText(head)) { reasons.push(`extension ${e}`); return { format: 'csv', family: 'structured', confidence: 'low', reasons }; }
  if (['.tsv', '.tab'].includes(e) && looksLikeText(head)) { reasons.push(`extension ${e}`); return { format: 'tsv', family: 'structured', confidence: 'low', reasons }; }
  if (['.yaml', '.yml'].includes(e) && looksLikeText(head)) { reasons.push(`extension ${e}`); return { format: 'yaml', family: 'structured', confidence: 'low', reasons }; }
  if (['.toml'].includes(e) && looksLikeText(head)) { reasons.push(`extension ${e}`); return { format: 'toml', family: 'structured', confidence: 'low', reasons }; }
  if (['.md', '.markdown', '.txt', '.log', '.text'].includes(e) && looksLikeText(head)) {
    reasons.push(`extension ${e} and text content`);
    return { format: 'text', family: 'text', confidence: 'low', reasons };
  }
  if (looksLikeText(head)) {
    reasons.push('no signature; bytes decode as text');
    return { format: 'text', family: 'text', confidence: 'low', reasons };
  }
  reasons.push('no known signature');
  return { format: 'unknown', family: 'binary', confidence: 'none', reasons };
}

function looksLikeText(head) {
  const n = Math.min(head.length, 4096);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = head[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / n < 0.02;
}

// ---------------------------------------------------------------------------
// PDF (minimal reader + structural rewriter for simple unencrypted files)
// ---------------------------------------------------------------------------

/**
 * Scan-based object table. Deliberately refuses the two structures this
 * rewriter cannot handle honestly: encrypted files and compressed object
 * streams (PDF 1.5+ cross-reference streams holding objects in /ObjStm).
 */
function parsePdf(buf) {
  const text = buf.latin1Slice ? buf.latin1Slice() : buf.toString('latin1');
  const objects = new Map(); // num -> {num, dictStart, dictEnd, streamStart, streamEnd, raw}
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endIdx = text.indexOf('endobj', bodyStart);
    if (endIdx === -1) continue;
    const body = text.slice(bodyStart, endIdx);
    const obj = { num, bodyStart, bodyEnd: endIdx, stream: null, dict: body };
    const sm = /stream\r?\n?/.exec(body);
    if (sm) {
      const dataStart = bodyStart + sm.index + sm[0].length;
      const dataEnd = text.lastIndexOf('endstream', endIdx);
      if (dataEnd > dataStart) {
        obj.stream = { start: dataStart, end: dataEnd };
        obj.dict = body.slice(0, sm.index);
      }
    }
    objects.set(num, obj);
  }
  const hasObjStm = [...objects.values()].some((o) => /\/Type\s*\/ObjStm\b/.test(o.dict));
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(text);
  const pageCount = (text.match(/\/Type\s*\/Page(?![sA-Za-z])/g) || []).length;
  const rootMatch = /\/Root\s+(\d+)\s+\d+\s+R/.exec(text);
  const infoMatch = /\/Info\s+(\d+)\s+\d+\s+R/.exec(text);
  const info = infoMatch ? readPdfInfo(objects.get(Number(infoMatch[1]))) : {};
  return { objects, hasObjStm, encrypted, pageCount, rootRef: rootMatch ? { num: Number(rootMatch[1]) } : null, info };
}

function readPdfInfo(obj) {
  const out = {};
  if (!obj) return out;
  for (const [key, prop] of [['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['creator', 'Creator'], ['producer', 'Producer']]) {
    const re = new RegExp(`/${prop}\\s*(?:\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`);
    const m = re.exec(obj.dict);
    if (!m) continue;
    const raw = m[0].slice(prop.length + 1).trim();
    if (raw.startsWith('(')) {
      out[key] = raw.slice(1, -1).replace(/\\([nrtbf()\\])/g, (_, c) => ({
        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\',
      }[c] || c));
    } else if (raw.startsWith('<')) {
      const hex = raw.slice(1, -1).replace(/\s+/g, '');
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      // UTF-16BE detection: leading BOM or zero high bytes pattern.
      out[key] = s.replace(/^﻿/, '') && s.charCodeAt(0) === 0xfeff
        ? decodeUtf16Be(hex)
        : s;
    }
  }
  return out;
}

function decodeUtf16Be(hex) {
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return Buffer.from(bytes).swap16().toString('utf16le').replace(/^﻿/, '');
}

const PDF_INHERITABLE = ['/MediaBox', '/Resources', '/CropBox', '/Rotate'];

/**
 * Build a new PDF containing the selected pages of the parsed sources, in the
 * given order. pagesSpec: [{srcIndex, objNum}]. Returns a Buffer.
 */
function rewritePdf(sources, pagesSpec, rotate) {
  // 1) Renumber every usable object of every source.
  const all = new Map(); // newNum -> {src, obj}
  const mapPerSrc = sources.map(() => new Map());
  let next = 2; // 1 is reserved for the new /Catalog, pages tree gets 2.. wait, see below
  // Reserve: 1 = catalog, 2 = pages tree.
  next = 3;
  const pageNewNums = [];
  for (let s = 0; s < sources.length; s++) {
    const { objects } = sources[s];
    for (const obj of objects.values()) {
      if (/\/Type\s*\/Pages\b/.test(obj.dict)) continue; // old page tree dropped
      const nn = next++;
      mapPerSrc[s].set(obj.num, nn);
      all.set(nn, { src: s, obj });
    }
  }
  for (const spec of pagesSpec) pageNewNums.push(mapPerSrc[spec.srcIndex].get(spec.objNum));

  // 2) Rewrite reference tokens inside dict parts only (never stream data).
  function rewriteRefs(dictText, s) {
    return dictText.replace(/(\d+)\s+\d+\s+R/g, (whole, n) => {
      const mapped = mapPerSrc[s].get(Number(n));
      return mapped ? `${mapped} 0 R` : whole;
    });
  }

  // 3) Reachability walk from catalog + page objects (dict refs only).
  const keep = new Set();
  const queue = [1, 2, ...pageNewNums];
  while (queue.length) {
    const n = queue.pop();
    if (keep.has(n)) continue;
    keep.add(n);
    const entry = all.get(n);
    if (!entry) continue;
    const refs = entry.obj.dict.matchAll(/(\d+)\s+\d+\s+R/g);
    for (const r of refs) {
      const mapped = mapPerSrc[entry.src].get(Number(r[1]));
      if (mapped && !keep.has(mapped)) queue.push(mapped);
    }
  }

  // 4) Serialize.
  const chunks = [];
  chunks.push(Buffer.from('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n', 'latin1'));
  const offsets = new Map();
  const dictOnly = (entry) => {
    let d = rewriteRefs(entry.obj.dict, entry.src);
    // Point copied page objects at the new page tree.
    if (/\/Type\s*\/Page(?![sA-Za-z])/.test(d)) {
      d = d.replace(/\/Parent\s+\d+\s+\d+\s+R/, `/Parent 2 0 R`);
      if (!/\/Parent\s/.test(d)) d = d.replace(/\/Type\s*\/Page(?![sA-Za-z])/, '/Parent 2 0 R /Type /Page');
      // Inherit missing attributes from the source page tree.
      for (const prop of PDF_INHERITABLE) {
        if (!new RegExp(`${prop}\\b`).test(d)) {
          const inherited = inheritFromPages(sources[entry.src], entry.obj.num, prop);
          if (inherited) d = d.replace(/\s*\/Type\s*\/Page(?![sA-Za-z])/, ` ${prop} ${inherited} /Type /Page`);
        }
      }
      if (rotate) {
        if (/\/Rotate\s+\d+/.test(d)) d = d.replace(/\/Rotate\s+\d+/, `/Rotate ${rotate}`);
        else d = d.replace(/\s*\/Type\s*\/Page(?![sA-Za-z])/, ` /Rotate ${rotate} /Type /Page`);
      }
    }
    return d;
  };
  for (const n of [...keep].sort((a, b) => a - b)) {
    const entry = all.get(n);
    if (!entry) continue;
    offsets.set(n, Buffer.concat(chunks).length);
    const head = `${n} 0 obj${dictOnly(entry)}`;
    if (entry.obj.stream) {
      const src = sources[entry.src].buf;
      const streamBytes = src.subarray(entry.obj.stream.start, entry.obj.stream.end);
      // Keep the exact stream bytes; /Length travels with the dict untouched.
      chunks.push(Buffer.from(`${head}\nstream\n`, 'latin1'), streamBytes, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      chunks.push(Buffer.from(`${head}\nendobj\n`, 'latin1'));
    }
  }
  // Catalog + pages tree.
  const kids = pageNewNums.filter(Boolean).map((n) => `${n} 0 R`).join(' ');
  const catalogOffset = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`, 'latin1'));
  offsets.set(1, catalogOffset);
  const pagesOffset = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`2 0 obj\n<< /Type /Pages /Count ${pageNewNums.filter(Boolean).length} /Kids [ ${kids} ] >>\nendobj\n`, 'latin1'));
  offsets.set(2, pagesOffset);

  const startxref = Buffer.concat(chunks).length;
  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let n = 1; n < next; n++) {
    const off = offsets.get(n);
    xref += off === undefined
      ? '0000000000 65535 f \n'
      : `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** One level of inheritance: copy /prop off the source's /Pages node. */
function inheritFromPages(source, pageObjNum, prop) {
  const pageObj = source.objects.get(pageObjNum);
  if (!pageObj) return null;
  const pm = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(pageObj.dict);
  if (!pm) return null;
  const parent = source.objects.get(Number(pm[1]));
  if (!parent) return null;
  const vm = new RegExp(`${prop}\\s*(\\[[^\\]]*\\]|\\([^)]*\\)|\\d+|/\\w+)`).exec(parent.dict);
  return vm ? vm[1] : null;
}

function listPdfPages(parsed) {
  const pages = [];
  for (const obj of parsed.objects.values()) {
    if (/\/Type\s*\/Page(?![sA-Za-z])/.test(obj.dict)) {
      const box = /\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(obj.dict);
      const rot = /\/Rotate\s+(\d+)/.exec(obj.dict);
      pages.push({
        objNum: obj.num,
        mediaBox: box ? box.slice(1).map(Number) : null,
        rotate: rot ? Number(rot[1]) : 0,
      });
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------
// ZIP (STORE + DEFLATE reader/writer; zip64 refused honestly)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Entry names must stay inside the extraction root: no absolute paths, no
 *  drive letters, no UNC, no parent traversal, after normalising separators. */
function safeZipName(name) {
  const normalized = String(name).replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized)) throw Object.assign(new Error(`entry escapes destination: ${name}`), { code: 'UNSAFE_PATH' });
  if (normalized.startsWith('/') || normalized.startsWith('//')) throw Object.assign(new Error(`entry escapes destination: ${name}`), { code: 'UNSAFE_PATH' });
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || p.includes('\0'))) throw Object.assign(new Error(`entry escapes destination: ${name}`), { code: 'UNSAFE_PATH' });
  return parts.join('/');
}

function parseZip(buf) {
  const eocdSig = [0x50, 0x4b, 0x05, 0x06];
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 66 * 1024);
  for (let i = buf.length - eocdSig.length; i >= scanFrom; i--) {
    if (buf[i] === eocdSig[0] && buf[i + 1] === eocdSig[1] && buf[i + 2] === eocdSig[2] && buf[i + 3] === eocdSig[3]) { eocd = i; break; }
  }
  if (eocd === -1) throw Object.assign(new Error('no ZIP end-of-central-directory record found'), { code: 'BAD_ZIP' });
  if (buf.subarray(0, Math.max(0, buf.length - 76)).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))) {
    throw Object.assign(new Error('ZIP64 archives are not supported by this bundled engine'), { code: 'ZIP64' });
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('corrupt central directory'), { code: 'BAD_ZIP' });
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const isDir = name.endsWith('/');
    entries.push({ name, method, compSize, localOff, isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
}

function zipEntryData(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw Object.assign(new Error('corrupt local header'), { code: 'BAD_ZIP' });
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw Object.assign(new Error(`unsupported compression method ${entry.method} for ${entry.name}`), { code: 'BAD_METHOD' });
}

function buildZip(files) {
  // files: [{name, data}]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const deflated = zlib.deflateRawSync(f.data, { level: 6 });
    const useDeflate = deflated.length < f.data.length;
    const payload = useDeflate ? deflated : f.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12); // fixed DOS time; archives stay deterministic
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0x2821, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// WAV / raw PCM
// ---------------------------------------------------------------------------

function parseWav(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WAVE') {
    throw Object.assign(new Error('not a RIFF/WAVE file'), { code: 'NOT_WAV' });
  }
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= buf.length) {
    const id = buf.subarray(p, p + 4).toString('latin1');
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && !fmt) {
      const audioFormat = buf.readUInt16LE(p + 8);
      let format = audioFormat;
      if (audioFormat === 0xfffe && size >= 40) {
        format = buf.readUInt16LE(p + 8 + 24); // first 2 bytes of the sub-format GUID
      }
      fmt = {
        audioFormat,
        format,
        channels: buf.readUInt16LE(p + 10),
        sampleRate: buf.readUInt32LE(p + 12),
        byteRate: buf.readUInt32LE(p + 16),
        blockAlign: buf.readUInt16LE(p + 20),
        bitsPerSample: buf.readUInt16LE(p + 22),
      };
    } else if (id === 'data' && !data) {
      data = { offset: p + 8, size: Math.min(size, buf.length - p - 8) };
    }
    p += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw Object.assign(new Error('WAV is missing its fmt or data chunk'), { code: 'NOT_WAV' });
  return { fmt, data };
}

function sampleBytes(bits) { return bits / 8; }

function readSample(buf, offset, bits) {
  switch (bits) {
    case 8: return (buf.readUInt8(offset) - 128) / 128; // unsigned 8-bit
    case 16: return buf.readInt16LE(offset) / 32768;
    case 24: {
      const v = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
      return ((v << 8) >> 8) / 8388608;
    }
    case 32: return buf.readFloatLE(offset);
    default: throw new Error(`unsupported sample width ${bits}`);
  }
}

function writeSample(out, offset, bits, v) {
  const c = Math.max(-1, Math.min(1, v));
  switch (bits) {
    case 8: out.writeUInt8(Math.round((c * 127) + 128) & 0xff, offset); break;
    case 16: out.writeInt16LE(Math.round(c * 32767), offset); break;
    case 24: {
      const n = Math.round(c * 8388607);
      out[offset] = n & 0xff;
      out[offset + 1] = (n >> 8) & 0xff;
      out[offset + 2] = (n >> 16) & 0xff;
      break;
    }
    case 32: out.writeFloatLE(c, offset); break;
    default: throw new Error(`unsupported sample width ${bits}`);
  }
}

function wavHeader(dataBytes, channels, sampleRate, bits) {
  const blockAlign = channels * (bits / 8);
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(bits === 32 ? 3 : 1, 20); // 3 = IEEE float
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Linear-interpolation resample + optional width change. Streaming-friendly
 *  over frames; whole input must fit the in-memory cap. */
function convertPcm(src, { srcRate, srcChannels, srcBits, dstRate, dstChannels, dstBits }) {
  const framesIn = Math.floor(src.length / (srcChannels * sampleBytes(srcBits)));
  const framesOut = dstRate === srcRate ? framesIn : Math.floor((framesIn * dstRate) / srcRate);
  const out = Buffer.alloc(framesOut * dstChannels * sampleBytes(dstBits));
  for (let f = 0; f < framesOut; f++) {
    const srcPos = dstRate === srcRate ? f : (f * srcRate) / dstRate;
    const f0 = Math.floor(srcPos);
    const frac = srcPos - f0;
    for (let c = 0; c < dstChannels; c++) {
      const srcChan = Math.min(c, srcChannels - 1); // channel drop/duplicate, no mixing matrix
      const base = f0 * srcChannels * sampleBytes(srcBits) + srcChan * sampleBytes(srcBits);
      const s0 = readSample(src, base, srcBits);
      let v = s0;
      if (frac > 0 && f0 + 1 < framesIn) {
        const base1 = (f0 + 1) * srcChannels * sampleBytes(srcBits) + srcChan * sampleBytes(srcBits);
        v = s0 + (readSample(src, base1, srcBits) - s0) * frac;
      }
      writeSample(out, f * dstChannels * sampleBytes(dstBits) + c * sampleBytes(dstBits), dstBits, v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// structured data subsets (JSON / YAML / TOML / CSV / TSV)
// ---------------------------------------------------------------------------

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '' || /[:#\[\]{{}}&*!|>'"%@`,\n]/.test(s) || /^(null|true|false|yes|no|on|off|~|\d+(\.\d+)?([eE][+-]?\d+)?)$/i.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === 'object') {
        const inner = toYaml(item, indent + 1);
        return `${pad}-\n${inner}`;
      }
      return `${pad}- ${yamlScalar(item)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}`;
    return keys.map((k) => {
      const v = value[k];
      const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
      if (v && typeof v === 'object') {
        return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
      }
      return `${pad}${key}: ${yamlScalar(v)}`;
    }).join('\n');
  }
  return `${pad}${yamlScalar(value)}`;
}

function parseYamlSubset(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  let i = 0;
  function parseBlock(minIndent) {
    if (i >= lines.length) return null;
    const firstIndent = lines[i].length - lines[i].trimStart().length;
    if (firstIndent < minIndent) return null;
    if (/^\s*-\s/.test(lines[i]) || lines[i].trim() === '-') {
      const arr = [];
      while (i < lines.length) {
        const line = lines[i];
        const ind = line.length - line.trimStart().length;
        if (ind < firstIndent || !/^\s*-\s?/.test(line)) break;
        const rest = line.replace(/^\s*-\s?/, '');
        i += 1;
        if (rest.trim() === '') {
          const child = parseBlock(firstIndent + 2);
          arr.push(child);
        } else if (/^[^:]+:\s/.test(rest) || /:$/.test(rest.trim())) {
          // inline map start: re-parse as map using a synthetic line
          const synthetic = `${' '.repeat(ind + 2)}${rest}`;
          lines.splice(i, 0, synthetic);
          const child = parseBlock(ind + 2);
          arr.push(child);
        } else {
          arr.push(scalar(rest.trim()));
        }
      }
      return arr;
    }
    const obj = {};
    while (i < lines.length) {
      const line = lines[i];
      const ind = line.length - line.trimStart().length;
      if (ind < firstIndent) break;
      const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
      if (!m) break;
      const key = unquote(m[1].trim());
      const rest = m[2].trim();
      i += 1;
      if (rest === '') {
        obj[key] = parseBlock(firstIndent + 1);
      } else {
        obj[key] = scalar(rest);
      }
    }
    return obj;
  }
  function unquote(s) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }
  function scalar(s) {
    if (s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return unquote(s);
    return s;
  }
  const out = parseBlock(0);
  return out ?? {};
}

function toToml(value) {
  const lines = [];
  const scalars = [];
  const tables = [];
  const arrays = [];
  for (const [k, v] of Object.entries(value ?? {})) {
    if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) scalars.push([k, v]);
    else if (Array.isArray(v)) arrays.push([k, v]);
    else if (v && typeof v === 'object') tables.push([k, v]);
    else scalars.push([k, v]);
  }
  const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
  for (const [k, v] of scalars) lines.push(`${key(k)} = ${tomlValue(v)}`);
  for (const [k, v] of tables) {
    lines.push('', `[${key(k)}]`);
    for (const [k2, v2] of Object.entries(v)) {
      if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) {
        lines.push('', `[${key(k)}.${key(k2)}]`);
        for (const [k3, v3] of Object.entries(v2)) lines.push(`${key(k3)} = ${tomlValue(v3)}`);
      } else if (Array.isArray(v2)) {
        lines.push(`${key(k2)} = ${tomlValue(v2)}`);
      } else {
        lines.push(`${key(k2)} = ${tomlValue(v2)}`);
      }
    }
  }
  for (const [k, v] of arrays) {
    for (const item of v) {
      lines.push('', `[[${key(k)}]]`);
      for (const [k2, v2] of Object.entries(item ?? {})) {
        if (v2 && typeof v2 === 'object') lines.push(`${key(k2)} = ${JSON.stringify(JSON.stringify(v2))} # nested value serialized as JSON string (TOML subset)`);
        else lines.push(`${key(k2)} = ${tomlValue(v2)}`);
      }
    }
  }
  return lines.join('\n');
}

function tomlValue(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => tomlValue(x)).join(', ')}]`;
  const s = String(v);
  // Literal strings keep backslashes honest; basic strings escape them.
  return JSON.stringify(s);
}

function parseTomlSubset(text) {
  const root = {};
  let target = root;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    const arrTable = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrTable) {
      const path = arrTable[1].split('.').map((s) => s.trim().replace(/^"|"$/g, ''));
      let node = root;
      for (let i = 0; i < path.length - 1; i++) node = node[path[i]] ??= {};
      const last = path[path.length - 1];
      node[last] ??= [];
      const item = {};
      node[last].push(item);
      target = item;
      continue;
    }
    if (table) {
      const path = table[1].split('.').map((s) => s.trim().replace(/^"|"$/g, ''));
      let node = root;
      for (const part of path) node = node[part] ??= {};
      target = node;
      continue;
    }
    const m = /^([^=]+)=\s*(.*)$/.exec(line);
    if (!m) continue;
    target[m[1].trim().replace(/^"|"$/g, '')] = tomlScalar(m[2].trim());
  }
  return root;
}

function tomlScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => tomlScalar(p.trim()));
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function csvEncode(rows, delimiter) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /["\n\r,;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((row) => row.map(esc).join(delimiter)).join('\r\n') + '\r\n';
}

function csvDecode(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
}

// ---------------------------------------------------------------------------
// text encoding / newlines
// ---------------------------------------------------------------------------

function decodeTextBuffer(buf, encoding) {
  switch (encoding) {
    case 'utf8': return new TextDecoder('utf-8').decode(buf);
    case 'utf16le': return new TextDecoder('utf-16le').decode(buf);
    case 'utf16be': return Buffer.from(buf).swap16().toString('utf16le');
    case 'latin1': return buf.toString('latin1');
    default: return new TextDecoder('utf-8').decode(buf);
  }
}

function encodeText(str, encoding, bom) {
  let out;
  switch (encoding) {
    case 'utf8': out = Buffer.from(str, 'utf8'); break;
    case 'utf16le': out = Buffer.from(str, 'utf16le'); break;
    case 'utf16be': out = Buffer.from(str, 'utf16le'); out.swap16(); break;
    case 'latin1': out = Buffer.from(str.replace(/[Ā-￿]/g, '?'), 'latin1'); break;
    default: out = Buffer.from(str, 'utf8');
  }
  const bomBuf = bom === 'utf8' ? Buffer.from([0xef, 0xbb, 0xbf])
    : bom === 'utf16le' ? Buffer.from([0xff, 0xfe])
      : bom === 'utf16be' ? Buffer.from([0xfe, 0xff])
        : null;
  return bomBuf ? Buffer.concat([bomBuf, out]) : out;
}

function convertNewlines(str, style) {
  if (style === 'lf') return str.replace(/\r\n?/g, '\n');
  if (style === 'crlf') return str.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  if (style === 'cr') return str.replace(/\r\n?/g, '\r');
  return str;
}

// ---------------------------------------------------------------------------
// op implementations
// ---------------------------------------------------------------------------

function opDetect(job) {
  const st = assertReadableFile(job.in);
  const fd = fs.openSync(job.in, 'r');
  const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
  fs.readSync(fd, head, 0, head.length, 0);
  const tail = Buffer.alloc(Math.min(TAIL_BYTES, Math.max(0, st.size - head.length)));
  if (tail.length) fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
  fs.closeSync(fd);
  const ext = path.extname(job.in);
  const det = detectFromBytes(head, tail, st.size, ext);
  return {
    ok: true,
    result: {
      size: st.size,
      mtimeMs: st.mtimeMs,
      extension: ext,
      ...det,
      reasons: det.reasons,
      headPreview: ASCII(head.subarray(0, 16)).replace(/[^\x20-\x7e]/g, '.'),
    },
  };
}

function opInspect(job) {
  const st = assertReadableFile(job.in);
  const format = job.args.format;
  const base = { size: st.size, mtimeMs: st.mtimeMs, format };
  if (format === 'pdf') {
    assertBufferable(st.size, 'PDF inspection');
    const buf = fs.readFileSync(job.in);
    const parsed = parsePdf(buf);
    if (parsed.encrypted) {
      return { ok: true, result: { ...base, encrypted: true, pages: null, note: 'Encrypted PDF - inspection stops at the encryption flag and every rewrite is unavailable.' } };
    }
    return {
      ok: true,
      result: {
        ...base,
        encrypted: false,
        objectStreams: parsed.hasObjStm,
        pages: listPdfPages(parsed),
        metadata: parsed.info,
        capabilities: parsed.hasObjStm
          ? { split: false, merge: false, reorder: false, rotate: false, reason: 'uses compressed object streams (PDF 1.5+ xref streams), which this bundled rewriter does not support' }
          : { split: true, merge: true, reorder: true, rotate: true },
      },
    };
  }
  if (format === 'wav') {
    assertBufferable(st.size, 'WAV inspection');
    const buf = fs.readFileSync(job.in);
    const { fmt, data } = parseWav(buf);
    return {
      ok: true,
      result: {
        ...base,
        formatTag: fmt.format,
        channels: fmt.channels,
        sampleRate: fmt.sampleRate,
        bitsPerSample: fmt.bitsPerSample,
        dataBytes: data.size,
        durationSeconds: Number(((data.size / (fmt.channels * (fmt.bitsPerSample / 8))) / fmt.sampleRate).toFixed(3)),
      },
    };
  }
  if (format === 'zip') {
    assertBufferable(st.size, 'ZIP inspection');
    const buf = fs.readFileSync(job.in);
    const { entries } = parseZip(buf);
    return {
      ok: true,
      result: {
        ...base,
        entries: entries.map((e) => ({ name: e.name, isDir: e.isDir, compressedBytes: e.compSize, method: e.method, safeName: (() => { try { return safeZipName(e.name); } catch { return null; } })() })),
        totalEntries: entries.length,
      },
    };
  }
  if (format === 'json') {
    assertBufferable(st.size, 'JSON inspection');
    const buf = fs.readFileSync(job.in);
    try {
      const v = JSON.parse(decodeTextBuffer(stripBom(buf), 'utf8'));
      return { ok: true, result: { ...base, valid: true, type: Array.isArray(v) ? 'array' : typeof v, topLevelKeys: v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).slice(0, 100) : null, length: Array.isArray(v) ? v.length : null } };
    } catch (err) {
      return { ok: true, result: { ...base, valid: false, error: err.message } };
    }
  }
  if (['mp4', 'mov', 'matroska', 'avi'].includes(format)) {
    const fd = fs.openSync(job.in, 'r');
    const head = Buffer.alloc(Math.min(4096, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    let container = format;
    if (format === 'matroska') {
      container = head.subarray(0, 40).includes(Buffer.from('webm')) ? 'webm' : 'mkv';
    }
    return {
      ok: true,
      result: {
        ...base,
        container,
        codecInfo: null,
        note: 'Header inspection only. No bundled video codec, so transcoding is unavailable; extracting or re-muxing streams needs an external engine this app does not carry.',
      },
    };
  }
  return { ok: true, result: base };
}

function stripBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3);
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return buf.subarray(2);
  return buf;
}

function opConvert(job) {
  // zip-create carries its own input list; every other adapter has one source.
  const st = job.in ? assertReadableFile(job.in) : null;
  const a = job.args || {};
  switch (job.adapter) {
    // -- documents ----------------------------------------------------------
    case 'pdf-split':
    case 'pdf-reorder':
    case 'pdf-rotate': {
      assertBufferable(st.size, 'PDF rewrite');
      const buf = fs.readFileSync(job.in);
      const parsed = parsePdf(buf);
      if (parsed.encrypted) throw Object.assign(new Error('PDF is encrypted; this bundled rewriter only handles unencrypted files'), { code: 'ENCRYPTED' });
      if (parsed.hasObjStm) throw Object.assign(new Error('PDF uses compressed object streams; this bundled rewriter only handles classic simple PDFs'), { code: 'OBJSTM' });
      const pages = listPdfPages(parsed);
      let spec;
      if (job.adapter === 'pdf-split') {
        const ranges = String(a.ranges || '').trim();
        spec = ranges
          ? ranges.split(',').flatMap((part) => {
            const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
            if (m) {
              const out = [];
              for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push({ srcIndex: 0, objNum: pages[i - 1]?.objNum });
              return out;
            }
            const one = Number(part.trim());
            return Number.isFinite(one) && pages[one - 1] ? [{ srcIndex: 0, objNum: pages[one - 1].objNum }] : [];
          }).filter(Boolean)
          : pages.map((p) => ({ srcIndex: 0, objNum: p.objNum }));
        if (spec.length === 0) throw new Error('page selection produced no pages');
      } else if (job.adapter === 'pdf-reorder') {
        const order = Array.isArray(a.order) ? a.order : [];
        if (order.length !== pages.length) throw new Error(`reorder needs all ${pages.length} page indices`);
        spec = order.map((one) => ({ srcIndex: 0, objNum: pages[one].objNum }));
      } else {
        spec = pages.map((p) => ({ srcIndex: 0, objNum: p.objNum }));
      }
      const out = rewritePdf([{ buf, objects: parsed.objects }], spec, job.adapter === 'pdf-rotate' ? Number(a.rotate) || 0 : 0);
      return { ok: true, bytes: out, result: { pages: spec.length, rotated: job.adapter === 'pdf-rotate' ? Number(a.rotate) || 0 : 0 } };
    }
    case 'pdf-merge': {
      const sources = [];
      const specs = [];
      for (const src of a.sources || []) {
        const s2 = statSafe(src);
        if (!s2 || !s2.isFile()) throw Object.assign(new Error(`merge source missing: ${path.basename(String(src))}`), { code: 'NO_SOURCE' });
        assertBufferable(s2.size, 'PDF merge input');
        const buf = fs.readFileSync(src);
        const parsed = parsePdf(buf);
        if (parsed.encrypted) throw Object.assign(new Error(`merge source is encrypted: ${path.basename(src)}`), { code: 'ENCRYPTED' });
        if (parsed.hasObjStm) throw Object.assign(new Error(`merge source uses object streams: ${path.basename(src)}`), { code: 'OBJSTM' });
        const idx = sources.push({ buf, objects: parsed.objects }) - 1;
        for (const p of listPdfPages(parsed)) specs.push({ srcIndex: idx, objNum: p.objNum });
      }
      if (sources.length < 2) throw new Error('merge needs at least two sources');
      const out = rewritePdf(sources, specs, 0);
      return { ok: true, bytes: out, result: { pages: specs.length, sources: sources.length } };
    }

    // -- archives ------------------------------------------------------------
    case 'zip-extract': {
      assertBufferable(st.size, 'ZIP extraction');
      const dest = String(a.destDir || '');
      if (!dest) throw new Error('extraction needs a destination folder');
      const buf = fs.readFileSync(job.in);
      const { entries } = parseZip(buf);
      let written = 0;
      const files = [];
      for (const e of entries) {
        if (e.isDir) continue;
        const safe = safeZipName(e.name);
        if (!safe) continue;
        const target = path.join(dest, safe);
        if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) {
          throw Object.assign(new Error(`entry escapes destination: ${e.name}`), { code: 'UNSAFE_PATH' });
        }
        const data = zipEntryData(buf, e);
        written += data.length;
        if (written > (a.maxTotalBytes || 2 * 1024 * 1024 * 1024)) {
          throw Object.assign(new Error('extracted total exceeds the safety bound'), { code: 'ZIP_BOMB' });
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        files.push(safe);
      }
      return { ok: true, result: { extracted: files.length, bytes: written, destDir: dest } };
    }
    case 'zip-create': {
      const files = (a.files || []).map((f) => {
        const s2 = statSafe(f.path);
        if (!s2 || !s2.isFile()) throw Object.assign(new Error(`input missing: ${path.basename(String(f.path))}`), { code: 'NO_SOURCE' });
        assertBufferable(s2.size, `archive input ${path.basename(f.path)}`);
        return { name: safeZipName(f.name || path.basename(f.path)), data: fs.readFileSync(f.path) };
      });
      const out = buildZip(files);
      return { ok: true, bytes: out, result: { entries: files.length } };
    }

    // -- audio ---------------------------------------------------------------
    case 'wav-to-raw': {
      assertBufferable(st.size, 'WAV conversion');
      const { data } = parseWav(fs.readFileSync(job.in));
      return { ok: true, bytes: Buffer.from(fs.readFileSync(job.in).subarray(data.offset, data.offset + data.size)), result: { dataBytes: data.size } };
    }
    case 'raw-to-wav': {
      assertBufferable(st.size, 'raw PCM conversion');
      const raw = fs.readFileSync(job.in);
      const channels = Number(a.channels) || 2;
      const sampleRate = Number(a.sampleRate) || 44100;
      const bits = Number(a.bits) || 16;
      const out = Buffer.concat([wavHeader(raw.length, channels, sampleRate, bits), raw]);
      return { ok: true, bytes: out, result: { channels, sampleRate, bits } };
    }
    case 'wav-convert': {
      assertBufferable(st.size, 'WAV conversion');
      const buf = fs.readFileSync(job.in);
      const { fmt, data } = parseWav(buf);
      const src = buf.subarray(data.offset, data.offset + data.size);
      const dstRate = Number(a.sampleRate) || fmt.sampleRate;
      const dstBits = Number(a.bits) || fmt.bitsPerSample;
      const dstChannels = Number(a.channels) || fmt.channels;
      const out = convertPcm(src, {
        srcRate: fmt.sampleRate, srcChannels: fmt.channels, srcBits: fmt.bitsPerSample,
        dstRate, dstBits, dstChannels,
      });
      const wav = Buffer.concat([wavHeader(out.length, dstChannels, dstRate, dstBits), out]);
      return {
        ok: true,
        bytes: wav,
        result: {
          from: { rate: fmt.sampleRate, bits: fmt.bitsPerSample, channels: fmt.channels },
          to: { rate: dstRate, bits: dstBits, channels: dstChannels },
          note: 'Linear-interpolation resampling; channel changes drop or duplicate channels rather than mixing.',
        },
      };
    }

    // -- text ------------------------------------------------------------------
    case 'text-convert': {
      assertBufferable(st.size, 'text conversion');
      const buf = fs.readFileSync(job.in);
      const srcEnc = a.sourceEncoding || sniffEncoding(buf);
      let str = decodeTextBuffer(stripBomIf(buf, srcEnc), srcEnc);
      if (a.newlines && a.newlines !== 'keep') str = convertNewlines(str, a.newlines);
      const out = encodeText(str, a.targetEncoding || 'utf8', a.bom || 'none');
      return {
        ok: true,
        bytes: out,
        result: { sourceEncoding: srcEnc, targetEncoding: a.targetEncoding || 'utf8', newlines: a.newlines || 'keep', bom: a.bom || 'none' },
      };
    }

    // -- structured --------------------------------------------------------------
    case 'json-to-yaml': {
      assertBufferable(st.size, 'JSON conversion');
      const v = JSON.parse(decodeTextBuffer(stripBom(fs.readFileSync(job.in)), 'utf8'));
      return { ok: true, text: `${toYaml(v)}\n`, result: { note: 'YAML subset: plain maps, sequences and scalars; anchors, aliases, multi-document files, comments and tags are not preserved.' } };
    }
    case 'yaml-to-json': {
      assertBufferable(st.size, 'YAML conversion');
      const v = parseYamlSubset(decodeTextBuffer(stripBom(fs.readFileSync(job.in)), 'utf8'));
      return { ok: true, text: `${JSON.stringify(v, null, 2)}\n`, result: { note: 'Parsed with the bundled YAML subset parser (block maps/sequences/scalars only).' } };
    }
    case 'json-to-toml': {
      assertBufferable(st.size, 'JSON conversion');
      const v = JSON.parse(decodeTextBuffer(stripBom(fs.readFileSync(job.in)), 'utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('TOML needs a top-level table (JSON object)');
      return { ok: true, text: `${toToml(v)}\n`, result: { note: 'TOML subset: scalar keys, one nesting level of tables, arrays of tables; deeper structures are serialized as JSON strings.' } };
    }
    case 'toml-to-json': {
      assertBufferable(st.size, 'TOML conversion');
      const v = parseTomlSubset(decodeTextBuffer(stripBom(fs.readFileSync(job.in)), 'utf8'));
      return { ok: true, text: `${JSON.stringify(v, null, 2)}\n`, result: { note: 'Parsed with the bundled TOML subset parser.' } };
    }
    case 'json-to-csv':
    case 'json-to-tsv': {
      assertBufferable(st.size, 'JSON conversion');
      const v = JSON.parse(decodeTextBuffer(stripBom(fs.readFileSync(job.in)), 'utf8'));
      if (!Array.isArray(v)) throw new Error('CSV conversion needs a JSON array of records');
      const delimiter = job.adapter === 'json-to-tsv' ? '\t' : ',';
      const cols = [...new Set(v.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : ['value'])))];
      const rows = [cols, ...v.map((r) => cols.map((c) => (r && typeof r === 'object' ? r[c] : r)))];
      return { ok: true, text: csvEncode(rows, delimiter), result: { rows: v.length, columns: cols.length, note: 'Nested values are serialized as JSON strings inside their cell; the reverse conversion produces strings.' } };
    }
    case 'csv-to-json':
    case 'tsv-to-json': {
      assertBufferable(st.size, 'CSV conversion');
      const delimiter = job.adapter === 'tsv-to-json' ? '\t' : ',';
      const rows = csvDecode(decodeTextBuffer(stripBom(fs.readFileSync(job.in)), 'utf8'), delimiter);
      if (rows.length === 0) throw new Error('no rows found');
      const [header, ...data] = rows;
      const coerce = (s) => {
        const t = s.trim();
        if (t === '') return '';
        if (t === 'true') return true;
        if (t === 'false') return false;
        if (/^-?\d+$/.test(t) && t.length < 16) return Number(t);
        if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(t)) return Number(t);
        return s;
      };
      const out = data.map((r) => Object.fromEntries(header.map((c, i) => [c || `column${i + 1}`, coerce(r[i] ?? '')])));
      return { ok: true, text: `${JSON.stringify(out, null, 2)}\n`, result: { rows: out.length, note: 'Empty cells, numbers and true/false are typed on read; everything else stays a string.' } };
    }

    // -- binary encodings ---------------------------------------------------------
    case 'to-base64':
    case 'to-hex': {
      const out = [];
      const chunk = 3 * 1024 * 1024;
      const fd = fs.openSync(job.in, 'r');
      const buf = Buffer.alloc(chunk);
      try {
        let pos = 0;
        while (pos < st.size) {
          const n = fs.readSync(fd, buf, 0, Math.min(chunk, st.size - pos), pos);
          out.push(job.adapter === 'to-base64' ? Buffer.from(buf.subarray(0, n)).toString('base64') : Buffer.from(buf.subarray(0, n)).toString('hex'));
          pos += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      const text = job.adapter === 'to-base64'
        ? out.join('').replace(/(.{76})/g, '$1\n') + '\n'
        : out.join('').replace(/(.{76})/g, '$1\n') + '\n';
      return { ok: true, text, result: { encodedBytes: st.size } };
    }
    case 'from-base64':
    case 'from-hex': {
      assertBufferable(st.size, 'binary decoding');
      const raw = decodeTextBuffer(stripBom(fs.readFileSync(job.in)), 'utf8').replace(/\s+/g, '');
      if (raw.length % (job.adapter === 'from-hex' ? 2 : 4) !== 0) {
        throw Object.assign(new Error('encoded length is not a whole number of units'), { code: 'BAD_LENGTH' });
      }
      const out = job.adapter === 'from-base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'hex');
      if (job.adapter === 'from-hex' && /[^0-9a-fA-F]/.test(raw)) throw new Error('input contains non-hexadecimal characters');
      return { ok: true, bytes: out, result: { decodedBytes: out.length } };
    }

    // -- icons (renderer pre-encodes PNGs; worker wraps them) -----------------------
    case 'png-to-ico': {
      const pngs = (a.pngFiles || []).map((p) => {
        const s2 = statSafe(p);
        if (!s2) throw Object.assign(new Error(`missing PNG layer: ${path.basename(String(p))}`), { code: 'NO_SOURCE' });
        const b = fs.readFileSync(p);
        if (!(b.length > 8 && b[0] === 0x89 && b[1] === 0x50)) throw new Error(`not a PNG: ${path.basename(p)}`);
        return b;
      });
      if (pngs.length === 0) throw new Error('no PNG layers supplied');
      const count = pngs.length;
      const header = Buffer.alloc(6);
      header.writeUInt16LE(0, 0);
      header.writeUInt16LE(1, 2); // type icon
      header.writeUInt16LE(count, 4);
      const dir = Buffer.alloc(16 * count);
      let dataOffset = 6 + 16 * count;
      pngs.forEach((png, i) => {
        // PNG IHDR carries width/height at bytes 16..23.
        const w = png.readUInt32BE(16);
        const h = png.readUInt32BE(20);
        dir.writeUInt8(w >= 256 ? 0 : w, i * 16 + 0);
        dir.writeUInt8(h >= 256 ? 0 : h, i * 16 + 1);
        dir.writeUInt8(0, i * 16 + 2); // palette
        dir.writeUInt8(0, i * 16 + 3);
        dir.writeUInt16LE(1, i * 16 + 4); // planes
        dir.writeUInt16LE(32, i * 16 + 6); // bit count
        dir.writeUInt32LE(png.length, i * 16 + 8);
        dir.writeUInt32LE(dataOffset, i * 16 + 12);
        dataOffset += png.length;
      });
      return { ok: true, bytes: Buffer.concat([header, dir, ...pngs]), result: { sizes: pngs.length } };
    }

    default:
      throw Object.assign(new Error(`worker has no adapter "${job.adapter}"`), { code: 'NO_ADAPTER' });
  }
}

function stripBomIf(buf, encoding) {
  return encoding === 'utf8' ? stripBom(buf) : buf;
}

function sniffEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  // UTF-16 without BOM: alternating zero bytes in the first block.
  let zerosEven = 0;
  let zerosOdd = 0;
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) zerosEven += 1;
    if (buf[i + 1] === 0) zerosOdd += 1;
  }
  if (zerosEven > n / 4) return 'utf16be';
  if (zerosOdd > n / 4) return 'utf16le';
  return 'utf8';
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function main() {
  const jobPath = process.argv[2];
  if (!jobPath) {
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    const job = readJob(jobPath);
    result = job.op === 'detect' ? opDetect(job) : job.op === 'inspect' ? opInspect(job) : opConvert(job);
  } catch (err) {
    result = fail(err.code || 'WORKER_ERROR', err.message);
  }
  try {
    writeResult(jobPath, result);
  } catch (err) {
    // The parent treats a missing result file as a worker crash.
    console.error('result write failed:', err.message);
    process.exitCode = 1;
  }
}

main();
