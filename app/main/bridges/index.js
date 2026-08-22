// Lane bridge loader.
//
// Feature lanes add main-process IPC handlers by dropping a module into this
// directory. Every module here is auto-discovered and must export:
//
//   export function register(ctx) { ... }
//
// where ctx carries the singletons the builtin handlers use:
//   { settingsStore, vault, providersStore, routerServer, broadcast }
//
// No other file ever needs to change for a lane to extend the IPC surface,
// which keeps parallel feature branches merge-conflict-free.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SELF = path.dirname(fileURLToPath(import.meta.url));

/**
 * Import every sibling module except this loader and call its register(ctx).
 * Modules are sorted so registration order is deterministic across machines.
 * A module that throws fails loudly at startup rather than half-registering.
 */
export async function loadLaneBridges(ctx) {
  const files = readdirSync(SELF)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort();
  for (const file of files) {
    const mod = await import(path.join(SELF, file));
    if (typeof mod.register !== 'function') {
      throw new Error(`lane bridge ${file} must export register(ctx)`);
    }
    mod.register(ctx);
  }
}
