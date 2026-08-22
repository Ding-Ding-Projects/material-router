/* Site i18n: three language modes (en / zh-HK / bilingual), per-language funny
   levels that style voice without touching facts, emoji toggle, School mode.
   Modules register their own bundles with addBundle(); page content registers
   through content-i18n.js. Missing keys fall back to English, then to the key. */

import { getSettings } from './store.js';

const bundles = new Map(); // name -> { en:{}, zh:{} }
const listeners = new Set();

export function addBundle(name, bundle) {
  bundles.set(name, {
    en: bundle.en || {},
    zh: bundle.zh || {},
  });
}

export function language() {
  return getSettings().language;
}

export function funnyLevel(langOfCopy) {
  const s = getSettings();
  return langOfCopy === 'zh' ? s.funnyZh : s.funnyEn;
}

export function schoolModeActive() {
  return getSettings().schoolMode === true;
}

export function emojiOn() {
  return getSettings().emojiOn === true && !schoolModeActive();
}

function lookup(key) {
  for (const bundle of bundles.values()) {
    if (bundle.en[key] != null || bundle.zh[key] != null) return bundle;
  }
  return null;
}

/* t(): factual strings. Never styled by the funny level. */
export function t(key, fallback = null) {
  const lang = language();
  const bundle = lookup(key);
  if (!bundle) return fallback != null ? fallback : key;
  if ((lang === 'zh' || lang === 'bi') && bundle.zh[key] != null) return bundle.zh[key];
  if (lang === 'zh' && bundle.en[key] != null) return bundle.en[key]; // zh missing -> EN fallback
  return bundle.en[key] != null ? bundle.en[key] : (fallback != null ? fallback : key);
}

/* copy(): descriptive strings styled by the per-language funny level.
   A bundle entry may be a plain string (level-independent) or
   { v: [level1..level5] }. Facts inside the text stay exact at every level. */
export function copy(key, fallback = null) {
  if (schoolModeActive()) {
    // School mode: English presentation, serious tone.
    return plainVariant(lookup(key), key, 'en', 1, fallback);
  }
  const lang = language();
  const track = lang === 'zh' ? 'zh' : 'en';
  return plainVariant(lookup(key), key, track, funnyLevel(track), fallback);
}

function plainVariant(bundle, key, track, level, fallback) {
  if (!bundle) return fallback != null ? fallback : key;
  const entryZh = bundle.zh[key];
  const entryEn = bundle.en[key];
  let entry = entryZh != null ? entryZh : entryEn;
  if (track === 'en' && entry == null) entry = entryEn;
  if (entry == null) return fallback != null ? fallback : key;
  if (typeof entry === 'string') {
    if (track === 'zh' && entryZh == null) return entry; // EN fallback for missing zh
    return entry;
  }
  const variants = Array.isArray(entry.v) ? entry.v : null;
  if (!variants) return fallback != null ? fallback : key;
  if (track === 'zh' && entryZh == null) {
    // Chinese track absent: use the English variants at the English level.
    return variants[0] != null ? variants[0] : String(entry);
  }
  const idx = Math.min(Math.max(level, 1), 5) - 1;
  const picked = variants[idx];
  if (picked == null) {
    // Fall back to the most serious variant rather than rendering blank.
    return variants.find((x) => x != null) || String(entry);
  }
  return picked;
}

/* Bilingual helper: primary + compact secondary line when in bi mode. */
export function bi(key, fallback = null) {
  const lang = language();
  if (lang !== 'bi') return [{ text: t(key, fallback), secondary: false }];
  const bundle = lookup(key);
  const out = [];
  const enText = bundle && bundle.en[key] != null ? bundle.en[key] : (fallback != null ? fallback : key);
  const zhText = bundle && bundle.zh[key] != null ? bundle.zh[key] : null;
  out.push({ text: enText, secondary: false });
  if (zhText) out.push({ text: zhText, secondary: true });
  return out;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* Re-render every element carrying data-i18n / data-i18n-copy on the page.
   data-i18n-attr="aria-label" targets attributes instead of textContent. */
export function applyDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.getAttribute('data-i18n'), node.textContent);
  });
  root.querySelectorAll('[data-i18n-copy]').forEach((node) => {
    node.textContent = copy(node.getAttribute('data-i18n-copy'), node.textContent);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    const attr = node.getAttribute('data-i18n-attr');
    const key = node.getAttribute('data-i18n-key');
    if (attr && key) node.setAttribute(attr, t(key, node.getAttribute(attr)));
  });
  // emoji toggle: decorative glyphs marked data-emoji disappear when off
  root.querySelectorAll('[data-emoji]').forEach((node) => {
    node.hidden = !emojiOn();
  });
  document.documentElement.lang = language() === 'zh' ? 'zh-HK' : 'en';
  for (const fn of listeners) {
    try { fn(language()); } catch { /* ignore listener errors */ }
  }
}
