// Purpose: provider configuration CRUD, routing rules with deterministic
// resolution order, and per-provider model caches with TTL.
// Foundation seam: server.js resolves routes through resolveRoute();
// Providers lane replaces the GUI but keeps these store APIs.
// Owned by Foundation Core lane.

import { JSONStore } from './store.js';
import { fetchModelList, UpstreamError } from './upstream.js';
import { upstreamPath } from './translator.js';

export const DEFAULTS = {
  schemaVersion: 1,
  providers: [],
  routingRules: [],
};

const MODEL_TTL_MS = 10 * 60 * 1000;

export class ProvidersStore {
  constructor(filePath) {
    this.store = new JSONStore(filePath, { defaults: DEFAULTS, debounceMs: 150 });
    /** providerId -> {ts:number, models:Array<{id,owned_by?}>} (in-memory only) */
    this.modelsCache = new Map();
  }

  // -- providers ------------------------------------------------------------

  listProviders() {
    return this.store.get('providers', []);
  }

  getProvider(id) {
    return this.listProviders().find((p) => p.id === id) || null;
  }

  createProvider(input) {
    const provider = normalizeProvider(input);
    const list = this.listProviders();
    if (list.some((p) => p.id === provider.id)) {
      throw new Error(`provider id "${provider.id}" already exists`);
    }
    list.push(provider);
    this.store.set('providers', list);
    return structuredClone(provider);
  }

  updateProvider(id, patch) {
    const list = this.listProviders();
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`provider "${id}" not found`);
    const merged = normalizeProvider({ ...list[idx], ...patch, id });
    list[idx] = merged;
    this.store.set('providers', list);
    this._invalidateModels(id);
    return structuredClone(merged);
  }

  deleteProvider(id) {
    const list = this.listProviders();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    this.store.set('providers', next);
    // Drop routing rules that pointed at the removed provider.
    const rules = this.listRules().filter((r) => r.providerId !== id);
    this.store.set('routingRules', rules);
    this._invalidateModels(id);
    return true;
  }

  // -- routing rules ----------------------------------------------------------

  listRules() {
    return this.store.get('routingRules', []);
  }

  addRule(rule) {
    const normalized = normalizeRule(rule);
    const rules = this.listRules();
    if (rules.some((r) => r.id === normalized.id)) {
      throw new Error(`rule id "${normalized.id}" already exists`);
    }
    rules.push(normalized);
    this.store.set('routingRules', rules);
    return structuredClone(normalized);
  }

  updateRule(id, patch) {
    const rules = this.listRules();
    const idx = rules.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`rule "${id}" not found`);
    rules[idx] = normalizeRule({ ...rules[idx], ...patch, id });
    this.store.set('routingRules', rules);
    return structuredClone(rules[idx]);
  }

  deleteRule(id) {
    const rules = this.listRules();
    const next = rules.filter((r) => r.id !== id);
    if (next.length === rules.length) return false;
    this.store.set('routingRules', next);
    return true;
  }

  /**
   * Deterministic resolution: highest priority wins; ties break by specificity
   * (exact > prefix > catchall), then by insertion order. Disabled providers
   * are skipped. Returns {provider, rule} or null.
   */
  resolveRoute(model) {
    const providersById = new Map(this.listProviders().map((p) => [p.id, p]));
    const rank = { exact: 3, prefix: 2, catchall: 1 };
    const rules = [...this.listRules()].sort((a, b) => {
      if ((b.priority ?? 0) !== (a.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
      if (rank[b.matchType] !== rank[a.matchType]) return rank[b.matchType] - rank[a.matchType];
      return 0; // Array.prototype.sort is stable: insertion order preserved
    });
    for (const rule of rules) {
      if (!ruleMatches(rule, model)) continue;
      const provider = providersById.get(rule.providerId);
      if (!provider || !provider.enabled) continue;
      return { provider, rule };
    }
    // Fall back to the first enabled provider with a defaultModel when no rule
    // matched, so a bare setup still routes instead of erroring.
    const fallback = this.listProviders().find((p) => p.enabled && p.defaultModel);
    if (fallback) {
      return { provider: fallback, rule: null };
    }
    return null;
  }

  // -- models cache -----------------------------------------------------------

  _invalidateModels(providerId) {
    this.modelsCache.delete(providerId);
  }

  getCachedModels(providerId) {
    const entry = this.modelsCache.get(providerId);
    if (!entry) return null;
    if (Date.now() - entry.ts > MODEL_TTL_MS) return null;
    return entry.models;
  }

  putCachedModels(providerId, models) {
    this.modelsCache.set(providerId, { ts: Date.now(), models });
  }

  async refreshModels(providerId, getSecret) {
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error(`provider "${providerId}" not found`);
    const apiKey = provider.keyRef ? getSecret(provider.keyRef) : null;
    const url = upstreamPath(
      { type: provider.type, baseUrl: effectiveBaseUrl(provider) },
      'models',
    );
    try {
      const json = await fetchModelList(provider, apiKey || '', url);
      const raw = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
      const models = raw
        .map((m) => ({ id: String(m?.id ?? m?.name ?? ''), owned_by: m?.owned_by ? String(m.owned_by) : undefined }))
        .filter((m) => m.id);
      this.putCachedModels(providerId, models);
      return models;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw err;
    }
  }
}

function effectiveBaseUrl(provider) {
  if (provider.baseUrl) return provider.baseUrl;
  if (provider.type === 'anthropic') return 'https://api.anthropic.com';
  return 'https://api.openai.com';
}

function normalizeProvider(input) {
  const type = input.type === 'anthropic' || input.type === 'openai-compatible' ? input.type : 'openai';
  return {
    id: String(input.id || `prov_${Math.random().toString(36).slice(2, 10)}`),
    name: String(input.name || 'Unnamed provider'),
    type,
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '',
    keyRef: typeof input.keyRef === 'string' ? input.keyRef : null,
    enabled: input.enabled !== false,
    defaultModel: typeof input.defaultModel === 'string' ? input.defaultModel : '',
  };
}

function normalizeRule(input) {
  const matchType = ['prefix', 'exact', 'catchall'].includes(input.matchType) ? input.matchType : 'prefix';
  return {
    id: String(input.id || `rule_${Math.random().toString(36).slice(2, 10)}`),
    matchType,
    pattern: matchType === 'catchall' ? '**' : String(input.pattern || ''),
    providerId: String(input.providerId || ''),
    priority: Number.isFinite(Number(input.priority)) ? Math.floor(Number(input.priority)) : 100,
    enabled: input.enabled !== false,
  };
}

function ruleMatches(rule, model) {
  if (!rule || rule.enabled === false) return false;
  if (!model) return rule.matchType === 'catchall';
  switch (rule.matchType) {
    case 'exact':
      return rule.pattern === model;
    case 'prefix':
      return model.startsWith(rule.pattern);
    case 'catchall':
      return true;
    default:
      return false;
  }
}
