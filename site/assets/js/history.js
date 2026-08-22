/* Local version history journal: append-only records of site state changes,
   with date + action + text filters (regex-capable), snapshots for restore,
   and export. Restores are recorded as new entries, never rewrites. */

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
      'hj.presets': 'Today', 'hj.7d': 'Last 7 days', 'hj.30d': 'Last 30 days', 'hj.all': 'All time',
      'hj.snapshot': 'Snapshot taken',
      'hj.confirmRestore': 'replace the current site settings with the snapshot from',
      'hj.confirmClear': 'clear the entire local history journal',
      'hj.clear': 'Clear journal…',
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
      'hj.presets': '今日', 'hj.7d': '最近 7 日', 'hj.30d': '最近 30 日', 'hj.all': '全部',
      'hj.snapshot': '已影快照',
      'hj.confirmRestore': '用呢個快照取代而家嘅網站設定：',
      'hj.confirmClear': '清空成個本地歷史日誌',
      'hj.clear': '清空日誌……',
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
  while (entries.length > MAX_ENTRIES) {
    const dropped = entries.pop();
    if (dropped.hasSnapshot) { /* snapshot goes with its entry */ }
  }
  storage.set('history', entries);
  document.dispatchEvent(new CustomEvent('site-history-changed'));
}

/* Listen for lock/schedule modules that record through DOM events. */
export function initHistoryBridge() {
  document.addEventListener('site-history-record', (e) => {
    if (e.detail && e.detail.action) recordHistory(e.detail);
  });
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
      ['all', t('hj.all')], ['today', t('hj.presets')], ['7', t('hj.7d')], ['30', t('hj.30d')],
    ].map(([v, l]) => el('option', { value: v, text: l })));
  const actionSel = el('select', { class: 'mr-select', 'aria-label': t('hj.action') },
    [['', `${t('hj.action')}: ${t('toast.filterAll')}`], ...ACTIONS.map((a) => [a, a])]
      .map(([v, l]) => el('option', { value: v, text: l })));
  toolbar.append(searchMount, dateIn, presetSel, actionSel);
  mount.append(toolbar);

  const listWrap = el('div', { class: 'centre-list' });
  mount.append(listWrap);

  const state = { mode: 'plain', pattern: '', flags: 'i' };
  createSearchBar(searchMount, {
    ariaLabel: t('hj.title'),
    onQuery(next) { Object.assign(state, next); render(); },
  });

  function withinRange(entry) {
    if (dateIn.value) {
      const day = entry.at.slice(0, 10);
      if (day !== dateIn.value) return false;
      return true;
    }
    if (presetSel.value === 'all') return true;
    const cutoff = presetSel.value === 'today'
      ? new Date(new Date().toDateString()).getTime()
      : Date.now() - Number(presetSel.value) * 86400000;
    return new Date(entry.at).getTime() >= cutoff;
  }

  function render() {
    listWrap.textContent = '';
    const entries = storage.get('history', []);
    if (!entries.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('hj.empty') }));
      return;
    }
    const q = state.pattern.trim().toLowerCase();
    const rows = entries.filter((entry) => {
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
    if (!rows.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('hj.noMatch') }));
    }
    for (const entry of rows) {
      const rowEl = el('div', { class: 'centre-row' });
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
  }

  const exportBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('hj.export') });
  exportBtn.addEventListener('click', () => {
    const entries = storage.get('history', []);
    const md = [
      `# ${t('hj.title')}`,
      '',
      ...entries.map((e) => `- \`${e.at}\` **${e.action}** ${e.label || ''}${e.hasSnapshot ? ` · ${t('hj.snapshot')}` : ''}`),
    ].join('\n');
    downloadBlob('site-history.md', md, 'text/markdown;charset=utf-8');
    recordHistory({ action: 'exported', label: t('hj.export') });
  });

  const clearBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('hj.clear') });
  clearBtn.addEventListener('click', async () => {
    const ok = await destructiveConfirm({ detail: t('hj.confirmClear'), affectedItems: `${storage.get('history', []).length} ×` });
    if (!ok) return;
    storage.set('history', []);
    render();
  });

  dateIn.addEventListener('change', render);
  presetSel.addEventListener('change', () => { dateIn.value = ''; render(); });
  actionSel.addEventListener('change', render);

  mount.append(el('div', { class: 'builder-actions' }, [exportBtn, clearBtn]));
  render();
  document.addEventListener('site-history-changed', debounce(render, 200));
}

/* Snapshot helper: call before risky mutations so restore has a target. */
export function takeSnapshot(label) {
  recordHistory({ action: 'snapshot', label: label || t('hj.snapshot'), snapshot: true });
  const entries = storage.get('history', []);
  const withSnap = entries.filter((e) => e.hasSnapshot).length;
  if (withSnap > MAX_SNAPSHOTS) {
    // drop the oldest snapshot-bearing entry's snapshot payload
    for (let i = entries.length - 1; i >= 0 && withSnap > MAX_SNAPSHOTS; i -= 1) {
      if (entries[i].hasSnapshot) { delete entries[i].snapshot; entries[i].hasSnapshot = false; }
    }
    storage.set('history', entries);
  }
}
