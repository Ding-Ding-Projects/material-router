// Purpose: pure-core tests for app/main/providers-store.js — provider/rule
// normalization, CRUD invariants, deterministic route resolution and the
// in-memory model cache. Zero dependencies.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ProvidersStore } from '../app/main/providers-store.js';

import { makeTempDir, makeTempCleanup, readJson, startHttpServer } from './helpers.mjs';

const tmpRoot = makeTempDir('providers');
test.after(makeTempCleanup(tmpRoot));

function newStore(name) {
  return new ProvidersStore(`${tmpRoot}/${name}.json`);
}

/** Flush the debounced JSONStore write so disk assertions are deterministic. */
async function flush(store) {
  await store.store.save();
}

// ---------------------------------------------------------------------------
// Provider CRUD + normalization
// ---------------------------------------------------------------------------

test('createProvider normalizes every field and generates ids', () => {
  const store = newStore('crud');

  const full = store.createProvider({
    id: 'p1',
    name: 'Main',
    type: 'anthropic',
    baseUrl: '  https://api.anthropic.com/  ',
    keyRef: 'vault:main',
    enabled: false,
    defaultModel: 'claude-x',
  });
  assert.deepEqual(full, {
    id: 'p1', name: 'Main', type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/', keyRef: 'vault:main',
    enabled: false, defaultModel: 'claude-x',
  });

  const minimal = store.createProvider({ id: 'p2', type: 'weird-type' });
  assert.equal(minimal.name, 'Unnamed provider');
  assert.equal(minimal.type, 'openai', 'unknown type coerces to openai');
  assert.equal(minimal.enabled, true, 'enabled unless explicitly false');
  assert.equal(minimal.keyRef, null);
  assert.equal(minimal.id, 'p2', 'a supplied id is kept as-is');

  const autoId = store.createProvider({});
  assert.match(autoId.id, /^prov_/);
  assert.notEqual(autoId.id, minimal.id, 'ids never collide across generated providers');
});

test('createProvider rejects duplicate ids; updateProvider merges and pins id', () => {
  const store = newStore('crud-dup');
  store.createProvider({ id: 'dup', name: 'first' });
  assert.throws(() => store.createProvider({ id: 'dup' }), /already exists/);

  const updated = store.updateProvider('dup', { name: 'renamed', enabled: false });
  assert.equal(updated.name, 'renamed');
  assert.equal(updated.enabled, false);
  // A patch trying to steal another identity is pinned back.
  const sneaky = store.updateProvider('dup', { id: 'other', name: 'sneaky' });
  assert.equal(sneaky.id, 'dup');
  assert.throws(() => store.updateProvider('missing-id', {}), /not found/);
});

test('deleteProvider removes the provider and cascades its rules', async () => {
  const store = newStore('cascade');
  store.createProvider({ id: 'gone', defaultModel: 'm' });
  store.createProvider({ id: 'stays' });
  store.addRule({ id: 'r1', matchType: 'exact', pattern: 'model-a', providerId: 'gone' });
  store.addRule({ id: 'r2', matchType: 'catchall', providerId: 'stays' });

  assert.equal(store.deleteProvider('gone'), true);
  assert.equal(store.deleteProvider('gone'), false, 'second delete reports nothing removed');
  assert.deepEqual(store.listProviders().map((p) => p.id), ['stays']);
  assert.deepEqual(store.listRules().map((r) => r.id), ['r2'], "rules pointing at a deleted provider don't dangle");

  await flush(store);
  const onDisk = readJson(`${tmpRoot}/cascade.json`);
  assert.deepEqual(onDisk.providers.map((p) => p.id), ['stays']);
  assert.deepEqual(onDisk.routingRules.map((r) => r.id), ['r2']);
});

// ---------------------------------------------------------------------------
// Rule normalization
// ---------------------------------------------------------------------------

