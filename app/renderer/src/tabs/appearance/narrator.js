// Purpose: the spoken-feedback narrator. OFF by default; opt-in only. It
// consumes main-process events through materialRouter.on (toast, plus the
// status events users ask about out loud), serializes utterances through one
// queue, coalesces bursts with a debounce and per-category cooldown, speaks
// per-language voices (English / Cantonese / both, strictly serialized), and
// ducks under its own live-region announcements.
//
// Honest limits, stated in the UI too: a desktop screen reader is not
// detectable from inside the renderer, so "duck" here means (a) never
// speaking while this app's own aria-live announcement is fresh and
// (b) pausing while the window is hidden. Users running a full screen reader
// should keep narration off - the control says so.
// Owned by Appearance lane.

import * as settings from '../../core/settings.js';
import { on } from '../../core/bridge.js';

const COOLDOWN_MS = 15_000;
const BURST_DEBOUNCE_MS = 700;

const state = {
  queue: [],
  speaking: false,
  lastSpoken: new Map(), // category key -> ts
  burstTimer: null,
  pending: [],
  listeners: [],
  voicesReady: false,
};

export function supported() {
  return typeof window.speechSynthesis === 'function'
    && typeof window.SpeechSynthesisUtterance === 'function';
}

function cfg() {
  const value = settings.get('appearance.narrator', null);
  const base = {
    enabled: false,
    language: 'en', // 'en' | 'zh' | 'both'
    voiceEn: '', // persisted voiceURI, '' = choose automatically
    voiceZh: '',
    rate: 1,
    pitch: 1,
  };
  if (!value || typeof value !== 'object') return base;
  return { ...base, ...value };
}

async function setCfg(patch) {
  await settings.set('appearance.narrator', { ...cfg(), ...patch });
}

export async function setEnabled(onOff) {
  await setCfg({ enabled: Boolean(onOff) });
  if (!onOff) stop();
}

export async function setLanguage(language) {
  if (!['en', 'zh', 'both'].includes(language)) throw new Error(`unknown narrator language "${language}"`);
  await setCfg({ language });
}

export async function setVoice(lang, voiceURI) {
  if (lang !== 'en' && lang !== 'zh') throw new Error('setVoice requires lang en|zh');
  await setCfg(lang === 'en' ? { voiceEn: String(voiceURI ?? '') } : { voiceZh: String(voiceURI ?? '') });
}

export async function setRate(rate) {
  await setCfg({ rate: clampRate(rate) });
}

export async function setPitch(pitch) {
  await setCfg({ pitch: clampPitch(pitch) });
}

/** Platform ranges for SpeechSynthesisUtterance are rate 0.1-10, pitch 0-2. */
export function clampRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(0.5, Math.round(n * 10) / 10));
}

export function clampPitch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0, Math.round(n * 10) / 10));
}

/**
 * Platform voices at runtime. Handles Chromium's empty-first enumeration:
 * returns [] now and re-fires `onVoicesChanged` once the list arrives.
 */
export function listVoices() {
  if (!supported()) return [];
  return window.speechSynthesis.getVoices() ?? [];
}

export function onVoicesChanged(cb) {
  if (!supported()) return () => {};
  const handler = () => {
    state.voicesReady = listVoices().length > 0;
    cb(listVoices());
  };
  window.speechSynthesis.addEventListener('voiceschanged', handler);
  handler(); // also answers immediately with whatever is already known
  return () => window.speechSynthesis.removeEventListener('voiceschanged', handler);
}

/** Voices usable for one narrated language ('en' | 'zh'). */
export function voicesFor(lang) {
  return listVoices().filter((v) => {
    const tag = `${v.lang ?? ''}`.toLowerCase().replace('_', '-');
    if (lang === 'en') return tag.startsWith('en');
    return tag.startsWith('yue') || (tag.startsWith('zh')
      && !tag.startsWith('zh-cn') && !tag.startsWith('zh-sg'));
  });
}

/** Resolve a stored voiceURI to a Voice object; null means fall back. */
export function resolveVoice(lang) {
  const wanted = lang === 'en' ? cfg().voiceEn : cfg().voiceZh;
  if (!wanted) return null; // '' = choose automatically (not a fallback)
  return voicesFor(lang).find((v) => v.voiceURI === wanted) ?? null;
}

