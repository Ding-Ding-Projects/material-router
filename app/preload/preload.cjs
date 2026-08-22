// Purpose: the only bridge between the sandboxed renderer and the main
// process. Exposes a minimal allowlisted surface. CommonJS by design:
// sandboxed preloads cannot be ES modules.
// Events delivered on the 'mr:event' channel: log, toast, server-status,
// update-status.
// Owned by Foundation Core lane.

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNEL = 'mr:event';

// Main multiplexes every logical event (log, toast, server-status,
// update-status, plus lane events such as builder-stream) onto this ONE
// physical ipcRenderer channel. The bridge therefore installs a single
// physical listener for the page lifetime and fans envelopes out to per-event
// subscriber sets. One physical listener total means the count never grows
// with the number of subscribers and can never trip Node's default
// EventEmitter MaxListenersExceededWarning (observed at "11 mr:event
// listeners" once the Server & Logs tab mounted its two subscriptions).
/** @type {Map<string, Set<(data:any)=>void>>} */
const listenersByEvent = new Map();

ipcRenderer.on(EVENT_CHANNEL, (_e, envelope) => {
  if (!envelope || typeof envelope.type !== 'string') return;
  const subs = listenersByEvent.get(envelope.type);
  if (!subs || subs.size === 0) return;
  // Snapshot so a cb that unsubscribes mid-dispatch cannot corrupt iteration.
  for (const cb of [...subs]) {
    try { cb(envelope.data); } catch { /* listener errors stay isolated */ }
  }
});

contextBridge.exposeInMainWorld('materialRouter', {
  /**
   * Invoke a registered handler. The main process allowlists both the domain
   * and the exact channel; unknown channels are rejected there.
   * @param {string} channel e.g. "settings:get-all"
   * @param {object=} payload
   */
  invoke(channel, payload) {
    if (typeof channel !== 'string') {
      return Promise.reject(new Error('channel must be a string'));
    }
    return ipcRenderer.invoke('mr:invoke', channel, payload ?? {});
  },

  /**
   * Subscribe to a main-process event. Returns an unsubscribe function.
   * Registers into the per-event subscriber set behind the single physical
   * channel listener; it never adds another ipcRenderer listener.
   * @param {string} event 'log' | 'toast' | 'server-status' | 'update-status'
   * @param {(data:any)=>void} cb
   */
  on(event, cb) {
    if (typeof event !== 'string' || typeof cb !== 'function') {
      throw new Error('on(event, cb) requires a string event and a callback');
    }
    let subs = listenersByEvent.get(event);
    if (!subs) {
      subs = new Set();
      listenersByEvent.set(event, subs);
    }
    subs.add(cb);
    return () => {
      const current = listenersByEvent.get(event);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) listenersByEvent.delete(event);
    };
  },

  platform: process.platform,
  // App/product versions arrive via invoke('shell:app-info'); the sandboxed
  // preload cannot reach the app module itself.
  versions: {
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
  },
});
