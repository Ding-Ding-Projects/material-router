// Purpose: scheduled appearance rules. A rule picks one target setting and a
// value, an optional date range + time window (native date/time inputs),
// either every day or an explicit weekday set, and can be toggled per rule.
//
// Semantics (stated in the UI too):
// - Dates are inclusive at BOTH ends.
// - Time windows support crossing midnight (start > end wraps).
//   Equal start/end means the WHOLE day matches. Empty times mean 00:00 /
//   23:59.
// - Weekdays are 0-6, Sunday=0. An EMPTY weekday set means every day.
// - Precedence: among matching enabled rules, the LATER rule in the list
//   wins. The UI states this next to the list.
// - Everything evaluates in the user's local timezone; the zone is shown.
// - External HTTPS/API sources are deliberately deferred this pass; local
//   profile import arrives through preset JSON import instead.
// Owned by Appearance lane.

import * as settings from '../../core/settings.js';
import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import { destructiveConfirm } from '../../core/dialogs.js';
import { toast } from '../../core/toasts.js';
import * as history from '../../core/history.js';
import * as engine from './engine.js';
import { createFilterPicker } from './filterpicker.js';
import { createColorPicker } from './colorpicker.js';

export const SCHEDULE_TARGETS = ['theme', 'density', 'accent', 'fontFamily', 'typeScale', 'rainbowSpeed'];

const TICK_MS = 15_000;

const state = {
  timer: null,
  lastAppliedKey: '',
  teardown: [],
};

function rules() {
  const list = settings.get('appearance.schedules', []);
  return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
}

async function saveRules(list) {
  await settings.set('appearance.schedules', list);
}

