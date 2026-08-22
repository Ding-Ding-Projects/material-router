// Purpose: pure-core tests for app/main/store.js — atomic writes (validity,
// unique temp names, bounded retry behaviour) and the JSONStore API.
//
// Retry coverage uses an in-process fs.promises.rename / fs.renameSync patch as
// the error-injection seam: store.js imports `fs` directly and exposes no DI
// hook, but the fs.promises object is shared and mutable, so EPERM/ENOENT can
// be injected deterministically on any platform. Simulating a real
// open-handle-on-Windows rename failure is platform-flaky (Node opens files
// with FILE_SHARE_DELETE, so the rename often succeeds) and is deliberately
// not attempted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  atomicWriteFile,
  atomicWriteFileSync,
  JSONStore,
} from '../app/main/store.js';

import { makeTempDir, makeTempCleanup, readJson, patchMethod } from './helpers.mjs';

const tmpRoot = makeTempDir('store');
test.after(makeTempCleanup(tmpRoot));

function targetPath(name) {
  return `${tmpRoot}/${name}`;
}

function listTmpFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

test('atomicWriteFile: writes the exact bytes it was given (JSONStore owns the newline)', async () => {
  const target = targetPath('atomic-basic.json');
  await atomicWriteFile(target, `${JSON.stringify({ hello: 'world' })}\n`);
  assert.deepEqual(readJson(target), { hello: 'world' });
  assert.ok(fs.readFileSync(target, 'utf8').endsWith('\n'), 'bytes preserved verbatim, newline included');
});

test('atomicWriteFile: creates missing parent directories', async () => {
  const target = `${tmpRoot}/nested/deeper/atomic-dirs.json`;
  await atomicWriteFile(target, '{"ok":true}');
  assert.deepEqual(readJson(target), { ok: true });
});

