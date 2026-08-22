// Purpose: the only bridge between the sandboxed renderer and the main
// process. Exposes a minimal allowlisted surface. CommonJS by design:
// sandboxed preloads cannot be ES modules.
// Events delivered on the 'mr:event' channel: log, toast, server-status,
// update-status.
// Owned by Foundation Core lane.

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNEL = 'mr:event';

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
   * @param {string} event 'log' | 'toast' | 'server-status' | 'update-status'
   * @param {(data:any)=>void} cb
   */
  on(event, cb) {
    if (typeof event !== 'string' || typeof cb !== 'function') {
      throw new Error('on(event, cb) requires a string event and a callback');
    }
    const listener = (_e, envelope) => {
      if (envelope && envelope.type === event) {
        try { cb(envelope.data); } catch { /* listener errors stay isolated */ }
      }
    };
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
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
