// Purpose: Providers-lane bridge. Adds ONE handler the existing builtin surface
// cannot express: `providers:test`, a stateless connection probe that works for
// an UNSAVED provider draft (explicit type/baseUrl plus either a freshly typed
// key or a vault keyRef) as well as for a saved provider id. The builtin
// `providers:refresh-models` requires a persisted provider and its stored key,
// so it cannot test a form mid-edit.
//
// Deadline semantics: fetchModelList carries its own rejecting timeout; this
// handler clamps the caller-supplied budget into [1s, 30s]. Secrets never
// reach logs: the plaintext key lives only in this call frame, and upstream
// error text is already redacted/truncated by normalizeUpstreamError().
//
// Owned by Providers lane. Registered automatically by bridges/index.js.

import { registerHandler } from '../ipc.js';
import { fetchModelList } from '../upstream.js';
import { upstreamPath } from '../translator.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

const KNOWN_TYPES = ['openai', 'anthropic', 'openai-compatible'];

/** Extract a normalized [{id, owned_by?}] list from either wire shape. */
function extractModels(json) {
  const raw = Array.isArray(json?.data)
    ? json.data
    : (Array.isArray(json?.models) ? json.models : []);
  return raw
    .map((m) => ({ id: String(m?.id ?? m?.name ?? ''), owned_by: m?.owned_by ? String(m.owned_by) : undefined }))
    .filter((m) => m.id);
}

export function register(ctx) {
  const { vault, providersStore } = ctx;

  registerHandler('providers', 'test', async (payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};

    // Resolve the effective provider descriptor: an explicit id wins (the
    // stored config is authoritative), otherwise the draft fields are used.
    let type = typeof input.type === 'string' ? input.type : '';
    let baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
    let keyRef = typeof input.keyRef === 'string' ? input.keyRef : '';

    const savedId = typeof input.id === 'string' ? input.id.trim() : '';
    if (savedId) {
      const saved = providersStore.getProvider(savedId);
      if (!saved) throw new Error(`providers.test: provider "${savedId}" not found`);
      type = saved.type;
      baseUrl = saved.baseUrl;
      keyRef = saved.keyRef || '';
    }

    if (!KNOWN_TYPES.includes(type)) {
      throw new Error('providers.test: unknown provider type');
    }
    // An empty baseUrl is allowed here for parity with the store: translator
    // and fetch will surface an honest connection error downstream.
    try {
      const parsed = new URL(baseUrl || `https://placeholder.invalid${type === 'anthropic' ? '' : '/v1'}`);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new Error('providers.test: base URL must be an absolute http(s) URL');
    }

    // Key resolution order: explicitly supplied draft key, else vault ref.
    // The plaintext value exists only inside this frame.
    let apiKey = typeof input.apiKey === 'string' ? input.apiKey : '';
    if (!apiKey && keyRef) {
      apiKey = vault.getSecret(keyRef) || '';
    }

    const requested = Number(input.timeoutMs);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(requested)))
      : DEFAULT_TIMEOUT_MS;

    const url = upstreamPath({ type, baseUrl }, 'models');

    try {
      const json = await fetchModelList({ type, baseUrl }, apiKey, url, { timeoutMs });
      const models = extractModels(json);
      // Warm the shared TTL cache when probing a saved provider so the local
      // router's /v1/models listing reflects the same result.
      if (savedId && providersStore.getProvider(savedId)) {
        providersStore.putCachedModels(savedId, models);
      }
      return { ok: true, modelCount: models.length, models };
    } catch (err) {
      // A reachable-but-rejecting upstream is a RESULT, not an exception:
      // returning ok:false keeps status/type intact for the UI, where the
      // ipc layer's generic wrapper would keep only message+code.
      return {
        ok: false,
        status: Number.isFinite(err?.status) ? err.status : null,
        errorType: typeof err?.type === 'string' && err.type ? err.type : 'connection_error',
        message: String(err?.message || 'connection test failed'),
      };
    }
  });
}
