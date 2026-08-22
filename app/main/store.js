// Purpose: durable JSON settings/state storage with atomic writes.
// Foundation seam: every later lane persists user state through JSONStore.
// Owned by Foundation Core lane.

import fs from 'node:fs';
import path from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_ATTEMPTS = 8;
const RETRY_DELAY_MS = 50;

let tmpCounter = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomic write: unique temp filename per call (pid + counter + random) then
 * rename over the target. On Windows a rename fails transiently when the
 * destination happens to be open (Defender scan, indexer, sync client), so
 * retry only EPERM/EACCES/EBUSY a bounded number of times, then give up and
 * throw honestly. Never retry ENOENT (temp vanished = caller bug) or ENOSPC.
 */
export async function atomicWriteFile(targetPath, data) {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    tmpCounter += 1;
    const tmp = path.join(
      dir,
      `.${path.basename(targetPath)}.${process.pid}.${tmpCounter}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );
    let renamed = false;
    try {
      await fs.promises.writeFile(tmp, data);
      try {
        await fs.promises.rename(tmp, targetPath);
        renamed = true;
        return;
      } catch (err) {
        lastError = err;
        if (!RETRY_CODES.has(err.code)) throw err;
      }
    } finally {
      if (!renamed) {
        // Best-effort cleanup of this attempt's temp file.
        fs.promises.unlink(tmp).catch(() => {});
      }
    }
    await sleep(RETRY_DELAY_MS * attempt);
  }
  const err = new Error(
    `atomic write failed after ${RETRY_ATTEMPTS} attempts for ${path.basename(targetPath)}: ${lastError?.code || 'unknown'}`,
  );
  err.cause = lastError;
  throw err;
}

/** Synchronous variant for shutdown-time flushes where awaiting is not possible. */
export function atomicWriteFileSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    tmpCounter += 1;
    const tmp = path.join(
      dir,
      `.${path.basename(targetPath)}.${process.pid}.${tmpCounter}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );
    let renamed = false;
    try {
      fs.writeFileSync(tmp, data);
      try {
        fs.renameSync(tmp, targetPath);
        renamed = true;
        return;
      } catch (err) {
        lastError = err;
        if (!RETRY_CODES.has(err.code)) throw err;
      }
    } finally {
      if (!renamed) {
        try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
      }
    }
    const end = Date.now() + RETRY_DELAY_MS * attempt;
    while (Date.now() < end) { /* bounded spin for the sync shutdown path */ }
  }
  const err = new Error(
    `atomic write failed after ${RETRY_ATTEMPTS} attempts for ${path.basename(targetPath)}: ${lastError?.code || 'unknown'}`,
  );
  err.cause = lastError;
  throw err;
}

function readPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function writePath(obj, dotted, value) {
  const keys = dotted.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

function deletePath(obj, dotted) {
  const keys = dotted.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node == null || typeof node !== 'object') return false;
    node = node[keys[i]];
  }
  if (node == null || typeof node !== 'object') return false;
  const last = keys[keys.length - 1];
  // `delete obj.missingKey` is true in JS; only report a real removal.
  if (!Object.prototype.hasOwnProperty.call(node, last)) return false;
  return delete node[last];
}

/**
 * JSON-backed key/value store persisted under userData/<name>.json.
 * Supports dotted paths ("server.port"). Subscribers fire on exact-key writes
 * and on parent-path writes that change the subtree root they watch.
 */
export class JSONStore {
  constructor(filePath, { defaults = {}, schemaVersion = 1, debounceMs = 0 } = {}) {
    this.filePath = filePath;
    this.defaults = structuredClone(defaults);
    this.schemaVersion = schemaVersion;
    this.debounceMs = debounceMs;
    this.data = null;
    this.subscribers = [];
    this._saveTimer = null;
    this._saving = Promise.resolve();
    this.load();
  }

  load() {
    let loaded = null;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      loaded = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupt file: keep defaults but preserve the bad file for inspection.
        try {
          fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        } catch { /* nothing more we can do */ }
      }
      loaded = null;
    }
    const base = structuredClone(this.defaults);
    if (loaded && typeof loaded === 'object') {
      deepMerge(base, loaded);
    }
    base.schemaVersion = this.schemaVersion;
    this.data = base;
  }

  get(key, fallback) {
    const v = readPath(this.data, key);
    return v === undefined ? fallback : v;
  }

  getAll() {
    return structuredClone(this.data);
  }

  set(key, value) {
    writePath(this.data, key, value);
    this.scheduleSave();
    this._notify(key, value);
  }

  delete(key) {
    const removed = deletePath(this.data, key);
    if (removed) {
      this.scheduleSave();
      this._notify(key, undefined);
    }
    return removed;
  }

  /**
   * Subscribe to changes. cb(key, value); value === undefined on delete.
   * Returns an unsubscribe function.
   */
  subscribe(key, cb) {
    const entry = { key, cb };
    this.subscribers.push(entry);
    return () => {
      const idx = this.subscribers.indexOf(entry);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  _notify(changedKey, value) {
    for (const { key, cb } of [...this.subscribers]) {
      if (changedKey === key || changedKey.startsWith(`${key}.`) || key.startsWith(`${changedKey}.`)) {
        try {
          cb(changedKey, readPath(this.data, key));
        } catch { /* subscriber errors must not break persistence */ }
      }
    }
  }

  scheduleSave() {
    if (this.debounceMs > 0) {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.save(), this.debounceMs);
      return;
    }
    this.save();
  }

  /** Persist now. Serialized so concurrent saves cannot interleave. */
  save() {
    clearTimeout(this._saveTimer);
    this._saving = this._saving.then(() =>
      atomicWriteFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`),
    );
    return this._saving;
  }

  /** Synchronous flush for app shutdown. Throws honestly on failure. */
  flushSync() {
    clearTimeout(this._saveTimer);
    atomicWriteFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}