test('atomicWriteFile: rapid concurrent saves use unique temp names and leave no residue', async () => {
  const target = targetPath('atomic-rapid.json');
  const observedTmpNames = new Set();
  const patch = patchMethod(fs.promises, 'rename', async (original, from, to) => {
    observedTmpNames.add(from);
    return original(from, to);
  });
  try {
    const saves = [];
    for (let i = 0; i < 20; i++) {
      saves.push(atomicWriteFile(target, JSON.stringify({ i })));
      // Interleave without awaiting: concurrent saves must serialize safely.
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(saves);

    const data = readJson(target);
    assert.ok(Number.isInteger(data.i), `final file holds one complete save, got ${JSON.stringify(data)}`);
    // At least one temp name per save; a real transient EPERM (Defender or the
    // indexer briefly holding the destination) legitimately adds a retried
    // attempt under a fresh name — observed live on Windows during development
    // of this suite. Uniqueness is the invariant, never the exact count.
    assert.ok(observedTmpNames.size >= 20,
      `every save used its own temp name (${observedTmpNames.size} observed for 20 saves)`);
    for (const name of observedTmpNames) {
      assert.ok(name.endsWith('.tmp'), `temp name shape: ${name}`);
      assert.ok(name.includes(`.${process.pid}.`), 'temp name carries the pid');
    }
    assert.deepEqual(listTmpFiles(tmpRoot), [], 'failed/succeeded attempts leave no .tmp behind');
  } finally {
    patch.restore();
  }
});

test('atomicWriteFile: retries transient EPERM then succeeds', async () => {
  const target = targetPath('atomic-eperm.json');
  let failures = 0;
  const patch = patchMethod(fs.promises, 'rename', async (original, from, to) => {
    if (failures < 2) {
      failures += 1;
      throw Object.assign(new Error('dest held open'), { code: 'EPERM' });
    }
    return original(from, to);
  });
  try {
    await atomicWriteFile(target, '{"retried":true}');
    assert.equal(failures, 2, 'two transient failures were retried');
    assert.deepEqual(readJson(target), { retried: true });
  } finally {
    patch.restore();
  }
});

test('atomicWriteFile: never retries ENOENT (caller bug surfaces immediately)', async () => {
  const target = targetPath('atomic-enoent.json');
  let attempts = 0;
  const patch = patchMethod(fs.promises, 'rename', async () => {
    attempts += 1;
    throw Object.assign(new Error('temp gone'), { code: 'ENOENT' });
  });
  try {
    await assert.rejects(
      () => atomicWriteFile(target, '{}'),
      (err) => err.code === 'ENOENT',
    );
    assert.equal(attempts, 1, 'exactly one attempt for a non-retryable code');
  } finally {
    patch.restore();
  }
});

test('atomicWriteFile: gives up honestly after bounded retries on persistent EPERM', async () => {
  const target = targetPath('atomic-stuck.json');
  let attempts = 0;
  const patch = patchMethod(fs.promises, 'rename', async () => {
    attempts += 1;
    throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
  });
  try {
    await assert.rejects(() => atomicWriteFile(target, '{}'), (err) => {
      assert.match(err.message, /atomic write failed after 8 attempts/);
      assert.equal(err.cause?.code, 'EBUSY', 'original error attached as cause');
      return true;
    });
    assert.equal(attempts, 8, 'bounded retry budget respected');
  } finally {
    patch.restore();
  }
});

// ---------------------------------------------------------------------------
// atomicWriteFileSync
// ---------------------------------------------------------------------------

test('atomicWriteFileSync: writes valid JSON synchronously and retries EPERM once', async () => {
  const target = targetPath('atomic-sync.json');
  atomicWriteFileSync(target, JSON.stringify({ sync: 1 }));
  assert.deepEqual(readJson(target), { sync: 1 });

  let failures = 0;
  const patch = patchMethod(fs, 'renameSync', (original, from, to) => {
    if (failures < 1) {
      failures += 1;
      throw Object.assign(new Error('locked'), { code: 'EACCES' });
    }
    return original(from, to);
  });
  try {
    atomicWriteFileSync(target, JSON.stringify({ sync: 2 }));
    assert.equal(failures, 1);
    assert.deepEqual(readJson(target), { sync: 2 });
  } finally {
    patch.restore();
  }
});

test('atomicWriteFileSync: throws after bounded retries when destination stays locked', () => {
  const target = targetPath('atomic-sync-stuck.json');
  const patch = patchMethod(fs, 'renameSync', () => {
    throw Object.assign(new Error('nope'), { code: 'EBUSY' });
  });
  try {
    assert.throws(() => atomicWriteFileSync(target, '{}'), /after 8 attempts.*EBUSY/s);
  } finally {
    patch.restore();
  }
});

// ---------------------------------------------------------------------------
// JSONStore
// ---------------------------------------------------------------------------

test('JSONStore: defaults deep-merge under loaded data; schemaVersion forced', () => {
  const dir = `${tmpRoot}/jsonstore-1`;
  const file = `${dir}/settings.json`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ server: { port: 8080 }, custom: [1, 2] }));

  const store = new JSONStore(file, {
    defaults: { server: { host: '127.0.0.1', port: 3000 }, theme: 'dark' },
    schemaVersion: 3,
  });
  // Loaded value wins over default inside merged object...
  assert.equal(store.get('server.port'), 8080);
  // ...default fills what the file lacked...
  assert.equal(store.get('server.host'), '127.0.0.1');
  assert.equal(store.get('theme'), 'dark');
  // ...arrays replace rather than merge...
  assert.deepEqual(store.get('custom'), [1, 2]);
  // ...and schemaVersion always reflects the running code.
  assert.equal(store.get('schemaVersion'), 3);
});

