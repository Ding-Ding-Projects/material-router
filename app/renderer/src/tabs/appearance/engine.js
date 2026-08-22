// Purpose: the runtime appearance engine. Reads persisted settings, merges
// any ACTIVE scheduled-rule overrides on top, and writes ONE override
// <style> element that redefines tokens.css custom properties on :root.
// tokens.css itself is never edited; this file only composes custom-property
// values, which is the sanctioned extension surface.
//
// Rainbow handling: the sentinel value ('rainbow') is stored as-is in
// settings. The engine never string-appends it - it flips a data attribute
// and one duration variable, and core/appearance.css does all animation.
// Speed is stored as a LEVEL 1-5; the level->duration mapping lives exactly
// here and nowhere else.
// Owned by Appearance lane.

import * as settings from '../../core/settings.js';
import { invoke } from '../../core/bridge.js';
import { deriveScheme, RAINBOW, isSentinel } from './colors.js';

// ---------------------------------------------------------------------------
// Documented mappings (single source of truth)
// ---------------------------------------------------------------------------

/** Level -> one full hue cycle. Bigger level = faster (a speed control). */
export const RAINBOW_LEVELS = Object.freeze({
  1: '30s',
  2: '18s',
  3: '12s',
  4: '8s',
  5: '5s',
});

/** Reduced motion settles on exactly this hue instead of animating. */
export const RAINBOW_REDUCED_HUE = 215;

/** Density -> spacing scale (px), comfortable = shipped tokens.css values. */
export const DENSITY_SCALES = Object.freeze({
  comfortable: [4, 8, 12, 16, 24, 32, 48, 64],
  compact: [3, 6, 9, 12, 18, 24, 36, 48],
});

export const TYPE_SCALE_MIN = 0.85;
export const TYPE_SCALE_MAX = 1.25;

/** Body-text weight choices offered in the UI. */
export const WEIGHT_OPTIONS = [400, 500, 600, 700];

export const DEFAULTS = Object.freeze({
  density: 'comfortable',
  accentSeed: '',
  fontFamily: '',
  typeScale: 1,
  baseWeight: 400,
  rainbowSpeed: 3,
});

const SCHEDULE_TARGETS = ['theme', 'density', 'accent', 'fontFamily', 'typeScale', 'rainbowSpeed'];

const state = {
  rootStyleEl: null,
  elementStyleEl: null,
  /** Active per-schedule overrides: {target: value} - never persisted. */
  scheduleOverrides: {},
};

function ensureStyleEl(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.append(el);
  }
  return el;
}

function read(key, fallback) {
  return settings.get(`appearance.${key}`, fallback);
}

function clampScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(TYPE_SCALE_MAX, Math.max(TYPE_SCALE_MIN, n));
}

function cssFontFamily(name) {
  const safe = String(name).replace(/[\\"]/g, '').trim();
  if (!safe) return '';
  // Always keep the shipped stack behind a custom face so unknown or slow
  // fonts degrade to something readable.
  return `"${safe}", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
}

/**
 * Effective setting values = base settings overridden by any active schedule
 * override. Callers wanting "what would I save" should use settings directly;
 * this answers "what is rendering right now".
 */
export function effective(key) {
  if (Object.prototype.hasOwnProperty.call(state.scheduleOverrides, key)) {
    return state.scheduleOverrides[key];
  }
  return read(key, DEFAULTS[key]);
}

/** Called by the scheduler when rules activate/deactivate. */
export function setScheduleOverrides(map) {
  state.scheduleOverrides = map && typeof map === 'object' ? { ...map } : {};
  render();
}

export function hasScheduleOverrides() {
  return Object.keys(state.scheduleOverrides).length > 0;
}

/** Compose the :root override block from current values. */
function rootCss() {
  const lines = [];

  // Density -> spacing scale vars.
  const scale = DENSITY_SCALES[read('density', DEFAULTS.density)] ?? DENSITY_SCALES.comfortable;
  for (let i = 0; i < 8; i++) {
    lines.push(`--mr-space-${i + 1}:${scale[i]}px`);
  }

  // Type scale multiplier consumed by core/appearance.css typography rules.
  lines.push(`--mr-type-scale:${clampScale(effective('typeScale'))}`);

  // Body text weight.
  const weight = Number(read('baseWeight', DEFAULTS.baseWeight)) || 400;
  lines.push(`--mr-base-weight:${weight}`);

  // Font family (custom face first, shipped stack as fallback).
  const family = cssFontFamily(read('fontFamily', DEFAULTS.fontFamily) || '');
  if (family) {
    lines.push(`font-family:${family}`);
  } else {
    // Explicitly restore the shipped stack so a cleared setting un-applies.
    lines.push('font-family:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif');
  }

  // Accent seed -> M3-style roles for BOTH themes at once.
  const accent = read('accentSeed', DEFAULTS.accentSeed);
  const rainbowOn = isSentinel(accent);
  lines.push(`--mr-rainbow-duration:${RAINBOW_LEVELS[Number(read('rainbowSpeed', DEFAULTS.rainbowSpeed))] ?? RAINBOW_LEVELS[3]}`);
  if (!rainbowOn && accent && parseableHex(accent)) {
    const scheme = deriveScheme(accent);
    for (const themeName of ['light', 'dark']) {
      const prefix = themeName === 'light' ? ':root' : "[data-theme='dark']";
      const roles = scheme[themeName];
      for (const [role, value] of Object.entries(roles)) {
        const token = `--md-sys-color-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        lines.push(`${prefix}{${token}:${value}}`);
      }
    }
  }

  return `:root{${lines.join(';')}}`;
}

