// Purpose: non-blocking toasts (bottom-right stack), a notification center
// with search / bulk actions / export / confirm-gated clear-all, and an
// aria-live announcement region. Errors persist until dismissed.
// Owned by Foundation Core lane.

import { h, svgIcon, ICONS, writeClipboard, saveText, fmtTimestamp } from './util.js';
import { copy, emojiToggleOn } from './i18n.js';
import { createSearchBar, matchesQuery } from './searchbar.js';
import { destructiveConfirm } from './dialogs.js';

const MAX_VISIBLE = 4;
const HISTORY_MAX = 200;

// Decorative emoji for toast titles, only while the persisted
// "Show emojis in dialogs and messages" toggle is on. Never applied to
// buttons or field labels (Delight lane contract).
const TOAST_EMOJI = { info: 'ℹ️', success: '✅', error: '⚠️' };

function titleEl(text, kind) {
  if (!emojiToggleOn()) return h('div', {}, text);
  return h('div', {},
    h('span', { 'aria-hidden': 'true', style: 'margin-right:6px' }, TOAST_EMOJI[kind] ?? '💬'),
    text);
}

const state = {
  host: null,
  liveRegion: null,
  /** @type {Array<object>} */
  history: [],
  unread: 0,
  onUnreadChange: null,
};

export function init({ onUnreadChange = null } = {}) {
  state.host = h('div', { class: 'm3-snackbar-host', id: 'mr-toasts' });
  document.body.append(state.host);
  state.liveRegion = h('div', { class: 'mr-visually-hidden', 'aria-live': 'polite', role: 'status' });
  document.body.append(state.liveRegion);

  // Restore persisted history (values only; timestamps survive restarts).
  try {
    const raw = localStorage.getItem('mr.notifications.history');
    if (raw) state.history = JSON.parse(raw).slice(-HISTORY_MAX) ?? [];
  } catch { /* fresh start */ }

  state.onUnreadChange = onUnreadChange;
}

function persistHistory() {
  try {
    localStorage.setItem('mr.notifications.history', JSON.stringify(state.history.slice(-HISTORY_MAX)));
  } catch { /* storage full - history is best-effort */ }
}

/**
 * Show a toast. kind: 'info' | 'success' | 'error'. Errors persist until the
 * user dismisses them; everything else auto-dismisses after `timeout` ms and
 * spills into the notification center when more than MAX_VISIBLE are showing.
 */
export function toast(title, body = '', { kind = 'info', timeout = null, actions = [] } = {}) {
  const entry = { ts: new Date().toISOString(), title: String(title), body: String(body), kind };
  state.history.push(entry);
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.unread += 1;
  state.onUnreadChange?.(state.unread);
  persistHistory();
  announce(`${title}. ${body}`);

  const el = buildToastEl(entry, actions, () => remove(el));
  const visible = state.host.querySelectorAll('.m3-snackbar').length;
  if (kind !== 'error' && visible >= MAX_VISIBLE) return el; // overflowed into center only

  state.host.append(el);
  if (timeout === null && kind !== 'error') timeout = 5000;
  if (timeout !== null && kind !== 'error') {
    setTimeout(() => remove(el), timeout);
  }
  return el;
}

function buildToastEl(entry, actions, onDismiss) {
  const el = h('div', {
    class: `m3-snackbar m3-snackbar--${entry.kind}`,
    role: entry.kind === 'error' ? 'alert' : 'status',
  },
    h('div', {},
      titleEl(entry.title, entry.kind),
      entry.body ? h('div', { class: 'mr-notif-item__body' }, entry.body) : null,
    ),
    h('div', { class: 'm3-snackbar__actions' },
      ...actions.map((a) => h('button', {
        class: 'm3-snackbar__action',
        onclick: () => { onDismiss(); a.run?.(); },
      }, a.label)),
      h('button', {
        class: 'm3-snackbar__action',
        'aria-label': copy('common.close'),
        onclick: onDismiss,
      }, svgIcon(ICONS.close)),
    ),
  );
  return el;
}

function remove(el) {
  el?.remove();
}

