// Purpose: the personal-vocabulary upload. Always visible; accepts a
// user-selected local JSON file through the native picker; validates against
// the bounded generic contract in main (size cap 256 KB, versioned schema,
// string-to-string pairs, depth <= 4, max 5000 entries) and rejects a bad
// file WHOLESALE with the reason. Valid files are cached in a dedicated
// JSONStore; clearing purges immediately. Local-only: no network, no path
// retention, no content logging.
// Owned by Delight lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { invoke } from '../../core/bridge.js';
import { toast } from '../../core/toasts.js';
import { record as historyRecord } from '../../core/history.js';
import { destructiveConfirmSuper } from './dialogs-super.js';
import { dc, refreshVocabCache, schoolActive } from './common.js';

const state = {
  loadedAt: null,
  entryCount: 0,
  lastError: null,
};

async function reloadState() {
  try {
    const s = await invoke('vault:delight-vocab-get');
    state.loadedAt = s.loadedAt;
    state.entryCount = Number(s.entryCount ?? 0);
  } catch { /* surfaced on next action */ }
}

/**
 * Render the vocabulary card into `container`. Under School mode the whole
 * control is absent.
 */
let hostEl = null;

export function renderVocabSection(container) {
  hostEl = container;
  renderNow();
}

function renderNow() {
  if (!hostEl) return;
  hostEl.replaceChildren();
  if (schoolActive()) return; // absent entirely

  const card = h('div', { class: 'm3-card m3-card--outlined' });
  card.append(h('h2', { class: 'm3-card__title' }, dc('dl.vocab.title')));
  card.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant);margin-top:0' }, dc('dl.vocab.desc')));

  const statusEl = h('div', { class: 'mr-col', style: 'gap:4px;margin-bottom:10px', role: 'status' });
  renderStatus(statusEl);

  // Always-visible picker (semantic input[type=file] + the native dialog).
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'mr-visually-hidden-input',
    id: 'mr-vocab-file',
    'aria-label': t('dl.vocab.pick'),
    onchange: (e) => handleFile(e.target.files?.[0]).finally(() => { e.target.value = ''; }),
  });
  const pickBtn = h('button', {
    class: 'm3-btn m3-btn--filled',
    onclick: () => fileInput.click(),
  }, state.loadedAt ? t('dl.vocab.replace') : t('dl.vocab.pick'));

  const clearBtn = h('button', {
    class: 'm3-btn m3-btn--text',
    style: 'color:var(--md-sys-color-error)',
    onclick: clearVocab,
    disabled: state.entryCount === 0 ? true : null,
  }, t('dl.vocab.clear'));

  card.append(
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' }, pickBtn, clearBtn),
    fileInput,
    statusEl,
    h('details', { class: 'mr-disclosure' },
      h('summary', {}, t('dl.common.moreInfo')),
      h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
        dc('dl.vocab.contract', { maxEntries: '5000', depth: '4' })),
      h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, dc('dl.vocab.privacy')),
      h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, dc('dl.vocab.hookGap')),
    ),
  );
  hostEl.append(card);
}

function renderStatus(el) {
  el.replaceChildren();
  if (state.lastError) {
    el.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-error);margin:0' }, t('dl.vocab.stateInvalid')));
    el.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-error);margin:0' },
      t('dl.vocab.reason', { reason: state.lastError })));
    return;
  }
  if (!state.loadedAt) {
    el.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:0' }, t('dl.vocab.stateNone')));
    return;
  }
  el.append(h('p', { class: 'mr-typography-body-medium', style: 'margin:0' },
    t('dl.vocab.stateLoaded', { count: String(state.entryCount) })));
  el.append(h('time', { datetime: state.loadedAt, class: 'mr-typography-label-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, state.loadedAt));
}

async function handleFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    state.lastError = err.message;
    renderNow();
    return;
  }
  try {
    const res = await invoke('vault:delight-vocab-set', { text, fileName: file.name });
    state.lastError = null;
    state.loadedAt = res.loadedAt;
    state.entryCount = Number(res.entryCount ?? 0);
    await refreshVocabCache();
    historyRecord('vocabulary loaded', `${res.entryCount} replacements`);
    toast(t('common.ok'), t('dl.vocab.stateLoaded', { count: String(res.entryCount) }), { kind: 'success' });
  } catch (err) {
    state.lastError = err.message;
    historyRecord('vocabulary rejected', err.message.slice(0, 120));
    toast(t('dl.vocab.stateInvalid'), err.message, { kind: 'error' });
  }
  renderNow();
}

async function clearVocab() {
  const ok = await destructiveConfirmSuper({
    title: t('dl.vocab.clear'),
    body: t('dl.vocab.stateCleared'),
    confirmLabel: t('dl.vocab.clear'),
  });
  if (!ok) return;
  try {
    await invoke('vault:delight-vocab-clear');
    await refreshVocabCache();
    state.lastError = null;
    state.loadedAt = null;
    state.entryCount = 0;
    historyRecord('vocabulary cleared', '');
    toast(t('common.ok'), t('dl.vocab.stateCleared'), { kind: 'info' });
  } catch (err) {
    toast(t('common.errorTitle'), err.message, { kind: 'error' });
  }
  renderNow();
}
