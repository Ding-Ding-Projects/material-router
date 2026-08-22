// Purpose: API Builder tab - compose a complete OpenAI/Anthropic request
// entirely from controls, preview the exact wire body in either format,
// send through the local router, watch streamed responses, and keep named
// presets. Free-text entry exists ONLY for message content and the system
// prompt; every configuration value is picked from real data.
// Owned by Builder lane - keeps the registerTab call and the exported tab id
// ('builder') stable so the registry stays valid.

import { h, writeClipboard, saveText, debounce } from '../../core/util.js';
import { t, copy, addBundle } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke, on } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { toast } from '../../core/toasts.js';
import * as history from '../../core/history.js';
import * as palette from '../../core/palette.js';
import { destructiveConfirm, confirm, promptText } from '../../core/dialogs.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import * as tabStrip from '../../core/tabs.js';
import {
  LIMITS,
  SYSTEM_PRESETS,
  TOOL_SUGGESTIONS,
  SCHEMA_TEMPLATES,
  rolesForEndpoint,
  MESSAGE_ROLES,
  defaultComposition,
  newMessage,
  normalizeComposition,
  canonicalOpenAIBody,
  validationErrors,
  extractUsage,
} from './compose.js';
import { SNIPPET_LANGUAGES, generateSnippet, snippetFilename } from './snippet.js';
import { en } from './i18n/en.js';
import { zh } from './i18n/zh.js';

const BUNDLE_NS = 'builder';
const DRAFT_KEY = 'mr.builder.draft';

// Register this tab's strings at module-eval time so any early t() call
// (palette titles, tab labels) resolves through the real bundle.
addBundle(BUNDLE_NS, { en, zh });

/** @type {ReturnType<typeof defaultComposition>} */
let state = defaultComposition();
let previewFormat = 'openai';
let lastPreview = { openai: null, anthropic: null, notes: [] };
let activeRequestId = null;
let responseResult = null;
let responseMode = 'pretty';
let serverInfo = { host: '127.0.0.1', port: 8787, authRequired: false, running: false };
let providersCache = [];
let snippetLang = 'curl';

/** Live element references rebuilt on mount(). */
const ui = {};

function tr(key, params) { return t(`${BUNDLE_NS}.${key}`, params); }
function cr(key, params) { return copy(`${BUNDLE_NS}.${key}`, params); }

// ---------------------------------------------------------------------------
// Tab registration
// ---------------------------------------------------------------------------

registerTab({
  id: 'builder',
  label: { en: 'API Builder', zh: 'API 建造器' },
  get icon() { return iconFromPath('M11 3h2v6h-2V3Zm-8 9h18v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7Zm2 2v4h14v-4H5Zm5 2h4v1h-4v-1ZM4 5a1 1 0 0 1 1-1h3v2H6v2H4V5Zm16 0v3h-2V6h-2V4h3a1 1 0 0 1 1 1Z'); },
  init: initBuilder,
});

function initBuilder(container) {
  restoreDraft();
  mount(container);
  subscribeStream();
  registerPaletteItems();
  ensureLanguagePass();
}

/**
 * Live retranslate: the composer state lives at module level (and in the
 * localStorage draft), so a language-mode change or School-mode flip rebuilds
 * through the existing mount() path without losing work. Preserved across
 * the rebuild: scroll position, the uncommitted stop-sequence input text,
 * the last response body (mount clears it; restored and re-rendered), and the
 * preset search query. In-flight streams keep streaming into the fresh panel.
 */
let languageUnsub = null;
function ensureLanguagePass() {
  if (languageUnsub) return;
  languageUnsub = settings.onChange((key) => {
    if (key !== 'general.languageMode' && key !== 'school.active') return;
    const panel = document.getElementById('mr-tab-panel-builder');
    if (!panel?.isConnected) return;
    const scroll = panel.scrollTop;
    const stopDraft = ui.stopInput?.value ?? '';
    const priorResponse = responseResult;
    const presetQuery = ui.presetSearch?.get?.() ?? null;
    mount(panel);
    if (stopDraft) ui.stopInput.value = stopDraft;
    if (priorResponse) {
      responseResult = priorResponse;
      renderResponse();
    }
    if (presetQuery?.text) {
      ui.presetSearch.set(presetQuery.text);
      if (presetQuery.mode === 'regex') ui.presetSearch.setMode('regex');
    }
    registerPaletteItems();
    panel.scrollTop = scroll;
  });
}

// ---------------------------------------------------------------------------
// Draft persistence (renderer-local autosave, like the shell journal)
// ---------------------------------------------------------------------------

let hadDraft = false;
function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const normalized = normalizeComposition(parsed);
    hadDraft = true;
    state = normalized;
  } catch { /* corrupt draft falls back to defaults */ }
}

const saveDraft = debounce(() => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
  } catch { /* storage full - draft is best-effort */ }
}, 400);

/** Every mutation funnels through here: persist + revalidate + re-preview. */
function markDirty() {
  saveDraft();
  schedulePreview();
  updateValidity();
}

const schedulePreview = debounce(() => refreshPreview(), 220);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function mount(container) {
  container.textContent = '';
  Object.keys(ui).forEach((k) => delete ui[k]);

  container.append(
    headBlock(),
    h('div', { class: 'mr-bldr-grid' },
      leftColumn(),
      rightColumn(),
    ),
  );

  syncAllControls();
  clearResponse();
  refreshProviders();
  refreshServerInfo();
  reloadPresets();
  refreshPreview();
  if (hadDraft) {
    hadDraft = false;
    toast(cr('copiedToastTitle'), cr('draftRestoredB'));
  }
}

function headBlock() {
  ui.resetBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    style: 'color:var(--md-sys-color-error)',
    onclick: resetComposer,
  }, tr('resetComposer'));

  return h('header', { class: 'mr-bldr-head' },
    h('div', {},
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.builder')),
      h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, cr('subtitle')),
    ),
    ui.resetBtn,
  );
}

function leftColumn() {
  return h('div', { class: 'mr-col' },
    endpointCard(),
    routingCard(),
    paramsCard(),
    systemCard(),
    toolsCard(),
  );
}

function rightColumn() {
  return h('div', { class: 'mr-col' },
    messagesCard(),
    previewCard(),
    responseCard(),
    presetsCard(),
    snippetCard(),
  );
}

