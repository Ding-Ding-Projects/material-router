// Purpose: the browser-style tab strip. Docks left/top/right/bottom,
// overflows by scrolling (never silently clips), supports pinning, named
// collapsible groups with move-via-picker, rename, close guards, drag reorder,
// full keyboard operation with roving tabindex, and persistence.
// Tab lifecycle: def.init(container) runs once on first activation,
// def.mount?(panel) on every activation, and def.destroy?(container, api) on
// close - the place for a tab module to unsubscribe events, clear timers and
// abort streams instead of leaving them alive until remount. A later remount
// re-runs init(), which re-registers everything the destroy released.
// Events dispatched for lanes: 'mr:tab-edit-appearance' {tabId, anchor},
// 'mr:tab-lock-element' {tabId, anchor}.
// Owned by Foundation Core lane.

import { h } from './util.js';
import * as settings from './settings.js';
import { languageMode, t } from './i18n.js';
import { showMenu, openModal, promptText } from './dialogs.js';
import { createSearchBar, matchesQuery } from './searchbar.js';

const GROUP_COLORS = ['#7d5260', '#6750a4', '#2b6777', '#526e2b', '#8c5a10', '#6d4b94'];

const state = {
  /** @type {Array<{id,label:{en,zh},icon?,init,mount?,destroy?}>} */
  defs: [],
  order: [],
  pinned: [],
  groups: [],
  customLabels: {},
  activeId: null,
  dockEdge: 'left',
  /** @type {Set<string>} */
  collapsedGroups: new Set(),
  stripEl: null,
  appEl: null,
  panelsEl: null,
  buttonsById: new Map(),
  panelsById: new Map(),
  mountedIds: new Set(),
  /** Ids whose destroy() already ran since their last mount (double-destroy guard). */
  destroyedSinceMount: new Set(),
  closeGuard: null,
  saveTimer: null,
};

export function init({ defs, appEl }) {
  state.defs = defs;
  state.appEl = appEl;

  const known = new Set(defs.map((d) => d.id));
  restore();
  const validOrder = state.order.filter((id) => known.has(id));
  for (const d of defs) if (!validOrder.includes(d.id)) validOrder.push(d.id);
  state.order = validOrder;
  state.pinned = [...new Set(state.pinned.filter((id) => known.has(id)))];
  for (const g of state.groups) g.members = g.members.filter((id) => known.has(id));
  state.groups = state.groups.filter((g) => g.members.length > 0);
  if (!state.activeId || !known.has(state.activeId)) {
    state.activeId = state.order[0] ?? null;
  }

  buildStrip();
  buildPanels();
  applyDock();
  activate(state.activeId);
  scheduleSave();

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeActive();
    }
  });
}

/**
 * Re-render strip chrome (tab labels, group headers, section titles) after a
 * language-mode change. Strip state survives; focus returns to the tab that
 * held it so keyboard users are not dumped on <body>.
 */
