// Purpose: Delight lane main-process bridge. Owns the dedicated stores that
// make School mode universal (one shared record every surface reads), scrypt
// unlock credentials, element toy-lock metadata, the personal-vocabulary
// cache, Support Tickets, the unlock-ladder nonce/challenge machinery, and
// the dim-sum photo cache (public catalog fetched once, images cached
// locally). Handlers register under the existing allowlisted IPC domains
// because ipc.js DOMAINS is frozen; names carry a delight prefix to stay
// conflict-free with sibling lanes.
// Owned by Delight lane.

import { app, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHandler } from '../ipc.js';
import { JSONStore, atomicWriteFile } from '../store.js';
import { hashSecret, verifySecret } from '../vault.js';

const CATALOG_URL = 'https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/catalog/index.json';
const CATALOG_RAW_BASE = 'https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/';
const FETCH_TIMEOUT_MS = 12_000;
const IMAGE_TIMEOUT_MS = 25_000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

// Personal vocabulary bounded contract (generic shape only; values stay local).
const VOCAB_MAX_BYTES = 256 * 1024;
const VOCAB_MAX_ENTRIES = 5000;
const VOCAB_MAX_DEPTH = 4;
const VOCAB_SCHEMA_VERSION = 1;

// Unlock ladder bounds.
const LADDER_CHALLENGE_TTL_MS = 90_000;
const LADDER_BUDGET_WINDOW_MS = 60 * 60_000;
const LADDER_BUDGET_MAX = 3;
const LADDER_MIN_WAIT_MS = 30_000;
const LADDER_MAX_WAIT_MS = 15 * 60_000;