// -- endpoint ---------------------------------------------------------------

function endpointCard() {
  ui.endpointGroup = h('div', { class: 'mr-bldr-seg', role: 'radiogroup', 'aria-label': tr('endpointTitle') },
    segButton('openai', tr('epOpenai')),
    segButton('anthropic', tr('epAnthropic')),
  );
  return h('section', { class: 'm3-card m3-card--outlined' },
    h('h2', { class: 'm3-card__title' }, tr('endpointTitle')),
    ui.endpointGroup,
    h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:8px 0 0' }, cr('endpointHelp')),
  );
}

function segButton(value, label) {
  return h('button', {
    class: 'mr-bldr-seg__btn',
    role: 'radio',
    dataset: { value },
    'aria-checked': String(state.endpoint === value),
    tabindex: state.endpoint === value ? '0' : '-1',
    onclick: () => setEndpoint(value),
    onkeydown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = value === 'openai' ? 'anthropic' : 'openai';
      setEndpoint(next);
      ui.endpointGroup.querySelector(`[data-value="${next}"]`)?.focus();
    },
  }, label);
}

function setEndpoint(value) {
  if (state.endpoint === value) return;
  state.endpoint = value;
  for (const btn of ui.endpointGroup.querySelectorAll('[role=radio]')) {
    const on = btn.dataset.value === value;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? '0' : '-1';
  }
  applyRoleAvailability();
  markDirty();
}

function applyRoleAvailability() {
  const allowed = rolesForEndpoint(state.endpoint);
  for (const sel of ui.roleSelects ?? []) {
    for (const opt of sel.options) {
      opt.disabled = !allowed.includes(opt.value);
    }
  }
  ui.systemRoleNote?.classList.toggle('hidden', state.endpoint !== 'anthropic');
}

// -- routing ------------------------------------------------------------------

function routingCard() {
  ui.providerSelect = h('select', {
    class: 'mr-bldr-select',
    'aria-label': tr('providerLabel'),
    onchange: (e) => {
      state.providerId = e.target.value;
      state.model = '';
      markDirty();
      loadModels(false);
    },
  });
  ui.modelSelect = h('select', {
    class: 'mr-bldr-select',
    'aria-label': tr('modelLabel'),
    onchange: (e) => { state.model = e.target.value; markDirty(); },
  });
  ui.refreshModelsBtn = iconTextButton(tr('refreshModels'), () => refreshModels(true), '⟳');
  ui.routingHint = h('p', { class: 'mr-typography-body-small mr-bldr-hint' }, '');
  ui.providersEmpty = h('div', { class: 'mr-bldr-empty', hidden: true },
    h('p', { class: 'mr-typography-body-medium' }, tr('providerEmpty')),
    h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, cr('providerEmptyHelp')),
    h('button', {
      class: 'm3-btn m3-btn--tonal m3-btn--sm',
      onclick: () => tabStrip.activate('providers'),
    }, tr('openProvidersBtn')),
  );

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('h2', { class: 'm3-card__title' }, tr('routingTitle')),
    fieldRow(tr('providerLabel'), ui.providerSelect, ui.refreshModelsBtn),
    fieldRow(tr('modelLabel'), ui.modelSelect),
    ui.routingHint,
    ui.providersEmpty,
  );
}

async function refreshProviders() {
  try {
    const { providers } = await invoke('providers:list');
    providersCache = Array.isArray(providers) ? providers.filter((p) => p.enabled) : [];
  } catch {
    providersCache = [];
  }

  ui.providerSelect.textContent = '';
  if (providersCache.length === 0) {
    ui.providerSelect.append(h('option', { value: '' }, tr('providerEmpty')));
    ui.modelSelect.textContent = '';
    ui.modelSelect.append(h('option', { value: '' }, tr('modelEmptyOption')));
    ui.providerSelect.disabled = true;
    ui.modelSelect.disabled = true;
    ui.refreshModelsBtn.disabled = true;
    ui.providersEmpty.hidden = false;
    state.providerId = '';
    state.model = '';
    updateValidity();
    return;
  }

  ui.providersEmpty.hidden = true;
  ui.providerSelect.disabled = false;
  ui.modelSelect.disabled = false;
  ui.refreshModelsBtn.disabled = false;
  for (const p of providersCache) {
    ui.providerSelect.append(h('option', { value: p.id }, `${p.name}${p.defaultModel ? ` (${p.defaultModel})` : ''}`));
  }
  if (!providersCache.some((p) => p.id === state.providerId)) {
    state.providerId = providersCache[0].id;
  }
  ui.providerSelect.value = state.providerId;
  await loadModels(false);
}

async function loadModels(afterRefresh) {
  const id = state.providerId;
  const provider = providersCache.find((p) => p.id === id);
  ui.modelSelect.textContent = '';
  let models = [];
  if (id) {
    try { models = await invoke('providers:get-models', { id }) ?? []; } catch { models = []; }
  }
  if (!Array.isArray(models)) models = [];

  if (models.length === 0) {
    ui.modelSelect.append(h('option', { value: '' }, tr('modelEmptyOption')));
    if (provider?.defaultModel) {
      ui.modelSelect.append(h('option', { value: provider.defaultModel }, `${provider.defaultModel} (${tr('defaultModelTag')})`));
    }
  } else {
    for (const m of models.slice(0, 500)) {
      ui.modelSelect.append(h('option', { value: m.id }, m.id));
    }
  }

  const ids = [...ui.modelSelect.options].map((o) => o.value);
  if (!ids.includes(state.model)) state.model = ids[0] ?? '';
  ui.modelSelect.value = state.model;

  ui.routingHint.textContent = models.length === 0 && afterRefresh
    ? cr('modelsEmptyAfterRefresh')
    : cr('modelsHint');
  updateValidity();
}

async function refreshModels(manual) {
  if (!state.providerId) return;
  ui.refreshModelsBtn.disabled = true;
  try {
    await invoke('providers:refresh-models', { id: state.providerId });
    await loadModels(true);
    if (manual) toast(cr('refreshDone'), '', { kind: 'success' });
  } catch (err) {
    if (manual) toast(tr('modelsFailedT'), err.message, { kind: 'error' });
  } finally {
    ui.refreshModelsBtn.disabled = false;
  }
}

// -- parameters ------------------------------------------------------------