/** Status line keys for a picker, resolved by the UI. Returns i18n keys+data. */
export function voiceStatus(lang) {
  if (!supported()) return { kind: 'unsupported' };
  const all = voicesFor(lang);
  if (all.length === 0) return { kind: 'noneForLang' };
  const chosen = resolveVoice(lang);
  if (chosen) {
    return chosen.localService === false
      ? { kind: 'network', voice: chosen }
      : { kind: 'ok', voice: chosen };
  }
  return cfg()[lang === 'en' ? 'voiceEn' : 'voiceZh']
    ? { kind: 'fallback', voice: all[0] } // choice kept; voice not installed
    : { kind: 'auto', voice: all[0] };
}

// -- speaking ------------------------------------------------------------------

function enqueue(text, langTag) {
  state.queue.push({ text, langTag });
  pump();
}

function pump() {
  if (!state.speaking && state.queue.length > 0 && document.visibilityState === 'visible') {
    const next = state.queue.shift();
    speakNow(next.text, next.langTag);
  }
}

function speakNow(text, langTag) {
  const conf = cfg();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = langTag;
  utter.rate = clampRate(conf.rate);
  utter.pitch = clampPitch(conf.pitch);
  const voice = resolveVoice(langTag === 'en-US' ? 'en' : 'zh');
  if (voice) utter.voice = voice;
  utter.onend = () => {
    state.speaking = false;
    pump();
  };
  utter.onerror = () => {
    state.speaking = false;
    pump();
  };
  state.speaking = true;
  window.speechSynthesis.speak(utter);
}

export function stop() {
  clearTimeout(state.burstTimer);
  state.pending = [];
  state.queue = [];
  if (supported()) window.speechSynthesis.cancel();
  state.speaking = false;
}

/** Speak one line now (test button), bypassing burst debounce but not queue. */
export function speakSample(text) {
  if (!supported() || !cfg().enabled) return;
  const conf = cfg();
  if (conf.language === 'en' || conf.language === 'both') enqueue(text, 'en-US');
  if (conf.language === 'zh' || conf.language === 'both') enqueue(text, 'zh-HK');
}

function shouldSpeakCategory(key) {
  const now = Date.now();
  const last = state.lastSpoken.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  state.lastSpoken.set(key, now);
  return true;
}

/**
 * Accept an event for narration. Bursts within BURST_DEBOUNCE_MS collapse
 * into one summary line so a flurry of toasts does not machine-gun speech.
 */
export function narrate(categoryKey, textEn, textZh) {
  if (!supported()) return;
  const conf = cfg();
  if (!conf.enabled) return;
  if (!document.visibilityState || document.visibilityState !== 'visible') return; // duck when hidden
  if (!shouldSpeakCategory(`${categoryKey}:${textEn}`)) return;

  state.pending.push({ textEn, textZh });
  clearTimeout(state.burstTimer);
  state.burstTimer = setTimeout(() => {
    const batch = state.pending.splice(0, state.pending.length);
    if (batch.length === 0) return;
    const count = batch.length;
    const first = batch[0];
    const prefix = count > 1 ? `${count} notifications. ` : '';
    const zhPrefix = count > 1 ? `${count} 則通知。` : '';
    if (conf.language === 'en' || conf.language === 'both') {
      enqueue(`${prefix}${first.textEn}`, 'en-US');
    }
    if (conf.language === 'zh' || conf.language === 'both') {
      enqueue(`${zhPrefix}${first.textZh}`, 'zh-HK');
    }
  }, BURST_DEBOUNCE_MS);
}

/** Wire event consumption. Call once at tab init; returns a teardown fn. */
export function init() {
  if (!supported()) return () => {};
  const offToast = on('toast', (payload) => {
    const title = typeof payload?.title === 'string' ? payload.title : '';
    const body = typeof payload?.body === 'string' ? payload.body : '';
    if (!title && !body) return;
    // Local-history entries surface as toasts too, so the toast channel is
    // the one honest feed for both (documented).
    narrate('toast', stripToSentence(title, body), stripToSentence(title, body));
  });

  // Duck fully when the window hides; resume cleanly when it returns.
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') stop();
    else pump();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    offToast();
    document.removeEventListener('visibilitychange', onVisibility);
    stop();
  };
}

function stripToSentence(title, body) {
  const combined = [title, body].filter(Boolean).join('. ');
  return combined.length > 220 ? `${combined.slice(0, 217)}…` : combined;
}
