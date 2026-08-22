// Purpose: Authenticator tab - local TOTP/HOTP entries with QR pairing,
// grouped base32 reveal behind an explicit action, live code display with a
// text countdown and next-code peek, bulk management, redacted/full exports,
// and a password-protected append-only mutation journal surface.
//
// Seams used (per HANDOFF.md): IPC `vault:auth-*` handlers registered by
// app/main/bridges/authenticator.js, createSearchBar + anchored regex builder
// for both search fields, destructiveConfirm for destructive gates, palette
// registration for command-palette coverage, shared history.record() calls,
// tokens-only CSS, i18n en+zh bundles registered from this directory.
//
// Owned by the Authenticator lane.

import { h, writeClipboard, saveText, fmtDate } from '../../core/util.js';
import { t, copy, addBundle } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import { openModal, destructiveConfirm, showMenu } from '../../core/dialogs.js';
import { toast } from '../../core/toasts.js';
import * as historyPanel from '../../core/history.js';
import * as palette from '../../core/palette.js';
import { qrSvgElement } from '../../core/qr.js';
import { en } from './i18n.en.js';
import { zh } from './i18n.zh.js';

// Register this lane's strings (keys are stored fully prefixed, "auth.*").
addBundle('auth', { en, zh });

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

const state = {
  /** @type {Array<object>} public entry metadata from the main process */
  entries: [],
  /** @type {Set<string>} */
  selected: new Set(),
  /** searchbar query state */
  query: null,
  /** @type {Set<string>} collapsed group names */
  collapsedGroups: new Set(),
  showPeek: false,
  vaultOk: true,
  obfuscationWarned: false,
};

/** id -> {code, next, secondsRemaining, fetchedAtMs, period, type, counter} */
const codeCache = new Map();

let liveRegion = null;
let listEl = null;
let countEl = null;
let addBtnEl = null;
let timerStarted = false;
let paletteReady = false;

// ---------------------------------------------------------------------------
// Tab definition
// ---------------------------------------------------------------------------

function render(container) {
  state.entries = [];
  state.selected.clear();

  liveRegion = h('div', { class: 'mr-visually-hidden', 'aria-live': 'polite', role: 'status' });

  const subtitle = h('p', { class: 'mr-typography-body-medium mr-auth-subtitle' }, '');
  const vaultChip = h('span', { class: 'm3-chip mr-auth-vault-chip', role: 'status' }, '');

  countEl = h('span', { class: 'mr-typography-label-medium mr-auth-count' });

  const historyBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    onclick: () => openHistoryManager(),
  }, `🕘 ${copy('auth.historyOpen')}`);

  const exportBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: (e) => openExportMenu(e.currentTarget),
  }, `${copy('auth.exportMenu')} ▾`);

  addBtnEl = h('button', {
    class: 'm3-btn m3-btn--filled',
    onclick: (e) => openAddMenu(e.currentTarget),
  }, `＋ ${copy('auth.add')}`);

  const headRow = h('div', { class: 'mr-row mr-auth-head' },
    h('div', { class: 'mr-grow' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.authenticator')),
      h('div', { class: 'mr-row', style: 'flex-wrap:wrap;gap:8px' }, subtitle, vaultChip),
    ),
    historyBtn, exportBtn, addBtnEl,
  );

  const search = createSearchBar({
    placeholder: copy('auth.searchPlaceholder'),
    label: copy('auth.searchPlaceholder'),
    onQuery: (qs) => { state.query = qs; renderList(); },
  });
  // Re-adopt a live query after a language rebuild so the fresh bar shows
  // what was being searched (no-op at first mount, where state.query is null).
  if (state.query?.text) search.set(state.query.text);
  if (state.query?.mode === 'regex') search.setMode('regex');

  const bulkBar = buildBulkBar();

  listEl = h('div', { class: 'mr-auth-list', role: 'list', 'aria-label': t('tabs.authenticator') });

  container.append(
    h('div', { class: 'mr-content mr-auth' },
      headRow,
      search.el,
      bulkBar,
      listEl,
      liveRegion,
    ),
  );

  refresh().then(() => {
    startTimer();
    registerPaletteItems(addBtnEl);
  }).catch((err) => {
    listEl.append(h('p', { class: 'mr-typography-body-medium mr-auth-error' },
      `${copy('common.errorTitle')}: ${err.message}`));
  });

  ensureLanguagePass();
}

/**
 * Live retranslate: rebuild the mounted list surface from the existing render
 * function when the language mode changes or School mode forces English.
 * Entry data is re-fetched through refresh(); row selection, the live search
 * query, collapsed groups and the peek flag all survive (state carries them,
 * selection is re-applied after render clears it). Open add/reveal/edit
 * dialogs are separate modal surfaces and keep their current copy until
 * reopened - noted honestly rather than rebuilt mid-interaction.
 */
let languageUnsub = null;
function ensureLanguagePass() {
  if (languageUnsub) return;
  languageUnsub = settings.onChange((key) => {
    if (key !== 'general.languageMode' && key !== 'school.active') return;
    const panel = document.getElementById('mr-tab-panel-authenticator');
    if (!panel?.isConnected) return;
    const scroll = panel.scrollTop;
    const selected = [...state.selected];
    render(panel);
    if (selected.length) {
      state.selected = new Set(selected);
      if (listEl) renderList();
    }
    panel.scrollTop = scroll;
  });
}

