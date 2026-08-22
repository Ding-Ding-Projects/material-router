// Purpose: tiny typed-ish facade over the preload bridge so modules import
// `invoke` instead of reaching into window.materialRouter everywhere (and so
// unit-style imports do not explode when the bridge is absent).
// Owned by Foundation Core lane.

export function invoke(channel, payload) {
  const bridge = globalThis.materialRouter;
  if (!bridge) return Promise.reject(new Error(`bridge unavailable for "${channel}"`));
  return bridge.invoke(channel, payload);
}

export function on(event, cb) {
  const bridge = globalThis.materialRouter;
  if (!bridge) return () => {};
  return bridge.on(event, cb);
}

/**
 * Subscribe to several events at once and get one unsubscribe for all of them.
 * The natural fit for a tab def's destroy() hook: tear the whole group down
 * with a single call, and it stays safe to call twice (the list is drained).
 * @param {Array<[string, Function]>} subscriptions - [event, cb] pairs.
 * @returns {() => void} combined unsubscribe (idempotent).
 */
export function onAll(subscriptions) {
  const offs = [];
  for (const [event, cb] of subscriptions ?? []) {
    const off = on(event, cb);
    if (typeof off === 'function') offs.push(off);
  }
  return () => {
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* one bad unsubscribe never blocks the rest */ }
    }
  };
}

export const platform = globalThis.materialRouter?.platform || 'unknown';
