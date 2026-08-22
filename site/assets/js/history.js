/* Local version history journal: append-only records of site state changes,
   with date + action + text filters (regex-capable), snapshots for restore,
   bulk selection actions, and export. Restores are recorded as new entries,
   never rewrites. */

import { el, storage, fmtDateTime, downloadBlob, debounce } from './util.js';
import { t } from './i18n.js';
import { createSearchBar } from './searchbar.js';
import { destructiveConfirm } from './dialogs.js';
import { getSettings, replaceSettings } from './store.js';

const MAX_ENTRIES = 300;
const MAX_SNAPSHOTS = 40;

export function registerHistoryBundle(addBundle) {
  addBundle('history', {
    en: {
      'hj.title': 'Version history',
      'hj.lead': 'Every change to this site\'s own settings is recorded here. Restoring creates a new entry; nothing is ever rewritten.',
      'hj.empty': 'No changes recorded yet.',
      'hj.noMatch': 'No entries match the current filters.',
      'hj.action': 'Action',
      'hj.date': 'Date',
      'hj.restore': 'Restore',
      'hj.restored': 'Restored an earlier state',
      'hj.export': 'Export view',
      'hj.snapshot': 'Save snapshot',
      'hj.confirmRestore': 'replace the current site settings with the snapshot from',
      'hj.confirmClear': 'clear the entire local history journal',
      'hj.clear': 'Clear journal…',
      'hj.bulkDelete': 'Delete selected permanently',
      'hj.confirmBulk': 'permanently delete the selected journal entries',
      'hj.selectAllView': 'Select all in this view',
      'hj.inverse': 'Invert selection',
      'hj.clearSel': 'Clear selection',
      'hj.selected': 'selected',
      'hj.deleted': 'Journal entries deleted',
      'hj.preset.all': 'All time', 'hj.preset.today': 'Today', 'hj.preset.7': 'Last 7 days', 'hj.preset.30': 'Last 30 days',
    },
    zh: {
      'hj.title': '版本歷史',
      'hj.lead': '呢個網站自己設定嘅每一次改動都會記喺度。還原係新增一條紀錄，永遠唔會改寫舊嘅。',
      'hj.empty': '仲未有任何紀錄。',
      'hj.noMatch': '無紀錄符合而家嘅篩選。',
      'hj.action': '動作',
      'hj.date': '日期',
      'hj.restore': '還原',
      'hj.restored': '還原咗較早嘅狀態',
      'hj.export': '匯出目前視圖',
      'hj.snapshot': '影快照',
      'hj.confirmRestore': '用呢個快照取代而家嘅網站設定：',
      'hj.confirmClear': '清空成個本地歷史日誌',
      'hj.clear': '清空日誌……',
      'hj.bulkDelete': '永久刪除揀咗嘅',
      'hj.confirmBulk': '永久刪除揀咗嘅日誌紀錄',
      'hj.selectAllView': '全選呢個視圖',
      'hj.inverse': '反轉揀選',
      'hj.clearSel': '清除揀選',
      'hj.selected': '項已揀',
      'hj.deleted': '已刪除日誌紀錄',
      'hj.preset.all': '全部時間', 'hj.preset.today': '今日', 'hj.preset.7': '最近 7 日', 'hj.preset.30': '最近 30 日',
    },
  });
}

const ACTIONS = ['settings-changed', 'schedule-changed', 'lock-created', 'lock-removed', 'unlocked', 'restored', 'exported', 'snapshot'];

export function recordHistory({ action, label = '', snapshot = false } = {}) {
  if (!action) return;
  const entries = storage.get('history', []);
  const entry = {
    id: `hj-${Date.now().toString(36)}-${entries.length}`,
    at: new Date().toISOString(),
    action,
    label: String(label).slice(0, 200),
    hasSnapshot: false,
  };
  if (snapshot) {
    entry.snapshot = getSettings();
    entry.hasSnapshot = true;
  }
  entries.unshift(entry);
  while (entries.length > MAX_ENTRIES) entries.pop();
  storage.set('history', entries);
  document.dispatchEvent(new CustomEvent('site-history-changed'));
}