function paramsCard() {
  ui.temperatureOut = h('output', { class: 'mr-bldr-out', for: 'bldr-temp' });
  ui.temperature = h('input', {
    type: 'range', class: 'm3-slider', id: 'bldr-temp',
    min: String(LIMITS.temperature.min), max: String(LIMITS.temperature.max), step: String(LIMITS.temperature.step),
    'aria-label': tr('temperatureLabel'),
    oninput: (e) => {
      state.params.temperature = Number(e.target.value);
      ui.temperatureOut.value = Number(e.target.value).toFixed(2);
      markDirty();
    },
  });

  ui.topPOut = h('output', { class: 'mr-bldr-out', for: 'bldr-topp' });
  ui.topP = h('input', {
    type: 'range', class: 'm3-slider', id: 'bldr-topp',
    min: String(LIMITS.topP.min), max: String(LIMITS.topP.max), step: String(LIMITS.topP.step),
    'aria-label': tr('topPLabel'),
    oninput: (e) => {
      state.params.topP = Number(e.target.value);
      ui.topPOut.value = Number(e.target.value).toFixed(2);
      markDirty();
    },
  });

  ui.maxTokens = h('input', {
    type: 'number', class: 'mr-bldr-num',
    min: String(LIMITS.maxTokens.min), max: String(LIMITS.maxTokens.max), step: '1',
    'aria-label': tr('maxTokensLabel'),
    onchange: (e) => {
      let v = Math.round(Number(e.target.value));
      if (!Number.isFinite(v)) v = LIMITS.maxTokens.default;
      v = Math.min(LIMITS.maxTokens.max, Math.max(LIMITS.maxTokens.min, v));
      e.target.value = String(v);
      state.params.maxTokens = v;
      markDirty();
    },
  });

  // Stop-sequence chip editor: typed entry stays available because stop
  // sequences cannot be enumerated, plus one-tap suggestion chips.
  ui.stopInput = h('input', {
    type: 'text', class: 'mr-grow',
    'aria-label': tr('stopInputLabel'),
    placeholder: '\\n\\nUser:',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addStopFromInput(); } },
  });
  ui.stopAddBtn = h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: addStopFromInput }, tr('stopAdd'));
  ui.stopChips = h('div', { class: 'mr-row', role: 'list', 'aria-label': tr('stopLabel'), style: 'flex-wrap:wrap' });

  ui.streamSwitch = switchRow(tr('streamLabel'), () => state.params.stream, (v) => { state.params.stream = v; markDirty(); });

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('h2', { class: 'm3-card__title' }, tr('paramsTitle')),
    sliderRow(tr('temperatureLabel'), ui.temperature, ui.temperatureOut),
    sliderRow(tr('topPLabel'), ui.topP, ui.topPOut),
    fieldRow(tr('maxTokensLabel'), ui.maxTokens),
    h('div', { class: 'mr-col', style: 'margin-top:12px' },
      h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('stopLabel')),
      h('div', { class: 'mr-row' }, ui.stopInput, ui.stopAddBtn),
      h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
        h('span', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('stopSuggest')),
        ...['\\n\\nUser:', 'END', '###'].map((s) => h('button', {
          class: 'm3-chip',
          onclick: () => addStop(s),
          'aria-label': `${tr('stopInputLabel')}: ${s}`,
        }, s.replace('\\n\\n', '¶¶'))),
      ),
      ui.stopChips,
      h('p', { class: 'mr-typography-body-small', style: 'margin:4px 0 0;color:var(--md-sys-color-on-surface-variant)' }, tr('stopHelp')),
    ),
    h('div', { style: 'margin-top:12px' }, ui.streamSwitch),
  );
}

function addStopFromInput() {
  const v = ui.stopInput.value.trim();
  if (!v) return;
  ui.stopInput.value = '';
  addStop(v);
}

function addStop(value) {
  if (state.params.stops.length >= LIMITS.stops.max || state.params.stops.includes(value)) return;
  state.params.stops.push(value);
  renderStopChips();
  markDirty();
}

function removeStop(value) {
  state.params.stops = state.params.stops.filter((s) => s !== value);
  renderStopChips();
  markDirty();
}

function renderStopChips() {
  ui.stopChips.textContent = '';
  for (const s of state.params.stops) {
    ui.stopChips.append(
      h('span', { class: 'm3-chip m3-chip--selected', role: 'listitem' },
        h('code', {}, s.replace(/\n/g, '¶')),
        h('button', {
          class: 'mr-bldr-chip-x',
          'aria-label': tr('stopRemoveAria', { value: s }),
          onclick: () => removeStop(s),
        }, '✕'),
      ),
    );
  }
  if (state.params.stops.length === 0) {
    ui.stopChips.append(h('span', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, '—'));
  }
}

// -- system prompt ----------------------------------------------------------

function systemCard() {
  ui.systemPreset = h('select', {
    class: 'mr-bldr-select',
    'aria-label': tr('systemPresetLabel'),
    onchange: (e) => {
      state.system.presetKey = e.target.value;
      const preset = SYSTEM_PRESETS.find((p) => p.key === e.target.value);
      if (preset) ui.systemCustom.value = preset.text;
      state.system.custom = ui.systemCustom.value;
      renderProvenance();
      markDirty();
    },
  }, ...SYSTEM_PRESETS.map((p) => h('option', { value: p.key }, tr(`sys${cap(p.key)}`))));

  ui.systemCustom = h('textarea', {
    class: 'mr-bldr-area',
    rows: '4',
    'aria-label': tr('systemCustomLabel'),
    oninput: (e) => { state.system.custom = e.target.value; renderProvenance(); markDirty(); },
  });
  ui.provenance = h('p', { class: 'mr-typography-body-small mr-bldr-provenance' }, '');
  return h('section', { class: 'm3-card m3-card--outlined' },
    h('h2', { class: 'm3-card__title' }, tr('systemTitle')),
    fieldRow(tr('systemPresetLabel'), ui.systemPreset),
    labeledArea(tr('systemCustomLabel'), ui.systemCustom),
    ui.provenance,
  );
}

function renderProvenance() {
  const custom = state.system.custom.trim();
  const preset = SYSTEM_PRESETS.find((p) => p.key === state.system.presetKey);
  if (custom && preset && custom === preset.text) {
    ui.provenance.textContent = cr('provenancePreset', { preset: tr(`sys${cap(preset.key)}`) });
  } else if (custom) {
    ui.provenance.textContent = cr('provenanceCustom');
  } else {
    ui.provenance.textContent = cr('provenanceNone');
  }
}

