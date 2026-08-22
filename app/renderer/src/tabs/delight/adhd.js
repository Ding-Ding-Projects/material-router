// Purpose: ADHD modes - five independent, OFF-by-default interface
// accommodations: Focus (dims everything but the working panel, one-action
// restore), Low stimulation (non-essential motion suppressed in union with
// prefers-reduced-motion), Time awareness (session elapsed + since last
// change near the tab strip), One thing at a time (a persisted next-action
// pin) and Momentum (one gentle dismissible note after a quiet stretch that
// honours its stated snooze). Plain factual tone throughout; no gamification,
// no scolding, no medical claims - they are named by what they DO.
// Owned by Delight lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import * as settings from '../../core/settings.js';
import { toast } from '../../core/toasts.js';
import { record as historyRecord } from '../../core/history.js';
import { dc, schoolActive } from './common.js';

const KEYS = {
  focus: 'adhd.focus',
  lowStim: 'adhd.lowStimulation',
  time: 'adhd.timeAwareness',
  oneThing: 'adhd.oneThing',
  momentum: 'adhd.momentum',
};

const booted = {
  strip: null,
  pinChip: null,
  momentumTimer: null,
  lastChange: Date.now(),
  sessionStart: Date.now(),
};

export function renderAdhdSection(container) {
  container.replaceChildren();
  if (schoolActive()) return; // absent entirely under School mode

  const card = h('div', { class: 'm3-card m3-card--outlined' });
  card.append(h('h2', { class: 'm3-card__title' }, dc('dl.adhd.title')));
  card.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin-top:0' }, dc('dl.adhd.intro')));

  function switchRow({ key, label, desc }) {
    const on = Boolean(settings.get(key, false));
    const input = h('input', {
      type: 'checkbox',
      checked: on ? true : null,
      id: `mr-adhd-${key}`,
      'aria-describedby': `mr-adhd-${key}-desc`,
      onchange: async (e) => {
        await settings.set(key, Boolean(e.target.checked));
        historyRecord('settings changed', label(), String(Boolean(e.target.checked)));
      },
    });
    return h('div', { class: 'mr-col', style: 'gap:0;margin-bottom:10px' },
      h('label', { class: 'm3-switch', for: input.id },
        input,
        h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'thumb' })),
        h('span', { class: 'label-text mr-typography-body-medium' }, label()),
      ),
      h('p', { id: `mr-adhd-${key}-desc`, class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:2px 0 0 60px' }, desc()),
    );
  }

  const rows = h('div', { class: 'mr-col' });
  rows.append(
    switchRow({ key: KEYS.focus, label: () => t('dl.adhd.focus'), desc: () => dc('dl.adhd.focusDesc') }),
    switchRow({ key: KEYS.lowStim, label: () => t('dl.adhd.lowStim'), desc: () => dc('dl.adhd.lowStimDesc') }),
    switchRow({ key: KEYS.time, label: () => t('dl.adhd.time'), desc: () => dc('dl.adhd.timeDesc') }),
    switchRow({ key: KEYS.oneThing, label: () => t('dl.adhd.oneThing'), desc: () => dc('dl.adhd.oneThingDesc') }),
    switchRow({ key: KEYS.momentum, label: () => t('dl.adhd.momentum'), desc: () => dc('dl.adhd.momentumDesc') }),
  );

  // Momentum configuration ---------------------------------------------------
  const idleInput = h('input', {
    type: 'number',
    min: '5',
    max: '240',
    value: String(Number(settings.get('adhd.idleMinutes', 20))),
    id: 'mr-adhd-idle',
    class: 'm3-slider',
    style: 'width:90px',
    'aria-label': t('dl.adhd.idleMinutes'),
    onchange: async (e) => {
      const v = Math.min(240, Math.max(5, Number(e.target.value) || 20));
      e.target.value = String(v);
      await settings.set('adhd.idleMinutes', v);
      restartMomentum();
    },
  });

  // One-thing pin editor ---------------------------------------------------------
  const pinInput = h('input', {
    type: 'text',
    value: String(settings.get('adhd.nextAction', '') || ''),
    maxlength: '140',
    id: 'mr-adhd-pin',
    'aria-label': t('dl.adhd.pinPlaceholder'),
    placeholder: t('dl.adhd.pinPlaceholder'),
    style: 'flex:1;min-width:200px',
  });
  const pinSave = h('button', {
    class: 'm3-btn m3-btn--tonal',
    onclick: async () => {
      await settings.set('adhd.nextAction', pinInput.value.trim());
      historyRecord('settings changed', t('dl.adhd.oneThing'), pinInput.value.trim() ? 'set' : 'cleared');
      renderPinChip();
    },
  }, t('dl.adhd.pinSave'));
  const pinClear = h('button', {
    class: 'm3-btn m3-btn--text',
    onclick: async () => {
      pinInput.value = '';
      await settings.set('adhd.nextAction', '');
      renderPinChip();
    },
  }, t('dl.adhd.pinClear'));

  card.append(
    rows,
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap;border-top:1px solid var(--md-sys-color-outline-variant);padding-top:10px' },
      h('label', { for: 'mr-adhd-idle', class: 'mr-typography-body-medium' }, t('dl.adhd.idleMinutes')), idleInput,
    ),
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap;border-top:1px solid var(--md-sys-color-outline-variant);padding-top:10px' },
      pinInput, pinSave, pinClear,
    ),
  );
  container.append(card);
}