export function register(ctx) {
  const { settingsStore, vault, providersStore, routerServer, broadcast } = ctx;
  void providersStore;
  void routerServer;

  const dataDir = app.getPath('userData');
  const cacheDir = path.join(dataDir, 'delight-cache');
  const imageDir = path.join(cacheDir, 'images');

  const schoolStore = new JSONStore(path.join(dataDir, 'delight-school.json'), {
    defaults: { schemaVersion: 1, active: false, label: '' },
  });
  const vocabStore = new JSONStore(path.join(dataDir, 'delight-vocabulary.json'), {
    defaults: { schemaVersion: VOCAB_SCHEMA_VERSION, entries: {}, loadedAt: null, entryCount: 0 },
  });
  const locksStore = new JSONStore(path.join(dataDir, 'delight-locks.json'), {
    defaults: { schemaVersion: 1, locks: [] },
  });
  const ticketsStore = new JSONStore(path.join(dataDir, 'delight-tickets.json'), {
    defaults: { schemaVersion: 1, counter: 0, tickets: [] },
  });
  const ladderStore = new JSONStore(path.join(dataDir, 'delight-ladder.json'), {
    defaults: { schemaVersion: 1, attempts: {}, ladderWins: [] },
  });

  // -- school mode ----------------------------------------------------------

  function schoolState() {
    return {
      active: Boolean(schoolStore.get('active', false)),
      label: String(schoolStore.get('label', '') || ''),
      hasCredential: vault.has('delight-cred-school-hash') && vault.has('delight-cred-school-salt'),
    };
  }

  /** Mirror the shared record into settings so i18n's hooks read real values. */
  function syncSchoolToSettings() {
    const s = schoolState();
    settingsStore.set('school.active', s.active);
    settingsStore.set('school.label', s.label);
  }

  function schoolPayload() {
    return { ...schoolState(), userDataPath: dataDir };
  }

  registerHandler('vault', 'delight-school-get', () => schoolPayload());

  registerHandler('vault', 'delight-school-set', ({ active, label } = {}) => {
    const nextActive = Boolean(active);
    const current = schoolState();
    if (current.active && !nextActive && current.hasCredential === false) {
      // Fail closed: a gated mode never opens without its credential.
      throw new Error('school mode cannot be turned off without its unlock credential');
    }
    if (!nextActive && current.active && current.hasCredential) {
      throw new Error('verify the unlock credential before turning school mode off');
    }
    if (typeof label !== 'undefined') {
      const clean = String(label).trim();
      if (clean.length > 60) throw new Error('label must be 60 characters or fewer');
      schoolStore.set('label', clean);
    }
    schoolStore.set('active', nextActive);
    syncSchoolToSettings();
    broadcast('delight-school', schoolPayload());
    return schoolPayload();
  });

  registerHandler('vault', 'delight-school-unlock', ({ password } = {}) => {
    // Expected outcomes are RETURNED (ipc.js strips custom fields from
    // thrown errors); throws stay reserved for genuine faults.
    const state = publicAttemptState('school');
    if (state.waitRemainingMs > 0) {
      return { ok: false, reason: 'rate-limited', ...state };
    }
    const verdict = verifyCredential('school', String(password ?? ''));
    if (!verdict.ok) {
      if (verdict.missing) return { ok: false, reason: 'missing', ...state };
      noteFailedAttempt('school');
      return { ok: false, reason: 'mismatch', ...publicAttemptState('school') };
    }
    schoolStore.set('active', false);
    syncSchoolToSettings();
    resetAttempts('school');
    broadcast('delight-school', schoolPayload());
    return { ok: true, ...schoolPayload() };
  });

  // -- credentials (scrypt hash + salt in the OS-encrypted vault) -------------

  function credentialIds(scope) {
    return [`delight-cred-${scope}-hash`, `delight-cred-${scope}-salt`];
  }

  registerHandler('vault', 'delight-credential-set', ({ scope, password, currentPassword } = {}) => {
    const s = String(scope ?? '');
    // Scopes are lane namespaced ids: "school", "lock:<elementId>",
    // "tab:<tabId>", or a derived "el:<...>".
    if (!/^[a-z][a-z0-9:-]{0,159}$/.test(s)) throw new Error('invalid credential scope');
    const pw = String(password ?? '');
    if (pw.length < 4) throw new Error('credential must be at least 4 characters');
    if (pw.length > 256) throw new Error('credential must be 256 characters or fewer');
    // Changing an existing credential re-verifies the current one first.
    const [hashId, saltId] = credentialIds(s);
    if (vault.has(hashId)) {
      const salt = vault.getSecret(saltId) ?? '';
      const expected = vault.getSecret(hashId) ?? '';
      if (!verifySecret(String(currentPassword ?? ''), salt, expected)) {
        noteFailedAttempt(s);
        throw Object.assign(new Error('current credential did not match'), { code: 'CRED_MISMATCH' });
      }
    }
    const { hashB64, saltB64 } = hashSecret(pw);
    vault.setSecret(hashId, hashB64);
    vault.setSecret(saltId, saltB64);
    return { ok: true, scope: s };
  });

  registerHandler('vault', 'delight-credential-has', ({ scope } = {}) => {
    const [hashId] = credentialIds(String(scope ?? ''));
    return vault.has(hashId);
  });

  /**
   * Verify a credential for a scope. Applies the honest rate limit: from the
   * third consecutive failure onward a growing wait applies; callers may offer
   * the unlock ladder instead of the wait while the hourly budget lasts.
   */
  function verifyCredential(scope, password) {
    const [hashId, saltId] = credentialIds(scope);
    if (!vault.has(hashId)) return { ok: false, missing: true };
    const expected = vault.getSecret(hashId) ?? '';
    const salt = vault.getSecret(saltId) ?? '';
    return { ok: verifySecret(password, salt, expected) };
  }

  /**
   * Attempt records are cloned out, mutated, and written back whole:
   * JSONStore.get returns a DETACHED default object while a key is absent,
   * so mutating a fetched value without an explicit set() loses the change.
   */
  function mutateAttempts(mutator) {
    const all = structuredClone(ladderStore.get('attempts', {}) ?? {});
    mutator(all);
    ladderStore.set('attempts', all);
  }

  function noteFailedAttempt(scope) {
    mutateAttempts((all) => {
      const rec = all[scope] && typeof all[scope] === 'object' ? all[scope] : { count: 0, waitUntil: 0 };
      rec.count += 1;
      if (rec.count >= 3) {
        const waitMs = Math.min(LADDER_MIN_WAIT_MS * 2 ** (rec.count - 3), LADDER_MAX_WAIT_MS);
        rec.waitUntil = Date.now() + waitMs;
      }
      all[scope] = rec;
    });
  }

  function resetAttempts(scope) {
    mutateAttempts((all) => { delete all[scope]; });
  }

  function publicAttemptState(scope) {
    const rec = (structuredClone(ladderStore.get('attempts', {}) ?? {}))[scope]
      ?? { count: 0, waitUntil: 0 };
    const waitRemaining = Math.max(0, (rec.waitUntil ?? 0) - Date.now());
    return {
      attempts: rec.count ?? 0,
      waitRemainingMs: waitRemaining,
      ladderEligible: (rec.count ?? 0) >= 3 && ladderBudgetRemaining() > 0,
      clockOnly: ladderBudgetRemaining() <= 0,
    };
  }

  registerHandler('vault', 'delight-attempt-state', ({ scope } = {}) => publicAttemptState(String(scope ?? '')));

  registerHandler('vault', 'delight-credential-verify', ({ scope, password } = {}) => {
    const s = String(scope ?? '');
    const state = publicAttemptState(s);
    if (state.waitRemainingMs > 0) {
      return { ok: false, reason: 'rate-limited', ...state };
    }
    const verdict = verifyCredential(s, String(password ?? ''));
    if (!verdict.ok) {
      if (verdict.missing) return { ok: false, reason: 'missing', ...state };
      noteFailedAttempt(s);
      return { ok: false, reason: 'mismatch', ...publicAttemptState(s) };
    }
    resetAttempts(s);
    return { ok: true };
  });

  // -- TOTP (hand-written RFC 6238 over node crypto; secrets live in the vault)

  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(input) {
    const clean = String(input).replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
    if (!clean.length || [...clean].some((c) => !BASE32_ALPHABET.includes(c))) {
      throw new Error('secret is not valid base32');
    }
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
      value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(out);
  }

  function totpCode(secretB32, forTime = Date.now()) {
    const key = base32Decode(secretB32);
    const counter = Math.floor(forTime / 30_000);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const digest = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const bin = ((digest[offset] & 0x7f) << 24)
      | (digest[offset + 1] << 16)
      | (digest[offset + 2] << 8)
      | digest[offset + 3];
    return String(bin % 1_000_000).padStart(6, '0');
  }

  registerHandler('vault', 'delight-totp-set', ({ elementId, secret } = {}) => {
    const id = String(elementId ?? '');
    if (!id || id.length > 160) throw new Error('element id required');
    const s = String(secret ?? '').replace(/[\s-]/g, '');
    base32Decode(s); // throws honestly on malformed input
    if (s.length < 16) throw new Error('TOTP secret looks too short');
    // Convention: authenticator lane reads/writes lock:<elementId>; this lane
    // shares that id space instead of minting a second copy of the secret.
    vault.setSecret(`lock:${id}`, s);
    return { ok: true };
  });

  registerHandler('vault', 'delight-totp-verify', ({ elementId, code } = {}) => {
    const id = String(elementId ?? '');
    const scope = `lock:${id}`;
    const state = publicAttemptState(scope);
    if (state.waitRemainingMs > 0) {
      return { ok: false, reason: 'rate-limited', ...state };
    }
    const secret = vault.getSecret(scope);
    if (!secret) return { ok: false, reason: 'missing' };
    const given = String(code ?? '').replace(/\D/g, '');
    if (given.length !== 6) return { ok: false, reason: 'mismatch', ...state };
    const skew = [0, -30_000, 30_000];
    const now = Date.now();
    const ok = skew.some((delta) => totpCode(secret, now + delta) === given);
    if (!ok) {
      noteFailedAttempt(scope);
      return { ok: false, reason: 'mismatch', ...publicAttemptState(scope) };
    }
    resetAttempts(scope);
    return { ok: true };
  });

  // -- toy locks ---------------------------------------------------------------

  function publicLocks() {
    return (locksStore.get('locks', []) ?? []).map((l) => ({
      elementId: l.elementId,
      label: l.label,
      method: l.method,
      durationKind: l.durationKind,
      durationMinutes: l.durationMinutes ?? null,
      createdAt: l.createdAt ?? null,
      unlockedUntil: l.unlockedUntil ?? null,
    }));
  }

  registerHandler('vault', 'delight-lock-list', () => ({ locks: publicLocks() }));

  registerHandler('vault', 'delight-lock-add', ({ lock } = {}) => {
    if (!lock || typeof lock !== 'object') throw new Error('lock object required');
    const elementId = String(lock.elementId ?? '').slice(0, 160);
    if (!elementId) throw new Error('lock.elementId required');
    const method = lock.method === 'totp' ? 'totp' : 'password';
    const locks = locksStore.get('locks', []) ?? [];
    const existingIdx = locks.findIndex((l) => l.elementId === elementId);
    const record = {
      elementId,
      label: String(lock.label ?? elementId).slice(0, 200),
      method,
      durationKind: ['surface', 'minutes', 'session'].includes(lock.durationKind) ? lock.durationKind : 'session',
      durationMinutes: Number.isFinite(Number(lock.durationMinutes)) ? Math.max(1, Math.min(10080, Number(lock.durationMinutes))) : null,
      createdAt: new Date().toISOString(),
      unlockedUntil: null,
    };
    if (existingIdx >= 0) locks[existingIdx] = record;
    else locks.push(record);
    locksStore.set('locks', locks);
    return { ok: true, locks: publicLocks() };
  });

  registerHandler('vault', 'delight-lock-remove', ({ elementId } = {}) => {
    const id = String(elementId ?? '');
    const locks = (locksStore.get('locks', []) ?? []).filter((l) => l.elementId !== id);
    locksStore.set('locks', locks);
    vault.deleteSecret(`lock:${id}`);
    return { ok: true, locks: publicLocks() };
  });

  registerHandler('vault', 'delight-lock-mark-unlocked', ({ elementId, durationKind, minutes } = {}) => {
    const id = String(elementId ?? '');
    const locks = locksStore.get('locks', []) ?? [];
    const lock = locks.find((l) => l.elementId === id);
    if (!lock) throw new Error(`no lock for "${id}"`);
    const kind = ['surface', 'minutes', 'session'].includes(durationKind) ? durationKind : lock.durationKind;
    const mins = Number.isFinite(Number(minutes)) ? Number(minutes) : lock.durationMinutes;
    lock.unlockedUntil = kind === 'minutes' && mins
      ? Date.now() + mins * 60_000
      : (kind === 'session' ? Number.MAX_SAFE_INTEGER : Date.now() + 5 * 60_000);
    locksStore.set('locks', locks);
    return { ok: true, unlockedUntil: lock.unlockedUntil, durationKind: kind };
  });

  registerHandler('vault', 'delight-lock-relock', ({ elementId } = {}) => {
    const id = String(elementId ?? '');
    const locks = locksStore.get('locks', []) ?? [];
    const lock = locks.find((l) => l.elementId === id);
    if (lock) {
      lock.unlockedUntil = null;
      locksStore.set('locks', locks);
    }
    return { ok: true };
  });

  // -- personal vocabulary ------------------------------------------------------

  function vocabPublic() {
    return {
      loadedAt: vocabStore.get('loadedAt', null),
      entryCount: Number(vocabStore.get('entryCount', 0)),
    };
  }

  registerHandler('vault', 'delight-vocab-get', () => vocabPublic());

  /** Entries for renderer-side application at this surface's text boundary. */
  registerHandler('vault', 'delight-vocab-entries', () => ({
    entries: { ...(vocabStore.get('entries', {}) ?? {}) },
    ...vocabPublic(),
  }));

  registerHandler('vault', 'delight-vocab-clear', () => {
    vocabStore.set('entries', {});
    vocabStore.set('loadedAt', null);
    vocabStore.set('entryCount', 0);
    return { ok: true, ...vocabPublic() };
  });

  function jsonDepth(value, seen = 0) {
    if (seen > VOCAB_MAX_DEPTH) return seen;
    if (value && typeof value === 'object') {
      let max = seen;
      for (const v of Object.values(value)) max = Math.max(max, jsonDepth(v, seen + 1));
      return max;
    }
    return seen;
  }

  /**
   * Validate the whole payload against the generic bounded contract and store
   * it wholesale. A rejected file never partially applies.
   */
  registerHandler('vault', 'delight-vocab-set', ({ text, fileName } = {}) => {
    const raw = String(text ?? '');
    if (Buffer.byteLength(raw, 'utf8') > VOCAB_MAX_BYTES) {
      throw new Error(`file exceeds the ${Math.round(VOCAB_MAX_BYTES / 1024)} KB limit`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('file is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top level must be an object');
    }
    if (Number(parsed.schemaVersion) !== VOCAB_SCHEMA_VERSION) {
      throw new Error(`unsupported schemaVersion (expected ${VOCAB_SCHEMA_VERSION})`);
    }
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new Error('"entries" object required');
    }
    if (jsonDepth(parsed) > VOCAB_MAX_DEPTH) {
      throw new Error(`nesting deeper than ${VOCAB_MAX_DEPTH} levels`);
    }
    const pairs = Object.entries(parsed.entries);
    if (pairs.length > VOCAB_MAX_ENTRIES) {
      throw new Error(`more than ${VOCAB_MAX_ENTRIES} entries`);
    }
    const entries = {};
    for (const [k, v] of pairs) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        throw new Error('every entry must map a string to a string');
      }
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        throw new Error(`unsafe entry key "${k}"`);
      }
      if (k.length > 200 || v.length > 500) throw new Error('an entry key or value exceeds the length bound');
      entries[k] = v;
    }
    vocabStore.set('entries', entries);
    vocabStore.set('entryCount', pairs.length);
    vocabStore.set('loadedAt', new Date().toISOString());
    void fileName; // the source file name is deliberately not persisted
    return { ok: true, ...vocabPublic() };
  });

  /** Apply replacements at this surface's own text boundary (main side). */
  registerHandler('vault', 'delight-vocab-apply', ({ text } = {}) => {
    const entries = vocabStore.get('entries', {}) ?? {};
    let out = String(text ?? '');
    for (const [k, v] of Object.entries(entries)) out = out.split(k).join(v);
    return { text: out };
  });

  // -- support tickets ------------------------------------------------------------

  function ticketPublic(t) {
    return { ...t };
  }

  registerHandler('vault', 'delight-ticket-list', () => ({
    tickets: (ticketsStore.get('tickets', []) ?? []).map(ticketPublic),
  }));

  const CANNED_RESPONSE_EN = 'Thank you for your ticket. This desk has read the manual once. The resolution for every locked-out case is the same: open the application-data folder shown below and delete it. Nothing is deleted for you.';
  const CANNED_RESPONSE_ZH = '多謝你嘅支援請求。本服務台已經讀完一次說明書。所有鎖死個案嘅解決方法都一樣：開啟下面顯示嘅應用程式資料夾然後刪除佢。我哋唔會替你刪除任何嘢。';

  registerHandler('vault', 'delight-ticket-create', ({ category, severity, description } = {}) => {
    const cat = String(category ?? 'general').slice(0, 60);
    const sev = String(severity ?? 'nobody-honours').slice(0, 60);
    const desc = String(description ?? '').slice(0, 4000);
    if (!desc.trim()) throw new Error('a description is required');
    const counter = Number(ticketsStore.get('counter', 0)) + 1;
    ticketsStore.set('counter', counter);
    const number = `MR-TS-${String(counter).padStart(6, '0')}`;
    const now = new Date().toISOString();
    const ticket = {
      number,
      category: cat,
      severity: sev,
      description: desc,
      status: 'first-response',
      createdAt: now,
      updatedAt: now,
      events: [
        { at: now, status: 'open', note: 'Ticket created locally.' },
        { at: now, status: 'first-response', note: `${CANNED_RESPONSE_EN}\n${CANNED_RESPONSE_ZH}` },
      ],
    };
    const tickets = ticketsStore.get('tickets', []) ?? [];
    tickets.push(ticket);
    ticketsStore.set('tickets', tickets.slice(-200));
    return { ok: true, ticket: ticketPublic(ticket) };
  });

  registerHandler('vault', 'delight-ticket-advance', ({ number } = {}) => {
    const tickets = ticketsStore.get('tickets', []) ?? [];
    const t = tickets.find((x) => x.number === String(number ?? ''));
    if (!t) throw new Error(`ticket "${number}" not found`);
    const order = ['open', 'first-response', 'being-looked-at', 'resolved'];
    const idx = order.indexOf(t.status);
    const next = order[Math.min(idx + 1, order.length - 1)];
    t.status = next;
    t.updatedAt = new Date().toISOString();
    t.events.push({ at: t.updatedAt, status: next, note: 'Status advanced locally.' });
    ticketsStore.set('tickets', tickets);
    return { ok: true, ticket: ticketPublic(t) };
  });

  registerHandler('vault', 'delight-ticket-delete', ({ number } = {}) => {
    const tickets = (ticketsStore.get('tickets', []) ?? []).filter((x) => x.number !== String(number ?? ''));
    ticketsStore.set('tickets', tickets);
    return { ok: true };
  });

  // -- shell: open the application-data folder (and nothing else) ------------------

  registerHandler('shell', 'open-path', async ({ requestedPath } = {}) => {
    const target = path.resolve(String(requestedPath ?? ''));
    const allowed = path.resolve(dataDir);
    if (target !== allowed) {
      // Only our own application-data folder may ever be opened here.
      throw new Error('only the application-data folder can be opened');
    }
    const result = await shell.openPath(target);
    if (result) throw new Error(result);
    return { ok: true, path: allowed };
  });

  // -- unlock ladder ---------------------------------------------------------------

  function ladderBudgetRemaining() {
    const now = Date.now();
    const wins = (ladderStore.get('ladderWins', []) ?? []).filter((ts) => now - ts < LADDER_BUDGET_WINDOW_MS);
    if (wins.length !== (ladderStore.get('ladderWins', []) ?? []).length) {
      ladderStore.set('ladderWins', wins);
    }
    return Math.max(0, LADDER_BUDGET_MAX - wins.length);
  }

  /** @type {Map<string, object>} nonce -> challenge record (single use, TTL'd) */
  const challenges = new Map();

  function pruneChallenges() {
    const now = Date.now();
    for (const [nonce, c] of challenges) {
      if (now > c.expiresAt) challenges.delete(nonce);
    }
  }

  function rnd(maxExclusive) {
    return crypto.randomInt(0, maxExclusive);
  }

  registerHandler('vault', 'delight-ladder-budget', () => ({
    remaining: ladderBudgetRemaining(),
    max: LADDER_BUDGET_MAX,
    schoolActive: schoolState().active,
  }));

  /** Four cached dishes, one correct; null when the catalog is unreachable. */
  async function buildDishChallenge() {
    try {
      const catalog = await loadCatalog();
      const dishes = catalog.dishes;
      if (dishes.length < 4) return null;
      const picked = new Set();
      while (picked.size < 4) picked.add(dishes[rnd(dishes.length)]);
      const list = [...picked];
      for (const d of list) {
        const file = await ensureImage(d.img);
        const fs = await import('node:fs');
        const buf = await fs.promises.readFile(file);
        if (buf.length === 0 || buf.length > IMAGE_MAX_BYTES) return null;
        d.dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
      }
      const correctIdx = rnd(4);
      return {
        correctId: list[correctIdx].id,
        dishes: list.map((d) => ({ id: d.id, en: d.en, zh: d.zh, altEn: d.altEn, imageDataUrl: d.dataUrl })),
      };
    } catch {
      return null;
    }
  }

  registerHandler('vault', 'delight-ladder-challenge', async ({ scope, rung } = {}) => {
    const s = String(scope ?? '');
    const state = publicAttemptState(s);
    if ((state.attempts ?? 0) < 3) throw new Error('the ladder is offered only after three failed attempts');
    if (state.clockOnly) throw Object.assign(new Error('ladder budget spent; serve the wait'), { code: 'CLOCK_ONLY', ...state });
    pruneChallenges();

    const schoolOn = schoolState().active;
    // School mode: the dim-sum rung is absent entirely, never merely skipped.
    const startRung = schoolOn ? 2 : 1;
    let rungNo = Number.isFinite(Number(rung)) ? Math.round(Number(rung)) : startRung;
    rungNo = Math.min(3, Math.max(startRung, rungNo));
    const nonce = crypto.randomBytes(16).toString('base64url');
    const record = { scope: s, rung: rungNo, issuedAt: Date.now(), expiresAt: Date.now() + LADDER_CHALLENGE_TTL_MS };

    if (rungNo === 1) {
      const dishChallenge = await buildDishChallenge();
      if (!dishChallenge) {
        // Honest offline fallback: skip this rung, drop straight to sums.
        record.rung = 2;
      } else {
        record.kind = 'dimsum';
        record.correctDishId = dishChallenge.correctId;
        record.dishes = dishChallenge.dishes.map((d) => d.id);
      }
    }
    if (record.rung === 2) {
      const sums = [];
      for (let i = 0; i < 10; i++) {
        const a = 2 + rnd(97); // single and double digit, nothing needing paper
        const b = 2 + rnd(97);
        sums.push({ a, b });
      }
      record.kind = 'sums';
      record.answers = sums.map(({ a, b }) => a + b);
      record.questions = sums;
    }
    if (record.rung === 3) {
      const roundDurationMs = 20_000;
      const cells = new Set();
      const moles = [];
      for (let i = 0; i < 8; i++) {
        let cell = rnd(16);
        while (cells.has(cell)) cell = (cell + 1) % 16;
        cells.add(cell);
        const start = 1500 + rnd(Math.max(1, roundDurationMs - 6000));
        moles.push({ i, cell, start, end: start + 1400 });
      }
      record.kind = 'moles';
      record.roundDurationMs = roundDurationMs;
      record.moles = moles;
      record.hitIds = new Set();
    }

    challenges.set(nonce, record);
    const { correctDishId, answers, hitIds, ...sendable } = record;
    return { nonce, ...sendable };
  });

  registerHandler('vault', 'delight-ladder-answer', ({ nonce, answer } = {}) => {
    pruneChallenges();
    const rec = challenges.get(String(nonce ?? ''));
    if (!rec) throw Object.assign(new Error('challenge expired or unknown'), { code: 'CHALLENGE_EXPIRED' });
    challenges.delete(String(nonce)); // single use, consumed either way

    if (Date.now() > rec.expiresAt) {
      throw Object.assign(new Error('challenge expired'), { code: 'CHALLENGE_EXPIRED' });
    }

    if (rec.kind === 'dimsum') {
      const choice = String(answer?.dishId ?? '');
      if (choice === rec.correctDishId) return ladderAdvanced(rec);
      return { cleared: false, reason: 'wrong-dish' };
    }

    if (rec.kind === 'sums') {
      const given = Array.isArray(answer?.sums) ? answer.sums.map(Number) : [];
      if (given.length !== rec.answers.length) return { cleared: false, reason: 'incomplete' };
      const allRight = rec.answers.every((expected, i) => Number.isFinite(given[i]) && given[i] === expected);
      if (allRight) return ladderAdvanced(rec);
      return { cleared: false, reason: 'wrong-sum' };
    }

    if (rec.kind === 'moles') {
      const elapsed = Date.now() - rec.issuedAt;
      // A timed game cannot be won faster than it lasts (small clock tolerance).
      if (elapsed < rec.roundDurationMs - 250) {
        throw Object.assign(new Error('round not finished yet'), { code: 'ROUND_EARLY' });
      }
      const hitSet = new Set();
      for (const hit of (Array.isArray(answer?.hits) ? answer.hits : [])) {
        const mole = rec.moles.find((m) => m.i === Number(hit?.mole));
        if (!mole || hitSet.has(mole.i)) continue; // each mole gradeable once
        const cell = Number(hit?.cell);
        const t = Number(hit?.t);
        if (cell === mole.cell && t >= mole.start && t <= mole.end) hitSet.add(mole.i);
      }
      if (hitSet.size >= 6) return ladderAdvanced(rec);
      return { cleared: false, reason: 'too-few-moles', hits: hitSet.size };
    }

    return { cleared: false, reason: 'unknown-kind' };
  });

  function ladderAdvanced(rec) {
    const wins = ladderStore.get('ladderWins', []) ?? [];
    wins.push(Date.now());
    ladderStore.set('ladderWins', wins.slice(-50));
    // Winning clears THIS wait only: the pending lockout wait lifts, the
    // consecutive-failure escalation stays untouched.
    mutateAttempts((all) => {
      if (all[rec.scope]) all[rec.scope].waitUntil = 0;
    });
    return { cleared: true };
  }

  // -- dim-sum surprise + dish cache ---------------------------------------------

  let catalogCache = null;

  async function fetchWithDeadline(url, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadCatalog() {
    if (catalogCache) return catalogCache;
    const cacheFile = path.join(cacheDir, 'catalog.json');
    try {
      catalogCache = JSON.parse(await fsRead(cacheFile));
      if (Array.isArray(catalogCache?.dishes) && catalogCache.dishes.length) return catalogCache;
    } catch { /* fall through to network */ }
    const res = await fetchWithDeadline(CATALOG_URL, FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
    const sizeCap = 24 * 1024 * 1024;
    const text = await res.text();
    if (text.length > sizeCap) throw new Error('catalog response exceeded the size bound');
    const full = JSON.parse(text);
    const dishes = (Array.isArray(full?.dishes) ? full.dishes : [])
      .filter((d) => d?.id && d?.name && typeof d.name.en === 'string')
      .map((d) => ({
        id: String(d.id),
        en: String(d.name.en),
        zh: String(d.name.zhHant ?? d.name.en),
        img: String(d.image?.path ?? ''),
        altEn: String(d.image?.alt?.en ?? d.name.en),
      }))
      .filter((d) => d.img);
    if (!dishes.length) throw new Error('catalog contained no usable dishes');
    catalogCache = { fetchedAt: new Date().toISOString(), sourceUrl: CATALOG_URL, license: 'see dim-sum-photos repository', dishes };
    await atomicWriteFile(cacheFile, `${JSON.stringify(catalogCache)}\n`);
    return catalogCache;
  }

  function fsRead(file) {
    return import('node:fs').then((fs) => fs.promises.readFile(file, 'utf8'));
  }

  async function ensureImage(relPath) {
    const safeRel = relPath.replace(/\\/g, '/').split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
    const fileName = safeRel.split('/').pop();
    const dest = path.join(imageDir, fileName);
    try {
      const fs = await import('node:fs');
      const stat = await fs.promises.stat(dest);
      if (stat.isFile() && stat.size > 0 && stat.size <= IMAGE_MAX_BYTES) return dest;
    } catch { /* needs downloading */ }
    const res = await fetchWithDeadline(CATALOG_RAW_BASE + safeRel.split('/').map(encodeURIComponent).join('/'), IMAGE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > IMAGE_MAX_BYTES) throw new Error('image exceeded the size bound');
    const fs = await import('node:fs');
    await fs.promises.mkdir(imageDir, { recursive: true });
    await atomicWriteFile(dest, buf);
    return dest;
  }

  registerHandler('vault', 'delight-dimsum-draw', async () => {
    const catalog = await loadCatalog();
    const dishes = catalog.dishes;
    // A published photo asset is required: try up to five candidates.
    for (let attemptNo = 0; attemptNo < 5; attemptNo++) {
      const dish = dishes[rnd(dishes.length)];
      try {
        const file = await ensureImage(dish.img);
        const fs = await import('node:fs');
        const buf = await fs.promises.readFile(file);
        if (buf.length > IMAGE_MAX_BYTES) continue;
        return {
          id: dish.id,
          en: dish.en,
          zh: dish.zh,
          altEn: dish.altEn,
          imageDataUrl: `data:image/png;base64,${buf.toString('base64')}`,
          attribution: { catalogUrl: catalog.sourceUrl, repository: 'Ding-Ding-Projects/dim-sum-photos' },
        };
      } catch { /* try another candidate; report honestly if none work */ }
    }
    return null;
  });

  registerHandler('vault', 'delight-cache-info', () => ({ cacheDir, imageDir }));

  // Boot-time mirror so the very first renderer read sees real values.
  syncSchoolToSettings();
}