function parseableHex(value) {
  return /^#[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(String(value).trim());
}

/** Apply the composed root block + rainbow attribute + window background. */
export function renderRoot() {
  state.rootStyleEl ??= ensureStyleEl('mr-appearance-root');
  state.rootStyleEl.textContent = rootCss();

  const accent = read('accentSeed', DEFAULTS.accentSeed);
  const rainbowOn = isSentinel(accent);
  if (rainbowOn) document.documentElement.dataset.mrRainbow = 'on';
  else delete document.documentElement.dataset.mrRainbow;

  syncWindowBackground();
}

/**
 * Keep the frameless window's native background in step with the resolved
 * theme (same seam theme.js uses). A scheduled theme override wins because
 * it decides the dataset.
 */
function syncWindowBackground() {
  const scheduled = state.scheduleOverrides.theme;
  let resolved;
  if (scheduled === 'light' || scheduled === 'dark') {
    resolved = scheduled;
  } else if (scheduled === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    resolved = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  if (scheduled) document.documentElement.dataset.theme = resolved;
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--md-sys-color-background').trim();
  if (/^#[0-9a-f]{6}$/i.test(bg)) {
    invoke('shell:set-background-color', { color: bg }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Per-element / per-tab overrides
// ---------------------------------------------------------------------------

const PROP_CSS = {
  fontFamily: (v) => (v ? `font-family:${cssFontFamily(v)}` : ''),
  fontSize: (v) => (numOk(v) ? `font-size:${Math.round(v)}px` : ''),
  fontWeight: (v) => (numOk(v, 100, 900) ? `font-weight:${Math.round(v)}` : ''),
  italic: (v) => (v == null ? '' : `font-style:${v ? 'italic' : 'normal'}`),
  textColor: (v) => (isSentinel(v) ? 'color:var(--md-sys-color-primary)' : (parseableHex(v) ? `color:${v}` : '')),
  bgColor: (v) => (isSentinel(v) ? 'background-color:var(--md-sys-color-primary-container)' : (parseableHex(v) ? `background-color:${v}` : '')),
  radius: (v) => (numOk(v, 0, 999) ? `border-radius:${Math.round(v)}px` : ''),
  underline: (v) => (!v || v === 'none' ? '' : `text-decoration-line:underline;text-decoration-style:${v}`),
  underlineColor: (v) => (parseableHex(v) ? `text-decoration-color:${v}` : ''),
  strike: (v) => (!v || v === 'none' ? '' : 'text-decoration-line:line-through'),
  overline: (v) => (v ? 'text-decoration-line:overline' : ''),
  caps: (v) => (v && v !== 'none' ? `text-transform:${v}` : ''),
  smallCaps: (v) => (v ? 'font-variant-caps:all-small-caps' : ''),
  letterSpacing: (v) => (numOk(v, -4, 12) ? `letter-spacing:${round1(v)}px` : ''),
  wordSpacing: (v) => (numOk(v, -8, 24) ? `word-spacing:${round1(v)}px` : ''),
  lineHeight: (v) => (numOk(v, 0.8, 3) ? `line-height:${round1(v)}` : ''),
  script: (v) => (v === 'super' ? 'vertical-align:super;font-size:.85em' : (v === 'sub' ? 'vertical-align:sub;font-size:.85em' : '')),
  shadowBlur: (v) => '', // composed below with opacity (needs both)
  shadowOpacity: (v) => '',
};

function numOk(v, min = -Infinity, max = Infinity) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max && !(typeof v === 'string' && v.trim() === '');
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function decorationLines(props) {
  // text-decoration-line must be ONE declaration; combine underline/overline/
  // line-through when several are requested.
  const parts = [];
  if (props.underline && props.underline !== 'none') parts.push('underline');
  if (props.overline) parts.push('overline');
  if (props.strike && props.strike !== 'none') parts.push('line-through');
  if (parts.length === 0) return '';
  let css = `text-decoration-line:${parts.join(' ')}`;
  if (parts.includes('underline') && props.underline && props.underline !== 'none') {
    css += `;text-decoration-style:${props.underline}`;
  }
  return css;
}

/** Text glow needs blur + opacity together against the text's own colour. */
function textShadow(props) {
  const blur = Number(props.shadowBlur);
  const op = Number(props.shadowOpacity);
  if (!numOk(blur, 0, 40) || !numOk(op, 0, 1) || blur <= 0 || op <= 0) return '';
  const alpha = Math.max(0.02, Math.min(1, op));
  const color = `color-mix(in srgb, currentColor ${Math.round(alpha * 100)}%, transparent)`;
  const soft = `0 0 ${Math.round(blur)}px ${color}`;
  const tight = `0 0 ${Math.max(1, Math.round(blur / 3))}px ${color}`;
  return `text-shadow:${tight},${soft}`;
}

function propsToCss(props) {
  if (!props || typeof props !== 'object') return '';
  const out = [];
  for (const [key, build] of Object.entries(PROP_CSS)) {
    if (key === 'shadowBlur' || key === 'shadowOpacity') continue;
    if (!(key in props)) continue;
    const decl = build(props[key]);
    if (decl) out.push(decl);
  }
  const deco = decorationLines(props);
  if (deco) out.push(deco);
  if (props.smallCaps) out.push(PROP_CSS.smallCaps(props.smallCaps));
  const shadow = textShadow(props);
  if (shadow) out.push(shadow);
  return out.join(';');
}

function selectorForTarget(key) {
  if (String(key).startsWith('tab:')) {
    const tabId = String(key).slice(4).replace(/[\\"]/g, '');
    return `.mr-tab-btn[data-tab-id="${tabId}"]`;
  }
  const safe = String(key).replace(/[\\"]/g, '');
  return `[data-mr-appearance-target="${safe}"]`;
}

/** Write every stored element/tab override into the element style sheet. */
export function renderElements() {
  state.elementStyleEl ??= ensureStyleEl('mr-appearance-elements');
  const blocks = [];
  const tabs = read('tabOverrides', {}) ?? {};
  for (const [tabId, props] of Object.entries(tabs)) {
    const css = propsToCss(explicitOnly(props));
    if (css) blocks.push(`${selectorForTarget(`tab:${tabId}`)}{${css}}`);
  }
  const elements = read('elementOverrides', {}) ?? {};
  for (const [key, props] of Object.entries(elements)) {
    const css = propsToCss(explicitOnly(props));
    if (css) blocks.push(`${selectorForTarget(key)}{${css}}`);
  }
  state.elementStyleEl.textContent = blocks.join('\n');
}

/**
 * Only properties present as keys are explicit. When explicit inheritance is
 * ON a saved record may carry `__explicit` lists; honour them by dropping
 * anything not listed so inherited properties keep tracking the theme.
 */
function explicitOnly(props) {
  if (!props || typeof props !== 'object') return {};
  const list = Array.isArray(props.__explicit) ? props.__explicit : null;
  if (!list) {
    const { __explicit, ...rest } = props;
    return rest;
  }
  const out = {};
  for (const key of list) {
    if (key in props) out[key] = props[key];
  }
  return out;
}

export function render() {
  renderRoot();
  renderElements();
}

/** Full pass after settings load/change. */
export function init() {
  render();
  settings.onChange(() => render());
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => syncWindowBackground());
}

export { RAINBOW };