/** Apply global effects; call once at boot after settings are ready. */
export function bootAdhd() {
  const apply = () => {
    const root = document.documentElement;
    root.dataset.adhdFocus = settings.get(KEYS.focus, false) ? 'on' : 'off';
    root.dataset.adhdLowStim = settings.get(KEYS.lowStim, false) ? 'on' : 'off';
    renderStrip();
    renderPinChip();
    renderFocusChip();
    restartMomentum();
  };

  settings.onChange((key) => {
    if (key.startsWith('adhd.')) apply();
  });
  apply();

  // Activity tracking feeds both Time awareness and Momentum.
  const markActive = () => { booted.lastChange = Date.now(); };
  window.addEventListener('pointerdown', markActive, { passive: true });
  window.addEventListener('keydown', markActive, { passive: true });
  settings.onChange(() => { booted.lastChange = Date.now(); });

  setInterval(() => {
    if (settings.get(KEYS.time, false)) updateStripValues();
    checkMomentum();
  }, 1000);
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const hh = Math.floor(m / 60);
  if (hh > 0) return `${hh}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// -- time awareness strip ---------------------------------------------------------

function renderStrip() {
  const want = Boolean(settings.get(KEYS.time, false)) || Boolean(settings.get('adhd.nextAction', ''));
  if (!want) {
    booted.strip?.remove();
    booted.strip = null;
    return;
  }
  if (!booted.strip || !booted.strip.isConnected) {
    booted.strip = h('div', { class: 'mr-time-strip', role: 'status', 'aria-label': t('dl.adhd.time') });
    document.body.append(booted.strip);
  }
  updateStripValues();
}

function updateStripValues() {
  if (!booted.strip) return;
  booted.strip.replaceChildren();
  if (settings.get(KEYS.time, false)) {
    booted.strip.append(
      h('span', {}, t('dl.adhd.sessionElapsed', { time: fmtElapsed(Date.now() - booted.sessionStart) })),
      h('span', { class: 'mr-time-strip__sep', 'aria-hidden': 'true' }, '·'),
      h('span', {}, t('dl.adhd.lastChange', { time: fmtElapsed(Date.now() - booted.lastChange) })),
    );
  }
  const pin = String(settings.get('adhd.nextAction', '') || '');
  if (pin && settings.get(KEYS.oneThing, false)) {
    booted.strip.append(
      h('span', { class: 'mr-time-strip__sep', 'aria-hidden': 'true' }, '·'),
      h('strong', {}, pin),
    );
  }
}

// -- one-thing pin chip -------------------------------------------------------------

function renderPinChip() {
  // The pin lives inside the time strip; nothing extra to draw when the
  // strip is absent because neither feature is on.
  renderStrip();
}

// -- focus restore chip ----------------------------------------------------------------

function renderFocusChip() {
  document.getElementById('mr-adhd-focus-chip')?.remove();
  if (!settings.get(KEYS.focus, false)) return;
  const chip = h('button', {
    class: 'mr-focus-chip',
    id: 'mr-adhd-focus-chip',
    onclick: async () => {
      await settings.set(KEYS.focus, false);
      toast(t('common.ok'), t('dl.adhd.focusOff'), { kind: 'info' });
    },
  }, `${t('dl.adhd.focusChip')} — ${t('dl.adhd.focusOff')}`);
  document.body.append(chip);
}

// -- momentum -----------------------------------------------------------------------------

let snoozeUntil = 0;

function restartMomentum() {
  clearTimeout(booted.momentumTimer);
  booted.momentumTimer = setTimeout(checkMomentum, 5000);
}

function checkMomentum() {
  clearTimeout(booted.momentumTimer);
  if (!settings.get(KEYS.momentum, false)) return;
  const idleMs = Number(settings.get('adhd.idleMinutes', 20)) * 60_000;
  const quietFor = Date.now() - Math.max(booted.lastChange, snoozeUntil);
  if (quietFor >= idleMs) showMomentumCard(Math.floor(quietFor / 60_000));
  else booted.momentumTimer = setTimeout(checkMomentum, Math.min(idleMs - quietFor, 30_000));
}

function showMomentumCard(minutesIdle) {
  if (document.getElementById('mr-momentum-card')) return;
  const snoozeMinutes = 15;
  const card = h('div', { class: 'mr-momentum-card', id: 'mr-momentum-card', role: 'status' },
    h('p', { class: 'mr-typography-body-medium', style: 'margin:0' }, t('dl.adhd.momentumCard', { minutes: String(minutesIdle) })),
    h('div', { class: 'mr-row', style: 'margin-top:8px' },
      h('button', {
        class: 'm3-btn m3-btn--tonal m3-btn--sm',
        onclick: () => {
          snoozeUntil = Date.now() + snoozeMinutes * 60_000;
          card.remove();
          checkMomentum();
        },
      }, t('dl.adhd.momentumSnooze', { minutes: String(snoozeMinutes) })),
      h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        onclick: () => card.remove(),
      }, t('dl.adhd.dismiss')),
    ),
  );
  document.body.append(card);
}