registerTab({
  id: 'authenticator',
  label: { en: 'Authenticator', zh: '驗證器' },
  get icon() {
    return iconFromPath('M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8Z');
  },
  init: render,
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refresh() {
  try {
    const res = await invoke('vault:auth-list');
    state.entries = res.entries ?? [];
    state.vaultOk = Boolean(res.encryptionAvailable);
    state.obfuscationWarned = Boolean(res.obfuscationWarned);
  } finally {
    await refreshCodes();
    renderList();
  }
}

async function refreshCodes(ids = null) {
  const targets = ids ?? state.entries.map((e) => e.id);
  let changedAny = false;
  for (const id of targets) {
    try {
      const c = await invoke('vault:auth-code', { id });
      const prev = codeCache.get(id);
      codeCache.set(id, { ...c, fetchedAtMs: Date.now() });
      if (!prev || prev.code !== c.code) changedAny = true;
    } catch {
      // Entry may have been deleted mid-flight; drop its cache row.
      codeCache.delete(id);
    }
  }
  if (changedAny) announceCodesChanged();
  return changedAny;
}

function announceCodesChanged() {
  if (!liveRegion) return;
  // One announcement per refresh wave - never per second, never reading the
  // codes themselves into the live region.
  liveRegion.textContent = copy('auth.codesRotated');
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

function filteredEntries() {
  const out = [];
  for (const e of state.entries) {
    if (state.query && !matchesQuery(state.query, `${e.issuer}\n${e.account}\n${e.group}`)) continue;
    out.push(e);
  }
  return out;
}

function groupOf(e) {
  return (e.group || '').trim();
}

function renderList() {
  if (!listEl) return;
  listEl.textContent = '';

  const rows = filteredEntries();
  updateCount(rows.length);

  if (state.entries.length === 0) {
    listEl.append(
      h('div', { class: 'mr-auth-empty' },
        h('h2', { class: 'mr-typography-title-large' }, copy('auth.emptyTitle')),
        h('p', { class: 'mr-typography-body-medium' }, copy('auth.emptyBody')),
        h('button', {
          class: 'm3-btn m3-btn--filled',
          onclick: () => openAddMenu(addBtnEl),
        }, `＋ ${copy('auth.add')}`),
      ),
    );
    syncBulkBar(0);
    return;
  }

  const groups = new Map();
  for (const e of rows) {
    const g = groupOf(e);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }

  const named = [...groups.entries()].filter(([g]) => g !== '');
  const unnamed = groups.get('') ?? [];

  for (const [g, members] of named) {
    listEl.append(buildGroupHeader(g, members));
    if (!state.collapsedGroups.has(g)) {
      for (const e of members) listEl.append(buildRow(e));
    }
  }
  if (unnamed.length > 0) {
    if (named.length > 0) listEl.append(buildGroupHeader('', unnamed));
    for (const e of unnamed) listEl.append(buildRow(e));
  }

  syncBulkBar(rows.length);
}

function buildGroupHeader(name, members) {
  const collapsed = state.collapsedGroups.has(name);
  const btn = h('button', {
    class: 'mr-auth-group-header',
    'aria-expanded': String(!collapsed),
    onclick: () => {
      if (collapsed) state.collapsedGroups.delete(name);
      else state.collapsedGroups.add(name);
      renderList();
    },
  },
    h('span', { class: 'mr-auth-group-chevron', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
    h('strong', {}, name || copy('auth.noGroup')),
    h('span', { class: 'mr-typography-label-medium' }, `${members.length}`),
  );
  return h('div', { class: 'mr-auth-group', role: 'presentation' }, btn);
}

function entryName(e) {
  return `${e.issuer || '?'} · ${e.account || '?'}`;
}

function buildRow(e) {
  const cached = codeCache.get(e.id);
  const row = h('div', {
    class: `mr-auth-row${state.selected.has(e.id) ? ' mr-auth-row--selected' : ''}`,
    dataset: { id: e.id },
    draggable: 'true',
    tabindex: '0',
    role: 'listitem',
    'aria-label': `${entryName(e)} ${e.armed ? '' : copy('auth.unconfirmedBadge')}`,
  });

  const select = h('input', {
    type: 'checkbox',
    class: 'mr-auth-row__check',
    'aria-label': `${copy('common.select')} ${entryName(e)}`,
    onchange: (ev) => {
      if (ev.target.checked) state.selected.add(e.id);
      else state.selected.delete(e.id);
      row.classList.toggle('mr-auth-row--selected', state.selected.has(e.id));
      syncBulkBar(filteredEntries().length);
    },
  });
  select.checked = state.selected.has(e.id);

  const icon = h('span', { class: 'mr-auth-row__icon', 'aria-hidden': 'true' }, e.iconEmoji || '🔐');

  const nameBlock = h('div', { class: 'mr-auth-row__name' },
    h('div', { class: 'mr-auth-row__issuer' }, e.issuer || '—'),
    h('div', { class: 'mr-auth-row__account mr-typography-body-small' }, e.account || ''),
  );

  const codeText = formatCode(cached?.code);
  const codeBtn = h('button', {
    class: 'mr-auth-code',
    title: copy('auth.copyCode'),
    'aria-label': `${copy('auth.copyCode')} — ${entryName(e)}`,
    onclick: async () => {
      const fresh = await currentCode(e.id);
      if (!fresh) return;
      await writeClipboard(fresh);
      toast(copy('auth.codeCopied'), entryName(e), { kind: 'success' });
      if (e.type === 'hotp') {
        // HOTP codes are single-use: advancing after copy is offered, never automatic.
      }
    },
  }, codeText);

  const timer = h('span', { class: 'mr-auth-timer', role: 'text' }, timerText(e, cached));

  const peek = h('span', { class: 'mr-auth-peek mr-typography-body-small' },
    state.showPeek && cached?.next ? `${copy('auth.nextLabel')} ${formatCode(cached.next)}` : '');

  const badge = e.armed
    ? null
    : h('button', {
        class: 'm3-chip mr-auth-badge',
        onclick: () => openConfirmEntryModal(e.id),
      }, `⚠ ${copy('auth.unconfirmedBadge')} · ${copy('auth.confirmShort')}`);

  const revealBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm m3-btn--icon-only',
    title: copy('auth.reveal'),
    'aria-label': `${copy('auth.reveal')} — ${entryName(e)}`,
    onclick: () => openRevealModal(e.id),
  }, '▣');

  const editBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm m3-btn--icon-only',
    title: copy('auth.edit'),
    'aria-label': `${copy('auth.edit')} — ${entryName(e)}`,
    onclick: () => openEditModal(e.id),
  }, '✎');

  const menuBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm m3-btn--icon-only',
    title: copy('auth.rowMenu'),
    'aria-label': `${copy('auth.rowMenu')} — ${entryName(e)}`,
    onclick: (ev) => openRowMenu(ev.currentTarget, e),
  }, '⋮');

  row.addEventListener('keydown', (ev) => {
    if (ev.altKey && ev.key === 'ArrowUp') { ev.preventDefault(); moveRow(e.id, -1); }
    else if (ev.altKey && ev.key === 'ArrowDown') { ev.preventDefault(); moveRow(e.id, 1); }
    else if (ev.key === 'Enter' && ev.target === row) { ev.preventDefault(); openRowMenu(menuBtn, e); }
  });
  row.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/mr-auth-id', e.id);
    ev.dataTransfer.effectAllowed = 'move';
    row.classList.add('mr-auth-row--dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('mr-auth-row--dragging'));
  row.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
  });
  row.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const draggedId = ev.dataTransfer.getData('text/mr-auth-id');
    if (draggedId && draggedId !== e.id) await reorderToBefore(draggedId, e.id);
  });

  row.append(
    select,
    icon,
    nameBlock,
    h('div', { class: 'mr-auth-row__codebox' }, codeBtn, timer, peek),
    h('div', { class: 'mr-auth-row__actions' }, ...(badge ? [badge] : []), revealBtn, editBtn, menuBtn),
  );
  return row;
}

function formatCode(code) {
  if (!code) return '••• •••';
  const s = String(code);
  if (s.length <= 4) return s;
  const half = Math.ceil(s.length / 2);
  return `${s.slice(0, half)} ${s.slice(half)}`;
}

function timerText(entry, cached) {
  if (!cached) return '';
  if (entry.type === 'hotp') return copy('auth.hotpCounter', { n: cached.counter ?? 0 });
  const remaining = Math.max(0, remainingSeconds(cached));
  return copy('auth.secondsLeft', { s: remaining });
}

function remainingSeconds(cached) {
  if (!cached || cached.type !== 'totp') return Infinity;
  const elapsed = Math.floor((Date.now() - cached.fetchedAtMs) / 1000);
  return (cached.secondsRemaining ?? 0) - elapsed;
}