export function refreshChrome() {
  if (!state.stripEl || !state.stripEl.isConnected) return;
  const focusedId = document.activeElement?.dataset?.tabId ?? null;
  renderStrip();
  const refocus = focusedId ? state.buttonsById.get(focusedId) : null;
  if (refocus) {
    try { refocus.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }
}

/** Register a veto hook: fn(tabDef) -> boolean|Promise<boolean> (true = allow close). */
export function setCloseGuard(fn) {
  state.closeGuard = fn;
}

function defaultModel() {
  return {
    dockEdge: 'left',
    order: [],
    pinned: [],
    groups: [],
    customLabels: {},
    activeId: null,
    collapsed: [],
  };
}

function restore() {
  const saved = settings.get('ui.tabstrip', null);
  const m = saved && typeof saved === 'object' ? saved : defaultModel();
  state.dockEdge = ['left', 'right', 'top', 'bottom'].includes(m.dockEdge) ? m.dockEdge : 'left';
  state.order = Array.isArray(m.order) ? [...m.order] : [];
  state.pinned = Array.isArray(m.pinned) ? [...m.pinned] : [];
  state.groups = Array.isArray(m.groups)
    ? m.groups
      .map((g, i) => ({
        id: String(g.id ?? `group_${i}`),
        name: String(g.name ?? ''),
        color: String(g.color ?? GROUP_COLORS[i % GROUP_COLORS.length]),
        members: Array.isArray(g.members) ? [...g.members] : [],
      }))
      .filter((g) => g.name)
    : [];
  state.customLabels = m.customLabels && typeof m.customLabels === 'object' ? { ...m.customLabels } : {};
  state.activeId = typeof m.activeId === 'string' ? m.activeId : null;
  state.collapsedGroups = new Set(Array.isArray(m.collapsed) ? m.collapsed : []);
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(persistNow, 250);
}

function persistNow() {
  settings.set('ui.tabstrip', {
    dockEdge: state.dockEdge,
    order: [...state.order],
    pinned: [...state.pinned],
    groups: state.groups.map((g) => ({ ...g, members: [...g.members] })),
    customLabels: { ...state.customLabels },
    activeId: state.activeId,
    collapsed: [...state.collapsedGroups],
  }).catch(() => {});
}

export function defById(id) {
  return state.defs.find((d) => d.id === id) ?? null;
}

function tabLabel(def) {
  const custom = state.customLabels[def.id];
  if (custom) return custom;
  const mode = languageMode();
  const label = def.label ?? {};
  if (mode === 'zh') return label.zh ?? label.en ?? def.id;
  if (mode === 'bilingual') return `${label.en ?? def.id} · ${label.zh ?? label.en ?? def.id}`;
  return label.en ?? def.id;
}

// -- layout -------------------------------------------------------------------

function applyDock() {
  state.appEl.dataset.dock = state.dockEdge;
  const strip = state.stripEl;
  strip.setAttribute('aria-orientation', state.dockEdge === 'top' || state.dockEdge === 'bottom' ? 'horizontal' : 'vertical');
}

/** All visible tab ids in display sequence: pinned first, then group members, then ungrouped. */
function displaySequence() {
  const grouped = new Set(state.groups.flatMap((g) => g.members));
  const pinnedSeq = state.order.filter((id) => state.pinned.includes(id));
  const groupSeq = state.groups.flatMap((g) => state.order.filter((id) => g.members.includes(id)));
  const ungroupedSeq = state.order.filter((id) => !grouped.has(id) && !state.pinned.includes(id));
  return [...pinnedSeq, ...groupSeq, ...ungroupedSeq];
}

function sectionOf(tabId) {
  if (state.pinned.includes(tabId)) return 'pinned';
  const g = state.groups.find((gr) => gr.members.includes(tabId));
  if (g) return `group:${g.id}`;
  return 'main';
}

// -- DOM ----------------------------------------------------------------------

function buildStrip() {
  state.stripEl?.remove();
  state.stripEl = h('div', { class: 'mr-tabstrip', role: 'tablist', id: 'mr-tabstrip' });
  renderStrip();
  state.appEl.append(state.stripEl);

  // Context menu on empty strip space: dock edge + new group.
  state.stripEl.addEventListener('contextmenu', (e) => {
    if (e.target !== state.stripEl) return;
    e.preventDefault();
    showMenu([
      ...dockEdgeItems(),
      { separator: true },
      { label: t('tabs.newGroup'), run: () => createGroupInteractive(null) },
    ], { x: e.clientX, y: e.clientY });
  });
}

function dockEdgeItems() {
  return [
    ['left', t('dock.left')], ['right', t('dock.right')],
    ['top', t('dock.top')], ['bottom', t('dock.bottom')],
  ].map(([edge, label]) => ({
    label,
    checked: state.dockEdge === edge,
    run: () => { state.dockEdge = edge; applyDock(); scheduleSave(); },
  }));
}

function renderStrip() {
  state.buttonsById.clear();
  const strip = state.stripEl;
  strip.textContent = '';

  // Pinned section
  const pinnedIds = state.order.filter((id) => state.pinned.includes(id));
  if (pinnedIds.length > 0) {
    strip.append(h('div', { class: 'mr-strip-section-label' }, t('common.pinned')));
    for (const id of pinnedIds) strip.append(makeTabButton(id));
  }

  // Groups
  for (const group of state.groups) {
    const collapsed = state.collapsedGroups.has(group.id);
    const memberWrap = h('div', { role: 'presentation' });
    for (const id of state.order.filter((x) => group.members.includes(x))) {
      memberWrap.append(makeTabButton(id));
    }
    if (!collapsed || memberWrap.children.length === 0) {
      strip.append(h('div', { class: `mr-tab-group${collapsed ? ' mr-tab-group--collapsed' : ''}` },
        h('div', {
          class: 'mr-tab-group__header',
          role: 'button',
          tabindex: '0',
          'aria-expanded': String(!collapsed),
          onclick: () => toggleGroup(group.id),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(group.id); } },
          oncontextmenu: (e) => {
            e.preventDefault();
            showMenu(groupMenuItems(group), { x: e.clientX, y: e.clientY });
          },
        },
          h('span', { class: 'mr-tab-group__dot', style: `background:${group.color}` }),
          h('span', {}, `${group.name} (${group.members.length})`),
          h('span', { class: 'mr-tab-group__chevron', 'aria-hidden': 'true' }, '▾'),
        ),
        ...(collapsed ? [] : [memberWrap]),
      ));
    }
  }

  // Ungrouped section
  const ungrouped = state.order.filter(
    (id) => !state.pinned.includes(id) && !state.groups.some((g) => g.members.includes(id)),
  );
  if (ungrouped.length > 0) {
    strip.append(h('div', { class: 'mr-strip-section-label' }, t('common.tabs')));
    for (const id of ungrouped) strip.append(makeTabButton(id));
  }
}

