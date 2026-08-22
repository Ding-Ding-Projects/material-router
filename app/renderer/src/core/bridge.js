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

export const platform = globalThis.materialRouter?.platform || 'unknown';
