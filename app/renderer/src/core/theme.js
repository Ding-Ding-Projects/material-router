// Purpose: light/dark/system theme application + persistence + change hooks.
// Owned by Foundation Core lane; Appearance lane layers presets on top of
// this module's onChange surface.

import * as settings from './settings.js';
import { invoke } from './bridge.js';

const listeners = new Set();
let systemMedia = null;

export function currentTheme() {
  const mode = settings.get('appearance.theme', 'system');
  if (mode === 'system') {
    return systemMedia?.matches ? 'dark' : 'light';
  }
  return mode === 'dark' ? 'dark' : 'light';
}

export function currentMode() {
  return settings.get('appearance.theme', 'system');
}

export async function setTheme(mode) {
  if (!['light', 'dark', 'system'].includes(mode)) throw new Error(`unknown theme "${mode}"`);
  await settings.set('appearance.theme', mode);
  apply();
}

export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function init() {
  systemMedia = window.matchMedia('(prefers-color-scheme: dark)');
  systemMedia.addEventListener('change', () => apply());
  apply();
}

function apply() {
  const resolved = currentTheme();
  document.documentElement.dataset.theme = resolved;
  // Native controls, form popups and scrollbars follow color-scheme, so an
  // explicit dark/light choice pins it and system keeps both allowed.
  document.documentElement.style.colorScheme =
    currentMode() === 'system' ? 'light dark' : resolved;
  syncThemeColorMeta();
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--md-sys-color-background').trim() || '#141218';
  // Keep the frameless window's native background in step to avoid flashes.
  invoke('shell:set-background-color', { color: bg }).catch(() => {});
  for (const cb of [...listeners]) {
    try { cb(resolved); } catch { /* listener errors stay isolated */ }
  }
}

let themeColorMeta = null;

/** Mirror the computed surface colour into <meta name="theme-color"> (PG-05). */
function syncThemeColorMeta() {
  const styles = getComputedStyle(document.documentElement);
  const color = styles.getPropertyValue('--md-sys-color-surface').trim()
    || styles.getPropertyValue('--md-sys-color-background').trim();
  if (!color) return;
  if (!themeColorMeta) {
    themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeColorMeta) {
      themeColorMeta = document.createElement('meta');
      themeColorMeta.setAttribute('name', 'theme-color');
      document.head.append(themeColorMeta);
    }
  }
  themeColorMeta.setAttribute('content', color);
}
