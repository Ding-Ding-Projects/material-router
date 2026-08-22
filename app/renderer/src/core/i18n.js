// Purpose: language modes (en / zh-HK colloquial / bilingual), per-language
// funny levels, and the copy() helper that styles voice without ever changing
// facts. School-mode gate hook returns false until the Delight lane lands.
// Owned by Foundation Core lane.

import * as settings from './settings.js';

const bundles = new Map(); // ns -> {en:{},zh:{}}
let currentNsCache = new Map();
// Whole-key index across every registered table. Lane bundles follow two
// key conventions: some store unprefixed strings under their namespace
// ("form.name" in ns "providers", addressed as t("providers.form.name")),
// others store fully prefixed keys verbatim ("server.sectionStatus",
// "dl.modes.title", and every core shell string). The namespaced lookup
// serves the first convention; this index serves the second.
let wholeKeyIndex = null;

export const LANGUAGES = ['en', 'zh', 'bilingual'];

export function addBundle(ns, bundle) {
  bundles.set(ns, bundle);
  currentNsCache.clear();
  if (!wholeKeyIndex) wholeKeyIndex = new Map();
  for (const lang of ['en', 'zh']) {
    const table = bundle?.[lang];
    if (!table || typeof table !== 'object') continue;
    for (const [key, value] of Object.entries(table)) {
      if (value == null) continue;
      let entry = wholeKeyIndex.get(key);
      if (!entry) {
        entry = { en: null, zh: null };
        wholeKeyIndex.set(key, entry);
      }
      // First registration wins per slot so resolution stays deterministic
      // regardless of lane import order.
      if (entry[lang] == null) entry[lang] = value;
    }
  }
}

export function languageMode() {
  // School mode forces English presentation on every surface (Delight lane).
  if (schoolModeActive()) return 'en';
  return settings.get('general.languageMode', 'en');
}

export function funnyLevel(lang) {
  // School mode suppresses playful copy entirely: level 1, fully serious.
  if (schoolModeActive()) return 1;
  return lang === 'zh'
    ? clampLevel(settings.get('general.funnyLevelZh', 5))
    : clampLevel(settings.get('general.funnyLevelEn', 5));
}

function clampLevel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** Emoji-in-dialogs toggle; suppressed entirely while School mode is on. */
export function emojiToggleOn() {
  return !schoolModeActive() && Boolean(settings.get('general.emojiInDialogs', false));
}

/**
 * School mode gate hook, now backed by the real shared record the Delight
 * lane's bridge mirrors into settings (school.active). Every surface must
 * call this rather than hardcoding behavior.
 */
export function schoolModeActive() {
  return Boolean(settings.get('school.active', false));
}

function resolve(nsKey) {
  if (currentNsCache.has(nsKey)) return currentNsCache.get(nsKey);
  const dot = nsKey.indexOf('.');
  const ns = dot === -1 ? 'core' : nsKey.slice(0, dot);
  const key = dot === -1 ? nsKey : nsKey.slice(dot + 1);
  const bundle = bundles.get(ns);
  let result = null;
  if (bundle) {
    // Convention 1: the table holds unprefixed strings for this namespace.
    const en = bundle.en?.[key];
    const zh = bundle.zh?.[key];
    if (en != null || zh != null) {
      result = { en: en != null ? en : null, zh: zh != null ? zh : null };
    }
  }
  // Convention 2: the table holds fully prefixed keys, so match nsKey whole.
  // Covers the core shell bundle (whose keys carry many prefixes under one
  // namespace) and lanes whose prefix differs from their namespace name
  // ("dl.*" registered as "delight").
  if (!result) result = wholeKeyIndex?.get(nsKey) ?? null;
  currentNsCache.set(nsKey, result);
  return result;
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`);
}

/**
 * Translate a namespaced key ("ns.key") honoring the language mode.
 * Bilingual renders "EN · 粵". Falls back to whichever side exists, then to
 * the raw key so a missing translation is loud, not blank.
 */
export function t(nsKey, params) {
  const entry = resolve(nsKey) ?? { en: null, zh: null };
  const mode = languageMode();
  if (mode === 'bilingual') {
    const en = entry.en ?? nsKey;
    const zh = entry.zh ?? entry.en ?? nsKey;
    return `${interpolate(en, params)} · ${interpolate(zh, params)}`;
  }
  const chosen = mode === 'zh' ? (entry.zh ?? entry.en) : (entry.en ?? entry.zh);
  return interpolate(chosen ?? nsKey, params);
}

// ---------------------------------------------------------------------------
// Funny voice: dictionary-based flourishes keyed by deterministic text hash.
// Level 1 = fully serious; level 5 = maximum playfulness. Facts never change:
// flourishes are appended interjections only, and are emoji-free while the
// dialogs-emoji toggle is off (foundation default).
// ---------------------------------------------------------------------------

const FLOURISHES_EN = {
  2: [' — noted.', ' (done properly).'],
  3: [' — nice and tidy.', ' (as it should be).'],
  4: [' — lovely stuff.', ' — smooth as anything.', ' (chuffed with this one).'],
  5: [' — brilliant, honestly.', ' — smooth as a fresh pot of milk tea.', ' (absolutely spot-on).'],
};

const FLOURISHES_ZH = {
  2: ['（辦妥喇）。', '（照規矩）。'],
  3: ['，幾齊整。', '（穩陣）。'],
  4: ['，正！', '，順利到不得了。'],
  5: ['——正到痺！', '，絲滑過奶茶。', '（一流！）'],
};

function hashString(s) {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Apply the funny-level voice to a factual string. Deterministic: the same
 * input at the same level always produces the same output, so UI copy does
 * not flicker between renders.
 */
export function applyFunnyVoice(text, lang = null, { allowEmoji = emojiToggleOn() } = {}) {
  const effectiveLang = lang ?? (languageMode() === 'zh' ? 'zh' : 'en');
  const level = funnyLevel(effectiveLang);
  if (level <= 1 || !text || typeof text !== 'string') return text;
  // Density rises with level; low levels only decorate occasionally.
  const hash = hashString(text);
  const density = [0, 0, 0.25, 0.5, 0.75, 1][level];
  if ((hash % 100) / 100 >= density) return text;
  void allowEmoji; // foundation flourish lists are emoji-free; Delight lane adds gated variants
  const table = effectiveLang === 'zh' ? FLOURISHES_ZH : FLOURISHES_EN;
  const options = table[level] ?? [];
  if (options.length === 0) return text;
  const pick = options[hash % options.length];
  return text.replace(/\s*$/, '') + pick;
}

/**
 * The one helper user-facing copy goes through: translate + funny voice +
 * language-mode awareness in a single call.
 */
export function copy(nsKey, params) {
  const base = t(nsKey, params);
  const mode = languageMode();
  if (mode === 'bilingual') return base; // already carries both languages; no suffix games
  return applyFunnyVoice(base, mode === 'zh' ? 'zh' : 'en');
}

/** Invalidate memoized lookups when settings change (called by app bootstrap). */
export function invalidateCache() {
  currentNsCache.clear();
}