export function newRule(partial = {}) {
  return {
    id: `rule_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    enabled: true,
    target: 'theme',
    value: 'dark',
    startDate: '',
    endDate: '',
    startTime: '',
    endTime: '',
    days: [],
    ...partial,
  };
}

/** Pure evaluation: which targets are overridden right now, later rule wins. */
export function evaluateRules(list, now = new Date()) {
  const overrides = {};
  if (!Array.isArray(list)) return overrides;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const weekday = now.getDay();
  const today = localDateStamp(now);
  for (const rule of list) {
    if (!rule?.enabled) continue;
    if (!SCHEDULE_TARGETS.includes(rule.target)) continue;
    if (rule.startDate && today < rule.startDate) continue;
    if (rule.endDate && today > rule.endDate) continue;
    if (Array.isArray(rule.days) && rule.days.length > 0 && !rule.days.map(Number).includes(weekday)) continue;
    if (!inTimeWindow(rule.startTime, rule.endTime, minutes)) continue;
    overrides[rule.target] = coerceValue(rule.target, rule.value);
  }
  return overrides;
}

function coerceValue(target, raw) {
  if (target === 'typeScale') {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(engine.TYPE_SCALE_MAX, Math.max(engine.TYPE_SCALE_MIN, n)) : 1;
  }
  if (target === 'rainbowSpeed') {
    const n = Math.round(Number(raw));
    return n >= 1 && n <= 5 ? n : 3;
  }
  return String(raw ?? '');
}

export function inTimeWindow(start, end, minutes) {
  const s = parseHHMM(start, 0);
  const e = parseHHMM(end, 24 * 60 - 1);
  if (s === e) return true; // equal bounds = whole day (documented)
  if (s < e) return minutes >= s && minutes <= e;
  // Wraps midnight: e.g. 22:00 -> 06:00.
  return minutes >= s || minutes <= e;
}

function parseHHMM(value, fallbackMinute) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return fallbackMinute;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return fallbackMinute;
  return hh * 60 + mm;
}

export function localDateStamp(now = new Date()) {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function fingerprint(map) {
  return JSON.stringify(map);
}

/** One evaluation pass; applies diffs through the engine. */
export function tick({ recordHistory = false } = {}) {
  const overrides = evaluateRules(rules());
  const key = fingerprint(overrides);
  engine.setScheduleOverrides(overrides);
  if (recordHistory && key !== state.lastAppliedKey) {
    const entries = Object.entries(overrides);
    if (entries.length > 0) {
      history.record('scheduled-appearance',
        entries.map(([k, v]) => `${k}=${v}`).join(', '),
        t('appearance.sched.appliedByRule'));
    } else if (state.lastAppliedKey && state.lastAppliedKey !== '{}') {
      history.record('scheduled-appearance', t('appearance.sched.clearedTitle'),
        t('appearance.sched.clearedDetail'));
    }
    state.lastAppliedKey = key;
  }
}

/** Start the minute-tick + wake evaluation loop. */
export function initEngine() {
  tick({ recordHistory: true });
  state.timer = setInterval(() => tick({ recordHistory: true }), TICK_MS);
  const onWake = () => tick({ recordHistory: true });
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('focus', onWake);
  settings.onChange(() => tick({ recordHistory: true }));
  state.teardown.push(() => {
    clearInterval(state.timer);
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('focus', onWake);
  });
  return () => { for (const fn of state.teardown.splice(0)) fn(); };
}

export function timezoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * Render the schedules manager into `container`. Returns { refresh } so the
 * hosting tab can re-render after external changes.
 */
export function renderManager(container) {
  let queryState = null;

  const listEl = h('div', { class: 'mr-col', style: 'gap:8px' });
  const search = createSearchBar({
    placeholder: t('appearance.sched.searchPlaceholder'),
    label: t('appearance.sched.searchPlaceholder'),
    onQuery: (q) => { queryState = q; renderList(); },
  });

  const addBtn = h('button', { class: 'm3-btn m3-btn--filled m3-btn--sm', onclick: () => addRule() },
    t('appearance.sched.addRule'));
  const deleteSelectedBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm', disabled: true,
    onclick: () => deleteSelected(),
  }, t('appearance.sched.deleteSelected'));

  const selectedIds = new Set();

  function visibleRules() {
    const q = queryState ?? { text: '', mode: 'plain' };
    return rules().map((rule, idx) => ({ rule, idx }))
      .filter(({ rule }) => matchesQuery(q, `${ruleLabel(rule)} ${rule.target} ${String(rule.value)}`));
  }

  function ruleLabel(rule) {
    return t(`appearance.sched.target.${rule.target}`);
  }

  function renderList() {
    listEl.textContent = '';
    const rows = visibleRules();
    if (rows.length === 0) {
      listEl.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('appearance.sched.empty')));
    }
    for (const { rule, idx } of rows) {
      listEl.append(ruleRow(rule, idx));
    }
    updateButtons();
  }

  async function toggleEnabled(rule, enabled) {
    const list = rules();
    const target = list.find((r) => r.id === rule.id);
    if (!target) return;
    target.enabled = enabled;
    await saveRules(list);
    tick({ recordHistory: true });
    renderList();
  }

  async function patchRule(rule, patch) {
    const list = rules();
    const target = list.find((r) => r.id === rule.id);
    if (!target) return;
    Object.assign(target, patch);
    await saveRules(list);
    tick({ recordHistory: true });
    renderList();
  }

  async function addRule() {
    const list = rules();
    list.push(newRule());
    await saveRules(list);
    history.record('scheduled-appearance', t('appearance.sched.ruleAdded'), '');
    renderList();
  }

  async function removeRule(rule) {
    const ok = await destructiveConfirm({
      title: t('appearance.sched.deleteConfirmTitle'),
      body: t('appearance.sched.deleteConfirmBody'),
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    const list = rules().filter((r) => r.id !== rule.id);
    await saveRules(list);
    history.record('scheduled-appearance', t('appearance.sched.ruleDeleted'), ruleLabel(rule));
    renderList();
  }

  async function deleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await destructiveConfirm({
      title: t('appearance.sched.bulkDeleteConfirmTitle'),
      body: t('appearance.sched.bulkDeleteConfirmBody'),
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    const remaining = rules().filter((r) => !ids.includes(r.id));
    await saveRules(remaining);
    selectedIds.clear();
    history.record('scheduled-appearance', t('appearance.sched.rulesDeleted'), String(ids.length));
    renderList();
    toast(t('appearance.sched.deletedToast'), '', { kind: 'success' });
  }

  function weekdayChips(rule) {
    const wrap = h('div', { class: 'mr-row mr-wrap', role: 'group', 'aria-label': t('appearance.sched.weekdays') });
    const dayLabels = [
      t('appearance.sched.day.sun'), t('appearance.sched.day.mon'), t('appearance.sched.day.tue'),
      t('appearance.sched.day.wed'), t('appearance.sched.day.thu'), t('appearance.sched.day.fri'),
      t('appearance.sched.day.sat'),
    ];
    dayLabels.forEach((label, dayIdx) => {
      const active = Array.isArray(rule.days) && rule.days.map(Number).includes(dayIdx);
      wrap.append(h('button', {
        type: 'button',
        class: `m3-chip${active ? ' m3-chip--selected' : ''}`,
        'aria-pressed': String(active),
        onclick: async () => {
          const current = new Set((rule.days ?? []).map(Number));
          if (current.has(dayIdx)) current.delete(dayIdx);
          else current.add(dayIdx);
          await patchRule(rule, { days: [...current].sort() });
        },
      }, label));
    });
    return wrap;
  }

  function ruleRow(rule, index) {
    const checkbox = h('input', {
      type: 'checkbox',
      'aria-label': t('common.select'),
      onchange: (e) => {
        if (e.target.checked) selectedIds.add(rule.id);
        else selectedIds.delete(rule.id);
        updateButtons();
      },
    });

    const enabledSwitch = h('input', {
      type: 'checkbox', class: 'm3-switch-input', checked: rule.enabled ? true : null,
      'aria-label': t('appearance.sched.enable'),
      onchange: (e) => toggleEnabled(rule, e.target.checked),
    });
    const switchWrap = h('label', { class: 'm3-switch' }, enabledSwitch, h('span', { class: 'track' }, h('span', { class: 'thumb' })));

    const targetPicker = buildTargetPicker(rule);
    const valueControl = buildValueControl(rule);

    const summary = h('div', { class: 'mr-row mr-wrap', style: 'gap:12px' },
      h('strong', {}, `#${index + 1}`),
      switchWrap,
      targetPicker.el,
      valueControl.el ?? valueControl,
    );

    const timingRow = h('div', { class: 'mr-row mr-wrap', style: 'gap:10px' },
      dateInput(t('history.dateFrom'), rule.startDate, (v) => patchRule(rule, { startDate: v })),
      h('span', { class: 'mr-visually-hidden' }, ''),
      dateInput(t('history.dateTo'), rule.endDate, (v) => patchRule(rule, { endDate: v })),
      timeInput(t('appearance.sched.startTime'), rule.startTime, (v) => patchRule(rule, { startTime: v })),
      timeInput(t('appearance.sched.endTime'), rule.endTime, (v) => patchRule(rule, { endTime: v })),
    );

    const row = h('div', { class: 'm3-card m3-card--outlined', dataset: { ruleId: rule.id } },
      h('div', { class: 'mr-row' },
        h('label', { class: 'm3-checkbox' }, checkbox),
        summary,
        h('span', { style: 'margin-left:auto;display:flex;gap:4px' },
          h('button', {
            type: 'button', class: 'm3-btn m3-btn--text m3-btn--sm',
            onclick: () => removeRule(rule),
            'aria-label': `${t('common.delete')} #${index + 1}`,
          }, t('common.delete')),
        ),
      ),
      h('div', { class: 'mr-col', style: 'margin-top:8px;gap:8px' },
        timingRow,
        weekdayChips(rule),
        h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:0' },
          summarizeWindow(rule)),
      ),
    );
    return row;
  }

  function buildTargetPicker(rule) {
    return createFilterPicker({
      label: t('appearance.sched.targetLabel'),
      value: rule.target,
      options: SCHEDULE_TARGETS.map((target) => ({
        value: target,
        label: t(`appearance.sched.target.${target}`),
      })),
      onChange: (value) => patchRule(rule, { target: value }),
    });
  }

  function buildValueControl(rule) {
    if (rule.target === 'theme') {
      return pickerFor(rule, ['light', 'dark', 'system'].map((v) => ({ value: v, label: t(`appearance.theme${cap(v)}`) })));
    }
    if (rule.target === 'density') {
      return pickerFor(rule, ['comfortable', 'compact'].map((v) => ({ value: v, label: t(`appearance.density.${v}`) })));
    }
    if (rule.target === 'accent') {
      return accentValueControl(rule);
    }
    if (rule.target === 'fontFamily') {
      return fontValueControl(rule);
    }
    if (rule.target === 'rainbowSpeed') {
      return pickerFor(rule, [1, 2, 3, 4, 5].map((lvl) => ({ value: lvl, label: `${t('appearance.accent.rainbowSpeed')} ${lvl}` })));
    }
    // typeScale: bounded number input
    return scaleValueControl(rule);
  }

  function pickerFor(rule, options) {
    return createFilterPicker({
      label: t('appearance.sched.valueLabel'),
      value: coerceValue(rule.target, rule.value),
      options,
      onChange: (value) => patchRule(rule, { value }),
    });
  }

  function accentValueControl(rule) {
    const wrap = h('div', { class: 'mr-row' });
    const picker = createColorPicker({
      label: t('appearance.sched.valueLabel'),
      value: isRainbowStr(rule.value) ? rule.value : (/^#[0-9a-f]{3,8}$/i.test(String(rule.value)) ? rule.value : '#6750a4'),
      onChange: (v) => patchRule(rule, { value: v }),
    });
    wrap.append(picker.el);
    return { el: wrap };
  }

  async function fontValueControl(rule) {
    const { enumerateFonts } = await import('./fonts.js');
    const info = await enumerateFonts();
    return createFilterPicker({
      label: t('appearance.sched.valueLabel'),
      value: String(rule.value ?? ''),
      options: [{ value: '', label: t('appearance.font.defaultOption') },
        ...info.families.map((f) => ({ value: f, label: f }))],
      onChange: (value) => patchRule(rule, { value }),
    });
  }

  function scaleValueControl(rule) {
    const input = h('input', {
      type: 'number', min: String(engine.TYPE_SCALE_MIN), max: String(engine.TYPE_SCALE_MAX), step: '0.05',
      value: String(coerceValue('typeScale', rule.value)),
      'aria-label': t('appearance.typeScale.label'),
      style: 'width:90px',
      onchange: (e) => patchRule(rule, { value: Number(e.target.value) || 1 }),
    });
    return { el: h('div', { class: 'mr-row' }, input) };
  }

  function dateInput(label, value, onCommit) {
    return h('input', {
      type: 'date', value: value ?? '', 'aria-label': label,
      onchange: (e) => onCommit(e.target.value),
    });
  }

  function timeInput(label, value, onCommit) {
    return h('input', {
      type: 'time', value: value ?? '', 'aria-label': label,
      onchange: (e) => onCommit(e.target.value),
    });
  }

  function summarizeWindow(rule) {
    const days = Array.isArray(rule.days) && rule.days.length > 0
      ? `${rule.days.length} ${t('appearance.sched.daysSelected')}`
      : t('appearance.sched.everyday');
    const startT = rule.startTime || '00:00';
    const endT = rule.endTime || '23:59';
    const crossNote = rule.startTime && rule.endTime
      && parseHHMM(rule.startTime, 0) > parseHHMM(rule.endTime, 1439)
      ? ` · ${t('appearance.sched.crossMidnight')}` : '';
    const datePart = rule.startDate || rule.endDate
      ? `${rule.startDate || '…'} → ${rule.endDate || '…'} · `
      : '';
    return `${datePart}${startT} – ${endT} · ${days}${crossNote}`;
  }

  function updateButtons() {
    deleteSelectedBtn.disabled = selectedIds.size === 0;
    void 0;
  }

  container.append(
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('span', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
        `${t('appearance.sched.timezone')}: ${timezoneName() || t('appearance.sched.timezoneUnknown')}`),
    ),
    h('details', { class: 'mr-setting-info' },
      h('summary', {}, t('appearance.aboutSetting')),
      h('p', { class: 'mr-typography-body-small' }, t('appearance.sched.precedenceDetail')),
      h('p', { class: 'mr-typography-body-small' }, t('appearance.sched.externalDeferred')),
    ),
    h('div', { class: 'mr-row' }, search.el, addBtn, deleteSelectedBtn),
    listEl,
  );
  renderList();

  return { refresh: renderList };
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isRainbowStr(v) {
  return typeof v === 'string' && v.trim().toLowerCase() === 'rainbow';
}
