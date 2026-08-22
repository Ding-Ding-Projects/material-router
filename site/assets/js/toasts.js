/* Non-blocking notifications: bottom-right toasts that never steal focus,
   plus a reviewable notification centre with search (regex-capable via its
   own builder), bulk actions, and export honoring the active filters. */

import { el, uid, downloadBlob, fmtDateTime } from './util.js';
import { createSearchBar } from './searchbar.js';
import { destructiveConfirm } from './dialogs.js';
import { t, copy } from './i18n.js';

const MAX_HISTORY = 200;
const history = [];
let centreOpen = false;
let centreNode = null;
let bellBtn = null;

export function registerToastBundle(addBundle) {
  addBundle('toasts', {
    en: {
      'toast.center': 'Notification centre',
      'toast.bell': 'Notifications',
      'toast.dismiss': 'Dismiss',
      'toast.close': 'Close notification centre',
      'toast.empty': 'No notifications yet. When something happens, it lands here without interrupting you.',
      'toast.noMatch': 'Nothing matches the current search or filters.',
      'toast.bulkDismiss': 'Dismiss selected',
      'toast.bulkDelete': 'Delete selected permanently',
      'toast.export': 'Export view',
      'toast.selectAllView': 'Select all in this view',
      'toast.inverse': 'Invert selection',
      'toast.clearSel': 'Clear selection',
      'toast.selected': 'selected',
      'toast.deleted': 'Deleted notifications permanently',
      'toast.errPersist': 'Error — stays until you dismiss it',
      'toast.filterAll': 'All',
      'toast.filterErr': 'Errors & warnings',
      'toast.confirmDelete': 'delete the selected notifications from this browser',
    },
    zh: {
      'toast.center': '通知中心',
      'toast.bell': '通知',
      'toast.dismiss': '閂咗佢',
      'toast.close': '閂埋通知中心',
      'toast.empty': '仲未有通知。有嘢發生嗰陣，會靜靜雞出現喺呢度，唔會打斷你。',
      'toast.noMatch': '無嘢符合而家嘅搜尋或者篩選。',
      'toast.bulkDismiss': '閂咗揀咗嘅',
      'toast.bulkDelete': '永久刪除揀咗嘅',
      'toast.export': '匯出目前視圖',
      'toast.selectAllView': '全選呢個視圖',
      'toast.inverse': '反轉揀選',
      'toast.clearSel': '清除揀選',
      'toast.selected': '項已揀',
      'toast.deleted': '已經永久刪除咗通知',
      'toast.errPersist': '錯誤 —— 唔會自己走，要你手動閂',
      'toast.filterAll': '全部',
      'toast.filterErr': '錯誤同警告',
      'toast.confirmDelete': '喺呢個瀏覽器入面永久刪除揀咗嘅通知',
    },
  });
}

/* notify({title, body, kind:'info'|'success'|'error'|'warn', emoji}) */
export function notify({ title = '', body = '', kind = 'info', emoji = '' } = {}) {
  const entry = {
    id: uid('ntf'),
    at: new Date().toISOString(),
    kind,
    title,
    body,
  };
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.pop();
  showToast(entry);
  updateBell();
  return entry.id;
}

function showToast(entry) {
  const host = ensureHost();
  const tone = entry.kind === 'error' ? '--md-sys-color-error-container'
    : entry.kind === 'success' ? '--md-sys-color-primary-container'
      : entry.kind === 'warn' ? '--md-sys-color-tertiary-container'
        : '--md-sys-color-surface-container-high';
  const card = el('div', {
    class: `toast toast--${entry.kind}`,
    role: entry.kind === 'error' || entry.kind === 'warn' ? 'alert' : 'status',
    style: `background: var(${tone});`,
  });
  const icon = entry.kind === 'error' ? '⛔' : entry.kind === 'success' ? '✅' : entry.kind === 'warn' ? '⚠️' : '💬';
  if (emojiOnSite()) card.append(el('span', { class: 'toast-icon', text: icon, 'aria-hidden': 'true' }));
  const textWrap = el('div', { class: 'toast-text' });
  if (entry.title) textWrap.append(el('div', { class: 'toast-title', text: entry.title }));
  if (entry.body) textWrap.append(el('div', { class: 'toast-body', text: entry.body }));
  const closeBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text toast-x', 'aria-label': t('toast.dismiss'), text: '✕' });
  closeBtn.addEventListener('click', () => card.remove());
  card.append(textWrap, closeBtn);
  host.append(card);

  const persist = entry.kind === 'error' || entry.kind === 'warn';
  if (!persist) setTimeout(() => { card.remove(); }, 6000);
}

function emojiOnSite() {
  try {
    const s = JSON.parse(localStorage.getItem('mr-site:settings') || '{}');
    return s.emojiOn !== false && s.schoolMode !== true;
  } catch { return true; }
}

function ensureHost() {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

export function initNotificationCenter() {
  bellBtn = el('button', {
    type: 'button',
    class: 'mr-btn mr-btn--tonal bell-btn',
    id: 'notif-bell',
    'aria-label': t('toast.bell'),
    'aria-expanded': 'false',
  });
  bellBtn.dataset.count = '0';
  bellBtn.textContent = '🔔 0';
  bellBtn.addEventListener('click', toggleCentre);
  const mount = document.getElementById('header-actions');
  if (mount) mount.append(bellBtn);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      toggleCentre();
    }
  });
}

function updateBell() {
  if (!bellBtn) return;
  const unseen = history.length;
  bellBtn.textContent = `${emojiOnSite() ? '🔔 ' : ''}${unseen}`;
  bellBtn.setAttribute('aria-label', `${t('toast.bell')} (${unseen})`);
}

