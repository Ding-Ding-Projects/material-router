// Purpose: the local append-only history journal (ring of 500) and its
// filterable panel: date range, action-type chips derived from recorded
// actions, text search, export. Restore hooks are stubs later lanes extend.
// Owned by Foundation Core lane.

import { h, saveText, fmtDate } from './util.js';
import { copy } from './i18n.js';
import { createSearchBar, matchesQuery } from './searchbar.js';
import { toast } from './toasts.js';

const JOURNAL_MAX = 500;
const STORAGE_KEY = 'mr.history.journal';

const state = {
  /** @type {Array<{ts:string,action:string,target:string,detail:string}>} */
  journal: [],
  restoreHooks: new Map(), // action -> fn(entry)
};

try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) state.journal = JSON.parse(raw).slice(-JOURNAL_MAX) ?? [];
} catch { /* fresh start */ }

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.journal.slice(-JOURNAL_MAX)));
  } catch { /* storage full - journal is best-effort */ }
}

/** Record one append-only entry. Unchanged states should not be recorded. */
export function record(action, targetLabel, detail = '') {
  state.journal.push({
    ts: new Date().toISOString(),
    action: String(action),
    target: String(targetLabel),
    detail: String(detail),
  });
  if (state.journal.length > JOURNAL_MAX) state.journal.shift();
  persist();
}

export function list() {
  return [...state.journal];
}

/** Register a restore implementation for an action type (later lanes). */
export function onRestore(action, fn) {
  state.restoreHooks.set(action, fn);
}

function hasRestore(action) {
  return state.restoreHooks.has(action);
}

/**
 * Render the HistoryPanel into `container`. Returns {footer} actions for the
 * hosting drawer.
 */
export function renderHistoryPanel(container) {
  let dateFrom = '';
  let dateTo = '';
  /** @type {Set<string>} */
  let activeActions = new Set();
  /** @type {Set<number>} */
  let selected = new Set();

  const search = createSearchBar({
    placeholder: copy('history.searchPlaceholder'),
    label: copy('history.searchPlaceholder'),
    onQuery: () => renderList(),
  });

  const dateFromInput = h('input', { type: 'date', 'aria-label': copy('history.dateFrom'), onchange: (e) => { dateFrom = e.target.value; renderList(); } });
  const dateToInput = h('input', { type: 'date', 'aria-label': copy('history.dateTo'), onchange: (e) => { dateTo = e.target.value; renderList(); } });

  const chipsEl = h('div', { class: 'mr-row', style: 'flex-wrap:wrap' });
  renderActionChips();

  const listEl = h('div', {});
  const countLabel = h('span', { class: 'mr-typography-label-medium', style: 'margin-left:auto;color:var(--md-sys-color-on-surface-variant)' });

  function allActionTypes() {
    return [...new Set(state.journal.map((e) => e.action))].sort();
  }

  function renderActionChips() {
    chipsEl.textContent = '';
    for (const action of allActionTypes()) {
      const count = state.journal.filter((e) => e.action === action).length;
      const chip = h('button', {
        class: `m3-chip${activeActions.has(action) ? ' m3-chip--selected' : ''}`,
        'aria-pressed': String(activeActions.has(action)),
        onclick: () => {
          if (activeActions.has(action)) activeActions.delete(action);
          else activeActions.add(action);
          renderActionChips();
          renderList();
        },
      }, `${action} (${count})`);
      chipsEl.append(chip);
    }
  }

  function inDateRange(entry) {
    const day = entry.ts.slice(0, 10);
    if (dateFrom && day < dateFrom) return false;
    if (dateTo && day > dateTo) return false;
    return true;
  }

  function filtered() {
    const q = search.get();
    return state.journal.map((e, idx) => ({ e, idx })).filter(({ e }) =>
      inDateRange(e)
      && (activeActions.size === 0 || activeActions.has(e.action))
      && matchesQuery(q, `${e.target}\n${e.detail}\n${e.action}`));
  }

  function updateButtons() {
    countLabel.textContent = `${filtered().length} · ${selected.size} ${copy('common.selected')}`;
    restoreBtn.disabled = selected.size !== 1 || !hasRestore(state.journal[[...selected][0]]?.action);
  }

  function renderList() {
    listEl.textContent = '';
    const rows = filtered();
    if (rows.length === 0) {
      listEl.append(h('p', { class: 'mr-palette__empty' }, copy('history.empty')));
    }
    for (const { e, idx } of rows) {
      listEl.append(h('div', { class: 'mr-history-item' },
        h('label', { class: 'm3-checkbox' },
          h('input', {
            type: 'checkbox',
            'aria-label': copy('common.select'),
            checked: selected.has(idx) ? true : null,
            onchange: (ev) => {
              ev.target.checked ? selected.add(idx) : selected.delete(idx);
              updateButtons();
            },
          }),
        ),
        h('div', { class: 'mr-grow' },
          h('div', {}, h('strong', {}, e.action), ` — ${e.target}`),
          e.detail ? h('div', { class: 'mr-notif-item__body' }, e.detail) : null,
        ),
        h('time', { datetime: e.ts }, fmtDate(e.ts)),
      ));
    }
    updateButtons();
  }

  const exportBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => {
      const rows = filtered().map(({ e }) => e);
      saveText(`history-${Date.now()}.md`,
        rows.map((e) => `- **${e.action}** — ${e.target}${e.detail ? ` — ${e.detail}` : ''} _(${fmtDate(e.ts)})_`).join('\n'),
        'text/markdown;charset=utf-8');
    },
  }, copy('common.exportMd'));

  const restoreBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    disabled: true,
    onclick: () => {
      const [idx] = [...selected];
      const entry = state.journal[idx];
      if (!entry) return;
      const hook = state.restoreHooks.get(entry.action);
      Promise.resolve(hook?.(entry)).then(() => {
        toast(copy('history.restoredTitle'), entry.target);
      }).catch((err) => {
        toast(copy('common.errorTitle'), err.message, { kind: 'error' });
      });
    },
  }, copy('history.restore'));

  container.append(
    search.el,
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      dateFromInput, dateToInput, countLabel,
    ),
    chipsEl,
    listEl,
  );
  renderList();

  return { footer: [exportBtn, restoreBtn] };
}
