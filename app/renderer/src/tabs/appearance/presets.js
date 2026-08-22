// Purpose: named appearance presets. Five built-in M3-faithful seeds ship in
// code (never persisted, so they can never drift from what was shipped);
// user-saved presets persist through settings and export/import as a JSON
// file. Applying a preset writes the same settings keys the manual controls
// write - there is no second path that could disagree with them.
// Owned by Appearance lane.

import * as settings from '../../core/settings.js';
import { saveBlob } from '../../core/util.js';
import { RAINBOW } from './colors.js';

/**
 * The values a preset captures. Deliberately narrow: theme stays the user's
 * own choice (a preset should not silently flip light/dark), while the rest
 * of the global look is captured.
 */
const CAPTURED_KEYS = ['density', 'accentSeed', 'fontFamily', 'typeScale', 'baseWeight', 'rainbowSpeed'];

export const PRESET_SCHEMA_VERSION = 1;
export const MAX_USER_PRESETS = 100;

/** Five M3-faithful reference schemes (seed colours from M3 sample palettes). */
export function builtInPresets() {
  return [
    { id: 'builtin-baseline', name: { en: 'M3 Baseline', zh: 'M3 基準紫' }, accentSeed: '#6750a4' },
    { id: 'builtin-blue', name: { en: 'M3 Blue', zh: 'M3 藍' }, accentSeed: '#0061a4' },
    { id: 'builtin-green', name: { en: 'M3 Green', zh: 'M3 綠' }, accentSeed: '#006e1c' },
    { id: 'builtin-amber', name: { en: 'M3 Amber', zh: 'M3 琥珀' }, accentSeed: '#7c5800' },
    { id: 'builtin-rose', name: { en: 'M3 Rose', zh: 'M3 玫瑰紅' }, accentSeed: '#984061' },
  ].map((p) => ({ ...p, builtIn: true, values: captureValues({ accentSeed: p.accentSeed }) }));
}

function captureValues(overrides = {}) {
  const values = {};
  for (const key of CAPTURED_KEYS) {
    values[key] = overrides[key] !== undefined
      ? overrides[key]
      : settings.get(`appearance.${key}`, undefined);
  }
  return values;
}

function userPresets() {
  const list = settings.get('appearance.presets', []);
  return Array.isArray(list) ? list : [];
}

export function allPresets() {
  return [...builtInPresets(), ...userPresets()];
}

/** Apply a preset's captured values through the same settings path as the UI. */
export async function applyPreset(preset) {
  if (!preset?.values) throw new Error('applyPreset: preset.values missing');
  for (const key of CAPTURED_KEYS) {
    if (preset.values[key] !== undefined) {
      await settings.set(`appearance.${key}`, preset.values[key]);
    }
  }
}

/** Capture current values into a named user preset. */
export async function saveCurrentAsPreset(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('saveCurrentAsPreset: name required');
  if (trimmed.length > 80) throw new Error('saveCurrentAsPreset: name too long');
  const list = userPresets().filter((p) => p.name !== trimmed);
  if (list.length >= MAX_USER_PRESETS) {
    throw new Error(`saveCurrentAsPreset: limit of ${MAX_USER_PRESETS} saved presets reached`);
  }
  const preset = {
    id: `user_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    builtIn: false,
    createdAt: new Date().toISOString(),
    values: captureValues(),
  };
  list.push(preset);
  await settings.set('appearance.presets', list);
  return preset;
}

export async function deleteUserPreset(id) {
  const list = userPresets().filter((p) => p.id !== id);
  await settings.set('appearance.presets', list);
}

/**
 * Export payload: user presets only by default; includeBuiltIns also carries
 * the five shipped ones marked so an import never overwrites them.
 */
export function exportPayload({ includeBuiltIns = false, ids = null } = {}) {
  let users = userPresets();
  if (Array.isArray(ids)) users = users.filter((p) => ids.includes(p.id));
  return {
    kind: 'material-router-appearance-presets',
    schemaVersion: PRESET_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    presets: includeBuiltIns
      ? [...builtInPresets(), ...users]
      : users,
  };
}

export function exportJson(options) {
  return `${JSON.stringify(exportPayload(options), null, 2)}\n`;
}

export function downloadPresets(filename, options) {
  saveBlob(filename, new Blob([exportJson(options)], { type: 'application/json' }));
}

/**
 * Validate and import an exported file. Returns the number imported.
 * Built-ins inside the file are recognised but not re-stored; unknown or
 * malformed entries are rejected loudly with a count rather than partially
 * applied.
 */
export async function importFromText(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new Error('importPresets: file is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object'
    || parsed.kind !== 'material-router-appearance-presets') {
    throw new Error('importPresets: not a Material Router presets export');
  }
  if (Number(parsed.schemaVersion) !== PRESET_SCHEMA_VERSION) {
    throw new Error(`importPresets: unsupported schemaVersion ${parsed.schemaVersion}`);
  }
  if (!Array.isArray(parsed.presets)) {
    throw new Error('importPresets: presets array missing');
  }
  const incoming = [];
  let skippedBuiltIn = 0;
  for (const raw of parsed.presets) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error('importPresets: a preset is missing its name');
    }
    if (!raw.values || typeof raw.values !== 'object') {
      throw new Error(`importPresets: preset "${raw.name}" has no values`);
    }
    if (raw.builtIn === true || String(raw.id ?? '').startsWith('builtin-')) {
      skippedBuiltIn += 1;
      continue;
    }
    const values = {};
    for (const key of CAPTURED_KEYS) {
      if (raw.values[key] === undefined) continue;
      const v = raw.values[key];
      // Sentinel passes through untouched; everything else must be sane.
      if (key === 'accentSeed' && v === RAINBOW) { values[key] = RAINBOW; continue; }
      if ((key === 'accentSeed' && v !== '' && !/^#[0-9a-f]{6}$/i.test(v))
        || (key === 'typeScale' && (!Number.isFinite(Number(v)) || Number(v) < 0.5 || Number(v) > 2))
        || (key === 'rainbowSpeed' && (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 5))) {
        throw new Error(`importPresets: preset "${raw.name}" value "${key}" out of range`);
      }
      values[key] = key === 'typeScale' ? Number(v) : v;
    }
    incoming.push({
      id: `user_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${incoming.length}`,
      name: raw.name.trim().slice(0, 80),
      builtIn: false,
      createdAt: new Date().toISOString(),
      values,
    });
  }

  if (incoming.length > 0) {
    const existingNames = new Set(userPresets().map((p) => p.name));
    const merged = [...userPresets()];
    for (const p of incoming) {
      if (existingNames.has(p.name)) continue; // keep the user's copy
      merged.push(p);
    }
    if (merged.length > MAX_USER_PRESETS) {
      throw new Error(`importPresets: would exceed ${MAX_USER_PRESETS} saved presets`);
    }
    await settings.set('appearance.presets', merged);
  }
  return { imported: incoming.length, skippedBuiltIn };
}

/** Reset every appearance customization to shipped defaults (global reset). */
export async function resetAllToDefaults() {
  const keys = [
    'appearance.density', 'appearance.accentSeed', 'appearance.fontFamily',
    'appearance.typeScale', 'appearance.baseWeight', 'appearance.rainbowSpeed',
    'appearance.recentColors',
  ];
  for (const key of keys) {
    const fallback = key === 'appearance.typeScale' ? 1
      : key === 'appearance.baseWeight' ? 400
        : key === 'appearance.rainbowSpeed' ? 3
          : '';
    await settings.set(key, fallback);
  }
}