// -- tools -------------------------------------------------------------------

function toolsCard() {
  ui.toolsSwitch = switchRow(tr('toolsEnableLabel'), () => state.tools.enabled, (v) => {
    state.tools.enabled = v;
    ui.toolForm.hidden = !v;
    markDirty();
  });

  ui.toolName = h('select', {
    class: 'mr-bldr-select',
    'aria-label': tr('toolNameLabel'),
    onchange: (e) => {
      state.tools.suggestionIndex = Number(e.target.value);
      const sug = TOOL_SUGGESTIONS[state.tools.suggestionIndex];
      ui.toolDesc.value = sug.description;
      state.tools.description = sug.description;
      markDirty();
    },
  }, ...TOOL_SUGGESTIONS.map((s, i) => h('option', { value: String(i) }, s.name)));

  ui.toolDesc = h('textarea', {
    class: 'mr-bldr-area',
    rows: '2',
    'aria-label': tr('toolDescLabel'),
    oninput: (e) => { state.tools.description = e.target.value; markDirty(); },
  });

  ui.toolSchema = h('select', {
    class: 'mr-bldr-select',
    'aria-label': tr('toolSchemaLabel'),
    onchange: (e) => { state.tools.templateKey = e.target.value; renderSchemaPreview(); markDirty(); },
  }, ...SCHEMA_TEMPLATES.map((tp) => h('option', { value: tp.key }, tp.label)));

  ui.schemaPre = h('pre', { class: 'mr-bldr-code mr-bldr-code--small', 'aria-label': tr('schemaPreviewLabel') });
  ui.toolForm = h('div', { class: 'mr-col', style: 'margin-top:10px' },
    fieldRow(tr('toolNameLabel'), ui.toolName),
    labeledArea(tr('toolDescLabel'), ui.toolDesc),
    fieldRow(tr('toolSchemaLabel'), ui.toolSchema),
    h('div', {}, h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('schemaPreviewLabel')), ui.schemaPre),
  );

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('h2', { class: 'm3-card__title' }, tr('toolsTitle')),
    ui.toolsSwitch,
    ui.toolForm,
  );
}

function renderSchemaPreview() {
  const template = SCHEMA_TEMPLATES.find((x) => x.key === state.tools.templateKey) ?? SCHEMA_TEMPLATES[0];
  ui.schemaPre.textContent = JSON.stringify(template.schema, null, 2);
}

// -- messages ------------------------------------------------------------------

function messagesCard() {
  ui.messagesHost = h('div', { class: 'mr-col', role: 'list', 'aria-label': tr('messagesTitle') });
  ui.roleNoteHost = h('p', { class: 'mr-typography-body-small mr-bldr-systemnote hidden' }, tr('systemRoleNote'));
  ui.addMsgBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    onclick: () => {
      state.messages.push(newMessage('user'));
      renderMessages();
      markDirty();
    },
  }, `＋ ${tr('addMessage')}`);

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('div', { class: 'mr-row' },
      h('h2', { class: 'm3-card__title', style: 'margin:0' }, tr('messagesTitle')),
      h('span', { class: 'mr-grow' }),
      ui.addMsgBtn,
    ),
    ui.messagesHost,
    ui.roleNoteHost,
  );
}

function renderMessages() {
  ui.messagesHost.textContent = '';
  ui.roleSelects = [];

  if (state.messages.length === 0) {
    ui.messagesHost.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('emptyMessages')));
    return;
  }

  state.messages.forEach((msg, idx) => {
    const roleSel = h('select', {
      class: 'mr-bldr-select mr-bldr-role',
      'aria-label': `${tr('roleLabel')} #${idx + 1}`,
      onchange: (e) => { msg.role = e.target.value; markDirty(); },
    }, ...MESSAGE_ROLES.map((r) => h('option', { value: r }, r)));
    roleSel.value = msg.role;
    ui.roleSelects.push(roleSel);

    const area = h('textarea', {
      class: 'mr-bldr-area mr-grow',
      rows: '2',
      'aria-label': `${tr('contentLabel')} #${idx + 1}`,
      oninput: (e) => { msg.content = e.target.value; saveDraft(); updateValidityDebounced(); },
    });
    area.value = msg.content;

    const row = h('div', { class: 'mr-bldr-msg', role: 'listitem' },
      h('div', { class: 'mr-row' },
        h('span', { class: 'mr-bldr-msgnum', 'aria-hidden': 'true' }, String(idx + 1)),
        roleSel,
        h('span', { class: 'mr-grow' }),
        iconButton('↑', tr('moveUp'), () => moveMessage(idx, -1), idx === 0),
        iconButton('↓', tr('moveDown'), () => moveMessage(idx, 1), idx === state.messages.length - 1),
        iconButton('⧉', tr('duplicate'), () => duplicateMessage(idx), false),
        iconButton('✕', tr('deleteMsg'), () => deleteMessage(idx), false, true),
      ),
      area,
    );
    ui.messagesHost.append(row);
  });
  applyRoleAvailability();
}

function moveMessage(idx, delta) {
  const next = idx + delta;
  if (next < 0 || next >= state.messages.length) return;
  const [m] = state.messages.splice(idx, 1);
  state.messages.splice(next, 0, m);
  renderMessages();
  markDirty();
}

function duplicateMessage(idx) {
  const src = state.messages[idx];
  state.messages.splice(idx + 1, 0, { ...newMessage(src.role), content: src.content });
  renderMessages();
  markDirty();
}

async function deleteMessage(idx) {
  const msg = state.messages[idx];
  if (!msg) return;
  const ok = await destructiveConfirm({
    title: tr('deleteMsgConfirmTitle', { index: idx + 1 }),
    body: tr('deleteMsgConfirmBody', { role: msg.role }),
    confirmLabel: t('common.delete'),
  });
  if (!ok) return;
  state.messages.splice(idx, 1);
  renderMessages();
  history.record(cr('histMsgDelete'), `#${idx + 1} · ${msg.role}`);
  markDirty();
}

// -- preview -----------------------------------------------------------------