test('addRule normalizes matchType/pattern/priority/enabled deterministically', async () => {
  const store = newStore('rules-norm');

  const catchall = store.addRule({ id: 'rc', matchType: 'catchall', pattern: 'ignored-input', providerId: 'px', priority: 7.9 });
  assert.equal(catchall.pattern, '**', 'catchall forces the ** pattern');
  assert.equal(catchall.priority, 7);

  const bad = store.addRule({ id: 'rb', matchType: 'regex-ish', pattern: '.*', providerId: 'px' });
  assert.equal(bad.matchType, 'prefix', 'unknown matchType falls back to prefix');

  const noPriority = store.addRule({ id: 'rn', matchType: 'exact', pattern: 'm', providerId: 'px', priority: NaN });
  assert.equal(noPriority.priority, 100, 'non-finite priority falls back to the documented default');

  const disabled = store.addRule({ id: 'rd', matchType: 'exact', pattern: 'm', providerId: 'px', enabled: false });
  assert.equal(disabled.enabled, false);

  store.addRule({ id: 'rdup', matchType: 'catchall', providerId: 'px' });
  assert.throws(() => store.addRule({ id: 'rdup', matchType: 'catchall', providerId: 'px' }), /already exists/);

  assert.throws(() => store.updateRule('missing', { priority: 5 }), /not found/);
  const updated = store.updateRule('rn', { priority: 3 });
  assert.equal(updated.priority, 3);

  assert.equal(store.deleteRule('rd'), true);
  assert.equal(store.deleteRule('rd'), false);

  await flush(store);
  assert.ok(Array.isArray(readJson(`${tmpRoot}/rules-norm.json`).routingRules));
});

// ---------------------------------------------------------------------------
// resolveRoute: deterministic resolution order
// ---------------------------------------------------------------------------

/**
 * Build a store with given providers/rules and return the resolved
 * {providerId, ruleId|null} or null, for readable scenario tables below.
 */
function resolveScenario(name, providers, rules, model) {
  const store = newStore(name);
  for (const p of providers) store.createProvider(p);
  for (const r of rules) store.addRule(r);
  const hit = store.resolveRoute(model);
  return hit ? { providerId: hit.provider.id, ruleId: hit.rule?.id ?? null } : null;
}

test('resolveRoute: higher priority wins over higher specificity', () => {
  const hit = resolveScenario('route-priority',
    [{ id: 'a', defaultModel: 'ma' }, { id: 'b', defaultModel: 'mb' }],
    [
      { id: 'specific', matchType: 'exact', pattern: 'gpt-4', providerId: 'b', priority: 10 },
      { id: 'broad', matchType: 'catchall', providerId: 'a', priority: 50 },
    ],
    'gpt-4');
  assert.deepEqual(hit, { providerId: 'a', ruleId: 'broad' }, 'priority 50 beats exact match at 10');
});

test('resolveRoute: ties break by specificity exact > prefix > catchall', () => {
  const hit = resolveScenario('route-specificity',
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [
      { id: 'catch', matchType: 'catchall', providerId: 'c', priority: 100 },
      { id: 'pre', matchType: 'prefix', pattern: 'gpt-', providerId: 'b', priority: 100 },
      { id: 'exact', matchType: 'exact', pattern: 'gpt-4', providerId: 'a', priority: 100 },
    ],
    'gpt-4');
  assert.deepEqual(hit, { providerId: 'a', ruleId: 'exact' });

  const prefixHit = resolveScenario('route-specificity-prefix',
    [{ id: 'a' }, { id: 'c' }],
    [
      { id: 'catch', matchType: 'catchall', providerId: 'c', priority: 100 },
      { id: 'pre', matchType: 'prefix', pattern: 'gpt-', providerId: 'a', priority: 100 },
    ],
    'gpt-4o-mini');
  assert.deepEqual(prefixHit, { providerId: 'a', ruleId: 'pre' });

  const onlyCatchall = resolveScenario('route-catchall-only',
    [{ id: 'c' }],
    [{ id: 'catch', matchType: 'catchall', providerId: 'c', priority: 100 }],
    'anything-at-all');
  assert.deepEqual(onlyCatchall, { providerId: 'c', ruleId: 'catch' });
});

test('resolveRoute: full ties keep insertion order (stable sort)', () => {
  const hit = resolveScenario('route-stable',
    [{ id: 'first' }, { id: 'second' }],
    [
      { id: 'rule-first', matchType: 'catchall', providerId: 'first', priority: 1 },
      { id: 'rule-second', matchType: 'catchall', providerId: 'second', priority: 1 },
    ],
    'any-model');
  assert.deepEqual(hit, { providerId: 'first', ruleId: 'rule-first' },
    'equal priority and specificity -> earlier-added rule wins, deterministically');
});

test('resolveRoute: disabled rules are skipped entirely', () => {
  const hit = resolveScenario('route-rule-disabled',
    [{ id: 'a' }],
    [{ id: 'off', matchType: 'catchall', providerId: 'a', enabled: false }],
    'm');
  assert.equal(hit, null);
});