function toggleGroup(groupId) {
  if (state.collapsedGroups.has(groupId)) state.collapsedGroups.delete(groupId);
  else state.collapsedGroups.add(groupId);
  renderStrip();
  scheduleSave();
}

function makeTabButton(tabId) {
  const def = defById(tabId);
  if (!def) return document.createComment(`missing ${tabId}`);
  const selected = state.activeId === tabId;
  const btn = h('button', {
    class: `mr-tab-btn${selected ? '' : ''}${state.pinned.includes(tabId) ? ' mr-tab-btn--pinned' : ''}`,
    role: 'tab',
    id: `mr-tab-btn-${tabId}`,
    'aria-selected': String(selected),
    'aria-controls': `mr-tab-panel-${tabId}`,
    tabindex: selected ? '0' : '-1',
    draggable: 'true',
    title: tabLabel(def),
    dataset: { tabId },
    onclick: () => activate(tabId),
    oncontextmenu: (e) => {
      e.preventDefault();
      showMenu(tabMenuItems(def), { x: e.clientX, y: e.clientY });
    },
    onkeydown: (e) => onTabKeydown(e, tabId),
  },
    def.icon ?? null,
    h('span', { class: 'mr-tab-btn__label' }, tabLabel(def)),
    state.pinned.includes(tabId) ? h('span', { class: 'mr-tab-btn__pin-indicator', 'aria-hidden': 'true' }, '●') : null,
  );
  attachDragHandlers(btn, tabId);
  state.buttonsById.set(tabId, btn);
  return btn;
}

function onTabKeydown(e, tabId) {
  const seq = displaySequence();
  const idx = seq.indexOf(tabId);
  const vertical = state.dockEdge === 'left' || state.dockEdge === 'right';
  const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
  const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';

  if (e.key === nextKey || e.key === prevKey) {
    e.preventDefault();
    let next = idx + (e.key === nextKey ? 1 : -1);
    if (next < 0) next = seq.length - 1;
    if (next >= seq.length) next = 0;
    activate(seq[next]);
    focusButton(seq[next]);
  } else if (e.key === 'Home') {
    e.preventDefault();
    activate(seq[0]);
    focusButton(seq[0]);
  } else if (e.key === 'End') {
    e.preventDefault();
    activate(seq[seq.length - 1]);
    focusButton(seq[seq.length - 1]);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    closeTab(tabId);
  }
}

function focusButton(tabId) {
  state.buttonsById.get(tabId)?.focus();
}

