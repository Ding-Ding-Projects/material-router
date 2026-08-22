// Purpose: built-in TOTP/HOTP authenticator backend. Implements RFC 4226
// (HOTP) and RFC 6238 (TOTP) with SHA-1/SHA-256/SHA-512, 6-8 digits and an
// arbitrary period, stores entry metadata in a JSONStore and entry secrets in
// the encrypted Vault under stable ids, and keeps an append-only, secret-free
// mutation journal in a dedicated JSONStore. Pairing requires typing one
// current code back before an entry lands armed.
//
// IPC surface: this lane registers handlers under the existing `vault` domain
// (the documented Authenticator seam in HANDOFF.md) with `auth-*` handler
// names, because the domain allowlist in ipc.js is owned by Foundation Core.
//
// Security notes:
//   - Secret values and generated codes are NEVER logged and NEVER written to
//     the journal. The journal carries metadata only.
//   - All persistent writes go through JSONStore / Vault (atomic).
//   - Errors propagate honestly with stable `err.code` values.
//
// Owned by the Authenticator lane.

import crypto from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import { JSONStore } from '../store.js';
import { hashSecret, verifySecret } from '../vault.js';
// The lane-bridge loader passes singletons only; handler registration comes
// straight from the frozen IPC registry (this file never mutates ipc.js).
import { registerHandler } from '../ipc.js';

const ALGORITHMS = Object.freeze(['SHA1', 'SHA256', 'SHA512']);
const DIGITS_ALLOWED = Object.freeze([6, 7, 8]);
const PERIOD_MIN = 1;
const PERIOD_MAX = 86_400; // one day; anything longer is almost certainly a typo
const SECRET_MIN_BYTES = 10; // RFC 4226 floor (80 bits); 128+ bits recommended
const SECRET_MAX_BYTES = 128;

const JOURNAL_MAX_ENTRIES = 2000;
const JOURNAL_MAX_AGE_DAYS = 400;
const UNLOCK_FAIL_DELAY_MS = 300;

/** Journal actions whose records carry a restorable metadata snapshot. */
const RESTORABLE_ACTIONS = Object.freeze(['edit', 'rekey', 'rename', 'group-change']);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* bounded spin; same pattern as store.js shutdown path */ }
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648)
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode base32 ignoring spaces, hyphens and '=' padding. Throws a typed
 * error naming the first offending character position (1-based).
 */