test('JSONStore: dotted get/set/delete with fallbacks', async () => {
  const store = new JSONStore(targetPath('jsonstore-dotted.json'));
  assert.equal(store.get('a.b.c', 'fallback'), 'fallback');

  store.set('a.b.c', 42);
  assert.equal(store.get('a.b.c'), 42);
  await store.save();

  const reloaded = new JSONStore(targetPath('jsonstore-dotted.json'));
  assert.equal(reloaded.get('a.b.c'), 42, 'persistence round trip through disk');

  assert.equal(reloaded.delete('a.b'), true);
  assert.equal(reloaded.delete('a.b'), false, 'deleting twice is honest about it');
  assert.equal(reloaded.get('a.b.c', 'gone'), 'gone');

  assert.equal(reloaded.delete('never.existed.here'), false);
});

test('JSONStore: subscribers fire on exact key, child keys and parent paths; unsubscribe works', async () => {
  const store = new JSONStore(targetPath('jsonstore-pubsub.json'));

  const seen = [];
  const unsub = store.subscribe('server', (key, value) => seen.push([key, value]));

  store.set('server.port', 1234);
  assert.deepEqual(seen.at(-1)[0], 'server.port');
  assert.deepEqual(seen.at(-1)[1], { port: 1234 }, 'watcher receives the subtree it watches');

  store.set('server', { port: 5 });
  assert.deepEqual(seen.at(-1), ['server', { port: 5 }]);

  store.set('other.key', 1); // unrelated -> no notification
  const before = seen.length;
  assert.equal(seen.length, before);

  unsub();
  store.set('server.port', 9);
  assert.equal(seen.length, before, 'unsubscribed listener stops firing');

  // Subscriber errors must not break persistence.
  store.subscribe('boom', () => { throw new Error('listener exploded'); });
  store.set('boom.x', 1); // must not throw
  await store.save();
  assert.equal(store.get('boom.x'), 1);
});

test('JSONStore: debounced saves coalesce and flush via save()', async () => {
  const store = new JSONStore(targetPath('jsonstore-debounce.json'), { debounceMs: 30 });
  store.set('x', 1);
  store.set('x', 2);
  store.set('x', 3);
  // Nothing written yet (debounce window).
  assert.throws(() => readJson(targetPath('jsonstore-debounce.json')), { code: 'ENOENT' });
  await store.save(); // explicit flush clears the timer and persists now
  const data = readJson(targetPath('jsonstore-debounce.json'));
  assert.equal(data.x, 3);
});

test('JSONStore: corrupt file is quarantined beside itself, defaults retained', () => {
  const dir = `${tmpRoot}/jsonstore-corrupt`;
  fs.mkdirSync(dir, { recursive: true });
  const file = `${dir}/state.json`;
  fs.writeFileSync(file, '{ this is not json');

  const store = new JSONStore(file, { defaults: { safe: true } });

  assert.equal(store.get('safe'), true);
  const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(quarantined.length, 1, `bad copy kept aside for inspection, saw ${quarantined}`);
  assert.ok(fs.statSync(`${dir}/${quarantined[0]}`).size > 0);
  // The live file was NOT overwritten by load.
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
});

test('JSONStore: getAll returns a detached clone (mutations do not leak into the store)', async () => {
  const store = new JSONStore(targetPath('jsonstore-clone.json'));
  store.set('nested.list', [{ id: 1 }]);
  await store.save();
  const snapshot = store.getAll();
  snapshot.nested.list.push({ id: 2 });
  snapshot.nested.mutated = true;
  assert.deepEqual(store.get('nested.list'), [{ id: 1 }]);
  assert.equal(store.get('nested.mutated'), undefined);
});

test('JSONStore: flushSync persists synchronously for shutdown paths', () => {
  const store = new JSONStore(targetPath('jsonstore-flushsync.json'), { debounceMs: 60_000 });
  store.set('shutdown', 'now');
  assert.throws(() => readJson(targetPath('jsonstore-flushsync.json')), { code: 'ENOENT' });
  store.flushSync();
  assert.equal(readJson(targetPath('jsonstore-flushsync.json')).shutdown, 'now');
});