function previewCard() {
  ui.fmtGroup = h('div', { class: 'mr-bldr-seg mr-bldr-seg--sm', role: 'radiogroup', 'aria-label': tr('previewTitle') },
    miniSeg('openai', tr('fmtOpenai')),
    miniSeg('anthropic', tr('fmtAnthropic')),
  );
  ui.previewCode = h('code', {});
  ui.previewPre = h('pre', { class: 'mr-bldr-code', 'aria-label': tr('previewTitle') }, ui.previewCode);
  ui.notesList = h('ul', { class: 'mr-bldr-notes', 'aria-label': tr('translateNotes') });
  ui.invalidList = h('div', { class: 'mr-bldr-invalid', role: 'alert' });

  ui.sendBtn = h('button', {
    class: 'm3-btn m3-btn--filled',
    onclick: sendTestRequest,
  }, tr('sendBtn'));
  ui.cancelBtn = h('button', {
    class: 'm3-btn m3-btn--outlined',
    style: 'display:none',
    onclick: () => { if (activeRequestId) invoke('builder:test-abort', { requestId: activeRequestId }).catch(() => {}); },
  }, tr('cancelBtn'));
  ui.copyBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: async () => {
      const body = previewBody();
      if (body != null) {
        await writeClipboard(JSON.stringify(body, null, 2));
        toast(cr('copiedToastTitle'), '', { kind: 'success', timeout: 2500 });
      }
    },
  }, tr('copyPreview'));

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('h2', { class: 'm3-card__title', style: 'margin:0' }, tr('previewTitle')),
      ui.fmtGroup,
      h('span', { class: 'mr-grow' }),
      ui.copyBtn,
    ),
    h('p', { class: 'mr-typography-body-small mr-bldr-hint' }, cr('previewHint')),
    ui.previewPre,
    h('div', {},
      h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('translateNotes')),
      ui.notesList,
    ),
    ui.invalidList,
    h('div', { class: 'mr-row', style: 'margin-top:12px' },
      ui.sendBtn,
      ui.cancelBtn,
      h('span', { class: 'mr-grow' }),
    ),
  );
}

function miniSeg(value, label) {
  return h('button', {
    class: 'mr-bldr-seg__btn mr-bldr-seg__btn--sm',
    role: 'radio',
    dataset: { value },
    'aria-checked': String(previewFormat === value),
    tabindex: previewFormat === value ? '0' : '-1',
    onclick: () => setPreviewFormat(value),
    onkeydown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = value === 'openai' ? 'anthropic' : 'openai';
      setPreviewFormat(next);
      ui.fmtGroup.querySelector(`[data-value="${next}"]`)?.focus();
    },
  }, label);
}

function setPreviewFormat(v) {
  previewFormat = v;
  for (const btn of ui.fmtGroup.querySelectorAll('[role=radio]')) {
    const on = btn.dataset.value === v;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? '0' : '-1';
  }
  renderPreview();
}

function previewBody() {
  if (previewFormat === 'anthropic') return lastPreview.anthropic;
  return lastPreview.openai;
}

async function refreshPreview() {
  const body = canonicalOpenAIBody(state);
  lastPreview.openai = body;
  try {
    const { req, notes } = await invoke('builder:translate-preview', { body: structuredClone(body) });
    lastPreview.anthropic = req;
    lastPreview.notes = Array.isArray(notes) ? notes : [];
  } catch {
    lastPreview.anthropic = null;
    lastPreview.notes = [{ code: 'preview_unavailable', message: '' }];
  }
  renderPreview();
  renderSnippet();
}

function renderPreview() {
  const body = previewBody();
  ui.previewCode.textContent = body == null ? '{}' : JSON.stringify(body, null, 2);

  ui.notesList.textContent = '';
  const notes = previewFormat === 'anthropic' ? lastPreview.notes : [];
  const visible = notes.filter((n) => n?.message);
  if (visible.length === 0) {
    ui.notesList.append(h('li', { class: 'mr-typography-body-small' }, tr('noNotes')));
  } else {
    for (const n of visible) {
      ui.notesList.append(h('li', { class: 'mr-typography-body-small' }, n.message));
    }
  }
}

function updateValidity() {
  const errs = validationErrors(state);
  ui.invalidList.textContent = '';
  if (errs.length > 0) {
    ui.invalidList.append(h('strong', { class: 'mr-typography-label-large' }, tr('invalidTitle')));
    ui.invalidList.append(h('ul', {}, ...errs.map((k) => h('li', { class: 'mr-typography-body-small' }, tr(k.replace(`${BUNDLE_NS}.`, ''))))));
  }
  const busy = Boolean(activeRequestId);
  ui.sendBtn.disabled = errs.length > 0 || busy;
  ui.sendBtn.setAttribute('aria-disabled', String(ui.sendBtn.disabled));
}
const updateValidityDebounced = debounce(() => updateValidity(), 350);

// -- send + response -----------------------------------------------------------

async function sendTestRequest() {
  if (activeRequestId) return;
  const errs = validationErrors(state);
  if (errs.length > 0) {
    toast(tr('sendFailedT'), tr(errs[0].replace(`${BUNDLE_NS}.`, '')), { kind: 'error' });
    return;
  }
  const body = canonicalOpenAIBody(state);
  responseResult = null;
  renderResponseLoading();

  try {
    const { requestId } = await invoke('builder:test-send', {
      endpoint: state.endpoint,
      body,
      stream: Boolean(state.params.stream),
    });
    activeRequestId = requestId;
    updateValidity();
    ui.cancelBtn.style.display = '';
    ui.sendBtn.textContent = tr('sending');
  } catch (err) {
    activeRequestId = null;
    responseResult = { error: { status: null, type: 'builder', message: err.message } };
    renderResponse();
    updateValidity();
  }
}

let streamSubscribed = false;
function subscribeStream() {
  if (streamSubscribed) return;
  streamSubscribed = true;
  on('builder-stream', (evt) => {
    if (!evt || evt.requestId !== activeRequestId) return;
    switch (evt.kind) {
      case 'start':
        ui.cancelBtn.style.display = '';
        break;
      case 'note':
        appendStreamNote(evt.detail ?? '');
        break;
      case 'done': {
        responseResult = {
          status: evt.status, ms: evt.ms, bytes: evt.bytes,
          response: evt.response ?? null, usage: evt.usage ?? extractUsage(null),
          text: evt.text, truncated: Boolean(evt.truncated),
          transcript: evt.transcript ?? '',
          streamed: typeof evt.text === 'string',
        };
        finishRequest();
        break;
      }
      case 'error':
        responseResult = { error: { status: evt.status, type: evt.type, message: evt.message } };
        finishRequest();
        toast(tr('sendFailedT'), evt.message ?? '', { kind: 'error' });
        break;
      case 'aborted':
        responseResult = { aborted: true };
        finishRequest();
        toast(tr('aborted'), '', { kind: 'info' });
        break;
      default:
        break;
    }
  });
}

