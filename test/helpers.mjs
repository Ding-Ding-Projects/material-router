// Purpose: shared test utilities for the pure-core suite.
// Zero dependencies: node:test + node:assert + node builtins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Create a unique temp directory for one test file; caller removes it in after(). */
export function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `material-router-${label}-`));
}

export function rmRf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * after() hook for test files that write under a temp dir: JSONStore.set()
 * kicks off unawaited background saves, and a debounced timer can still fire
 * milliseconds after the last test. Settle first so cleanup never races a
 * write that is still landing.
 */
export function makeTempCleanup(dir, settleMs = 300) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    rmRf(dir);
  };
}

/** Read a JSON file from disk (throws if absent or invalid — assertions want that). */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Tiny SSE/http fixture server on an ephemeral loopback port.
 * handler(req, res) decides the response; tests close it via server.close()
 * plus closeAllConnections so hung sockets cannot keep the process alive.
 */
import http from 'node:http';

export function startHttpServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
        close: async () => {
          // Node >=18.2: force-close kept-alive sockets so close() resolves
          // even when a fixture deliberately never responds.
          try { server.closeAllConnections?.(); } catch { /* older node */ }
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

/**
 * Patch a method on a live object (e.g. fs.promises.rename) to intercept calls,
 * delegating to the original afterwards. Returns { restore() }.
 * Used as the error-injection seam for store.js retry logic: the module imports
 * `fs` directly and exposes no DI seam, but the fs.promises object is shared
 * and mutable in-process.
 */
export function patchMethod(obj, name, wrapper) {
  const original = obj[name].bind(obj);
  let active = true;
  obj[name] = (...args) => {
    if (!active) return original(...args);
    return wrapper(original, ...args);
  };
  return {
    restore() {
      active = false;
      delete obj[name];
      // Restore the own property only if we installed one; deleting returns the
      // prototype method. Assign back defensively in case it was an own prop.
      if (!obj[name]) obj[name] = original;
    },
  };
}
