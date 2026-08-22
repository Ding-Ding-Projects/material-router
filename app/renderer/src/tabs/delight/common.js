// Purpose: shared helpers for the Delight lane renderer modules: boot
// readiness, the personal-vocabulary text transform for this lane's own
// surfaces, app-data path lookup, and small formatting helpers.
// Owned by Delight lane.

import { invoke } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { copy } from '../../core/i18n.js';

/** Run fn once the settings cache is populated (boot ordering safety). */
export function whenReady(fn) {
  const tick = () => {
    if (settings.ready()) {
      try { fn(); } catch (err) { console.error('[delight] init failed:', err); }
    } else {
      setTimeout(tick, 40);
    }
  };
  tick();
}

let vocabEntries = null;

export async function refreshVocabCache() {
  try {
    const data = await invoke('vault:delight-vocab-entries');
    vocabEntries = data?.entries && typeof data.entries === 'object' ? data.entries : {};
  } catch {
    vocabEntries = null;
  }
  return vocabEntries;
}

/**
 * Apply personal-vocabulary replacements to a string rendered by THIS lane's
 * surfaces. Other surfaces keep their shipped wording until the shared i18n
 * transform hook exists - stated honestly in the vocabulary UI.
 */
export function vt(text) {
  if (!vocabEntries || typeof text !== 'string') return text;
  let out = text;
  for (const [k, v] of Object.entries(vocabEntries)) out = out.split(k).join(v);
  return out;
}

/** copy() + personal vocabulary: descriptive prose path for this lane. */
export function dc(nsKey, params) {
  return vt(copy(nsKey, params));
}

let userDataPath = null;
export async function getUserDataPath() {
  if (userDataPath) return userDataPath;
  try {
    const info = await invoke('shell:app-info');
    userDataPath = info?.userDataPath ?? '';
  } catch {
    userDataPath = '';
  }
  return userDataPath;
}

export function schoolActive() {
  return Boolean(settings.get('school.active', false));
}

export function schoolLabel() {
  const custom = String(settings.get('school.label', '') || '').trim();
  return custom || copy('dl.school.title');
}