async function currentCode(id) {
  try {
    const c = await invoke('vault:auth-code', { id });
    codeCache.set(id, { ...c, fetchedAtMs: Date.now() });
    return c.code;
  } catch (err) {
    toast(copy('common.errorTitle'), err.message, { kind: 'error' });
    return null;
  }
}

function noticeJournalError(journalError) {
  if (journalError) {
    toast(copy('common.errorTitle'), copy('auth.journalFailed', { error: journalError }), { kind: 'error' });
  }
}

function updateCount(shownCount) {
  if (!countEl) return;
  const total = state.entries.length;
  countEl.textContent = `${shownCount}/${total} ${total === 1 ? copy('auth.entry') : copy('auth.entries')}`;
}

// ---------------------------------------------------------------------------
// Timer loop (single interval; DOM writes only while the tab is attached)
// ---------------------------------------------------------------------------

function startTimer() {
  if (timerStarted) return;
  timerStarted = true;
  setInterval(async () => {
    if (!listEl || !listEl.isConnected) return;
    let needRefetch = [];
    for (const [id, cached] of codeCache.entries()) {
      if (cached.type !== 'totp') continue;
      if (remainingSeconds(cached) <= 0) needRefetch.push(id);
      const timerEl = listEl.querySelector(`[data-id="${CSS.escape(id)}"] .mr-auth-timer`);
      const entry = state.entries.find((e) => e.id === id);
      if (timerEl && entry) timerEl.textContent = timerText(entry, cached);
    }
    if (needRefetch.length > 0) {
      await refreshCodes(needRefetch);
      for (const id of needRefetch) updateRowCodeDom(id);
    }
  }, 250);
}

function updateRowCodeDom(id) {
  const cached = codeCache.get(id);
  const entry = state.entries.find((e) => e.id === id);
  if (!cached || !entry || !listEl) return;
  const scope = `[data-id="${CSS.escape(id)}"]`;
  const codeBtn = listEl.querySelector(`${scope} .mr-auth-code`);
  if (codeBtn) codeBtn.textContent = formatCode(cached.code);
  const timerEl = listEl.querySelector(`${scope} .mr-auth-timer`);
  if (timerEl) timerEl.textContent = timerText(entry, cached);
  const peekEl = listEl.querySelector(`${scope} .mr-auth-peek`);
  if (peekEl) peekEl.textContent = state.showPeek && cached.next ? `${copy('auth.nextLabel')} ${formatCode(cached.next)}` : '';
}

// ---------------------------------------------------------------------------
// Bulk bar
// ---------------------------------------------------------------------------

function buildBulkBar() {
  const bar = h('div', { class: 'mr-row mr-auth-bulkbar', role: 'toolbar', 'aria-label': copy('auth.selectedCount', { n: 0 }) });
  syncBulkBarRef = { bar };
  rebuildBulkBar(bar);
  return bar;
}

let syncBulkBarRef = null;

function rebuildBulkBar(bar) {
  bar.textContent = '';

  const selectAll = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => {
      const shown = filteredEntries();
      const allSelected = shown.every((e) => state.selected.has(e.id));
      if (allSelected) shown.forEach((e) => state.selected.delete(e.id));
      else shown.forEach((e) => state.selected.add(e.id));
      renderList();
    },
  }, copy('auth.selectAllShown'));

  const invert = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => {
      for (const e of filteredEntries()) {
        if (state.selected.has(e.id)) state.selected.delete(e.id);
        else state.selected.add(e.id);
      }
      renderList();
    },
  }, copy('auth.invertSelection'));

  const clear = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => { state.selected.clear(); renderList(); },
  }, copy('auth.clearSelection'));

  const del = h('button', {
    class: 'm3-btn m3-btn--danger m3-btn--sm',
    disabled: state.selected.size === 0 ? true : null,
    onclick: () => deleteSelected(),
  }, `🗑 ${copy('auth.deleteSelected')}`);

  const group = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    disabled: state.selected.size === 0 ? true : null,
    onclick: () => groupSelected(),
  }, copy('auth.groupSelected'));

  bar.append(selectAll, invert, clear, del, group);
}

function syncBulkBar(shownCount) {
  void shownCount;
  if (!syncBulkBarRef) return;
  rebuildBulkBar(syncBulkBarRef.bar);
}

// ---------------------------------------------------------------------------
// Row menu + mutations
// ---------------------------------------------------------------------------

function openRowMenu(anchor, e) {
  const idx = state.entries.findIndex((x) => x.id === e.id);
  showMenu([
    { label: copy('auth.reveal'), run: () => openRevealModal(e.id) },
    { label: copy('auth.edit'), run: () => openEditModal(e.id) },
    { label: copy('auth.copyCode'), run: async () => {
        const code = await currentCode(e.id);
        if (code) { await writeClipboard(code); toast(copy('auth.codeCopied'), '', { kind: 'success' }); }
      } },
    { label: state.showPeek ? copy('auth.hidePeek') : copy('auth.peek'), run: () => {
        state.showPeek = !state.showPeek;
        renderList();
      } },
    { separator: true },
    { label: copy('auth.moveUp'), disabled: idx <= 0 ? true : null, run: () => moveRow(e.id, -1) },
    { label: copy('auth.moveDown'), disabled: idx < 0 || idx >= state.entries.length - 1 ? true : null, run: () => moveRow(e.id, 1) },
    ...(e.type === 'hotp'
      ? [{ label: copy('auth.incrementCounter'), run: () => advanceCounter(e.id) }]
      : []),
    ...(e.armed ? [] : [{ label: copy('auth.confirmShort'), run: () => openConfirmEntryModal(e.id) }]),
    { separator: true },
    { label: `🗑 ${copy('auth.remove')}`, run: () => deleteEntries([e.id]) },
  ], { anchor });
}