function toggleCentre() {
  if (centreOpen) { closeCentre(); return; }
  openCentre();
}

function openCentre() {
  centreOpen = true;
  if (bellBtn) bellBtn.setAttribute('aria-expanded', 'true');
  const sel = new Set();

  centreNode = el('div', { class: 'modal-scrim centre-scrim' });
  const panel = el('div', { class: 'centre-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'centre-title' });
  panel.append(el('h2', { id: 'centre-title', class: 'modal-title', text: t('toast.center') }));

  const toolbar = el('div', { class: 'centre-toolbar' });
  const filterKind = el('select', { class: 'mr-select', 'aria-label': t('toast.filterAll') },
    [
      ['all', t('toast.filterAll')],
      ['bad', t('toast.filterErr')],
    ].map(([v, label]) => el('option', { value: v, text: label })));
  const sbMount = el('div', {});
  toolbar.append(sbMount, filterKind);
  panel.append(toolbar);

  const listWrap = el('div', { class: 'centre-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': t('toast.center') });
  panel.append(listWrap);

  const bulkBar = el('div', { class: 'centre-bulk' });
  const countLabel = el('span', { class: 'centre-count', text: `0 ${t('toast.selected')}` });
  const bSelAll = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('toast.selectAllView') });
  const bInv = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('toast.inverse') });
  const bClear = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('toast.clearSel') });
  const bDismiss = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('toast.bulkDismiss'), disabled: '' });
  const bDelete = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('toast.bulkDelete'), disabled: '' });
  const bExport = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('toast.export') });
  bulkBar.append(countLabel, bSelAll, bInv, bClear, bDismiss, bDelete, bExport);
  panel.append(bulkBar);

  const actionsRow = el('div', { class: 'modal-actions' });
  const closeBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--filled', text: t('toast.close') });
  closeBtn.addEventListener('click', closeCentre);
  actionsRow.append(closeBtn);
  panel.append(actionsRow);
  centreNode.append(panel);
  document.body.append(centreNode);
  centreNode.addEventListener('pointerdown', (e) => { if (e.target === centreNode) closeCentre(); });

  const state = { mode: 'plain', pattern: '', flags: 'i' };
  createSearchBar(sbMount, {
    ariaLabel: t('sb.search'),
    onQuery(next) { Object.assign(state, next); render(); },
  });

  function visible() {
    const q = state.pattern.trim().toLowerCase();
    return history.filter((n) => {
      if (filterKind.value === 'bad' && !(n.kind === 'error' || n.kind === 'warn')) return false;
      if (!q) return true;
      const hay = `${n.title}\n${n.body}`.toLowerCase();
      if (state.mode === 'regex') {
        try {
          const re = new RegExp(state.pattern, state.flags.replace('g', '') || undefined);
          return re.test(hay);
        } catch { return true; }
      }
      return hay.includes(q);
    });
  }

  function render() {
    listWrap.textContent = '';
    const rows = visible();
    if (!history.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('toast.empty') }));
    } else if (!rows.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('toast.noMatch') }));
    }
    for (const n of rows) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = sel.has(n.id);
      cb.setAttribute('aria-label', n.title || n.kind);
      cb.addEventListener('change', () => {
        if (cb.checked) sel.add(n.id); else sel.delete(n.id);
        syncBulk();
        // preserve focus while re-rendering selection state
        row.classList.toggle('is-selected', cb.checked);
      });
      const row = el('div', { class: `centre-row kind-${n.kind}`, role: 'option', 'aria-selected': cb.checked ? 'true' : 'false' }, [
        cb,
        el('div', { class: 'centre-row-main' }, [
          el('div', { class: 'centre-row-title', text: n.title || n.kind }),
          n.body ? el('div', { class: 'centre-row-body', text: n.body }) : null,
          el('time', { class: 'centre-row-time', datetime: n.at, text: fmtDateTime(n.at) }),
        ]),
      ]);
      listWrap.append(row);
    }
    syncBulk();
  }

  function syncBulk() {
    countLabel.textContent = `${sel.size} ${t('toast.selected')}`;
    const any = sel.size > 0;
    bDismiss.disabled = !any;
    bDelete.disabled = !any;
  }

  bSelAll.addEventListener('click', () => { for (const n of visible()) sel.add(n.id); render(); });
  bInv.addEventListener('click', () => {
    const ids = new Set(visible().map((n) => n.id));
    for (const id of ids) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
    render();
  });
  bClear.addEventListener('click', () => { sel.clear(); render(); });
  bDismiss.addEventListener('click', () => {
    for (const n of history) {
      if (sel.has(n.id)) n.dismissed = true;
    }
    sel.clear();
    render();
  });
  bDelete.addEventListener('click', async () => {
    const ok = await destructiveConfirm({
      detail: t('toast.confirmDelete'),
      affectedItems: `${sel.size} ×`,
    });
    if (!ok) return;
    const doomed = new Set(sel);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (doomed.has(history[i].id)) history.splice(i, 1);
    }
    sel.clear();
    updateBell();
    render();
    notify({ title: t('toast.deleted'), kind: 'success' });
  });
  bExport.addEventListener('click', () => {
    const rows = visible();
    const md = [
      `# ${t('toast.center')}`,
      '',
      ...rows.map((n) => `- **[${n.kind}] ${n.title}** — ${n.body} (${n.at})`),
    ].join('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(`notifications-${stamp}.md`, md, 'text/markdown;charset=utf-8');
  });

  filterKind.addEventListener('change', render);
  render();
  closeBtn.focus();
}

function closeCentre() {
  centreOpen = false;
  if (bellBtn) bellBtn.setAttribute('aria-expanded', 'false');
  if (centreNode) { centreNode.remove(); centreNode = null; }
}