function tabMenuItems(def) {
  const isPinned = state.pinned.includes(def.id);
  const groupId = state.groups.find((g) => g.members.includes(def.id))?.id ?? null;
  return [
    { label: `${t('common.rename')}…`, shortcut: '', run: async () => renameTab(def) },
    { label: isPinned ? t('tabs.unpin') : t('tabs.pin'), run: () => (isPinned ? unpinTab(def.id) : pinTab(def.id)) },
    { label: `${t('tabs.moveIntoGroup')}…`, disabled: false, checked: groupId != null, run: () => openMovePicker(def.id) },
    { separator: true },
    {
      label: t('tabs.editAppearance'),
      run: () => window.dispatchEvent(new CustomEvent('mr:tab-edit-appearance', { detail: { tabId: def.id, anchor: state.buttonsById.get(def.id) } })),
    },
    {
      label: `${t('tabs.lockElement')}…`,
      run: () => window.dispatchEvent(new CustomEvent('mr:tab-lock-element', { detail: { tabId: def.id, anchor: state.buttonsById.get(def.id) } })),
    },
    { separator: true },
    ...dockEdgeItems().map((item) => ({ ...item })),
    { separator: true },
    { label: t('tabs.closeOthers'), run: () => closeOthers(def.id) },
    { label: t('tabs.closeAll'), run: () => closeAll() },
    { label: t('tabs.close'), run: () => closeTab(def.id) },
  ];
}

function groupMenuItems(group) {
  return [
    { label: `${t('common.rename')}…`, run: async () => renameGroup(group) },
    {
      label: t('tabs.disbandGroup'),
      run: () => {
        state.groups = state.groups.filter((g) => g.id !== group.id);
        renderStrip();
        scheduleSave();
      },
    },
  ];
}

async function renameTab(def) {
  const name = await promptText({
    title: t('tabs.renameTitle'),
    label: t('tabs.renameLabel'),
    value: state.customLabels[def.id] ?? '',
    placeholder: tabLabel(def),
  });
  if (name === null) return;
  if (name.trim() === '') delete state.customLabels[def.id];
  else state.customLabels[def.id] = name.trim();
  renderStrip();
  scheduleSave();
}

async function renameGroup(group) {
  const name = await promptText({
    title: t('tabs.renameGroupTitle'),
    label: t('tabs.renameLabel'),
    value: group.name,
  });
  if (name === null || !name.trim()) return;
  group.name = name.trim();
  renderStrip();
  scheduleSave();
}

function pinTab(id) {
  state.pinned.push(id);
  renderStrip();
  scheduleSave();
}

function unpinTab(id) {
  state.pinned = state.pinned.filter((x) => x !== id);
  renderStrip();
  scheduleSave();
}

// -- drag reorder ---------------------------------------------------------------

function attachDragHandlers(btn, tabId) {
  btn.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/mr-tab', tabId);
    e.dataTransfer.effectAllowed = 'move';
  });
  btn.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/mr-tab')) {
      e.preventDefault();
      const rect = btn.getBoundingClientRect();
      const horizontal = state.dockEdge === 'top' || state.dockEdge === 'bottom';
      const after = horizontal
        ? e.clientX > rect.left + rect.width / 2
        : e.clientY > rect.top + rect.height / 2;
      btn.classList.toggle('drag-over-top', !after);
      btn.classList.toggle('drag-over-bottom', after);
    }
  });
  btn.addEventListener('dragleave', () => {
    btn.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  btn.addEventListener('drop', (e) => {
    e.preventDefault();
    btn.classList.remove('drag-over-top', 'drag-over-bottom');
    const dragged = e.dataTransfer.getData('text/mr-tab');
    if (!dragged || dragged === tabId) return;
    moveWithinSection(dragged, tabId);
  });
}

function moveWithinSection(fromId, toId) {
  if (sectionOf(fromId) !== sectionOf(toId)) {
    openMovePickerForTarget(fromId, toId);
    return;
  }
  const fromIdx = state.order.indexOf(fromId);
  const toIdx = state.order.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return;
  state.order.splice(fromIdx, 1);
  state.order.splice(state.order.indexOf(toId) + 1, 0, fromId);
  renderStrip();
  scheduleSave();
}

// -- move-to-group picker ---------------------------------------------------------

function createGroupInteractive(firstMemberId = null) {
  return promptText({
    title: t('tabs.newGroupTitle'),
    label: t('tabs.groupNameLabel'),
  }).then(async (name) => {
    if (!name?.trim()) return;
    const group = {
      id: `group_${Math.random().toString(36).slice(2, 9)}`,
      name: name.trim(),
      color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length],
      members: [],
    };
    state.groups.push(group);
    if (firstMemberId) {
      group.members.push(firstMemberId);
    }
    renderStrip();
    scheduleSave();
    return group;
  });
}