async function moveRow(id, delta) {
  const ids = state.entries.map((e) => e.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await persistOrder(ids);
}

async function reorderToBefore(draggedId, beforeId) {
  const ids = state.entries.map((e) => e.id).filter((id) => id !== draggedId);
  const at = ids.indexOf(beforeId);
  if (at === -1) return;
  ids.splice(at, 0, draggedId);
  await persistOrder(ids);
}

async function persistOrder(ids) {
  try {
    const res = await invoke('vault:auth-reorder', { ids });
    noticeJournalError(res?.journalError);
    historyPanel.record('authenticator.reorder', `${ids.length} entries`);
    await reloadEntriesOnly();
  } catch (err) {
    toast(copy('common.errorTitle'), err.message, { kind: 'error' });
  }
}

async function reloadEntriesOnly() {
  const res = await invoke('vault:auth-list');
  state.entries = res.entries ?? [];
  state.vaultOk = Boolean(res.encryptionAvailable);
  renderList();
}

async function advanceCounter(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  try {
    const res = await invoke('vault:auth-update', { id, patch: { counter: (entry.counter || 0) + 1 } });
    noticeJournalError(res?.journalError);
    historyPanel.record('authenticator.counter', entryName(entry));
    await reloadEntriesOnly();
    await refreshCodes([id]);
    updateRowCodeDom(id);
  } catch (err) {
    toast(copy('common.errorTitle'), err.message, { kind: 'error' });
  }
}

async function deleteEntries(ids) {
  const targets = state.entries.filter((e) => ids.includes(e.id));
  if (targets.length === 0) return;
  const names = targets.map(entryName);
  const ok = await destructiveConfirm({
    title: targets.length === 1
      ? t('auth.deleteOneTitle')
      : t('auth.deleteManyTitle', { n: targets.length }),
    body: targets.length === 1
      ? t('auth.deleteOneBody', { name: names[0] })
      : `${t('auth.deleteManyBody', { n: targets.length })}\n\n${names.join('\n')}`,
    confirmLabel: copy('auth.deleteConfirm'),
  });
  if (!ok) return;
  try {
    const res = await invoke('vault:auth-remove', { ids });
    noticeJournalError(res?.journalError);
    for (const e of targets) {
      state.selected.delete(e.id);
      codeCache.delete(e.id);
    }
    historyPanel.record('authenticator.remove', names.join('; ').slice(0, 200));
    toast(copy('auth.deleteConfirm'), names.join('; ').slice(0, 120), { kind: 'success' });
    await reloadEntriesOnly();
  } catch (err) {
    toast(copy('common.errorTitle'), err.message, { kind: 'error' });
  }
}

async function deleteSelected() {
  await deleteEntries([...state.selected]);
}

async function groupSelected() {
  const existing = [...new Set(state.entries.map(groupOf).filter(Boolean))];
  const dlg = openModal({
    title: copy('auth.groupSelected'),
    body: (body) => {
      const input = h('input', {
        class: 'm3-textfield mr-grow',
        list: 'mr-auth-group-suggestions',
        placeholder: copy('auth.groupPlaceholder'),
        'aria-label': copy('auth.group'),
      });
      const dl = h('datalist', { id: 'mr-auth-group-suggestions' },
        existing.map((g) => h('option', { value: g })));
      body.append(h('div', { class: 'mr-row' }, input, dl));
      body.run = () => input.value;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); dlg.close(); }
      });
      queueMicrotask(() => input.focus());
    },
    actions: [
      { label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} },
      { label: copy('common.save'), kind: 'm3-btn--filled', run: async () => {
          const value = bodyValue(dlg);
          const ids = [...state.selected];
          try {
            const res = await invoke('vault:auth-group-many', { ids, group: value });
            noticeJournalError(res?.journalError);
            historyPanel.record('authenticator.group', `${ids.length} -> "${value}"`);
            await reloadEntriesOnly();
          } catch (err) {
            toast(copy('common.errorTitle'), err.message, { kind: 'error' });
          }
          return true;
        } },
    ],
  });
  void dlg;
}

/** Read the value stashed on a dialog body by the body-builder above. */
function bodyValue(dlg) {
  const holder = dlg.el.querySelector('.m3-dialog__body');
  return holder && typeof holder.run === 'function' ? holder.run() : '';
}

// ---------------------------------------------------------------------------
// Add flows
// ---------------------------------------------------------------------------

function openAddMenu(anchor) {
  showMenu([
    { label: copy('auth.addUri'), run: () => openAddUriModal() },
    { label: copy('auth.addManual'), run: () => openManualModal() },
    { label: copy('auth.importList'), run: () => openImportManyModal() },
  ], { anchor });
}

function openAddUriModal() {
  let dlgRef = null;
  dlgRef = openModal({
    title: copy('auth.uriTitle'),
    body: (body) => {
      const ta = h('textarea', {
        class: 'm3-textfield mr-auth-uri-input',
        rows: '4',
        placeholder: copy('auth.uriPlaceholder'),
        'aria-label': copy('auth.uriField'),
        spellcheck: 'false',
      });
      const errLine = h('p', { class: 'mr-auth-error mr-typography-body-small', role: 'alert' });
      const parseBtn = h('button', {
        class: 'm3-btn m3-btn--tonal',
        onclick: async () => {
          errLine.textContent = '';
          try {
            const res = await invoke('vault:auth-parse-uri', { text: ta.value });
            swapToPairing(body, res.draft, res.uri, () => dlgRef.close());
          } catch (err) {
            errLine.textContent = `${copy('auth.parseBad')}: ${err.message}`;
          }
        },
      }, copy('auth.parse'));
      body.append(ta, errLine, h('div', { class: 'mr-row' }, parseBtn));
      queueMicrotask(() => ta.focus());
    },
    actions: [{ label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} }],
  });
}

function openManualModal() {
  let dlgRef = null;
  dlgRef = openModal({
    title: copy('auth.manualTitle'),
    body: (body) => {
      const fields = manualFields();
      const errLine = h('p', { class: 'mr-auth-error mr-typography-body-small', role: 'alert' });
      const nextBtn = h('button', {
        class: 'm3-btn m3-btn--tonal',
        onclick: async () => {
          errLine.textContent = '';
          const draft = collectDraft(fields);
          try {
            const res = await invoke('vault:auth-validate-draft', { draft });
            swapToPairing(body, res.draft, res.uri, () => dlgRef.close());
          } catch (err) {
            errLine.textContent = err.message;
          }
        },
      }, copy('dialogs.continue'));
      body.append(fields.el, errLine, h('div', { class: 'mr-row' }, nextBtn));
    },
    actions: [{ label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} }],
  });
}

function openImportManyModal() {
  openModal({
    title: copy('auth.importList'),
    body: (body) => {
      const ta = h('textarea', {
        class: 'm3-textfield mr-auth-uri-input',
        rows: '8',
        placeholder: `${copy('auth.uriPlaceholder')}\notpauth://totp/…`,
        'aria-label': copy('auth.importList'),
        spellcheck: 'false',
      });
      const report = h('div', { class: 'mr-auth-import-report' });
      let parsedDrafts = [];

      const parseBtn = h('button', {
        class: 'm3-btn m3-btn--tonal',
        onclick: async () => {
          report.textContent = '';
          parsedDrafts = [];
          const res = await invoke('vault:auth-parse-uri-list', { text: ta.value });
          parsedDrafts = res.drafts ?? [];
          const errs = res.errors ?? [];
          if (parsedDrafts.length === 0 && errs.length === 0) {
            report.append(h('p', { class: 'mr-typography-body-small' }, copy('auth.emptyBody')));
            importBtn.disabled = true;
            return;
          }
          for (const d of parsedDrafts) {
            report.append(h('div', { class: 'mr-auth-import-row' },
              `${d.iconEmoji || '🔐'} ${d.issuer || '?'} · ${d.account || '?'} — ${d.algorithm} ${d.digits}${d.type === 'totp' ? `/(${d.period}s)` : ''}`));
          }
          for (const msg of errs) {
            report.append(h('div', { class: 'mr-auth-error mr-typography-body-small' }, msg));
          }
          importBtn.disabled = parsedDrafts.length === 0 ? true : null;
        },
      }, copy('auth.parse'));

      const importBtn = h('button', {
        class: 'm3-btn m3-btn--filled',
        disabled: true,
        onclick: async () => {
          try {
            const res = await invoke('vault:auth-import', { items: parsedDrafts });
            noticeJournalError(res?.journalError);
            historyPanel.record('authenticator.import', `${res.addedCount} entries`);
            toast(copy('auth.paired'), copy('auth.unconfirmedBadge') + ': ' + res.addedCount, { kind: 'info' });
            await reloadEntriesOnly();
          } catch (err) {
            toast(copy('common.errorTitle'), err.message, { kind: 'error' });
          }
        },
      }, copy('auth.importList'));

      body.append(ta, h('div', { class: 'mr-row' }, parseBtn, importBtn), report);
    },
    actions: [{ label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} }],
  });
}

