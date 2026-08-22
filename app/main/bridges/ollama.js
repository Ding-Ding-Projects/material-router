// Purpose: Toolbox lane - local Ollama suite manager. Talks ONLY to the
// documented local HTTP API on 127.0.0.1 (default port 11434) plus the
// official model catalog at registry.ollama.ai on an explicit refresh.
// Bridge-owned fetch with rejecting deadlines and bounded payloads; the
// sandboxed renderer never opens a socket itself.
//
// Owned by the Utility (Toolbox) lane.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { registerHandler, broadcast } from '../ipc.js';
import { JSONStore } from '../store.js';

const DEFAULT_BASE = 'http://127.0.0.1:11434';
const CATALOG_URL = 'https://registry.ollama.ai/library';
const CATALOG_STALE_HOURS = 24;

const HEALTH_TIMEOUT_MS = 4000;
const API_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 60 * 60_000; // pulls are long; deadline is a backstop
const CHAT_TIMEOUT_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const CHAT_CONCURRENCY = 1; // one generation at a time per session surface

/** @type {JSONStore|null} */
let store = null;

let pullControllers = new Map(); // pullId -> AbortController
let chatControllers = new Map(); // chatId -> AbortController
let activePulls = 0;
const PULL_PARALLELISM = 2;
const pullQueue = [];

// ---------------------------------------------------------------------------
// store / lifecycle
// ---------------------------------------------------------------------------

export function register(ctx) {
  void ctx;
  store = new JSONStore(path.join(app.getPath('userData'), 'ollama-store.json'), {
    defaults: {
      schemaVersion: 1,
      catalog: { fetchedAt: null, models: [] },
      variantCache: {},
      sessions: [],
      profiles: [],
      profileSnapshots: [],
      cart: [],
      settings: { baseUrl: DEFAULT_BASE },
    },
  });

  // Prebuilt safe harness profiles (first run only).
  if ((store.get('profiles', []) ?? []).length === 0) {
    store.set('profiles', [
      {
        id: 'profile_ollama_run',
        name: 'Ollama CLI run',
        executable: 'ollama',
        args: ['run', '{model}'],
        cwd: '',
        envKeys: [],
        prebuilt: true,
      },
      {
        id: 'profile_ollama_serve_check',
        name: 'Ollama serve (background service)',
        executable: 'ollama',
        args: ['serve'],
        cwd: '',
        envKeys: [],
        prebuilt: true,
      },
    ]);
  }

  registerHandler('ollama', 'status', () => getStatus());
  registerHandler('ollama', 'installed', () => getInstalled());
  registerHandler('ollama', 'running', () => getRunning());
  registerHandler('ollama', 'show', ({ model } = {}) => showModel(String(model || '')));
  registerHandler('ollama', 'catalog', () => getCatalog());
  registerHandler('ollama', 'variants', ({ name } = {}) => getVariants(String(name || '')));
  registerHandler('ollama', 'catalog-refresh', () => refreshCatalog());
  registerHandler('ollama', 'host-resources', () => hostResources());
  registerHandler('ollama', 'fit-verdict', ({ sizeBytes } = {}) =>
    fitVerdict(Number(sizeBytes), hostResources()));
  registerHandler('ollama', 'cart-add', ({ items } = {}) => cartAdd(items));
  registerHandler('ollama', 'cart-list', () => store.get('cart', []));
  registerHandler('ollama', 'cart-remove', ({ tag } = {}) => {
    store.set('cart', store.get('cart', []).filter((i) => i.tag !== String(tag)));
    return store.get('cart', []);
  });
  registerHandler('ollama', 'pull-start', () => startPulls());
  registerHandler('ollama', 'pull-cancel', ({ tag } = {}) => cancelPull(String(tag || '')));
  registerHandler('ollama', 'delete-model', ({ model } = {}) => deleteModel(String(model || '')));
  registerHandler('ollama', 'chat-start', ({ session } = {}) => chatStart(session));
  registerHandler('ollama', 'chat-stop', ({ chatId } = {}) => chatStop(String(chatId || '')));
  registerHandler('ollama', 'sessions-save', ({ sessions } = {}) => saveSessions(sessions));
  registerHandler('ollama', 'sessions-load', () => store.get('sessions', []));
  registerHandler('ollama', 'profiles-list', () => listProfiles());
  registerHandler('ollama', 'profile-pick-executable', ({ title } = {}, event) => pickExecutable(title, event));
  registerHandler('ollama', 'profile-register', ({ profile } = {}) => registerProfile(profile));
  registerHandler('ollama', 'profile-delete', ({ id } = {}) => deleteProfile(String(id || '')));
  registerHandler('ollama', 'profile-launch', ({ id, model } = {}) => launchProfile(String(id || ''), String(model || '')));
  registerHandler('ollama', 'profile-preflight', ({ id, model } = {}) => {
    const profile = store.get('profiles', []).find((p) => p.id === String(id || ''));
    if (!profile) throw new Error(`no such profile "${id}"`);
    return preflightLaunch(profile, String(model || ''));
  });
  registerHandler('ollama', 'profile-snapshot-restore', ({ snapshotId } = {}) => restoreSnapshot(String(snapshotId || '')));
  registerHandler('ollama', 'troubleshooting', () => ({ doc: TROUBLESHOOTING_MD }));
}

