// Purpose: OS-encrypted secret storage (Electron safeStorage) plus scrypt
// hashing for local lock credentials. Secrets are never logged, never
// returned in lists, and never serialized anywhere but vault.dat.
// Foundation seam: Providers/Builder/Authenticator lanes read keys via
// vault.getSecret(keyRef).
// Owned by Foundation Core lane.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { safeStorage } from 'electron';
import { atomicWriteFileSync } from './store.js';

const MAGIC = Buffer.from('MRVLT01\n', 'utf8');

export class Vault {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, Buffer>} id -> encrypted payload */
    this.records = new Map();
    this.obfuscationWarned = false;
    this._load();
  }

  get encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  _load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupt vault: keep the bad file aside rather than silently wiping it.
        try { fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      }
      return;
    }
    if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return;
    let offset = MAGIC.length;
    while (offset + 4 <= raw.length) {
      const len = raw.readUInt32LE(offset);
      offset += 4;
      if (len === 0 || offset + len > raw.length) break;
      const payload = raw.subarray(offset, offset + len);
      offset += len;
      try {
        const rec = JSON.parse(payload.toString('utf8'));
        if (rec && typeof rec.id === 'string' && typeof rec.data === 'string') {
          this.records.set(rec.id, Buffer.from(rec.data, 'base64'));
        }
      } catch { /* skip malformed record */ }
    }
  }

  _persist() {
    const chunks = [MAGIC];
    for (const [id, enc] of this.records) {
      const payload = Buffer.from(JSON.stringify({ id, data: enc.toString('base64') }), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      chunks.push(header, payload);
    }
    atomicWriteFileSync(this.filePath, Buffer.concat(chunks));
  }

  /**
   * Encrypt and store a secret under a stable id. Returns true when written
   * with real OS encryption, false when the obfuscation fallback was used
   * (callers should surface that warning once in the UI).
   */
  setSecret(id, plaintext) {
    if (typeof id !== 'string' || !id) throw new Error('vault: secret id required');
    if (typeof plaintext !== 'string') throw new Error('vault: secret must be a string');
    const value = Buffer.from(plaintext, 'utf8');
    let enc;
    if (this.encryptionAvailable) {
      enc = safeStorage.encryptString(value);
    } else {
      enc = this._obfuscate(value);
      this.obfuscationWarned = true;
    }
    this.records.set(id, enc);
    this._persist();
    return this.encryptionAvailable;
  }

  getSecret(id) {
    const enc = this.records.get(id);
    if (!enc) return null;
    try {
      if (this.encryptionAvailable && !this._isObfuscated(enc)) {
        return safeStorage.decryptString(enc);
      }
      if (this._isObfuscated(enc)) {
        return this._deobfuscate(enc).toString('utf8');
      }
      // Stored under a different availability regime than now: fail closed.
      return null;
    } catch {
      return null;
    }
  }

  deleteSecret(id) {
    const had = this.records.delete(id);
    if (had) this._persist();
    return had;
  }

  has(id) {
    return this.records.has(id);
  }

  /** Ids only. Values are never exposed through this path. */
  listIds() {
    return [...this.records.keys()];
  }

  _isObfuscated(buf) {
    return buf.length >= 4 && buf.readUInt32BE(0) === 0x4f464231; // 'OFB1'
  }

  _obfuscate(value) {
    const key = crypto.randomBytes(32);
    const out = Buffer.alloc(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value[i] ^ key[i % key.length];
    const header = Buffer.from('OFB1', 'ascii');
    return Buffer.concat([header, key, out]);
  }

  _deobfuscate(buf) {
    const key = buf.subarray(4, 36);
    const body = buf.subarray(36);
    const out = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i++) out[i] = body[i] ^ key[i % key.length];
    return out;
  }
}

/**
 * scrypt hash for local lock credentials (School-mode unlock, history access).
 * Never used for API keys. Returns base64 hash + salt; caller persists both.
 */
export function hashSecret(password, saltB64) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('vault: password required');
  }
  const salt = saltB64
    ? Buffer.from(saltB64, 'base64')
    : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { hashB64: hash.toString('base64'), saltB64: salt.toString('base64') };
}

export function verifySecret(password, saltB64, expectedHashB64) {
  try {
    const { hashB64 } = hashSecret(password, saltB64);
    const a = Buffer.from(hashB64, 'base64');
    const b = Buffer.from(expectedHashB64, 'base64');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function defaultVaultPath(userDataDir) {
  return path.join(userDataDir, 'vault.dat');
}