/** Manual-entry form fields. Returns {el, read()} */
function manualFields(preset = {}) {
  const typeSel = h('select', { class: 'm3-select', 'aria-label': copy('auth.type') },
    h('option', { value: 'totp' }, copy('auth.typeTotp')),
    h('option', { value: 'hotp' }, copy('auth.typeHotp')),
  );
  typeSel.value = preset.type || 'totp';

  const secretInput = h('input', {
    class: 'm3-textfield mr-grow',
    placeholder: copy('auth.secretPlaceholder'),
    'aria-label': copy('auth.secret'),
    spellcheck: 'false',
    autocomplete: 'off',
  });
  if (preset.secret) secretInput.value = preset.secret;

  const genBtn = h('button', {
    class: 'm3-btn m3-btn--outlined m3-btn--sm',
    onclick: async () => {
      const res = await invoke('vault:auth-new-secret');
      secretInput.value = res.secretB32.replace(/(.{4})(?=.)/g, '$1 ');
    },
  }, copy('auth.generate'));

  const issuerInput = h('input', { class: 'm3-textfield mr-grow', 'aria-label': copy('auth.issuer'), value: preset.issuer ?? '' });
  const accountInput = h('input', { class: 'm3-textfield mr-grow', 'aria-label': copy('auth.account'), value: preset.account ?? '' });

  const algoSel = h('select', { class: 'm3-select', 'aria-label': copy('auth.algorithm') },
    ['SHA1', 'SHA256', 'SHA512'].map((a) => h('option', { value: a }, a)));
  algoSel.value = preset.algorithm || 'SHA1';

  const digitsSel = h('select', { class: 'm3-select', 'aria-label': copy('auth.digits') },
    [6, 7, 8].map((d) => h('option', { value: String(d) }, `${d} ${copy('auth.digitsUnit')}`)));
  digitsSel.value = String(preset.digits ?? 6);

  const periodInput = h('input', {
    class: 'm3-textfield', type: 'number', min: '1', max: '86400', step: '1',
    value: String(preset.period ?? 30), 'aria-label': `${copy('auth.period')} (${copy('auth.periodUnit')})`,
  });

  const counterInput = h('input', {
    class: 'm3-textfield', type: 'number', min: '0', step: '1',
    value: String(preset.counter ?? 0), 'aria-label': copy('auth.counter'),
  });

  const hotpOnly = () => {
    const isHotp = typeSel.value === 'hotp';
    periodInput.disabled = isHotp;
    counterInput.disabled = !isHotp;
  };
  typeSel.addEventListener('change', hotpOnly);
  hotpOnly();

  const el = h('div', { class: 'mr-auth-form' },
    h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.type')), typeSel),
    h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.secret')),
      h('div', { class: 'mr-row' }, secretInput, genBtn)),
    h('p', { class: 'mr-typography-body-small mr-auth-hint' }, copy('auth.secretHint')),
    h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.issuer')), issuerInput),
    h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.account')), accountInput),
    h('div', { class: 'mr-row' },
      h('label', { class: 'mr-auth-field mr-grow' }, h('span', {}, copy('auth.algorithm')), algoSel),
      h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.digits')), digitsSel),
      h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.period')), periodInput),
      h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.counter')), counterInput),
    ),
  );

  return {
    el,
    read: () => ({
      type: typeSel.value,
      secret: secretInput.value,
      issuer: issuerInput.value.trim(),
      account: accountInput.value.trim(),
      algorithm: algoSel.value,
      digits: Number(digitsSel.value),
      period: Number(periodInput.value || 30),
      counter: Number(counterInput.value || 0),
      iconEmoji: suggestEmojiLocal(issuerInput.value),
      group: '',
    }),
  };
}

function collectDraft(fields) {
  return fields.read();
}

function suggestEmojiLocal(issuer) {
  const s = String(issuer || '').toLowerCase();
  if (/mail|gmail|outlook|proton/.test(s)) return '✉️';
  if (/git/.test(s)) return '🐙';
  if (/bank|pay/.test(s)) return '💳';
  if (/cloud|aws|azure/.test(s)) return '☁️';
  return '🔐';
}

/**
 * Replace a dialog's body with the pairing view: QR (rendered locally from
 * `uri`), grouped key behind an explicit reveal, parameters stated as facts,
 * and the typed-code gate. `onSaved` closes the host dialog after success.
 */
function swapToPairing(dialogBody, draft, uri, onSaved) {
  dialogBody.textContent = '';
  const paramsLine = draft.type === 'hotp'
    ? copy('auth.paramsHotp', { digits: draft.digits, counter: draft.counter ?? 0 })
    : copy('auth.params', { algo: draft.algorithm, digits: draft.digits, period: draft.period });

  const qrHolder = h('div', { class: 'mr-auth-qr-holder' });
  const keyRevealed = h('div', { class: 'mr-auth-key mr-typography-body-small', hidden: true });
  const revealBtn = h('button', {
    class: 'm3-btn m3-btn--outlined m3-btn--sm',
    'aria-pressed': 'false',
    onclick: () => {
      const showing = !keyRevealed.hidden;
      keyRevealed.hidden = showing;
      revealBtn.textContent = showing ? copy('auth.revealKey') : copy('auth.hideKey');
      revealBtn.setAttribute('aria-pressed', String(!showing));
    },
  }, copy('auth.revealKey'));

  const copyKeyBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: async () => {
      await writeClipboard(draft.secret);
      toast(copy('common.copied'), copy('auth.revealKey'), { kind: 'success' });
    },
  }, copy('auth.keyCopy'));

  const codeInput = h('input', {
    class: 'm3-textfield',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: String(draft.digits + 2),
    placeholder: '· '.repeat(Math.min(draft.digits, 4)).trim(),
    'aria-label': copy('auth.confirmField'),
  });
  const errLine = h('p', { class: 'mr-auth-error mr-typography-body-small', role: 'alert' });

  const confirmBtn = h('button', {
    class: 'm3-btn m3-btn--filled',
    onclick: async () => {
      errLine.textContent = '';
      confirmBtn.disabled = true;
      try {
        const res = await invoke('vault:auth-add', { draft, confirmCode: codeInput.value });
        noticeJournalError(res?.journalError);
        historyPanel.record('authenticator.add', entryName(res.entry));
        toast(copy('auth.paired'), entryName(res.entry), { kind: 'success' });
        onSaved?.();
        await reloadEntriesOnly();
        await refreshCodes([res.entry.id]);
        updateRowCodeDom(res.entry.id);
      } catch (err) {
        errLine.textContent = err.code === 'auth-code-mismatch' ? copy('auth.wrongCode') : err.message;
        confirmBtn.disabled = false;
      }
    },
  }, copy('auth.confirmBtn'));

  // Render the QR locally from the canonical URI the main process produced.
  try {
    const { el } = qrSvgElement(uri, { label: copy('auth.qrAlt', { name: `${draft.issuer} · ${draft.account}`.trim() }) });
    qrHolder.append(el);
  } catch (err) {
    qrHolder.append(h('p', { class: 'mr-auth-error mr-typography-body-small' }, err.message));
  }

  keyRevealed.append(formatBase32Grouped(draft.secret));

  dialogBody.append(
    h('h3', { class: 'mr-typography-title-medium' }, copy('auth.pairTitle')),
    h('p', { class: 'mr-typography-body-medium' }, copy('auth.pairIntro')),
    qrHolder,
    h('p', { class: 'mr-typography-label-large mr-auth-params' }, paramsLine),
    h('div', { class: 'mr-row' }, revealBtn, copyKeyBtn),
    keyRevealed,
    h('div', { class: 'mr-row mr-auth-confirm-row' },
      codeInput,
      confirmBtn,
    ),
    errLine,
  );
  queueMicrotask(() => codeInput.focus());
}