// ---------------------------------------------------------------------------
// localhost-only HTTP helper with rejecting deadlines
// ---------------------------------------------------------------------------

async function ollamaFetch(pathname, { method = 'GET', body = null, timeoutMs = API_TIMEOUT_MS, signal = null, onLine = null } = {}) {
  const base = String(store.get('settings.baseUrl', DEFAULT_BASE) || DEFAULT_BASE);
  let url;
  try {
    url = new URL(pathname, base);
  } catch {
    throw new Error(`invalid Ollama base URL "${base}"`);
  }
  // Loopback enforcement: the documented local API is the only permitted target.
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host) && !host.endsWith('.localhost')) {
    throw new Error(`refusing non-loopback Ollama endpoint "${url.hostname}"`);
  }
  if (url.protocol !== 'http:') {
    throw new Error('Ollama API must be reached over plain http on loopback');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama API ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    if (onLine) {
      // NDJSON stream: bounded line-by-line consumption with byte cap.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_JSON_BYTES) throw new Error('stream exceeded its size bound');
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) onLine(line);
        }
      }
      if (buf.trim()) onLine(buf.trim());
      clearTimeout(timer);
      return { streamed: true };
    }
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) throw new Error('response exceeded its size bound');
    clearTimeout(timer);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    clearTimeout(timer);
    if (timedOut) {
      throw Object.assign(new Error(`request to ${pathname} exceeded its ${Math.round(timeoutMs / 1000)}s deadline`), { code: 'DEADLINE' });
    }
    if (err?.code === 'CANCELLED' || err?.name === 'AbortError') {
      throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    }
    if (err?.cause?.code === 'ECONNREFUSED') {
      throw Object.assign(
        new Error(`nothing is listening on ${url.host} - install or start the Ollama service`),
        { code: 'ECONNREFUSED' },
      );
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// status + installed + running + show
// ---------------------------------------------------------------------------

function diagnose(err) {
  if (err?.code === 'ECONNREFUSED') {
    return {
      state: 'unreachable',
      reasonKey: 'ollama.state.unreachable',
      actionKey: 'ollama.action.startService',
      detail: err.message,
    };
  }
  if (err?.code === 'DEADLINE') {
    return {
      state: 'unhealthy',
      reasonKey: 'ollama.state.unhealthy',
      actionKey: 'ollama.action.checkService',
      detail: err.message,
    };
  }
  return {
    state: 'error',
    reasonKey: 'ollama.state.error',
    actionKey: 'ollama.action.retry',
    detail: err?.message || String(err),
  };
}

async function getStatus() {
  const catalog = store.get('catalog', {});
  const staleHours = catalog.fetchedAt
    ? (Date.now() - Date.parse(catalog.fetchedAt)) / 3_600_000
    : null;
  const resources = hostResources();
  try {
    const version = await ollamaFetch('/api/version', { timeoutMs: HEALTH_TIMEOUT_MS });
    return {
      reachable: true,
      version: version?.version ?? null,
      diagnosis: { state: 'ok', reasonKey: 'ollama.state.ok', actionKey: null, detail: null },
      catalogAgeHours: staleHours,
      catalogStale: staleHours === null || staleHours > CATALOG_STALE_HOURS,
      resources,
      diskOk: resources.diskFreeBytes === null || resources.diskFreeBytes > 1024 * 1024 * 1024,
    };
  } catch (err) {
    return {
      reachable: false,
      version: null,
      diagnosis: diagnose(err),
      catalogAgeHours: staleHours,
      catalogStale: staleHours === null || staleHours > CATALOG_STALE_HOURS,
      resources,
      diskOk: resources.diskFreeBytes === null || resources.diskFreeBytes > 1024 * 1024 * 1024,
    };
  }
}

async function getInstalled() {
  const data = await ollamaFetch('/api/tags');
  return {
    models: (Array.isArray(data?.models) ? data.models : []).map((m) => ({
      name: m.name,
      model: m.model ?? m.name,
      size: m.size ?? null,
      digest: m.digest ? `${String(m.digest).slice(0, 12)}` : null,
      modifiedAt: m.modified_at ?? null,
      family: m.details?.family ?? null,
      families: m.details?.families ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
    })),
  };
}

async function getRunning() {
  const data = await ollamaFetch('/api/ps');
  return {
    models: (Array.isArray(data?.models) ? data.models : []).map((m) => ({
      name: m.name,
      model: m.model ?? m.name,
      size: m.size ?? null,
      sizeVram: m.size_vram ?? null,
      expiresAt: m.expires_at ?? null,
    })),
  };
}

async function showModel(model) {
  if (!model) throw new Error('show needs a model name');
  const data = await ollamaFetch('/api/show', { method: 'POST', body: { model } });
  return {
    capabilities: Array.isArray(data?.capabilities) ? data.capabilities : [],
    family: data?.details?.family ?? null,
    families: data?.details?.families ?? null,
    parameterSize: data?.details?.parameter_size ?? null,
    quantization: data?.details?.quantization_level ?? null,
    parameters: typeof data?.parameters === 'string' ? data.parameters : null,
    template: typeof data?.template === 'string' ? data.template.slice(0, 2000) : null,
    modelfile: typeof data?.modelfile === 'string' ? data.modelfile.slice(0, 4000) : null,
  };
}

// ---------------------------------------------------------------------------
// official catalog (explicit refresh only)
// ---------------------------------------------------------------------------

async function refreshCatalog() {
  const raw = await fetchWithDeadline(CATALOG_URL, CATALOG_TIMEOUT_MS);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the official catalog returned something that is not JSON');
  }
  const models = (Array.isArray(parsed) ? parsed : []).map((m) => ({
    name: m.name ?? null,
    description: typeof m.description === 'string' ? m.description.slice(0, 600) : null,
    pulls: m.pull_count ?? m.pulls ?? null,
    tagCount: m.tags ?? null,
    updatedAt: m.updated_at ?? null,
    capabilityHints: Array.isArray(m.capabilities) ? m.capabilities : [],
  })).filter((m) => m.name);
  store.set('catalog', { fetchedAt: new Date().toISOString(), models });
  broadcast('ollama-catalog', { refreshedAt: store.get('catalog.fetchedAt'), count: models.length });
  return { count: models.length, fetchedAt: store.get('catalog.fetchedAt') };
}