test('resolveRoute: matching rule over a disabled provider falls through to next candidate', () => {
  const hit = resolveScenario('route-provider-disabled',
    [{ id: 'off', enabled: false, defaultModel: 'x' }, { id: 'on', defaultModel: 'y' }],
    [
      { id: 'top', matchType: 'catchall', providerId: 'off', priority: 500 },
      { id: 'low', matchType: 'catchall', providerId: 'on', priority: 10 },
    ],
    'm');
  assert.deepEqual(hit, { providerId: 'on', ruleId: 'low' },
    'disabled provider cannot win even with the top-priority rule');
});

test('resolveRoute: unmatched rules fall back to first enabled provider with defaultModel', () => {
  const hit = resolveScenario('route-fallback',
    [{ id: 'no-default' }, { id: 'with-default', defaultModel: 'fallback-m' }],
    [{ id: 'never', matchType: 'exact', pattern: 'unrelated-model', providerId: 'no-default' }],
    'some-other-model');
  assert.deepEqual(hit, { providerId: 'with-default', ruleId: null });

  const none = resolveScenario('route-null',
    [{ id: 'no-default' }],
    [{ id: 'never', matchType: 'exact', pattern: 'x', providerId: 'no-default' }],
    'other');
  assert.equal(none, null, 'no rule matched and no fallback exists -> honest null');

  const emptyStore = newStore('route-empty');
  assert.equal(emptyStore.resolveRoute('anything'), null);
});

test('resolveRoute: empty/null model matches only catchall rules', () => {
  const store = newStore('route-blank-model');
  store.createProvider({ id: 'a' });
  store.addRule({ id: 'exact', matchType: 'exact', pattern: '', providerId: 'a' });
  store.addRule({ id: 'catch', matchType: 'catchall', providerId: 'a' });
  const hit = store.resolveRoute('');
  assert.equal(hit?.rule?.id, 'catch', 'blank model only satisfies the catchall rule');
});

// ---------------------------------------------------------------------------
// Model cache (in-memory, TTL'd)
// ---------------------------------------------------------------------------

test('models cache stores/hits/expires and invalidates on provider update', async () => {
  const store = newStore('cache');
  store.createProvider({ id: 'p', defaultModel: 'm' });

  assert.equal(store.getCachedModels('p'), null, 'cold cache misses');

  store.putCachedModels('p', [{ id: 'model-a' }]);
  assert.deepEqual(store.getCachedModels('p'), [{ id: 'model-a' }]);

  // TTL expiry without fake timers: age the entry past the 10 minute TTL.
  const entry = store.modelsCache.get('p');
  entry.ts = Date.now() - (11 * 60 * 1000);
  assert.equal(store.getCachedModels('p'), null, 'stale entry expires');

  store.putCachedModels('p', [{ id: 'fresh' }]);
  store.updateProvider('p', { name: 'renamed' });
  assert.equal(store.getCachedModels('p'), null, 'provider mutation invalidates its cache');

  store.deleteProvider('p');
  assert.equal(store.modelsCache.has('p'), false, 'delete clears any residual cache entry');
});

// ---------------------------------------------------------------------------
// refreshModels against a local fixture server (exercises upstream.fetchModelList)
// ---------------------------------------------------------------------------

test('refreshModels fetches, maps and caches a real model list', async () => {
  let sawAuth = '';
  const fx = await startHttpServer((req, res) => {
    sawAuth = req.headers.authorization || '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: [
        { id: 'gpt-a', owned_by: 'org' },
        { id: 'gpt-b' },
        { id: '' },            // dropped by the mapper
        {},                    // dropped by the mapper
        { name: 'named-not-id' }, // id-less entries fall back to name
      ],
    }));
  });
  try {
    const store = newStore('refresh');
    store.createProvider({ id: 'prov', type: 'openai-compatible', baseUrl: fx.url(''), keyRef: 'k' });

    const models = await store.refreshModels('prov', () => 'secret-key-value');
    assert.ok(sawAuth.startsWith('Bearer '), `GET used bearer auth, got ${sawAuth}`);
    assert.deepEqual(models, [
      { id: 'gpt-a', owned_by: 'org' },
      { id: 'gpt-b', owned_by: undefined },
      { id: 'named-not-id', owned_by: undefined },
    ]);
    assert.deepEqual(store.getCachedModels('prov'), models, 'result cached after refresh');

    assert.rejects(() => store.refreshModels('missing-provider', () => ''), /not found/);
  } finally {
    await fx.close();
  }
});