function finishRequest() {
  activeRequestId = null;
  ui.cancelBtn.style.display = 'none';
  ui.sendBtn.textContent = tr('sendBtn');
  renderResponse();
  updateValidity();
}

function responseCard() {
  ui.respMeta = h('dl', { class: 'mr-bldr-meta' });
  ui.usageTable = h('table', { class: 'mr-bldr-table' });
  ui.modeGroup = h('div', { class: 'mr-bldr-seg mr-bldr-seg--sm', role: 'radiogroup', 'aria-label': `${tr('prettyToggle')}/${tr('rawToggle')}` },
    respModeSeg('pretty', tr('prettyToggle')),
    respModeSeg('raw', tr('rawToggle')),
  );
  ui.respOutput = h('div', {
    class: 'mr-bldr-resp',
    role: 'log',
    'aria-live': 'polite',
    'aria-label': tr('streamOutputLabel'),
  });
  ui.clearRespBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: clearResponse,
  }, tr('clearResponse'));

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('h2', { class: 'm3-card__title', style: 'margin:0' }, tr('responseTitle')),
      ui.modeGroup,
      h('span', { class: 'mr-grow' }),
      ui.clearRespBtn,
    ),
    ui.respMeta,
    h('h3', { class: 'mr-typography-label-large', style: 'margin:12px 0 4px' }, tr('usageTitle')),
    ui.usageTable,
    ui.respOutput,
    h('p', { class: 'mr-typography-body-small mr-bldr-hint' }, cr('sentViaRouter')),
  );
}

function respModeSeg(value, label) {
  return h('button', {
    class: 'mr-bldr-seg__btn mr-bldr-seg__btn--sm',
    role: 'radio',
    dataset: { value },
    'aria-checked': String(responseMode === value),
    tabindex: responseMode === value ? '0' : '-1',
    onclick: () => {
      responseMode = value;
      for (const b of ui.modeGroup.querySelectorAll('[role=radio]')) {
        const on = b.dataset.value === value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? '0' : '-1';
      }
      renderResponse();
    },
  }, label);
}

function renderResponseLoading() {
  ui.respMeta.textContent = '';
  ui.usageTable.textContent = '';
  ui.respOutput.textContent = '';
  ui.respOutput.append(
    h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('sending')),
    h('div', { class: 'mr-bldr-streamlog', id: 'mr-bldr-streamlog' }),
  );
}

let streamLogEl = null;
function appendStreamNote(detail) {
  streamLogEl = document.getElementById('mr-bldr-streamlog');
  if (!streamLogEl) return;
  streamLogEl.append(h('div', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, detail));
}

function clearResponse() {
  responseResult = null;
  ui.respMeta.textContent = '';
  ui.usageTable.textContent = '';
  ui.respOutput.textContent = '';
  ui.respOutput.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('respEmpty')));
}

function renderResponse() {
  ui.respMeta.textContent = '';
  ui.usageTable.textContent = '';

  if (!responseResult) {
    ui.respOutput.textContent = '';
    ui.respOutput.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('respEmpty')));
    return;
  }

  if (responseResult.aborted) {
    ui.respOutput.textContent = '';
    ui.respOutput.append(h('p', { class: 'mr-typography-body-medium' }, tr('aborted')));
    return;
  }

  if (responseResult.error) {
    const e = responseResult.error;
    ui.respMeta.append(metaItem(tr('respStatus'), String(e.status ?? '—')));
    ui.respOutput.textContent = '';
    ui.respOutput.append(h('pre', { class: 'mr-bldr-code mr-bldr-code--error' }, `${e.type ?? 'error'}: ${e.message ?? ''}`));
    return;
  }

  ui.respMeta.append(
    metaItem(tr('respStatus'), String(responseResult.status ?? '—')),
    metaItem(tr('respTime'), `${Math.round(responseResult.ms ?? 0)} ms`),
    metaItem(tr('respFormat'), state.endpoint === 'anthropic' ? 'Anthropic' : 'OpenAI'),
  );

  const u = responseResult.usage ?? {};
  ui.usageTable.append(
    h('tr', {},
      th(tr('usagePrompt')), th(tr('usageCompletion')), th(tr('usageTotal')),
    ),
    h('tr', {},
      td(fmtTok(u.prompt)), td(fmtTok(u.completion)), td(fmtTok(u.total)),
    ),
  );

  ui.respOutput.textContent = '';
  if (responseResult.streamed) {
    const body = responseMode === 'raw'
      ? (responseResult.transcript || '')
      : (responseResult.text || '');
    ui.respOutput.append(h('pre', { class: 'mr-bldr-code mr-bldr-code--wrap' }, body));
    if (responseResult.truncated) {
      ui.respOutput.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
        tr('streamTruncated', { kb: Math.round(400) })));
    }
    return;
  }

  const json = responseResult.response;
  const text = json == null ? '' : (responseMode === 'raw' ? JSON.stringify(json) : JSON.stringify(json, null, 2));
  ui.respOutput.append(h('pre', { class: 'mr-bldr-code mr-bldr-code--wrap' }, text));
}

function metaItem(label, value) {
  return h('div', { class: 'mr-bldr-meta__item' },
    h('dt', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, label),
    h('dd', { class: 'mr-typography-body-medium' }, value),
  );
}
function th(text) { return h('th', { scope: 'col', class: 'mr-typography-label-medium' }, text); }
function td(text) { return h('td', { class: 'mr-typography-body-medium' }, text); }
function fmtTok(v) { return v == null ? '—' : String(v); }

// -- presets --------------------------------------------------------------------

