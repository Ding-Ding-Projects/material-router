// Purpose: renderer-side settings cache. One load at bootstrap, dotted-path
// reads, writes go through IPC and update the local cache immediately.
// Owned by Foundation Core lane.

import { invoke } from './bridge.js';

let cache = null;
const changeListeners = new Set();

export async function init() {
  cache = await invoke('settings:get-all');
}

export function ready() {
  return cache !== null;
}

export function get(key, fallback = undefined) {
  if (!cache) return fallback;
  const value = key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), cache);
  return value === undefined ? fallback : value;
}

export function getAll() {
  return structuredClone(cache ?? {});
}

/** Persist a dotted-path value; resolves after the main process confirms. */
export async function set(key, value) {
  await invoke('settings:set', { key, value });
  applyLocal(key, value);
  for (const cb of [...changeListeners]) {
    try { cb(key, value); } catch { /* listener errors stay isolated */ }
  }
}

function applyLocal(key, value) {
  const keys = key.split('.');
  let node = cache ??= {};
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

export function onChange(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}
