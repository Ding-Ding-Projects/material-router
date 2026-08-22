// Purpose: Server lane bridge - the authoritative log store for the Server &
// Logs tab, access-token generation, restart handling, and config-drift
// reporting. Registered after the builtin handlers, so the logs:query /
// logs:clear overrides here are the ones the renderer talks to (the HANDOFF
// seam map assigns the logs:query channel to this lane).
// Owned by Server lane.

import crypto from 'node:crypto';
import { registerHandler } from '../ipc.js';

const LOG_STORE_MAX = 2000;

/**
 * @param {{settingsStore:any, vault:any, routerServer:any}} ctx
 */
export function register({ settingsStore, vault, routerServer }) {
  // -- authoritative log store ------------------------------------------------
  // Mirrors every event the router emits, capped like the foundation ring.
  // Counters: totalReceived counts everything since launch; routed counts the
  // request-shaped entries currently kept, so clearing the log resets it.
  /** @type {Array<object>} */
  const logStore = [];
  const logKeys = new Set();
  let totalReceived = 0;
  let dropped = 0;

  // Config actually bound by the running listener. server.js reads port/host
  // from settings at listen() time only, so drift must be measured against a
  // snapshot taken when the listen status event fires - getStatus() alone
  // would report the desired values and hide real drift.
  /** @type {{host:string, port:number}|null} */
  let applied = null;

  routerServer.on('log', (event) => {
    totalReceived += 1;
    const key = logKey(event);
    if (!logKeys.has(key)) {
      logKeys.add(key);
      logStore.push(event);
      if (logStore.length > LOG_STORE_MAX) {
        const overflow = logStore.length - LOG_STORE_MAX;
        for (let i = 0; i < overflow; i++) logKeys.delete(logKey(logStore[i]));
        logStore.splice(0, overflow);
        dropped += overflow;
      }
    }
    if (event?.kind === 'status' && event?.endpoint === 'listen') {
      const detail = String(event.detail ?? '');
      const sep = detail.lastIndexOf(':');
      applied = {
        host: sep === -1 ? detail : detail.slice(0, sep),
        port: sep === -1 ? Number.NaN : Number(detail.slice(sep + 1)),
      };
    } else if (event?.kind === 'status' && event?.endpoint === 'stopped') {
      applied = null;
    }
  });

  function routedCount() {
    return logStore.filter((e) => e?.kind === 'route' || e?.kind === 'request').length;
  }

  // -- logs domain -------------------------------------------------------------
  // Overrides the builtin ring-backed handlers (registered earlier); channel
  // names and response shapes stay identical.
  registerHandler('logs', 'query', ({ limit = 200 } = {}) => {
    const n = Math.max(1, Math.min(Number(limit) || 200, LOG_STORE_MAX));
    return logStore.slice(-n);
  });

  registerHandler('logs', 'clear', () => {
    logStore.length = 0;
    logKeys.clear();
    return true;
  });

  registerHandler('logs', 'stats', () => ({
    stored: logStore.length,
    totalReceived,
    routed: routedCount(),
    dropped,
  }));

  // -- server domain additions ---------------------------------------------------
  /**
   * Generate a strong bearer token, store it in the vault under the id the
   * router already reads ('routerToken'), and hand it back exactly once.
   * The value is never logged and never returned by any other handler.
   */
  registerHandler('server', 'generate-token', () => {
    const token = `mr_${crypto.randomBytes(32).toString('base64url')}`;
    const encrypted = vault.setSecret('routerToken', token);
    return { token, encryptionAvailable: Boolean(encrypted) };
  });

  /** Presence only. Token values are reveal-once at generation time. */
  registerHandler('server', 'token-status', () => ({
    present: Boolean(vault.has('routerToken')),
  }));

  registerHandler('server', 'config-state', () => {
    const desired = {
      port: Number(settingsStore.get('server.port', 8787)),
      host: String(settingsStore.get('server.host', '127.0.0.1')),
      corsEnabled: Boolean(settingsStore.get('server.corsEnabled', false)),
      authRequired: Boolean(settingsStore.get('server.authRequired', false)),
    };
    const running = routerServer.isRunning;
    const drift = [];
    if (running && applied) {
      if (applied.port !== desired.port) drift.push('port');
      if (applied.host !== desired.host) drift.push('host');
    }
    return { desired, applied, running, drift };
  });

  /**
   * Apply pending port/host changes: stop, then start again with current
   * settings. If start fails (busy port, bad host) the error propagates and
   * the listener stays stopped - the UI surfaces the reason honestly.
   */
  registerHandler('server', 'restart', async () => {
    await routerServer.stop();
    await routerServer.start();
    return routerServer.getStatus();
  });
}

/** Stable dedupe key for one log event. */
function logKey(e) {
  return [
    e?.ts, e?.id, e?.kind, e?.direction, e?.model, e?.provider,
    e?.endpoint, e?.ms, e?.bytes, e?.status, e?.detail, e?.error,
  ].join('|');
}