function presetsCard() {
  ui.presetSearch = createSearchBar({
    placeholder: tr('searchPlaceholder'),
    label: tr('searchPlaceholder'),
    onQuery: () => renderPresetList(),
  });
  ui.presetsHost = h('div', { class: 'mr-col' });

  ui.savePresetBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    onclick: savePresetFlow,
  }, tr('savePreset'));

  ui.exportPresetsBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: exportPresets,
  }, tr('exportPreset'));

  ui.openEditorBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => openInEditor(`material-router-presets-${Date.now()}.json`, JSON.stringify(currentPresetsForEditor(), null, 2)),
  }, tr('openInEditor'));

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('h2', { class: 'm3-card__title' }, tr('presetsTitle')),
    ui.presetSearch.el,
    ui.presetsHost,
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap;margin-top:8px' },
      ui.savePresetBtn, ui.exportPresetsBtn, ui.openEditorBtn,
    ),
  );
}

let presetsCache = [];
async function reloadPresets() {
  try {
    const { presets } = await invoke('builder:preset-list');
    presetsCache = Array.isArray(presets) ? presets : [];
  } catch {
    presetsCache = [];
  }
  renderPresetList();
}

function currentPresetsForEditor() {
  const q = ui.presetSearch?.get?.() ?? { text: '', mode: 'plain' };
  return {
    exportedAt: new Date().toISOString(),
    count: filteredPresets(q).length,
    presets: filteredPresets(q),
  };
}

function filteredPresets(q) {
  return presetsCache.filter((p) => matchesQuery(q, `${p.name}\n${JSON.stringify(p.preset ?? {})}`));
}

function renderPresetList() {
  if (!ui.presetsHost) return;
  const q = ui.presetSearch.get();
  const rows = filteredPresets(q);
  ui.presetsHost.textContent = '';

  if (rows.length === 0) {
    ui.presetsHost.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, tr('presetsEmpty')));
    return;
  }
  for (const p of rows) {
    ui.presetsHost.append(h('div', { class: 'mr-bldr-preset' },
      h('div', { class: 'mr-grow', style: 'min-width:0' },
        h('div', { class: 'mr-typography-body-medium', style: 'font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, p.name),
        h('time', { datetime: p.updatedAt, class: 'mr-typography-label-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, p.updatedAt?.slice(0, 19).replace('T', ' ')),
      ),
      h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => loadPreset(p) }, tr('load')),
      h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        style: 'color:var(--md-sys-color-error)',
        onclick: () => deletePreset(p),
      }, tr('deletePreset')),
    ));
  }
}

function loadPreset(p) {
  if (!p?.preset) return;
  state = normalizeComposition(structuredClone(p.preset));
  syncAllControls();
  markDirty();
  history.record(cr('histLoad'), p.name);
  toast(cr('histLoad'), cr('presetLoadedB', { name: p.name }), { kind: 'success' });
}

async function deletePreset(p) {
  const ok = await destructiveConfirm({
    title: tr('deletePresetConfirmTitle', { name: p.name }),
    body: tr('deletePresetConfirmBody', { name: p.name }),
    confirmLabel: t('common.delete'),
  });
  if (!ok) return;
  try {
    await invoke('builder:preset-delete', { id: p.id });
    history.record(cr('histDelete'), p.name);
    toast(cr('histDelete'), cr('presetDeletedB', { name: p.name }));
  } catch (err) {
    toast(t('common.errorTitle'), err.message, { kind: 'error' });
  }
  await reloadPresets();
}

async function savePresetFlow() {
  const suggested = tr('defaultPresetName', { ts: new Date().toISOString().slice(0, 16).replace('T', ' ') });
  const name = await promptText({
    title: tr('presetNameTitle'),
    label: tr('presetNameLabel'),
    value: suggested,
  });
  if (name === null) return;
  const clean = name.trim() || suggested;

  const existing = presetsCache.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    const replace = await confirm({
      title: tr('presetReplaceTitle'),
      body: tr('presetReplaceBody', { name: clean }),
      confirmLabel: t('common.confirm'),
    });
    if (!replace) return;
  }

  const preset = {
    endpoint: state.endpoint,
    providerId: state.providerId,
    model: state.model,
    params: structuredClone(state.params),
    system: { ...state.system },
    tools: { ...state.tools },
    messages: state.messages.map(({ role, content }) => ({ role, content })),
  };

  try {
    const { replaced } = await invoke('builder:preset-save', {
      name: clean,
      preset,
      id: existing?.id,
    });
    history.record(cr('histSave'), clean);
    toast(cr('histSave'), replaced ? cr('presetReplacedB', { name: clean }) : cr('presetSavedB', { name: clean }), { kind: 'success' });
  } catch (err) {
    toast(t('common.errorTitle'), err.message, { kind: 'error' });
  }
  await reloadPresets();
}