function openMovePicker(tabId) {
  openMovePickerForTarget(tabId, null);
}

function openMovePickerForTarget(tabId, targetGroupId = null) {
  let search;
  const listEl = h('div', {});

  function options() {
    const q = search?.get() ?? { text: '', mode: 'plain' };
    const rows = [];
    rows.push({
      key: '__ungrouped__',
      title: t('common.ungrouped'),
      count: state.order.filter((id) => !state.pinned.includes(id) && !state.groups.some((g) => g.members.includes(id))).length,
      color: '',
      match: matchesQuery(q, t('common.ungrouped')),
    });
    for (const g of state.groups) {
      rows.push({
        key: g.id,
        title: g.name,
        count: g.members.length,
        color: g.color,
        match: matchesQuery(q, g.name),
      });
    }
    return rows.filter((r) => r.match && r.key !== targetGroupId);
  }

  function renderList() {
    listEl.textContent = '';
    const rows = options();
    if (rows.length === 0) {
      listEl.append(h('p', { class: 'mr-palette__empty' }, t('tabs.noMoveTargets')));
    }
    for (const row of rows) {
      listEl.append(h('button', {
        class: 'm3-btn m3-btn--text',
        style: 'width:100%;justify-content:flex-start;border-radius:var(--md-sys-shape-corner-sm)',
        onclick: () => {
          moveTo(row.key === '__ungrouped__' ? null : row.key, tabId);
          dlg.close();
        },
      },
        row.color ? h('span', { class: 'mr-tab-group__dot', style: `background:${row.color}` }) : null,
        h('span', {}, row.title),
        h('span', { style: 'margin-left:auto;color:var(--md-sys-color-on-surface-variant)' }, String(row.count)),
      ));
    }
  }

  search = createSearchBar({
    placeholder: copySearchPlaceholder(),
    label: copySearchPlaceholder(),
    onQuery: () => renderList(),
  });

  const dlg = openModal({
    title: t('tabs.moveIntoGroup'),
    body: (container) => {
      container.append(search.el, listEl);
    },
    actions: [{
      label: `${t('tabs.newGroup')}…`,
      kind: 'm3-btn--tonal',
      run: async () => {
        const name = await promptText({
          title: t('tabs.newGroupTitle'),
          label: t('tabs.groupNameLabel'),
        });
        if (name?.trim()) {
          moveTo(name.trim(), tabId);
          dlg.close();
        }
        return false; // keep the dialog open under the prompt
      },
    }],
  });

  renderList();
  queueMicrotask(() => search.focus());
}

function copySearchPlaceholder() {
  return t('tabs.filterGroups');
}

function moveTo(groupNameOrId, tabId) {
  let group = state.groups.find((g) => g.id === groupNameOrId)
    ?? state.groups.find((g) => g.name === groupNameOrId);
  if (!group && groupNameOrId) {
    group = {
      id: `group_${Math.random().toString(36).slice(2, 9)}`,
      name: groupNameOrId,
      color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length],
      members: [],
    };
    state.groups.push(group);
  }
  for (const g of state.groups) g.members = g.members.filter((id) => id !== tabId);
  if (group) {
    group.members.push(tabId);
    state.pinned = state.pinned.filter((id) => id !== tabId);
  }
  state.groups = state.groups.filter((g) => g.members.length > 0);
  renderStrip();
  scheduleSave();
}

// -- panels ---------------------------------------------------------------------