async function fetchWithDeadline(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status} from ${new URL(url).host}`);
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) throw new Error('catalog response exceeded its size bound');
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`catalog fetch exceeded its ${Math.round(timeoutMs / 1000)}s deadline`), { code: 'DEADLINE' });
    }
    throw Object.assign(new Error(`catalog unreachable: ${err?.message || 'network error'} (offline? the last verified copy stays available)`), { code: 'CATALOG_NETWORK' });
  } finally {
    clearTimeout(timer);
  }
}

function getCatalog() {
  const catalog = store.get('catalog', { fetchedAt: null, models: [] });
  const ageHours = catalog.fetchedAt ? (Date.now() - Date.parse(catalog.fetchedAt)) / 3_600_000 : null;
  return {
    fetchedAt: catalog.fetchedAt ?? null,
    ageHours,
    stale: ageHours === null || ageHours > CATALOG_STALE_HOURS,
    models: catalog.models ?? [],
  };
}

async function getVariants(name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('invalid model name');
  const cacheKey = `variantCache.${name}`;
  const cached = store.get(cacheKey, null);
  if (cached) return cached;
  const raw = await fetchWithDeadline(`${CATALOG_URL}/${encodeURIComponent(name)}/tags`, CATALOG_TIMEOUT_MS);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`variant list for "${name}" is not JSON`);
  }
  const entry = {
    fetchedAt: new Date().toISOString(),
    tags: (Array.isArray(parsed?.tags) ? parsed.tags : []).map((t) => ({
      tag: t.name ?? t.tag ?? null,
      fullSize: t.full_size ?? t.size ?? null,
      digest: t.digest ? String(t.digest).slice(0, 12) : null,
    })),
  };
  // Bound the cache so the store cannot grow without limit.
  const cache = store.get('variantCache', {}) ?? {};
  if (Object.keys(cache).length > 300) store.set('variantCache', {});
  store.set(cacheKey, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// conservative hardware fit verdicts (evidence-based, timestamped)
// ---------------------------------------------------------------------------

function modelsDirGuess() {
  const envDir = process.env.OLLAMA_MODELS;
  if (envDir && fs.existsSync(envDir)) return envDir;
  const guess = path.join(os.homedir(), '.ollama', 'models');
  if (fs.existsSync(guess)) return guess;
  return os.homedir(); // last resort for the free-space probe
}

function hostResources() {
  let diskFreeBytes = null;
  try {
    const s = fs.statfsSync(modelsDirGuess());
    diskFreeBytes = Number(s.bavail) * Number(s.bsize);
  } catch { /* statfs unavailable */ }
  return {
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    diskFreeBytes,
    probedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Conservative verdict rules, decided only by measured numbers:
 *   Runs well       blob <= 50% of total RAM and fits on disk
 *   Runs with limits blob <= 85% of total RAM and fits on disk
 *   Unlikely        bigger than 85% of RAM or bigger than free disk
 *   Unknown         missing measurement (never inferred from the name)
 */
function fitVerdict(sizeBytes, resources, installedSizes = []) {
  const evidence = [
    `probed ${resources.probedAt}`,
    `RAM total ${(resources.totalMemBytes / 1073741824).toFixed(1)} GiB, free ${(resources.freeMemBytes / 1073741824).toFixed(1)} GiB`,
  ];
  if (resources.diskFreeBytes !== null) {
    evidence.push(`disk free where models live: ${(resources.diskFreeBytes / 1073741824).toFixed(1)} GiB`);
  } else {
    evidence.push('disk free could not be measured here');
  }
  if (installedSizes.length) {
    evidence.push(`already-installed variants total ${(installedSizes.reduce((a, b) => a + b, 0) / 1073741824).toFixed(1)} GiB`);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes == null || !resources.totalMemBytes) {
    return { verdict: 'Unknown', evidence: [...evidence, 'download size unknown for this variant'] };
  }
  evidence.push(`variant download size ${(sizeBytes / 1073741824).toFixed(2)} GiB`);
  const ratio = sizeBytes / resources.totalMemBytes;
  const fitsDisk = resources.diskFreeBytes === null ? true : sizeBytes < resources.diskFreeBytes;
  if (!fitsDisk) {
    return { verdict: 'Unlikely', evidence: [...evidence, 'download is larger than the measured free disk space'] };
  }
  if (ratio <= 0.5) return { verdict: 'Runs well', evidence: [...evidence, `uses about ${Math.round(ratio * 100)}% of total RAM`] };
  if (ratio <= 0.85) return { verdict: 'Runs with limits', evidence: [...evidence, `uses about ${Math.round(ratio * 100)}% of total RAM; expect slower answers near the ceiling`] };
  return { verdict: 'Unlikely', evidence: [...evidence, `needs about ${Math.round(ratio * 100)}% of total RAM resident`] };
}

// ---------------------------------------------------------------------------
// cart + batch pulls (bounded parallelism, honest partial outcomes)
// ---------------------------------------------------------------------------

function cartAdd(items) {
  if (!Array.isArray(items)) throw new Error('cart needs an items array');
  const cart = store.get('cart', []);
  for (const item of items) {
    const tag = String(item?.tag || '');
    if (!tag || cart.some((c) => c.tag === tag)) continue;
    cart.push({
      tag,
      modelName: String(item.modelName || tag.split(':')[0]),
      fullSize: Number.isFinite(item.fullSize) ? item.fullSize : null,
      verdict: item.verdict ?? 'Unknown',
      addedAt: new Date().toISOString(),
      state: 'queued', // queued | pulling | done | failed | cancelled
      progress: null,
      error: null,
    });
  }
  if (cart.length > 200) throw new Error('cart is capped at 200 pending pulls');
  store.set('cart', cart);
  return cart;
}

function startPulls() {
  const cart = store.get('cart', []);
  for (const item of cart) {
    if (item.state === 'queued' && !pullQueue.includes(item.tag)) pullQueue.push(item.tag);
  }
  drainPulls();
  return store.get('cart', []);
}

function drainPulls() {
  while (activePulls < PULL_PARALLELISM && pullQueue.length > 0) {
    const tag = pullQueue.shift();
    activePulls += 1;
    runPull(tag).finally(() => {
      activePulls -= 1;
      drainPulls();
    });
  }
}

async function runPull(tag) {
  const setItem = (patch) => {
    const cart = store.get('cart', []);
    const item = cart.find((c) => c.tag === tag);
    if (!item) return null;
    Object.assign(item, patch);
    store.set('cart', cart);
    broadcast('ollama-cart', cart);
    return item;
  };

  const current = store.get('cart', []).find((c) => c.tag === tag);
  if (!current || current.state === 'cancelled') return;
  const controller = new AbortController();
  pullControllers.set(tag, controller);
  setItem({ state: 'pulling', progress: { total: null, completed: 0, percent: 0 }, error: null });

  try {
    await ollamaFetch('/api/pull', {
      method: 'POST',
      body: { model: tag, stream: true },
      timeoutMs: PULL_TIMEOUT_MS,
      signal: controller.signal,
      onLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.error) throw new Error(evt.error);
          const item = setItem({
            state: evt.status === 'success' ? 'done' : 'pulling',
            progress: {
              total: evt.total ?? null,
              completed: evt.completed ?? 0,
              percent: evt.total ? Math.round(((evt.completed ?? 0) / evt.total) * 100) : null,
              digest: evt.digest ? String(evt.digest).slice(0, 12) : null,
            },
          });
          void item;
        } catch (lineErr) {
          if (lineErr.message && !/JSON/.test(lineErr.message)) throw lineErr;
        }
      },
    });
  } catch (err) {
    setItem({
      state: err?.code === 'CANCELLED' ? 'cancelled' : 'failed',
      error: err?.message || 'pull failed',
    });
  } finally {
    pullControllers.delete(tag);
  }
}

function cancelPull(tag) {
  const controller = pullControllers.get(tag);
  if (controller) controller.abort();
  const inQueue = pullQueue.indexOf(tag);
  if (inQueue >= 0) pullQueue.splice(inQueue, 1);
  const cart = store.get('cart', []);
  const item = cart.find((c) => c.tag === tag);
  if (item && ['queued', 'pulling'].includes(item.state)) {
    item.state = 'cancelled';
    item.error = null;
    store.set('cart', cart);
    broadcast('ollama-cart', cart);
  }
  return store.get('cart', []);
}

async function deleteModel(model) {
  if (!model) throw new Error('delete needs a model name');
  await ollamaFetch('/api/delete', { method: 'DELETE', body: { model }, timeoutMs: API_TIMEOUT_MS });
  return true;
}

// ---------------------------------------------------------------------------
// chat streaming
// ---------------------------------------------------------------------------

function saveSessions(sessions) {
  if (!Array.isArray(sessions)) throw new Error('sessions must be an array');
  if (sessions.length > 500) throw new Error('session history is capped at 500 saved conversations');
  store.set('sessions', sessions.slice(-500));
  return true;
}

async function chatStart(session) {
  if (!session || !Array.isArray(session.messages) || !session.model) {
    throw new Error('chat needs a model and a messages array');
  }
  const chatId = String(session.chatId || `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  if (chatControllers.has(chatId)) throw new Error('a generation is already running for this conversation');

  const controller = new AbortController();
  chatControllers.set(chatId, controller);

  const options = {};
  const numeric = [['num_predict', 2048], ['temperature', null], ['top_p', null], ['top_k', null], ['repeat_penalty', null], ['num_ctx', null]];
  for (const [key] of numeric) {
    const v = session.options?.[key];
    if (Number.isFinite(Number(v))) options[key] = Number(v);
  }

  // Fire-and-forget: progress streams out as events; errors surface there too.
  (async () => {
    try {
      await ollamaFetch('/api/chat', {
        method: 'POST',
        body: {
          model: String(session.model),
          messages: session.messages.slice(-80), // bounded context window of turns
          stream: true,
          ...(Object.keys(options).length ? { options } : {}),
        },
        timeoutMs: CHAT_TIMEOUT_MS,
        signal: controller.signal,
        onLine: (line) => {
          try {
            const evt = JSON.parse(line);
            broadcast('ollama-chat', {
              chatId,
              delta: evt.message?.content ?? '',
              done: Boolean(evt.done),
              evalCount: evt.eval_count ?? null,
              error: evt.error ?? null,
              model: session.model,
            });
            if (evt.error) throw new Error(evt.error);
          } catch (lineErr) {
            if (!/JSON/.test(lineErr.message)) throw lineErr;
          }
        },
      });
    } catch (err) {
      broadcast('ollama-chat', {
        chatId,
        delta: '',
        done: true,
        error: err?.code === 'CANCELLED' ? null : (err?.message || 'generation failed'),
        stopped: err?.code === 'CANCELLED',
      });
    } finally {
      chatControllers.delete(chatId);
    }
  })();

  return { chatId };
}

