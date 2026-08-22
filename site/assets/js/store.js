/* Site settings store: one versioned schema in localStorage.
   Mirrors the app's JSONStore discipline (versioned, bounded, atomic within
   the single localStorage transaction) for the site's own per-visitor state. */

import { storage } from './util.js';

export const SETTINGS_VERSION = 1;

export const DEFAULTS = Object.freeze({
  schemaVersion: SETTINGS_VERSION,
  language: 'en',              // en | zh | bi
  funnyEn: 5,                  // 1..5
  funnyZh: 5,                  // 1..5
  emojiOn: true,
  schoolMode: false,
  appearance: {
    theme: 'system',           // light | dark | system
    accent: '',                // '' = token default; '#rrggbb' or RAINBOW sentinel
    rainbowSecondsLevel: 2,    // 1..5 speed level, mapped once below
    density: 0,                // -1 compact, 0 default, 1 roomy
    fontFamily: '',
    fontScale: 100,            // percent
    fontWeight: 400,
    letterSpacing: 0,
    lineHeight: 150,
    reduceMotion: false,
  },
  scheduleEnabled: true,
  lowStimulation: false,
  showSessionTime: false,
  nextAction: '',
  paletteFullWindow: false,
});

/* Level -> seconds for a full hue cycle. One mapping, read by CSS var writer. */
export const RAINBOW_LEVEL_SECONDS = { 1: 60, 2: 30, 3: 15, 4: 8, 5: 4 };

const listeners = new Set();

let current = hydrate();

function hydrate() {
  const saved = storage.get('settings', null);
  if (!saved || saved.schemaVersion !== SETTINGS_VERSION) {
    // Unknown or older schema: start from defaults rather than partially applying.
    return structuredClone(DEFAULTS);
  }
  return deepMerge(structuredClone(DEFAULTS), saved);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], v);
    } else if (k in base) {
      base[k] = v;
    }
  }
  return base;
}

export function getSettings() {
  return current;
}

export function updateSettings(patch) {
  deepMerge(current, patch);
  persist();
}

export function replaceSettings(next) {
  const merged = deepMerge(structuredClone(DEFAULTS), next || {});
  merged.schemaVersion = SETTINGS_VERSION;
  current = merged;
  persist();
  emit();
}

function persist() {
  storage.set('settings', current);
  emit();
}

function emit() {
  for (const fn of listeners) {
    try { fn(current); } catch { /* one bad listener never blocks the rest */ }
  }
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