/** Announce through the polite live region for screen readers. */
export function announce(text) {
  if (!state.liveRegion || !text) return;
  state.liveRegion.textContent = '';
  requestAnimationFrame(() => {
    state.liveRegion.textContent = String(text);
  });
}

/** Mark everything read (called when the notification drawer opens). */
export function markAllRead() {
  state.unread = 0;
  state.onUnreadChange?.(0);
}

// ---------------------------------------------------------------------------
// Notification Center panel (rendered into a container by the drawer)
// ---------------------------------------------------------------------------

export function renderNotificationCenter(container) {
  let selected = new Set();

  const search = createSearchBar({
    placeholder: copy('notif.searchPlaceholder'),
    label: copy('notif.searchPlaceholder'),
    onQuery: () => renderList(),
  });

  const listEl = h('div', {});
  const countLabel = h('span', { class: 'mr-typography-label-medium', style: 'margin-left:auto;color:var(--md-sys-color-on-surface-variant)' });
  const selectAllBtn = h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: toggleSelectAll }, copy('common.selectAll'));
  const dismissSelBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    disabled: true,
    onclick: async () => {
      for (const idx of [...selected].sort((a, b) => b - a)) state.history.splice(idx, 1);
      selected.clear();
      persistHistory();
      renderList();
    },
  }, copy('notif.dismissSelected'));
  const exportJsonBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => saveText(`notifications-${Date.now()}.json`, JSON.stringify(filtered(), null, 2), 'application/json'),
  }, copy('common.exportJson'));
  const exportMdBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => saveText(
      `notifications-${Date.now()}.md`,
      filtered().map((n) => `- **${n.title}** — ${n.body} _(${fmtTimestamp(n.ts)})_`).join('\n') || '',
      'text/markdown;charset=utf-8',
    ),
  }, copy('common.exportMd'));
  const clearAllBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    style: 'color:var(--md-sys-color-error)',
    onclick: async () => {
      const ok = await destructiveConfirm({
        title: copy('notif.clearConfirmTitle'),
        body: copy('notif.clearConfirmBody'),
      });
      if (!ok) return;
      state.history.length = 0;
      selected.clear();
      persistHistory();
      renderList();
    },
  }, copy('notif.clearAll'));

  function filtered() {
    const q = search.get();
    return state.history.map((n, idx) => ({ n, idx }))
      .filter(({ n }) => matchesQuery(q, `${n.title}\n${n.body}`));
  }

  function updateButtons() {
    dismissSelBtn.disabled = selected.size === 0;
    countLabel.textContent = `${filtered().length} · ${selected.size} ${copy('common.selected')}`;
  }

  function toggleSelectAll() {
    const rows = filtered();
    const allSelected = rows.every(({ idx }) => selected.has(idx));
    selected.clear();
    if (!allSelected) rows.forEach(({ idx }) => selected.add(idx));
    renderList();
  }

  function renderList() {
    listEl.textContent = '';
    const rows = filtered();
    if (rows.length === 0) {
      listEl.append(h('p', { class: 'mr-palette__empty' }, copy('notif.empty')));
    }
    for (const { n, idx } of rows) {
      listEl.append(h('div', { class: 'mr-notif-item' },
        h('label', { class: 'm3-checkbox' },
          h('input', {
            type: 'checkbox',
            'aria-label': copy('common.select'),
            checked: selected.has(idx) ? true : null,
            onchange: (e) => {
              e.target.checked ? selected.add(idx) : selected.delete(idx);
              updateButtons();
            },
          }),
        ),
        h('div', { class: 'mr-notif-item__text' },
          h('div', { class: 'mr-notif-item__title' }, n.title),
          n.body ? h('div', { class: 'mr-notif-item__body' }, n.body) : null,
          h('time', { datetime: n.ts, class: 'mr-typography-label-small' }, fmtTimestamp(n.ts)),
        ),
      ));
    }
    updateButtons();
  }

  container.append(
    search.el,
    h('div', { class: 'mr-row' }, countLabel),
    listEl,
  );
  renderList();

  return {
    footer: [selectAllBtn, dismissSelBtn, exportJsonBtn, exportMdBtn, clearAllBtn],
    refresh: renderList,
  };
}

export function unreadCount() {
  return state.unread;
}