function chatStop(chatId) {
  const controller = chatControllers.get(chatId);
  if (controller) controller.abort();
  return true;
}

// ---------------------------------------------------------------------------
// harness profiles: file-picker registration, preflight, snapshot + rollback
// ---------------------------------------------------------------------------

function listProfiles() {
  return {
    profiles: store.get('profiles', []),
    snapshots: store.get('profileSnapshots', []).map(({ id, createdAt, reason }) => ({ id, createdAt, reason })),
  };
}

async function pickExecutable(title, event) {
  const { dialog, BrowserWindow } = await import('electron');
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: typeof title === 'string' ? title : 'Choose the program this profile launches',
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

const ARG_TOKEN_OK = /^(\{model\}|--?[A-Za-z0-9][A-Za-z0-9=_:.\-/]*|[A-Za-z0-9_.:\-/\\ {}$(),']+)$/;

function validateProfile(profile) {
  const errors = [];
  const name = String(profile?.name || '').trim();
  const executable = String(profile?.executable || '').trim();
  if (!name) errors.push('profile needs a name');
  if (!executable) errors.push('profile needs an executable chosen through the file picker');
  if (!path.isAbsolute(executable) && executable !== 'ollama') {
    errors.push('use the file picker to choose an absolute executable path (or the built-in "ollama")');
  }
  let args = Array.isArray(profile?.args) ? profile.args.map(String) : [];
  if (args.length > 64) errors.push('too many arguments (max 64)');
  args = args.filter(Boolean);
  for (const a of args) {
    if (!ARG_TOKEN_OK.test(a)) errors.push(`argument not allowed by the schema: ${a.slice(0, 40)}`);
  }
  const envKeys = Array.isArray(profile?.envKeys) ? profile.envKeys.map(String) : [];
  for (const k of envKeys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) errors.push(`environment key not allowed: ${k.slice(0, 40)}`);
  }
  if (envKeys.length > 16) errors.push('too many environment keys (max 16)');
  const cwd = String(profile?.cwd || '').trim();
  if (cwd && !path.isAbsolute(cwd)) errors.push('working directory must be absolute when given');
  return { errors, args, envKeys, cwd, name, executable };
}

function snapshotProfiles(reason) {
  const snapshots = store.get('profileSnapshots', []);
  const id = `snap_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  snapshots.push({
    id,
    createdAt: new Date().toISOString(),
    reason,
    profiles: structuredClone(store.get('profiles', [])),
  });
  while (snapshots.length > 20) snapshots.shift();
  store.set('profileSnapshots', snapshots);
  return id;
}

function registerProfile(profile) {
  const v = validateProfile(profile);
  if (v.errors.length) {
    throw new Error(`profile rejected: ${v.errors.join('; ')}`);
  }
  snapshotProfiles(`before registering "${v.name}"`);
  const profiles = store.get('profiles', []);
  const existingIdx = profiles.findIndex((p) => p.id === profile.id);
  const record = {
    id: profile.id || `profile_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: v.name,
    executable: v.executable,
    args: v.args,
    cwd: v.cwd,
    envKeys: v.envKeys,
    prebuilt: false,
    updatedAt: new Date().toISOString(),
  };
  if (existingIdx >= 0 && !profiles[existingIdx].prebuilt) profiles[existingIdx] = record;
  else if (existingIdx >= 0) throw new Error('built-in example profiles cannot be overwritten; register a new one');
  else profiles.push(record);
  if (profiles.length > 50) throw new Error('profile list is capped at 50');
  store.set('profiles', profiles);
  return record;
}

function deleteProfile(id) {
  snapshotProfiles(`before deleting a profile`);
  const profiles = store.get('profiles', []);
  const target = profiles.find((p) => p.id === id);
  if (!target) throw new Error(`no such profile "${id}"`);
  if (target.prebuilt) throw new Error('built-in example profiles stay available; they cannot be deleted');
  store.set('profiles', profiles.filter((p) => p.id !== id));
  return true;
}

/** Preflight preview: everything needed to judge the launch, secrets redacted. */
function preflightLaunch(profile, model) {
  const blockers = [];
  const resolvedArgs = profile.args.map((a) => a.replace('{model}', model || '{model}'));
  if (profile.args.includes('{model}') && !model) blockers.push('this profile expects a model name ({model}) but none was supplied');
  if (!fs.existsSync(profile.executable) && profile.executable !== 'ollama') {
    blockers.push(`executable not found at ${profile.executable}`);
  }
  if (profile.cwd && !fs.existsSync(profile.cwd)) blockers.push(`working directory does not exist: ${profile.cwd}`);
  return {
    profileId: profile.id,
    name: profile.name,
    executable: profile.executable,
    args: resolvedArgs,
    cwd: profile.cwd || '(profile default)',
    envKeysRedacted: profile.envKeys.map((k) => `${k}=<redacted>`),
    model: model || null,
    blockers,
  };
}

/** Launch with health verification and automatic rollback of nothing user-owned:
 *  the snapshot covers the profile store; a failed health check rolls the
 *  profile list back to it and kills the child. */
async function launchProfile(id, model) {
  const profile = store.get('profiles', []).find((p) => p.id === id);
  if (!profile) throw new Error(`no such profile "${id}"`);
  const preflight = preflightLaunch(profile, model);
  if (preflight.blockers.length) {
    return { launched: false, preflight, error: `blocked: ${preflight.blockers.join('; ')}` };
  }
  const snapshotId = snapshotProfiles(`before launching "${profile.name}"`);

  const bin = profile.executable === 'ollama' ? 'ollama' : profile.executable;
  let child;
  try {
    child = spawn(bin, preflight.args, {
      cwd: profile.cwd || undefined,
      env: { ...process.env },
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
  } catch (err) {
    restoreSnapshot(snapshotId);
    return { launched: false, preflight, error: `could not start: ${err.message}`, snapshotId };
  }

  const startedAt = Date.now();
  const healthMs = 4000;
  await new Promise((resolve) => setTimeout(resolve, healthMs));

  let healthy = false;
  let exited = null;
  try { exited = child.exitCode; } catch { /* polling quirk */ }
  if (exited === null) healthy = true; // still alive after the window
  else child.kill();

  if (!healthy) {
    restoreSnapshot(snapshotId);
    return {
      launched: false,
      preflight,
      error: `process exited within ${healthMs / 1000}s (exit code ${exited}); the profile list was rolled back`,
      snapshotId,
    };
  }
  return {
    launched: true,
    preflight,
    pid: child.pid ?? null,
    healthCheck: `alive after ${(Date.now() - startedAt) / 1000}s`,
    snapshotId,
  };
}

function restoreSnapshot(snapshotId) {
  const snapshots = store.get('profileSnapshots', []);
  const snap = snapshots.find((s) => s.id === snapshotId);
  if (!snap) throw new Error(`no such snapshot "${snapshotId}"`);
  store.set('profiles', structuredClone(snap.profiles));
  return true;
}

// ---------------------------------------------------------------------------
// bundled offline troubleshooting doc (rendered in-panel through md.js)
// ---------------------------------------------------------------------------

const TROUBLESHOOTING_MD = `# Ollama troubleshooting

## Nothing is listening (connection refused)

The manager talks to the documented local API on \`http://127.0.0.1:11434\`.
When the connection is refused the service is either not installed or not
running.

**Next actions**

1. Install Ollama from its official distribution for your platform.
2. Start it once so the background service registers.
3. Press **Refresh status** in this panel.

## Unhealthy (deadline exceeded)

The port answered slowly or not at all within the deadline.

**Next actions**: check whether \`ollama serve\` is running twice, check CPU
load from a running model, then retry. Deadlines reject rather than hang, so
the panel always comes back.

## Catalog stale or offline

The Model Store keeps the last verified copy of the official library. When
offline you can browse it, search it, and read previously fetched variant
lists; refreshing requires network access and happens only when you press
**Refresh catalog**.

## Insufficient disk

Before any pull starts, the queue checks free space beside your models folder
and refuses honestly when the reservation would not fit. Free space (or point
\`OLLAMA_MODELS\` at a larger disk) and retry the cancelled item.

## A pull fails partway

Partial outcomes are kept per item: done, failed, cancelled. Failed items
never turn the batch green, and already-finished models are never deleted by
a later failure. Retry re-downloads only what Ollama still misses.

## Hardware fit says "Unlikely"

Verdicts come from measured numbers only: your total RAM, the variant's
declared download size and free disk space. They are conservative: a large
quantized model can still run with limits if your system allows paging, but
the manager will not promise it.
`;