/* Listen for lock/schedule modules that record through DOM events. */
export function initHistoryBridge() {
  document.addEventListener('site-history-record', (e) => {
    if (e.detail && e.detail.action) recordHistory(e.detail);
  });
}

/* Snapshot helper: gives restore a target state. */
export function takeSnapshot(label) {
  recordHistory({ action: 'snapshot', label: label || t('hj.snapshot'), snapshot: true });
  const entries = storage.get('history', []);
  let withSnap = entries.filter((e) => e.hasSnapshot).length;
  if (withSnap > MAX_SNAPSHOTS) {
    for (let i = entries.length - 1; i >= 0 && withSnap > MAX_SNAPSHOTS; i -= 1) {
      if (entries[i].hasSnapshot) { delete entries[i].snapshot; entries[i].hasSnapshot = false; withSnap -= 1; }
    }
    storage.set('history', entries);
  }
}

export function buildHistoryPanel(mount) {
  mount.textContent = '';
  mount.append(
    el('h3', { class: 'modal-title', text: t('hj.title') }),
    el('p', { class: 'setting-desc', text: t('hj.lead') }),
  );

  const toolbar = el('div', { class: 'centre-toolbar history-toolbar' });
  const searchMount = el('div', {});
  const dateIn = el('input', { type: 'date', class: 'mr-input', 'aria-label': t('hj.date') });
  const presetSel = el('select', { class: 'mr-select', 'aria-label': t('hj.date') },
    [
      ['all', t('hj.preset.all')], ['today', t('hj.preset.today')], ['7', t('hj.preset.7')], ['30', t('hj.preset.30')],
    ].map(([v, l]) => el('option', { value: v, text: l })));
  const actionSel = el('select', { class: 'mr-select', 'aria-label': t('hj.action') },
    [['', `${t('hj.action')}: —`], ...ACTIONS.map((a) => [a, a])]
      .map(([v, l]) => el('option', { value: v, text: l })));
  toolbar.append(searchMount, dateIn, presetSel, actionSel);
  mount.append(toolbar);

  const listWrap = el('div', { class: 'centre-list' });
  mount.append(listWrap);

  const bulkBar = el('div', { class: 'centre-bulk' });
  const countLabel = el('span', { class: 'centre-count' });
  const bAll = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('hj.selectAllView') });
  const bInv = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('hj.inverse') });
  const bClr = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('hj.clearSel') });
  const bDel = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('hj.bulkDelete'), disabled: '' });
  bulkBar.append(countLabel, bAll, bInv, bClr, bDel);
  mount.append(bulkBar);

  const sel = new Set();

  const state = { mode: 'plain', pattern: '', flags: 'i' };
  createSearchBar(searchMount, {
    ariaLabel: t('hj.title'),
    onQuery(next) { Object.assign(state, next); render(); },
  });

  function visibleRows() {
    const entries = storage.get('history', []);
    const q = state.pattern.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!withinRange(entry)) return false;
      if (actionSel.value && entry.action !== actionSel.value) return false;
      if (!q) return true;
      const hay = `${entry.action} ${entry.label} ${fmtDateTime(entry.at)}`.toLowerCase();
      if (state.mode === 'regex') {
        try { return new RegExp(state.pattern, state.flags.replace('g', '') || undefined).test(hay); }
        catch { return true; }
      }
      return hay.includes(q);
    });
  }

  function withinRange(entry) {
    if (dateIn.value) return entry.at.slice(0, 10) === dateIn.value;
    if (presetSel.value === 'all') return true;
    const cutoff = presetSel.value === 'today'
      ? new Date(new Date().toDateString()).getTime()
      : Date.now() - Number(presetSel.value) * 86400000;
    return new Date(entry.at).getTime() >= cutoff;
  }

  function syncBulk() {
    countLabel.textContent = `${sel.size} ${t('hj.selected')}`;
    bDel.disabled = sel.size === 0;
  }

  function render() {
    listWrap.textContent = '';
    const entries = storage.get('history', []);
    if (!entries.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('hj.empty') }));
      syncBulk();
      return;
    }
    const rows = visibleRows();
    if (!rows.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('hj.noMatch') }));
    }
    for (const entry of rows) {
      const rowEl = el('div', { class: 'centre-row' });
      const cb = el('input', { type: 'checkbox', 'aria-label': `${entry.action} · ${fmtDateTime(entry.at)}` });
      cb.checked = sel.has(entry.id);
      cb.addEventListener('change', () => {
        if (cb.checked) sel.add(entry.id); else sel.delete(entry.id);
        rowEl.classList.toggle('is-selected', cb.checked);
        syncBulk();
      });
      rowEl.append(cb);

      const main = el('div', { class: 'centre-row-main' }, [
        el('div', { class: 'centre-row-title', text: entry.label || entry.action }),
        el('div', { class: 'centre-row-body' }, [
          el('code', { text: entry.action }),
          document.createTextNode(` · ${fmtDateTime(entry.at)}`),
        ]),
      ]);
      rowEl.append(main);

      if (entry.hasSnapshot && entry.snapshot) {
        const restoreBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('hj.restore') });
        restoreBtn.addEventListener('click', async () => {
          const ok = await destructiveConfirm({
            detail: `${t('hj.confirmRestore')} ${fmtDateTime(entry.at)}`,
          });
          if (!ok) return;
          replaceSettings(entry.snapshot);
          recordHistory({ action: 'restored', label: `${t('hj.restored')} · ${fmtDateTime(entry.at)}` });
          render();
        });
        rowEl.append(restoreBtn);
      }
      listWrap.append(rowEl);
    }
    syncBulk();
  }

  const snapBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('hj.snapshot') });
  snapBtn.addEventListener('click', () => { takeSnapshot(t('hj.snapshot')); render(); });

  const exportBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('hj.export') });
  exportBtn.addEventListener('click', () => {
    const md = [
      `# ${t('hj.title')}`,
      '',
      ...visibleRows().map((e2) => `- \`${e2.at}\` **${e2.action}** ${e2.label || ''}${e2.hasSnapshot ? ' · snapshot' : ''}`),
    ].join('\n');
    downloadBlob('site-history.md', md, 'text/markdown;charset=utf-8');
    recordHistory({ action: 'exported', label: t('hj.export') });
  });

  const clearBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('hj.clear') });
  clearBtn.addEventListener('click', async () => {
    const ok = await destructiveConfirm({
      detail: t('hj.confirmClear'),
      affectedItems: `${storage.get('history', []).length} ×`,
    });
    if (!ok) return;
    storage.set('history', []);
    sel.clear();
    render();
  });

  bAll.addEventListener('click', () => { for (const r of visibleRows()) sel.add(r.id); render(); });
  bInv.addEventListener('click', () => {
    for (const r of visibleRows()) { if (sel.has(r.id)) sel.delete(r.id); else sel.add(r.id); }
    render();
  });
  bClr.addEventListener('click', () => { sel.clear(); render(); });
  bDel.addEventListener('click', async () => {
    const ok = await destructiveConfirm({ detail: t('hj.confirmBulk'), affectedItems: `${sel.size} ×` });
    if (!ok) return;
    const doomed = new Set(sel);
    const kept = storage.get('history', []).filter((e2) => !doomed.has(e2.id));
    storage.set('history', kept);
    sel.clear();
    recordHistory({ action: 'settings-changed', label: t('hj.deleted') });
    render();
  });

  dateIn.addEventListener('change', render);
  presetSel.addEventListener('change', () => { dateIn.value = ''; render(); });
  actionSel.addEventListener('change', render);

  mount.append(el('div', { class: 'builder-actions' }, [snapBtn, exportBtn, clearBtn]));
  render();
  document.addEventListener('site-history-changed', debounce(render, 200));
}