function exportPresets() {
  const data = currentPresetsForEditor();
  saveText(`material-router-presets-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  history.record(cr('histExport'), `${data.count}`);
}

async function openInEditor(filename, content) {
  try {
    const res = await invoke('builder:open-in-editor', { filename, content });
    if (res.opened === 'vscode') {
      toast(cr('histEditor'), cr('openedVscode', { path: res.path }), { kind: 'success' });
    } else if (res.opened === 'default') {
      toast(cr('histEditor'), cr('openedDefault', { path: res.path }));
    } else {
      toast(tr('openFailed', { reason: res.reason ?? '' }), res.path, { kind: 'error' });
    }
    history.record(cr('histEditor'), filename);
  } catch (err) {
    toast(t('common.errorTitle'), err.message, { kind: 'error' });
  }
}

// -- snippets ---------------------------------------------------------------------

function snippetCard() {
  ui.snippetLang = h('select', {
    class: 'mr-bldr-select',
    'aria-label': tr('langLabel'),
    onchange: (e) => { snippetLang = e.target.value; renderSnippet(); },
  }, ...SNIPPET_LANGUAGES.map((l) => h('option', { value: l.key }, l.label)));

  ui.snippetCode = h('code', {});
  ui.snippetPre = h('pre', { class: 'mr-bldr-code', 'aria-label': tr('snippetTitle') }, ui.snippetCode);
  ui.snippetHint = h('p', { class: 'mr-typography-body-small mr-bldr-hint' }, '');

  return h('section', { class: 'm3-card m3-card--outlined' },
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('h2', { class: 'm3-card__title', style: 'margin:0' }, tr('snippetTitle')),
      h('span', { class: 'mr-grow' }),
      h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        onclick: async () => {
          await writeClipboard(ui.snippetCode.textContent);
          toast(cr('copiedToastTitle'), '', { kind: 'success', timeout: 2500 });
        },
      }, tr('copySnippet')),
      h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        onclick: () => saveText(snippetFilename(snippetLang), ui.snippetCode.textContent),
      }, tr('exportSnippet')),
    ),
    fieldRow(tr('langLabel'), ui.snippetLang),
    ui.snippetPre,
    ui.snippetHint,
  );
}

function renderSnippet() {
  if (!ui.snippetCode || !ui.snippetHint) return;
  const anthropicBody = lastPreview.anthropic;
  const text = generateSnippet(
    snippetLang,
    { endpoint: state.endpoint, openaiBody: lastPreview.openai ?? canonicalOpenAIBody(state), anthropicBody },
    serverInfo,
  );
  ui.snippetCode.textContent = text;
  const url = `http://${serverInfo.host}:${serverInfo.port}`;
  ui.snippetHint.textContent = cr('snippetHint', { url })
    + (serverInfo.running ? '' : ` ${cr('serverStoppedNote')}`);
}

async function refreshServerInfo() {
  try {
    const s = await invoke('server:get-status');
    serverInfo = {
      host: s.host ?? serverInfo.host,
      port: s.port ?? serverInfo.port,
      authRequired: Boolean(s.authRequired),
      running: Boolean(s.running),
    };
  } catch { /* defaults stay */ }
  renderSnippet();
}

// ---------------------------------------------------------------------------
// Control sync (state -> DOM)
// ---------------------------------------------------------------------------

function syncAllControls() {
  for (const btn of ui.endpointGroup?.querySelectorAll('[role=radio]') ?? []) {
    const on = btn.dataset.value === state.endpoint;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? '0' : '-1';
  }
  ui.temperature.value = String(state.params.temperature);
  ui.temperatureOut.value = Number(state.params.temperature).toFixed(2);
  ui.topP.value = String(state.params.topP);
  ui.topPOut.value = Number(state.params.topP).toFixed(2);
  ui.maxTokens.value = String(state.params.maxTokens);

  ui.streamSwitch.querySelector('input').checked = state.params.stream;
  ui.toolsSwitch.querySelector('input').checked = state.tools.enabled;
  ui.toolForm.hidden = !state.tools.enabled;

  ui.systemPreset.value = state.system.presetKey;
  ui.systemCustom.value = state.system.custom;

  ui.toolName.value = String(state.tools.suggestionIndex);
  ui.toolDesc.value = state.tools.description;
  ui.toolSchema.value = state.tools.templateKey;
  renderSchemaPreview();

  renderStopChips();
  renderMessages();
  renderProvenance();

  ui.fmtGroup.querySelectorAll('[role=radio]').forEach((b) => {
    const on = b.dataset.value === previewFormat;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? '0' : '-1';
  });
}

async function resetComposer() {
  const ok = await destructiveConfirm({
    title: tr('resetConfirmTitle'),
    body: tr('resetConfirmBody'),
    confirmLabel: t('common.delete'),
  });
  if (!ok) return;
  state = defaultComposition();
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  const panel = document.getElementById('mr-tab-panel-builder');
  if (panel) mount(panel);
  history.record(cr('histReset'), '');
  toast(cr('histReset'), cr('composerResetB'));
}

// ---------------------------------------------------------------------------
// Shared tiny builders
// ---------------------------------------------------------------------------

function fieldRow(labelText, control, ...extra) {
  const wrap = h('label', { class: 'mr-bldr-field' },
    h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, labelText),
  );
  const row = h('div', { class: 'mr-row' }, control, ...extra);
  wrap.append(row);
  // Clicking the wrapper label focuses the first focusable child.
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) row.querySelector('select,input,textarea,button')?.focus();
  });
  return wrap;
}

function labeledArea(labelText, control) {
  return h('label', { class: 'mr-bldr-field' },
    h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, labelText),
    control,
  );
}

function sliderRow(labelText, slider, out) {
  return h('div', { class: 'mr-bldr-sliderrow' },
    h('div', { class: 'mr-row' },
      h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, labelText),
      h('span', { class: 'mr-grow' }),
      out,
    ),
    slider,
  );
}

function switchRow(labelText, _get, setChange) {
  const input = h('input', {
    type: 'checkbox',
    'aria-label': labelText,
    onchange: (e) => setChange(e.target.checked),
  });
  return h('label', { class: 'm3-switch' },
    input,
    h('span', { class: 'track' }, h('span', { class: 'thumb' })),
    h('span', { class: 'label-text' }, labelText),
  );
}

function iconButton(glyph, label, onClick, disabled, danger = false) {
  return h('button', {
    class: `m3-btn m3-btn--text m3-btn--sm m3-btn--icon-only${danger ? ' mr-bldr-danger' : ''}`,
    'aria-label': label,
    title: label,
    disabled: disabled ? true : null,
    onclick: onClick,
  }, glyph);
}

function iconTextButton(label, onClick, glyph) {
  return h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: onClick },
    h('span', { 'aria-hidden': 'true' }, glyph), label);
}

// ---------------------------------------------------------------------------
// Command palette coverage
// ---------------------------------------------------------------------------

let paletteRegistered = false;
function registerPaletteItems() {
  const runIfMounted = (fn) => () => { if (ui.sendBtn?.isConnected) fn(); };
  const items = [
    { id: 'builder.sendTest', titleKey: 'palSend', run: runIfMounted(sendTestRequest) },
    { id: 'builder.addMessage', titleKey: 'palAddMsg', run: runIfMounted(() => ui.addMsgBtn.click()) },
    { id: 'builder.savePreset', titleKey: 'palSavePreset', run: runIfMounted(savePresetFlow) },
    {
      id: 'builder.copyPreview', titleKey: 'palCopyPreview',
      run: runIfMounted(async () => {
        const body = previewBody();
        if (body != null) {
          await writeClipboard(JSON.stringify(body, null, 2));
          toast(cr('copiedToastTitle'), '', { kind: 'success', timeout: 2500 });
        }
      }),
    },
    { id: 'builder.toggleFmt', titleKey: 'palToggleFmt', run: runIfMounted(() => setPreviewFormat(previewFormat === 'openai' ? 'anthropic' : 'openai')) },
  ];
  for (const item of items) {
    palette.register({
      id: item.id,
      title: tr(item.titleKey),
      section: 'Actions',
      run: item.run,
    });
  }
  paletteRegistered = true;
  void paletteRegistered;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