export function base32Decode(input) {
  if (typeof input !== 'string') throw fail('auth-invalid-secret', 'Secret must be text');
  const clean = input.toUpperCase().replace(/[\s-=]/g, '');
  if (clean.length === 0) throw fail('auth-invalid-secret', 'Secret is empty');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) {
      throw fail('auth-invalid-secret', `"${clean[i]}" at position ${i + 1} is not a valid base32 character`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function normalizeSecret(input) {
  const raw = str(input).trim();
  // Accept a pasted otpauth:// URI wherever a secret is expected - users
  // routinely paste whatever they have.
  if (/^otpauth:\/\//i.test(raw)) {
    const parsed = parseOtpauthUri(raw);
    return normalizeSecret(parsed.secret);
  }
  const bytes = base32Decode(raw);
  if (bytes.length < SECRET_MIN_BYTES) {
    throw fail('auth-secret-short', `Secret decodes to ${bytes.length} bytes; at least ${SECRET_MIN_BYTES} required`);
  }
  if (bytes.length > SECRET_MAX_BYTES) {
    throw fail('auth-secret-long', `Secret decodes to ${bytes.length} bytes; at most ${SECRET_MAX_BYTES} supported`);
  }
  return base32Encode(bytes);
}

// ---------------------------------------------------------------------------
// RFC 4226 HOTP / RFC 6238 TOTP core
// ---------------------------------------------------------------------------

function hmacFor(algorithm) {
  switch (String(algorithm).toUpperCase()) {
    case 'SHA1': return 'sha1';
    case 'SHA256': return 'sha256';
    case 'SHA512': return 'sha512';
    default: throw fail('auth-invalid-algorithm', `Unknown algorithm "${algorithm}"`);
  }
}

/**
 * RFC 4226 Section 5.3: HMAC, dynamic truncation, modulus 10^digits,
 * zero-padded to `digits`. Callers clamp digits to 6-8 before calling.
 */
export function hotp(secretBytes, counter, algorithm = 'SHA1', digits = 6) {
  if (!Number.isInteger(counter) || counter < 0) {
    throw fail('auth-invalid-counter', 'Counter must be a non-negative integer');
  }
  const ctrBuf = Buffer.alloc(8);
  ctrBuf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(hmacFor(algorithm), secretBytes).update(ctrBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  const modulus = 10 ** digits;
  return String(binary % modulus).padStart(digits, '0');
}

/** RFC 6238 TOTP at unix time `nowSec` (seconds); t0 is 0 per the RFC. */
export function totp(secretBytes, nowSec, { algorithm = 'SHA1', digits = 6, period = 30 } = {}) {
  return hotp(secretBytes, Math.floor(nowSec / period), algorithm, digits);
}

/** True when `code` equals the HOTP value at exactly `counter`. */
export function hotpMatches(secretBytes, counter, algorithm, digits, code) {
  const given = String(code ?? '').trim();
  return timingSafeEq(hotp(secretBytes, counter, algorithm, digits), given);
}

/** Standard +/- 1 step acceptance window for TOTP verification. */
export function totpMatches(secretBytes, paramsLike, code, nowSec = Date.now() / 1000) {
  const period = Number(paramsLike.period) || 30;
  const target = Math.floor(nowSec / period);
  const given = String(code ?? '').replace(/\s+/g, '');
  for (let drift = -1; drift <= 1; drift++) {
    if (timingSafeEq(hotp(secretBytes, target + drift, paramsLike.algorithm, paramsLike.digits), given)) {
      return true;
    }
  }
  return false;
}

function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// otpauth:// URI handling
// ---------------------------------------------------------------------------

/**
 * Parse an otpauth:// URI. Provided parameters win; defaults apply only when
 * a parameter is genuinely absent. Throws typed errors on malformed input.
 */
export function parseOtpauthUri(uri) {
  let u;
  try {
    u = new URL(String(uri).trim());
  } catch {
    throw fail('auth-invalid-uri', 'That text is not a valid URI');
  }
  if (u.protocol !== 'otpauth:') {
    throw fail('auth-invalid-uri', 'URI must start with otpauth://');
  }
  const type = (u.hostname || '').toLowerCase();
  if (type !== 'totp' && type !== 'hotp') {
    throw fail('auth-invalid-uri', `Unsupported otpauth type "${type}" (expected totp or hotp)`);
  }

  // Label: "/issuer:account" or "/account". The issuer may also arrive
  // percent-encoded inside the label; the explicit issuer= parameter wins
  // when both exist (per the key URI format's consistency note).
  let label = '';
  try {
    label = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  } catch {
    label = u.pathname.replace(/^\/+/, '');
  }
  let issuerFromLabel = '';
  let account = label;
  const colon = label.indexOf(':');
  if (colon > 0) {
    issuerFromLabel = label.slice(0, colon).trim();
    account = label.slice(colon + 1).trim();
  }

  const secretParam = u.searchParams.get('secret');
  if (!secretParam) throw fail('auth-invalid-uri', 'URI has no secret parameter');

  const issuerParam = str(u.searchParams.get('issuer')).trim();

  const algoRaw = str(u.searchParams.get('algorithm'), 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const algorithm = ALGORITHMS.includes(algoRaw) ? algoRaw : null;
  if (!algorithm) throw fail('auth-invalid-algorithm', `URI requests unsupported algorithm "${algoRaw}"`);

  const digits = readIntParam(u.searchParams.get('digits'), 6, DIGITS_ALLOWED[0], DIGITS_ALLOWED[DIGITS_ALLOWED.length - 1], 'digits');
  const period = readIntParam(u.searchParams.get('period'), 30, PERIOD_MIN, PERIOD_MAX, 'period');
  let counter = 0;
  if (u.searchParams.has('counter')) {
    counter = readIntParam(u.searchParams.get('counter'), 0, 0, Number.MAX_SAFE_INTEGER, 'counter');
  }

  return {
    type,
    secret: normalizeSecret(secretParam),
    issuer: issuerParam || issuerFromLabel,
    account: account.trim(),
    algorithm,
    digits,
    period,
    counter,
  };
}

function readIntParam(raw, fallback, min, max, name) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw fail('auth-invalid-param', `Parameter "${name}" must be a whole number between ${min} and ${max}`);
  }
  return n;
}

/** Build a canonical otpauth:// URI for an entry (also what the QR encodes). */
export function buildOtpauthUri({ type = 'totp', secret, issuer, account, algorithm = 'SHA1', digits = 6, period = 30, counter = 0 }) {
  if (!secret) throw fail('auth-invalid-secret', 'Cannot build a URI without a secret');
  const issuerPart = str(issuer).trim();
  const accountPart = str(account).trim();
  const labelPart = `${encodeURIComponent(issuerPart)}${issuerPart ? '%3A' : ''}${encodeURIComponent(accountPart)}`;
  const params = new URLSearchParams();
  params.set('secret', secret);
  if (issuerPart) params.set('issuer', issuerPart);
  if (type === 'hotp') {
    params.set('counter', String(Math.max(0, Math.floor(Number(counter) || 0))));
  } else {
    params.set('algorithm', algorithm);
    params.set('digits', String(digits));
    params.set('period', String(period));
  }
  return `otpauth://${type}/${labelPart}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Lane singleton
// ---------------------------------------------------------------------------

class AuthenticatorService {
  constructor(userDataDir, vaultRef) {
    this.vault = vaultRef;
    this.store = new JSONStore(path.join(userDataDir, 'authenticator.json'), {
      defaults: {
        schemaVersion: 1,
        entries: [],
        historyAccess: { credSet: false, saltB64: null, hashB64: null },
      },
    });
    this.journal = new JSONStore(path.join(userDataDir, 'authenticator-history.json'), {
      defaults: { schemaVersion: 1, seq: 0, entries: [] },
    });
    /** In-memory only; never persisted. */
    this.historyUnlocked = false;
    this.unlockFails = 0;
    this.pruneJournal(false);
  }

  secretId(entryId) {
    return `mr.auth.secret.${entryId}`;
  }

  listEntries() {
    return this.store.get('entries', []);
  }

  saveEntries(entries) {
    this.store.set('entries', entries);
    this.store.save().catch(() => { /* save() already retried; surfaced on next read */ });
  }

  findEntry(id) {
    const entry = this.listEntries().find((e) => e.id === String(id));
    if (!entry) throw fail('auth-entry-not-found', 'That entry no longer exists');
    return entry;
  }

  getSecretB32(id) {
    const b32 = this.vault?.getSecret(this.secretId(String(id)));
    if (!b32) throw fail('auth-secret-missing', 'The secret for this entry is missing from the vault');
    return b32;
  }

  /**
   * Append one journal record. A journal-write failure must never fail the
   * user operation, so this catches and reports through the return value.
   * `extra` carries non-secret structured data (restore snapshots).
   */
  journalAppend(action, target, detail = '', extra = {}) {
    const result = { journaled: true, journalError: null };
    try {
      const seq = Number(this.journal.get('seq', 0)) + 1;
      const entries = this.journal.get('entries', []);
      entries.push({
        seq,
        ts: new Date().toISOString(),
        action,
        target: String(target).slice(0, 200),
        // Detail is metadata-only by construction; callers never pass secrets.
        detail: String(detail).slice(0, 600),
        ...extra,
      });
      this.journal.set('seq', seq);
      this.journal.set('entries', entries);
      this.pruneJournal(false);
      this.journal.save().catch(() => {});
    } catch (err) {
      result.journaled = false;
      result.journalError = err?.message ? String(err.message).slice(0, 200) : 'journal write failed';
    }
    return result;
  }

  pruneJournal(saveAfter = true) {
    const cutoff = Date.now() - JOURNAL_MAX_AGE_DAYS * 86_400_000;
    const entries = this.journal.get('entries', []);
    let trimmed = entries.filter((e) => {
      const t = Date.parse(e.ts);
      return !Number.isNaN(t) ? t >= cutoff : true; // keep undated rows rather than guessing
    });
    if (trimmed.length > JOURNAL_MAX_ENTRIES) trimmed = trimmed.slice(trimmed.length - JOURNAL_MAX_ENTRIES);
    if (trimmed.length !== entries.length) {
      this.journal.set('entries', trimmed);
      if (saveAfter) this.journal.save().catch(() => {});
    }
    return entries.length - trimmed.length;
  }
}

let service = null;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(ctx) {
  service = new AuthenticatorService(app.getPath('userData'), ctx.vault);

  // Handlers land in the frozen IPC registry. ctx may override the sink
  // (harnesses use this); production always passes through ipc.js.
  const H = (name, fn) => (typeof ctx.registerHandler === 'function' ? ctx.registerHandler : registerHandler)('vault', name, fn);

  const publicEntry = (e) => ({
    id: e.id,
    type: e.type,
    issuer: e.issuer,
    account: e.account,
    iconEmoji: e.iconEmoji || '',
    group: e.group || '',
    algorithm: e.algorithm,
    digits: e.digits,
    period: e.period,
    counter: e.counter || 0,
    armed: Boolean(e.armed),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });

  const metaLabel = (e) => `${e.issuer || '?'} · ${e.account || '?'}`;

  // -- listing ---------------------------------------------------------------
  H('auth-list', () => ({
    entries: service.listEntries().map(publicEntry),
    encryptionAvailable: Boolean(service.vault?.encryptionAvailable),
    obfuscationWarned: Boolean(service.vault?.obfuscationWarned),
  }));

  // -- pairing ---------------------------------------------------------------
  // Creating an entry REQUIRES one current code typed back: the code is
  // verified against the submitted parameters before anything persists, so an
  // entry only ever lands armed when its secret demonstrably works.
  H('auth-add', ({ draft, confirmCode }) => {
    const entry = validateDraft(draft);
    const secretBytes = base32Decode(entry.secret);
    if (!verifyAgainstParams(secretBytes, entry, confirmCode)) {
      throw fail('auth-code-mismatch', 'That code did not match. Nothing was saved.');
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      type: entry.type,
      issuer: entry.issuer,
      account: entry.account,
      iconEmoji: entry.iconEmoji || '',
      group: entry.group || '',
      algorithm: entry.algorithm,
      digits: entry.digits,
      period: entry.period,
      counter: entry.counter,
      armed: true,
      createdAt: now,
      updatedAt: now,
    };
    service.vault.setSecret(service.secretId(id), entry.secret);
    const entries = service.listEntries();
    entries.push(record);
    service.saveEntries(entries);
    const j = service.journalAppend('add', metaLabel(record), summarizeDraft(record));
    return { entry: publicEntry(record), journalError: j.journalError };
  });

  // Bulk import starts every entry unarmed; each one is armed individually by
  // typing one current code (auth-confirm), keeping the pairing rule uniform.
  H('auth-import', ({ items }) => {
    if (!Array.isArray(items) || items.length === 0) {
      throw fail('auth-import-empty', 'Nothing to import');
    }
    if (items.length > 200) throw fail('auth-import-too-many', 'Import at most 200 entries at once');
    const now = new Date().toISOString();
    const entries = service.listEntries();
    const added = [];
    for (const item of items) {
      const draft = validateDraft(item);
      const id = crypto.randomUUID();
      const record = {
        id,
        type: draft.type,
        issuer: draft.issuer,
        account: draft.account,
        iconEmoji: draft.iconEmoji || '',
        group: draft.group || '',
        algorithm: draft.algorithm,
        digits: draft.digits,
        period: draft.period,
        counter: draft.counter,
        armed: false,
        createdAt: now,
        updatedAt: now,
      };
      service.vault.setSecret(service.secretId(id), draft.secret);
      entries.push(record);
      added.push(record);
    }
    service.saveEntries(entries);
    const j = service.journalAppend('import',
      `${added.length} ${added.length === 1 ? 'entry' : 'entries'}`,
      added.map(metaLabel).join('; ').slice(0, 600));
    return { addedCount: added.length, added: added.map(publicEntry), journalError: j.journalError };
  });

  // Confirm pairing of an unarmed entry by typing one current code.
  H('auth-confirm', ({ id, code }) => {
    const entry = service.findEntry(String(id));
    const secretBytes = base32Decode(service.getSecretB32(entry.id));
    if (!verifyAgainstParams(secretBytes, entry, code)) {
      throw fail('auth-code-mismatch', 'That code did not match. The entry stays unconfirmed.');
    }
    const entries = service.listEntries();
    const row = entries.find((e) => e.id === entry.id);
    row.armed = true;
    row.updatedAt = new Date().toISOString();
    service.saveEntries(entries);
    const j = service.journalAppend('confirm-pairing', metaLabel(row), '');
    return { entry: publicEntry(row), journalError: j.journalError };
  });

  // -- editing -----------------------------------------------------------------
  H('auth-update', ({ id, patch }) => {
    const found = service.findEntry(String(id));
    const p = patch && typeof patch === 'object' ? patch : {};
    const entries = service.listEntries();
    const row = entries.find((e) => e.id === found.id);
    const beforeFields = pickMeta(row);

    if ('issuer' in p) row.issuer = clampText(p.issuer, 120).trim();
    if ('account' in p) row.account = clampText(p.account, 200).trim();
    if ('iconEmoji' in p) row.iconEmoji = clampText(p.iconEmoji, 8);
    if ('group' in p) row.group = clampText(p.group, 60).trim();

    // Crypto parameters may be corrected, but changing them invalidates a
    // prior pairing, so the entry drops back to unarmed and must be
    // re-confirmed with a fresh current code.
    let recrypto = false;
    if ('algorithm' in p && validAlgorithm(p.algorithm) !== row.algorithm) {
      row.algorithm = validAlgorithm(p.algorithm);
      recrypto = true;
    }
    if ('digits' in p && validDigits(p.digits) !== row.digits) {
      row.digits = validDigits(p.digits);
      recrypto = true;
    }
    if ('period' in p && validPeriod(p.period) !== row.period) {
      row.period = validPeriod(p.period);
      recrypto = true;
    }
    if ('counter' in p && row.type === 'hotp') {
      const c = validCounter(p.counter);
      if (c !== row.counter) { row.counter = c; } // counter moves never unpair
    }
    if (recrypto) row.armed = false;

    row.updatedAt = new Date().toISOString();
    service.saveEntries(entries);
    const changes = diffMeta(beforeFields, pickMeta(row));
    const action = recrypto ? 'rekey' : (changes.includes('issuer:') || changes.includes('account:') ? 'rename' : 'edit');
    const j = service.journalAppend(action, metaLabel(row), changes, {
      snapshot: [{ id: row.id, fields: beforeFields }],
    });
    return { entry: publicEntry(row), recrypto, journalError: j.journalError };
  });

  H('auth-remove', ({ ids }) => {
    const removeIds = (Array.isArray(ids) ? ids : [ids]).map(String);
    if (removeIds.length === 0) throw fail('auth-nothing-selected', 'No entries selected');
    const entries = service.listEntries();
    const removed = [];
    const kept = [];
    for (const e of entries) {
      if (removeIds.includes(e.id)) {
        removed.push(e);
        service.vault.deleteSecret(service.secretId(e.id));
      } else {
        kept.push(e);
      }
    }
    if (removed.length === 0) throw fail('auth-entry-not-found', 'None of the selected entries exist');
    service.saveEntries(kept);
    const j = service.journalAppend('remove',
      removed.map(metaLabel).join('; ').slice(0, 200),
      `${removed.length} removed; secret deleted from vault`,
      // Ids retained so the UI can state plainly that removal is final.
      { removedIds: removed.map((e) => e.id) });
    return { removedCount: removed.length, journalError: j.journalError };
  });

  H('auth-reorder', ({ ids }) => {
    if (!Array.isArray(ids) || ids.length === 0) throw fail('auth-nothing-selected', 'No order supplied');
    const entries = service.listEntries();
    if (ids.length !== entries.length) throw fail('auth-reorder-incomplete', 'Order must include every entry');
    const byId = new Map(entries.map((e) => [e.id, e]));
    const orderedIds = ids.map(String);
    const ordered = orderedIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw fail('auth-entry-not-found', `Unknown entry in supplied order`);
      return row;
    });
    service.saveEntries(ordered);
    const j = service.journalAppend('reorder', `${ordered.length} entries`, 'list order changed', {
      orderSnapshot: entries.map((e) => e.id),
    });
    return { journalError: j.journalError };
  });

  H('auth-group-many', ({ ids, group }) => {
    const target = Array.isArray(ids) ? ids.map(String) : [];
    if (target.length === 0) throw fail('auth-nothing-selected', 'No entries selected');
    const g = clampText(group, 60).trim();
    const entries = service.listEntries();
    const changed = [];
    for (const row of entries) {
      if (target.includes(row.id) && row.group !== g) {
        row.group = g;
        row.updatedAt = new Date().toISOString();
        changed.push(metaLabel(row));
      }
    }
    service.saveEntries(entries);
    const j = service.journalAppend('group-change', changed.join('; ').slice(0, 200) || 'no change', `group set to "${g}"`, {
      snapshot: entries.filter((r) => target.includes(r.id)).map((r) => ({ id: r.id, fields: pickMeta(r) })),
    });
    return { changedCount: changed.length, journalError: j.journalError };
  });

  // -- codes --------------------------------------------------------------------
  H('auth-code', ({ id }) => {
    const entry = service.findEntry(String(id));
    const secretBytes = base32Decode(service.getSecretB32(entry.id));
    const nowSec = Math.floor(Date.now() / 1000);
    if (entry.type === 'hotp') {
      return {
        type: 'hotp',
        code: hotp(secretBytes, entry.counter, entry.algorithm, entry.digits),
        next: hotp(secretBytes, entry.counter + 1, entry.algorithm, entry.digits),
        counter: entry.counter,
        armed: Boolean(entry.armed),
      };
    }
    const counterNow = Math.floor(nowSec / entry.period);
    return {
      type: 'totp',
      code: hotp(secretBytes, counterNow, entry.algorithm, entry.digits),
      next: hotp(secretBytes, counterNow + 1, entry.algorithm, entry.digits),
      secondsRemaining: entry.period - (nowSec % entry.period),
      period: entry.period,
      armed: Boolean(entry.armed),
    };
  });

  // Verify a typed code against an entry WITHOUT changing its armed state.
  H('auth-verify', ({ id, code }) => {
    const entry = service.findEntry(String(id));
    const secretBytes = base32Decode(service.getSecretB32(entry.id));
    return { matched: verifyAgainstParams(secretBytes, entry, code) };
  });

  // -- reveal (QR / grouped base32) ----------------------------------------------
  H('auth-show-secret', ({ id }) => {
    const entry = service.findEntry(String(id));
    const secretB32 = service.getSecretB32(entry.id);
    return {
      uri: buildOtpauthUri({
        type: entry.type,
        secret: secretB32,
        issuer: entry.issuer,
        account: entry.account,
        algorithm: entry.algorithm,
        digits: entry.digits,
        period: entry.period,
        counter: entry.counter,
      }),
      secretB32,
      algorithm: entry.algorithm,
      digits: entry.digits,
      period: entry.period,
      type: entry.type,
      counter: entry.counter,
    };
  });

  // -- authoring helpers -----------------------------------------------------------
  H('auth-parse-uri', ({ text }) => {
    const parsed = parseOtpauthUri(str(text));
    return { draft: draftFromParsed(parsed), uri: buildOtpauthUri(parsed) };
  });

  H('auth-parse-uri-list', ({ text }) => {
    const lines = str(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const drafts = [];
    const errors = [];
    for (const [i, line] of lines.entries()) {
      try {
        drafts.push(draftFromParsed(parseOtpauthUri(line)));
      } catch (err) {
        errors.push(`line ${i + 1}: ${err.message}`);
      }
    }
    return { drafts, errors };
  });

  H('auth-new-secret', () => ({ secretB32: base32Encode(crypto.randomBytes(20)) }));

  H('auth-validate-draft', ({ draft }) => {
    const clean = validateDraft(draft);
    const hasSecret = Boolean(clean.secret);
    const uri = buildOtpauthUri({
      type: clean.type,
      secret: clean.secret,
      issuer: clean.issuer,
      account: clean.account,
      algorithm: clean.algorithm,
      digits: clean.digits,
      period: clean.period,
      counter: clean.counter,
    });
    delete clean.secret;
    return { draft: { ...clean, secretSet: hasSecret }, uri };
  });

  // -- exports ----------------------------------------------------------------------
  // mode 'redacted' (the ordinary export) carries metadata ONLY and states the
  // omission; mode 'full' carries usable secrets and is reached exclusively
  // through the renderer's gated deliberate-secrets action.
  H('auth-export', ({ mode }) => {
    const entries = service.listEntries().map(publicEntry);
    const stamp = new Date().toISOString();
    if (mode === 'full') {
      const full = entries.map((e) => {
        let secret = null;
        let uri = null;
        try {
          secret = service.getSecretB32(e.id);
          uri = buildOtpauthUri({
            type: e.type, secret, issuer: e.issuer, account: e.account,
            algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter,
          });
        } catch { /* entry with missing secret exports as null fields */ }
        return { ...e, secret, uri };
      });
      return {
        exportedAt: stamp,
        kind: 'material-router-authenticator-full',
        WARNING_PLAINTEXT_SECRETS: true,
        note: 'This export contains usable secrets in plain text. Store it carefully.',
        entries: full,
      };
    }
    return {
      exportedAt: stamp,
      kind: 'material-router-authenticator-redacted',
      secretsOmitted: true,
      note: 'Secrets are intentionally omitted from this export; only entry metadata is included.',
      entries,
    };
  });

  // -- append-only mutation journal ---------------------------------------------------
  H('auth-journal-query', ({ fromDay = '', toDay = '', actions = [], limit = 1000 } = {}) => {
    const entries = service.journal.get('entries', []);
    const actionSet = Array.isArray(actions) && actions.length > 0 ? new Set(actions.map(String)) : null;
    const rows = entries.filter((e) => {
      if (actionSet && !actionSet.has(e.action)) return false;
      const day = typeof e.ts === 'string' ? e.ts.slice(0, 10) : '';
      if (fromDay && day < fromDay) return false;
      if (toDay && day > toDay) return false;
      return true;
    });
    const capped = rows.slice(-Math.max(1, Math.min(Number(limit) || 1000, JOURNAL_MAX_ENTRIES)));
    return {
      rows: capped,
      total: entries.length,
      matched: rows.length,
      truncated: rows.length - capped.length,
      retention: { maxEntries: JOURNAL_MAX_ENTRIES, maxAgeDays: JOURNAL_MAX_AGE_DAYS },
    };
  });

  H('auth-journal-status', () => {
    const entries = service.journal.get('entries', []);
    const access = service.store.get('historyAccess', {});
    return {
      count: entries.length,
      oldestTs: entries.length ? entries[0].ts : null,
      newestTs: entries.length ? entries[entries.length - 1].ts : null,
      credSet: Boolean(access.credSet),
      unlocked: service.historyUnlocked,
      retention: { maxEntries: JOURNAL_MAX_ENTRIES, maxAgeDays: JOURNAL_MAX_AGE_DAYS },
    };
  });

  // Restore a metadata change recorded in the journal. Removals are honestly
  // NOT restorable: recovering a removed entry would require its secret, and
  // secrets are never written to the journal.
  H('auth-journal-restore', ({ seq }) => {
    const journalRows = service.journal.get('entries', []);
    const rec = journalRows.find((e) => e.seq === Number(seq));
    if (!rec) throw fail('auth-journal-not-found', 'No journal entry with that sequence number');

    if (rec.action === 'reorder' && Array.isArray(rec.orderSnapshot)) {
      const current = service.listEntries();
      const byId = new Map(current.map((e) => [e.id, e]));
      const wanted = rec.orderSnapshot.filter((id) => byId.has(id));
      if (wanted.length !== current.length) {
        throw fail('auth-not-restorable', 'Entries were added or removed since; the old order no longer applies');
      }
      service.saveEntries(wanted.map((id) => byId.get(id)));
      const j = service.journalAppend('restore', rec.target, `restored list order from journal record ${rec.seq}`);
      return { restored: 'order', journalError: j.journalError };
    }

    if (RESTORABLE_ACTIONS.includes(rec.action) && Array.isArray(rec.snapshot)) {
      const current = service.listEntries();
      const byId = new Map(current.map((e) => [e.id, e]));
      let applied = 0;
      for (const snap of rec.snapshot) {
        const row = byId.get(snap?.id);
        if (!row) continue; // entry was removed later; nothing to restore into
        const clean = sanitizeMetaFields(snap.fields);
        // Restoring crypto parameters invalidates whatever pairing the entry
        // currently holds, so it drops back to unarmed for a fresh confirm.
        const cryptoTouched = ['algorithm', 'digits', 'period', 'counter']
          .some((f) => f in clean && clean[f] !== row[f]);
        Object.assign(row, clean);
        if (cryptoTouched) row.armed = false;
        row.updatedAt = new Date().toISOString();
        applied += 1;
      }
      if (applied === 0) throw fail('auth-not-restorable', 'The affected entries no longer exist');
      service.saveEntries(current);
      const j = service.journalAppend('restore', rec.target, `restored ${applied} ${applied === 1 ? 'entry' : 'entries'} from journal record ${rec.seq}`);
      return { restored: applied, journalError: j.journalError };
    }

    throw fail('auth-not-restorable',
      rec.action === 'remove'
        ? 'Removed entries cannot be recovered from the journal because their secret was deleted with them'
        : 'Only edits, renames and order changes can be restored from the journal');
  });

  // -- history-manager credential ------------------------------------------------------
  H('auth-history-set-password', ({ oldPassword, newPassword }) => {
    const access = service.store.get('historyAccess', { credSet: false });
    const newPw = String(newPassword ?? '');
    if (newPw.length < 4) throw fail('auth-password-short', 'Use at least 4 characters for the history password');
    if (access.credSet) {
      const ok = verifySecret(String(oldPassword ?? ''), access.saltB64, access.hashB64);
      if (!ok) throw fail('auth-password-wrong', 'Current history password did not match');
    }
    const { hashB64, saltB64 } = hashSecret(newPw);
    service.store.set('historyAccess', { credSet: true, saltB64, hashB64 });
    service.store.save().catch(() => {});
    service.historyUnlocked = true;
    service.unlockFails = 0;
    const j = service.journalAppend('history-password-change', 'mutation journal access',
      access.credSet ? 'password changed' : 'password set');
    return { journalError: j.journalError };
  });

  H('auth-history-unlock', ({ password }) => {
    const access = service.store.get('historyAccess', { credSet: false });
    if (!access.credSet) throw fail('auth-no-credential', 'No history password is set yet');
    if (service.unlockFails >= 3) {
      // Small bounded delay after repeated failures; honest friction, not
      // punitive, and this surface is a convenience lock by design.
      sleepSync(UNLOCK_FAIL_DELAY_MS * Math.min(service.unlockFails, 10));
    }
    const ok = verifySecret(String(password ?? ''), access.saltB64, access.hashB64);
    if (!ok) {
      service.unlockFails += 1;
      throw fail('auth-password-wrong', 'That password did not match');
    }
    service.unlockFails = 0;
    service.historyUnlocked = true;
    return { unlocked: true };
  });

  H('auth-history-lock', () => {
    service.historyUnlocked = false;
    return { unlocked: false };
  });

  H('auth-journal-prune', () => {
    const removed = service.pruneJournal(false);
    service.journal.save().catch(() => {});
    const j = service.journalAppend('prune', 'mutation journal', `${removed} aged records dropped by retention policy`);
    return { removed, journalError: j.journalError };
  });
}

// ---------------------------------------------------------------------------
// Helpers shared by the handlers above
// ---------------------------------------------------------------------------

function draftFromParsed(parsed) {
  return {
    type: parsed.type,
    secret: parsed.secret,
    issuer: parsed.issuer,
    account: parsed.account,
    iconEmoji: suggestEmoji(parsed.issuer),
    group: '',
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    period: parsed.period,
    counter: parsed.counter,
  };
}

const META_FIELDS = ['issuer', 'account', 'iconEmoji', 'group', 'algorithm', 'digits', 'period', 'counter'];

function pickMeta(entry) {
  const out = {};
  for (const f of META_FIELDS) out[f] = entry[f];
  out.armed = Boolean(entry.armed);
  return out;
}

/** Journal snapshots are trusted only after clamping back to valid ranges. */
function sanitizeMetaFields(fields) {
  const src = fields && typeof fields === 'object' ? fields : {};
  const out = {};
  if ('issuer' in src) out.issuer = clampText(src.issuer, 120).trim();
  if ('account' in src) out.account = clampText(src.account, 200).trim();
  if ('iconEmoji' in src) out.iconEmoji = clampText(src.iconEmoji, 8);
  if ('group' in src) out.group = clampText(src.group, 60).trim();
  if ('algorithm' in src) { try { out.algorithm = validAlgorithm(src.algorithm); } catch { /* keep current */ } }
  if ('digits' in src) { try { out.digits = validDigits(src.digits); } catch { /* keep current */ } }
  if ('period' in src) { try { out.period = validPeriod(src.period); } catch { /* keep current */ } }
  if ('counter' in src) { try { out.counter = validCounter(src.counter); } catch { /* keep current */ } }
  return out;
}

function suggestEmoji(issuer) {
  const s = String(issuer || '').toLowerCase();
  if (/mail|gmail|outlook|proton/.test(s)) return '✉️';
  if (/git|hub|lab/.test(s)) return '🐙';
  if (/bank|pay|financ|money/.test(s)) return '💳';
  if (/cloud|aws|azure|google/.test(s)) return '☁️';
  if (/game|steam|play/.test(s)) return '🎮';
  return '🔐';
}

function clampText(v, max) {
  return String(v ?? '').slice(0, max);
}

function validAlgorithm(v) {
  const a = String(v ?? '').toUpperCase();
  if (!ALGORITHMS.includes(a)) throw fail('auth-invalid-algorithm', `Algorithm must be one of ${ALGORITHMS.join(', ')}`);
  return a;
}

function validDigits(v) {
  const n = Number(v);
  if (!DIGITS_ALLOWED.includes(n)) throw fail('auth-invalid-digits', 'Digits must be 6, 7 or 8');
  return n;
}

function validPeriod(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < PERIOD_MIN || n > PERIOD_MAX) {
    throw fail('auth-invalid-period', `Period must be a whole number between ${PERIOD_MIN} and ${PERIOD_MAX} seconds`);
  }
  return n;
}

function validCounter(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw fail('auth-invalid-counter', 'Counter must be a whole number of 0 or more');
  return n;
}

function validType(v) {
  const t = String(v ?? 'totp').toLowerCase();
  if (t !== 'totp' && t !== 'hotp') throw fail('auth-invalid-type', 'Type must be totp or hotp');
  return t;
}

/** Full validation for a submitted draft (add/import). Returns a clean copy. */
function validateDraft(draft) {
  if (!draft || typeof draft !== 'object') throw fail('auth-invalid-draft', 'An entry draft is required');
  const type = validType(draft.type);
  return {
    type,
    secret: normalizeSecret(draft.secret),
    issuer: clampText(draft.issuer, 120).trim(),
    account: clampText(draft.account, 200).trim(),
    iconEmoji: clampText(draft.iconEmoji, 8),
    group: clampText(draft.group, 60).trim(),
    algorithm: validAlgorithm(draft.algorithm || 'SHA1'),
    digits: validDigits(draft.digits ?? 6),
    period: validPeriod(draft.period ?? 30),
    counter: type === 'hotp' ? validCounter(draft.counter ?? 0) : 0,
  };
}

function verifyAgainstParams(secretBytes, paramsLike, code) {
  const given = String(code ?? '').replace(/\s+/g, '');
  if (!given) return false;
  if (paramsLike.type === 'hotp') {
    return hotpMatches(secretBytes, Number(paramsLike.counter) || 0, paramsLike.algorithm, paramsLike.digits, given);
  }
  return totpMatches(secretBytes, paramsLike, given);
}

/** Human-readable, secret-free summary used as journal detail on add. */
function summarizeDraft(entry) {
  const parts = [entry.type.toUpperCase(), entry.algorithm, `${entry.digits} digits`];
  if (entry.type === 'totp') parts.push(`${entry.period}s period`);
  else parts.push(`counter ${entry.counter}`);
  return parts.join(', ');
}

function diffMeta(before, after) {
  const changes = [];
  for (const f of ['issuer', 'account', 'group', 'iconEmoji', 'algorithm', 'digits', 'period', 'counter']) {
    const b = String(before[f] ?? '');
    const a = String(after[f] ?? '');
    if (b !== a) changes.push(`${f}: ${b || '(empty)'} -> ${a || '(empty)'}`);
  }
  if (Boolean(before.armed) !== Boolean(after.armed)) {
    changes.push(`paired: ${before.armed ? 'yes' : 'no'} -> ${after.armed ? 'yes' : 'no'}`);
  }
  return changes.join('; ');
}