function formatBase32Grouped(b32) {
  const clean = String(b32 || '').replace(/[\s-]/g, '').toUpperCase();
  const parts = clean.match(/.{1,4}/g) ?? [];
  const out = h('div', { class: 'mr-auth-key-lines' });
  for (let i = 0; i < parts.length; i += 4) {
    out.append(h('div', {}, parts.slice(i, i + 4).join(' ')));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reveal (existing entry) + confirm-pairing (unarmed entry)
// ---------------------------------------------------------------------------

async function fetchSecretView(id) {
  return invoke('vault:auth-show-secret', { id });
}

function openRevealModal(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  const dlg = openModal({
    title: `${copy('auth.reveal')} — ${entryName(entry)}`,
    body: (body) => {
      fillSecretView(body, entry, { confirmable: !entry.armed, onClose: () => dlg.close() });
    },
    actions: [{ label: copy('common.close'), kind: 'm3-btn--text', run: () => {} }],
  });
}

function openConfirmEntryModal(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  const dlg = openModal({
    title: copy('auth.pairTitle'),
    body: (body) => {
      fillSecretView(body, entry, { confirmable: true, onClose: () => dlg.close() });
    },
    actions: [{ label: copy('common.close'), kind: 'm3-btn--text', run: () => {} }],
  });
}

function fillSecretView(body, entry, { confirmable, onClose }) {
  const statusLine = h('p', { class: 'mr-typography-body-medium' }, copy('auth.pairIntro'));
  const qrHolder = h('div', { class: 'mr-auth-qr-holder' });
  const paramsLine = h('p', { class: 'mr-typography-label-large mr-auth-params' }, '');
  const keyRevealed = h('div', { class: 'mr-auth-key mr-typography-body-small', hidden: true });
  const revealBtn = h('button', {
    class: 'm3-btn m3-btn--outlined m3-btn--sm',
    'aria-pressed': 'false',
    onclick: () => {
      const showing = !keyRevealed.hidden;
      keyRevealed.hidden = showing;
      revealBtn.textContent = showing ? copy('auth.revealKey') : copy('auth.hideKey');
      revealBtn.setAttribute('aria-pressed', String(!showing));
    },
  }, copy('auth.revealKey'));
  const copyKeyBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: async () => {
      if (secretB32) { await writeClipboard(secretB32); toast(copy('common.copied'), '', { kind: 'success' }); }
    },
  }, copy('auth.keyCopy'));

  let secretB32 = '';

  const errLine = h('p', { class: 'mr-auth-error mr-typography-body-small', role: 'alert' });

  const codeInput = h('input', {
    class: 'm3-textfield',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: String((entry.digits || 6) + 2),
    'aria-label': copy('auth.confirmField'),
  });

  const confirmBtn = h('button', {
    class: 'm3-btn m3-btn--filled',
    onclick: async () => {
      errLine.textContent = '';
      try {
        await invoke('vault:auth-confirm', { id: entry.id, code: codeInput.value });
        historyPanel.record('authenticator.pair', entryName(entry));
        toast(copy('auth.paired'), entryName(entry), { kind: 'success' });
        onClose?.();
        await reloadEntriesOnly();
        await refreshCodes([entry.id]);
        updateRowCodeDom(entry.id);
      } catch (err) {
        errLine.textContent = err.code === 'auth-code-mismatch' ? copy('auth.wrongCode') : err.message;
      }
    },
  }, copy('auth.confirmExisting'));

  (async () => {
    try {
      const view = await fetchSecretView(entry.id);
      secretB32 = view.secretB32;
      const { el } = qrSvgElement(view.uri, { label: copy('auth.qrAlt', { name: entryName(entry) }) });
      qrHolder.append(el);
      paramsLine.textContent = view.type === 'hotp'
        ? copy('auth.paramsHotp', { digits: view.digits, counter: view.counter })
        : copy('auth.params', { algo: view.algorithm, digits: view.digits, period: view.period });
      keyRevealed.append(formatBase32Grouped(view.secretB32));
    } catch (err) {
      qrHolder.append(h('p', { class: 'mr-auth-error mr-typography-body-small' }, err.message));
    }
  })();

  body.append(statusLine, qrHolder, paramsLine,
    h('div', { class: 'mr-row' }, revealBtn, copyKeyBtn),
    keyRevealed);

  if (confirmable && !entry.armed) {
    body.append(
      h('div', { class: 'mr-row mr-auth-confirm-row' }, codeInput, confirmBtn),
      errLine,
    );
    queueMicrotask(() => codeInput.focus());
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

function openEditModal(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;

  const issuerInput = h('input', { class: 'm3-textfield mr-grow', 'aria-label': copy('auth.issuer'), value: entry.issuer ?? '' });
  const accountInput = h('input', { class: 'm3-textfield mr-grow', 'aria-label': copy('auth.account'), value: entry.account ?? '' });
  const iconInput = h('input', {
    class: 'm3-textfield', maxlength: '8', 'aria-label': copy('auth.icon'),
    value: entry.iconEmoji ?? '', style: 'width:5.5em;text-align:center',
  });

  const groups = [...new Set(state.entries.map(groupOf).filter(Boolean))];
  const groupInput = h('input', {
    class: 'm3-textfield mr-grow', list: 'mr-auth-edit-groups',
    placeholder: copy('auth.groupPlaceholder'), 'aria-label': copy('auth.group'),
    value: entry.group ?? '',
  });
  const dl = h('datalist', { id: 'mr-auth-edit-groups' }, groups.map((g) => h('option', { value: g })));

  const algoSel = h('select', { class: 'm3-select', 'aria-label': copy('auth.algorithm') },
    ['SHA1', 'SHA256', 'SHA512'].map((a) => h('option', { value: a }, a)));
  algoSel.value = entry.algorithm;
  const digitsSel = h('select', { class: 'm3-select', 'aria-label': copy('auth.digits') },
    [6, 7, 8].map((d) => h('option', { value: String(d) }, `${d} ${copy('auth.digitsUnit')}`)));
  digitsSel.value = String(entry.digits);
  const periodInput = h('input', {
    class: 'm3-textfield', type: 'number', min: '1', max: '86400', step: '1',
    value: String(entry.period ?? 30), 'aria-label': copy('auth.period'),
  });

  openModal({
    title: copy('auth.editTitle'),
    body: (body) => {
      body.append(
        h('div', { class: 'mr-row' }, iconInput, issuerInput),
        accountInput,
        h('div', { class: 'mr-row' }, groupInput, dl),
        h('div', { class: 'mr-row' },
          h('label', { class: 'mr-auth-field mr-grow' }, h('span', {}, copy('auth.algorithm')), algoSel),
          h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.digits')), digitsSel),
          h('label', { class: 'mr-auth-field' }, h('span', {}, copy('auth.period')), periodInput),
        ),
        h('p', { class: 'mr-typography-body-small mr-auth-hint mr-auth-warn' }, copy('auth.cryptoWarning')),
      );
    },
    actions: [
      { label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} },
      { label: copy('common.save'), kind: 'm3-btn--filled', run: async () => {
          const patch = {
            issuer: issuerInput.value,
            account: accountInput.value,
            iconEmoji: iconInput.value,
            group: groupInput.value,
            algorithm: algoSel.value,
            digits: Number(digitsSel.value),
            period: Number(periodInput.value || 30),
          };
          try {
            const res = await invoke('vault:auth-update', { id, patch });
            noticeJournalError(res?.journalError);
            historyPanel.record('authenticator.edit', entryName(res.entry ?? entry));
            await reloadEntriesOnly();
            await refreshCodes([id]);
            updateRowCodeDom(id);
            if (res.recrypto) {
              toast(copy('auth.cryptoWarning'), entryName(res.entry ?? entry), { kind: 'info' });
              openConfirmEntryModal(id);
            }
            return true;
          } catch (err) {
            toast(copy('common.errorTitle'), err.message, { kind: 'error' });
            return false;
          }
        } },
    ],
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function openExportMenu(anchor) {
  showMenu([
    { label: copy('auth.exportRedacted'), run: exportRedacted },
    { label: copy('auth.exportFull'), run: exportFullGated },
  ], { anchor });
}

async function exportRedacted() {
  try {
    const payload = await invoke('vault:auth-export', { mode: 'redacted' });
    saveText(
      `material-router-authenticator-metadata-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    toast(copy('auth.exported'), copy('auth.redactedNote'), { kind: 'success' });
    historyPanel.record('authenticator.export', 'metadata only');
  } catch (err) {
    toast(copy('common.errorTitle'), err.message, { kind: 'error' });
  }
}

async function exportFullGated() {
  const ok = await destructiveConfirm({
    title: copy('auth.fullGateTitle'),
    body: copy('auth.fullGateBody'),
    confirmLabel: copy('auth.exportFull'),
  });
  if (!ok) return;
  try {
    const payload = await invoke('vault:auth-export', { mode: 'full' });
    saveText(
      `material-router-authenticator-SECRETS-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    toast(copy('auth.exported'), copy('auth.fullGateBody'), { kind: 'error' }); // persists until dismissed
    historyPanel.record('authenticator.export', 'SECRETS included (plain text)');
  } catch (err) {
    toast(copy('common.errorTitle'), err.message, { kind: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Mutation-history manager (own scrypt credential, redacted journal)
// ---------------------------------------------------------------------------

const RESTORABLE = new Set(['edit', 'rekey', 'rename', 'group-change', 'reorder']);

function openHistoryManager() {
  openModal({
    title: copy('auth.historyTitle'),
    body: (body) => buildHistoryGate(body),
    actions: [],
  });
}

async function buildHistoryGate(body) {
  let status;
  try {
    status = await invoke('vault:auth-journal-status');
  } catch (err) {
    body.append(h('p', { class: 'mr-auth-error' }, err.message));
    return;
  }

  if (!status.credSet) {
    body.append(h('p', { class: 'mr-typography-body-medium' }, copy('auth.setPasswordIntro')));
    const pw = h('input', { class: 'm3-textfield', type: 'password', autocomplete: 'new-password', 'aria-label': copy('auth.newPassword') });
    const errLine = h('p', { class: 'mr-auth-error mr-typography-body-small', role: 'alert' });
    const save = h('button', {
      class: 'm3-btn m3-btn--filled',
      onclick: async () => {
        errLine.textContent = '';
        try {
          await invoke('vault:auth-history-set-password', { oldPassword: null, newPassword: pw.value });
          body.textContent = '';
          buildHistoryBody(body);
        } catch (err) {
          errLine.textContent = err.message;
        }
      },
    }, copy('auth.setPassword'));
    body.append(h('div', { class: 'mr-row mr-auth-confirm-row' }, pw, save), errLine);
    queueMicrotask(() => pw.focus());
    return;
  }

  if (!status.unlocked) {
    body.append(h('h3', { class: 'mr-typography-title-medium' }, copy('auth.unlockTitle')));
    const pw = h('input', { class: 'm3-textfield', type: 'password', autocomplete: 'current-password', 'aria-label': copy('auth.password') });
    const errLine = h('p', { class: 'mr-auth-error mr-typography-body-small', role: 'alert' });
    const unlock = h('button', {
      class: 'm3-btn m3-btn--filled',
      onclick: async () => {
        errLine.textContent = '';
        try {
          await invoke('vault:auth-history-unlock', { password: pw.value });
          body.textContent = '';
          buildHistoryBody(body);
        } catch (err) {
          errLine.textContent = copy('auth.wrongPassword');
        }
      },
    }, copy('auth.unlock'));
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock.click(); });
    body.append(h('div', { class: 'mr-row mr-auth-confirm-row' }, pw, unlock), errLine);
    queueMicrotask(() => pw.focus());
    return;
  }

  buildHistoryBody(body);
}

function buildHistoryBody(body) {
  body.textContent = '';
  body.classList.add('mr-auth-history');

  body.append(h('p', { class: 'mr-typography-body-small mr-auth-hint' }, copy('auth.historyIntro')));

  const retentionLine = h('p', { class: 'mr-typography-label-medium mr-auth-retention' });
  const search = createSearchBar({
    placeholder: copy('auth.historySearch'),
    label: copy('auth.historySearch'),
    onQuery: () => renderRows(),
  });
  const dateFrom = h('input', { class: 'm3-textfield', type: 'date', 'aria-label': copy('auth.dateFrom') });
  const dateTo = h('input', { class: 'm3-textfield', type: 'date', 'aria-label': copy('auth.dateTo') });
  const chips = h('div', { class: 'mr-row', style: 'flex-wrap:wrap' });
  const detailBox = h('div', { class: 'mr-auth-diff' });
  const listBox = h('div', { class: 'mr-auth-journal-list', role: 'list' });

  /** @type {Array<object>} currently loaded journal rows */
  let rows = [];
  let meta = { retention: { maxEntries: 2000, maxAgeDays: 400 } };
  /** @type {Set<string>} */
  const activeActions = new Set();

  async function loadQuery() {
    const res = await invoke('vault:auth-journal-query', {
      fromDay: dateFrom.value || '',
      toDay: dateTo.value || '',
      actions: [...activeActions],
      limit: 1000,
    });
    rows = res.rows ?? [];
    meta = res;
    retentionLine.textContent = copy('auth.retention', {
      max: res.retention.maxEntries, days: res.retention.maxAgeDays,
    }) + `  ·  ${res.matched}/${res.total}`;
    renderChips(res.total);
    renderRows();
  }

  function allActions() {
    const counts = new Map();
    for (const r of rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
    return counts;
  }

  function renderChips(totalCount) {
    chips.textContent = '';
    for (const [action, n] of [...allActions()].sort()) {
      chips.append(h('button', {
        class: `m3-chip${activeActions.has(action) ? ' m3-chip--selected' : ''}`,
        'aria-pressed': String(activeActions.has(action)),
        onclick: () => {
          if (activeActions.has(action)) activeActions.delete(action);
          else activeActions.add(action);
          loadQuery();
        },
      }, `${actionLabel(action)} (${n})`));
    }
    void totalCount;
  }

  function matches(r) {
    const qs = search.get();
    return matchesQuery(qs, `${r.target}\n${r.detail}\n${actionLabel(r.action)}`);
  }

  function renderRows() {
    listBox.textContent = '';
    const visible = rows.filter(matches);
    if (visible.length === 0) {
      listBox.append(h('p', { class: 'mr-typography-body-medium' }, copy('auth.historyEmpty')));
    }
    for (const r of visible) {
      const restorable = RESTORABLE.has(r.action)
        && (Array.isArray(r.snapshot) || Array.isArray(r.orderSnapshot));
      const rowEl = h('div', { class: 'mr-auth-journal-row', role: 'listitem' },
        h('time', { datetime: r.ts, class: 'mr-auth-journal-ts' }, fmtDate(r.ts)),
        h('span', { class: 'm3-chip mr-auth-journal-action' }, actionLabel(r.action)),
        h('span', { class: 'mr-grow' },
          h('div', {}, r.target),
          r.detail ? h('div', { class: 'mr-typography-body-small mr-auth-journal-detail' }, r.detail) : null,
        ),
        r.seq != null ? h('span', { class: 'mr-typography-label-small' }, `#${r.seq}`) : null,
        h('button', {
          class: 'm3-btn m3-btn--tonal m3-btn--sm',
          disabled: restorable ? null : true,
          title: restorable ? copy('auth.restoreBtn') : copy('auth.cannotRestore'),
          'aria-label': `${copy('auth.restoreBtn')} #${r.seq}`,
          onclick: () => restoreSeq(r),
        }, copy('auth.restoreBtn')),
      );
      rowEl.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        showDiff(r);
      });
      listBox.append(rowEl);
    }
  }

  async function restoreSeq(r) {
    if (r.action === 'remove') {
      detailBox.textContent = '';
      detailBox.append(h('p', { class: 'mr-typography-body-small mr-auth-warn' }, copy('auth.removedNotRestorable')));
      return;
    }
    try {
      await invoke('vault:auth-journal-restore', { seq: r.seq });
      toast(copy('auth.restoreDone'), r.target, { kind: 'success' });
      await reloadEntriesOnly();
      await loadQuery();
    } catch (err) {
      toast(copy('common.errorTitle'), err.message, { kind: 'error' });
    }
  }

  function showDiff(r) {
    detailBox.textContent = '';
    detailBox.append(h('h4', { class: 'mr-typography-title-small' }, `${copy('auth.diffDetail')} — #${r.seq} ${actionLabel(r.action)}`));
    if (r.detail) {
      for (const part of String(r.detail).split('; ')) {
        if (!part) continue;
        detailBox.append(h('div', { class: 'mr-auth-diff-line' }, part));
      }
    } else {
      detailBox.append(h('div', { class: 'mr-typography-body-small' }, r.target));
    }
    if (RESTORABLE.has(r.action) && !(Array.isArray(r.snapshot) || Array.isArray(r.orderSnapshot))) {
      detailBox.append(h('p', { class: 'mr-typography-body-small mr-auth-warn' }, copy('auth.cannotRestore')));
    }
  }

  const lockBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: async () => {
      await invoke('vault:auth-history-lock');
      buildHistoryGate(body);
    },
  }, `🔒 ${copy('auth.lock')}`);

  const pruneBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    onclick: async () => {
      const ok = await destructiveConfirm({
        title: copy('auth.prune'),
        body: `${copy('auth.retention', { max: meta.retention.maxEntries, days: meta.retention.maxAgeDays })}`,
        confirmLabel: copy('auth.prune'),
      });
      if (!ok) return;
      const res = await invoke('vault:auth-journal-prune');
      noticeJournalError(res?.journalError);
      toast(copy('auth.prunedCount', { n: res.removed ?? 0 }), '', { kind: 'info' });
      await loadQuery();
    },
  }, `🧹 ${copy('auth.prune')}`);

  const exportMdBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => {
      const visible = rows.filter(matches);
      const header = `<!-- ${copy('auth.historyOmits')} -->\n\n`;
      saveText(`authenticator-history-${Date.now()}.md`,
        header + visible.map((r) =>
          `- **#${r.seq} ${actionLabel(r.action)}** — ${r.target}${r.detail ? ` — ${r.detail}` : ''} _(${fmtDate(r.ts)})_`).join('\n') + '\n',
        'text/markdown;charset=utf-8');
      historyPanel.record('authenticator.historyExport', `${visible.length} records`);
    },
  }, copy('auth.exportHistoryMd'));

  dateFrom.addEventListener('change', loadQuery);
  dateTo.addEventListener('change', loadQuery);

  body.append(
    search.el,
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' }, dateFrom, dateTo, retentionLine),
    chips,
    listBox,
    detailBox,
    h('div', { class: 'mr-row', style: 'margin-top:12px' }, exportMdBtn, pruneBtn, lockBtn),
  );

  loadQuery();
}

function actionLabel(action) {
  const key = `act.${action}`;
  const label = t(key);
  return label === key ? String(action) : label;
}

// ---------------------------------------------------------------------------
// Command palette coverage
// ---------------------------------------------------------------------------

function registerPaletteItems(addAnchor) {
  // Re-registers are intentional: palette.register replaces by id, so the
  // language-change pass calls this again to refresh localized titles.
  paletteReady = true;
  palette.register({
    id: 'auth.add',
    title: copy('auth.add'),
    keywords: ['authenticator', 'totp', 'otp', 'add', 'pair'],
    section: 'Actions',
    run: () => openAddMenu(addAnchor?.isConnected ? addAnchor : document.body),
  });
  palette.register({
    id: 'auth.history',
    title: copy('auth.historyOpen'),
    keywords: ['authenticator', 'journal', 'history'],
    section: 'Actions',
    run: () => openHistoryManager(),
  });
  palette.register({
    id: 'auth.export.metadata',
    title: copy('auth.exportRedacted'),
    keywords: ['authenticator', 'export'],
    section: 'Actions',
    run: () => exportRedacted(),
  });
}