function buildPanels() {
  state.panelsEl = h('div', { class: 'mr-content', id: 'mr-content' });
  for (const def of state.defs) {
    const panel = h('div', {
      class: 'mr-panel',
      role: 'tabpanel',
      id: `mr-tab-panel-${def.id}`,
      'aria-labelledby': `mr-tab-btn-${def.id}`,
      tabindex: '0',
      hidden: true,
    });
    state.panelsById.set(def.id, panel);
    state.panelsEl.append(panel);
  }
  state.appEl.append(state.panelsEl);
}

function ensureMounted(def, panel) {
  if (state.mountedIds.has(def.id)) return;
  state.mountedIds.add(def.id);
  state.destroyedSinceMount.delete(def.id); // fresh mount: a later close may destroy again
  try {
    def.init(panel);
  } catch (err) {
    panel.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-error)' }, `${def.id}: init failed - ${err.message}`));
  }
}

/**
 * Run def.destroy once per mount, before the panel is removed so the module
 * can still read its own DOM while unsubscribing. Never throws into closeTab.
 */
function runDestroy(def, panel) {
  if (typeof def.destroy !== 'function') return;
  if (!state.mountedIds.has(def.id)) return; // never initialized: nothing to release
  if (state.destroyedSinceMount.has(def.id)) return; // double-destroy guard
  state.destroyedSinceMount.add(def.id);
  try {
    def.destroy(panel, { id: def.id, reason: 'close' });
  } catch (err) {
    console.error(`[tabs] destroy failed for "${def.id}":`, err);
  }
}

// -- activation & closing ----------------------------------------------------------

export function activeId() {
  return state.activeId;
}

export async function activate(tabId) {
  if (!defById(tabId)) return;
  state.activeId = tabId;
  for (const [id, panel] of state.panelsById) {
    const show = id === tabId;
    panel.hidden = !show;
    panel.classList.toggle('mr-active', show);
  }
  for (const [id, btn] of state.buttonsById) {
    btn.setAttribute('aria-selected', String(id === tabId));
    btn.tabIndex = id === tabId ? 0 : -1;
  }
  const def = defById(tabId);
  ensureMounted(def, state.panelsById.get(tabId));
  try {
    def.mount?.(state.panelsById.get(tabId));
  } catch { /* mount errors stay isolated */ }
  scheduleSave();
}

async function passesGuard(def) {
  if (!state.closeGuard) return true;
  try {
    return Boolean(await state.closeGuard(def));
  } catch {
    return false;
  }
}

export async function closeTab(tabId) {
  const def = defById(tabId);
  if (!def) return;
  if (state.defs.length <= 1) return; // never leave the strip empty
  if (!(await passesGuard(def))) return;

  const idx = state.order.indexOf(tabId);
  state.order = state.order.filter((id) => id !== tabId);
  state.pinned = state.pinned.filter((id) => id !== tabId);
  for (const g of state.groups) g.members = g.members.filter((id) => id !== tabId);
  state.groups = state.groups.filter((g) => g.members.length > 0);
  delete state.customLabels[tabId];

  const panel = state.panelsById.get(tabId);
  runDestroy(def, panel);
  if (panel) {
    panel.remove();
    state.panelsById.delete(tabId);
  }
  state.mountedIds.delete(tabId);

  if (state.activeId === tabId) {
    const next = state.order[Math.min(idx, state.order.length - 1)];
    state.activeId = null;
    if (next) await activate(next);
  }
  renderStrip();
  rebuildPanelNode(tabId);
  scheduleSave();
}

function rebuildPanelNode(tabId) {
  // Keep a panel node available in case the tab is re-created by a lane.
  if (defById(tabId) && !state.panelsById.has(tabId)) {
    const panel = h('div', {
      class: 'mr-panel', role: 'tabpanel', id: `mr-tab-panel-${tabId}`, hidden: true, tabindex: '0',
    });
    state.panelsById.set(tabId, panel);
    state.panelsEl.append(panel);
  }
}

export async function closeActive() {
  if (state.activeId) await closeTab(state.activeId);
}

export async function closeOthers(keepId) {
  for (const id of [...state.order]) {
    if (id !== keepId && !state.pinned.includes(id)) {
      await closeTab(id);
    }
  }
}

export async function closeAll() {
  for (const id of [...state.order.filter((x) => !state.pinned.includes(x))]) {
    await closeTab(id);
  }
}
