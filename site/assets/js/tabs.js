/* Browser-style tabbed navigation for the whole site.
   Strip docks left/right/top/bottom; overflow surface; drag + keyboard
   reorder; pinning with a dedicated region; named collapsible groups;
   per-tab appearance editing; toy locks; full persistence in localStorage.
   Everything is rebuilt from one state object so restarts restore exactly. */

import { el, clamp, storage, uid } from './util.js';
import { t } from './i18n.js';
import { getSettings } from './store.js';
import { getLock, isUnlocked, createLockWizard, promptUnlock } from './locks.js';

export function registerTabsBundle(addBundle) {
  addBundle('tabs', {
    en: {
      'tb.dock': 'Dock strip',
      'tb.dock.left': 'Left', 'tb.dock.right': 'Right', 'tb.dock.top': 'Top', 'tb.dock.bottom': 'Bottom',
      'tb.pin': 'Pin tab', 'tb.unpin': 'Unpin tab',
      'tb.rename': 'Rename…',
      'tb.movegroup': 'Move… into group…',
      'tb.editAppearance': 'Edit tab appearance…',
      'tb.lock': 'Lock this tab…',
      'tb.close': 'Close',
      'tb.closeOthers': 'Close others (this session)',
      'tb.overflow': 'More tabs',
      'tb.groups': 'Tab groups',
      'tb.newGroup': 'New group…',
      'tb.noGroups': 'No groups yet.',
      'tb.groupName': 'Group name',
      'tb.createGroup': 'Create',
      'tb.moveTo': 'Move into',
      'tb.noGroupOption': '(no group)',
      'tb.appearance.title': 'Edit tab appearance',
      'tb.appearance.color': 'Colour',
      'tb.appearance.fontSize': 'Font size (%)',
      'tb.appearance.weight': 'Weight',
      'tb.appearance.italic': 'Italic',
      'tb.appearance.underline': 'Underline',
      'tb.appearance.strike': 'Strikethrough',
      'tb.appearance.icon': 'Icon / emoji',
      'tb.appearance.radius': 'Corner radius (px)',
      'tb.appearance.reset': 'Reset this tab',
      'tb.locked': 'Locked',
      'tb.tablist': 'Site pages',
    },
    zh: {
      'tb.dock': '工具列位置',
      'tb.dock.left': '左', 'tb.dock.right': '右', 'tb.dock.top': '上', 'tb.dock.bottom': '下',
      'tb.pin': '釘選分頁', 'tb.unpin': '取消釘選',
      'tb.rename': '改名……',
      'tb.movegroup': '搬去……群組……',
      'tb.editAppearance': '編輯分頁外觀……',
      'tb.lock': '鎖上呢個分頁……',
      'tb.close': '閂咗佢',
      'tb.closeOthers': '閂其他（今次session）',
      'tb.overflow': '仲有更多分頁',
      'tb.groups': '分頁群組',
      'tb.newGroup': '開新群組……',
      'tb.noGroups': '仲未有群組。',
      'tb.groupName': '群組名',
      'tb.createGroup': '開',
      'tb.moveTo': '搬入去',
      'tb.noGroupOption': '(冇群組)',
      'tb.appearance.title': '編輯分頁外觀',
      'tb.appearance.color': '顏色',
      'tb.appearance.fontSize': '字號（%）',
      'tb.appearance.weight': '字重',
      'tb.appearance.italic': '斜體',
      'tb.appearance.underline': '底線',
      'tb.appearance.strike': '刪除線',
      'tb.appearance.icon': '圖示／emoji',
      'tb.appearance.radius': '角位弧度（px）',
      'tb.appearance.reset': '重置呢個分頁',
      'tb.locked': '已上鎖',
      'tb.tablist': '網站分頁',
    },
  });
}

/* Page registry shared by tabs + palette + docs hub. */
import { PAGES } from './pages-data.js';

const DEFAULT_STATE = Object.freeze({
  dock: 'left',                    // left | right | top | bottom
  order: PAGES.map((p) => p.id),
  pinned: [],
  closedSession: [],               // hidden for this browser session only
  groups: [],                      // [{id,name,color,collapsed}]
  membership: {},                  // tabId -> groupId | ''
  custom: {},                      // tabId -> {color,fontSize,weight,italic,...}
  labels: {},                      // tabId -> user rename
});

function loadState() {
  const saved = storage.get('tabstate', null);
  const state = { ...structuredClone(DEFAULT_STATE), ...(saved || {}) };
  // registry changes: keep unknown ids out, add new pages at the end
  state.order = [
    ...state.order.filter((id) => PAGES.some((p) => p.id === id)),
    ...PAGES.map((p) => p.id).filter((id) => !state.order.includes(id)),
  ];
  state.pinned = (state.pinned || []).filter((id) => state.order.includes(id));
  return state;
}

let STATE = loadState();
const save = () => storage.set('tabstate', STATE);

export function currentPageId() {
  const here = location.pathname.split('/').pop() || 'index.html';
  const page = PAGES.find((p) => p.href === here || p.href === `${here}`);
  return page ? page.id : PAGES[0].id;
}

/* ---------- public init ---------- */
let stripEl = null;

export function initTabs() {
  const existing = document.getElementById('site-tabstrip');
  if (existing) existing.remove();
  document.documentElement.setAttribute('data-dock', STATE.dock);
  document.body.classList.toggle('dock-column', STATE.dock === 'top' || STATE.dock === 'bottom');
  stripEl = el('nav', {
    class: 'tabstrip', role: 'tablist', id: 'site-tabstrip',
    'aria-label': t('tb.tablist'), 'aria-orientation': vertical() ? 'vertical' : 'horizontal',
  });
  const root = document.getElementById('tabstrip-root');
  if (root) root.append(stripEl);
  else document.body.prepend(stripEl);
  // locked-note target used by aria-describedby on locked tabs
  if (!document.getElementById('locked-note')) {
    const note = el('span', { class: 'visually-hidden', id: 'locked-note', text: t('lk.lockedBadge') || '' });
    document.body.append(note);
  }
  render();
  window.addEventListener('resize', debounceRender);
}

const debounceRender = (() => {
  let tId = null;
  return () => {
    clearTimeout(tId);
    tId = setTimeout(() => render(), 120);
  };
})();

function vertical() {
  return STATE.dock === 'left' || STATE.dock === 'right';
}
function dockEdgeClass() {
  return `dock-${STATE.dock}`;
}

function visibleTabs() {
  const current = currentPageId();
  const ordered = STATE.order
    .map((id) => ({ page: PAGES.find((p) => p.id === id), id }))
    .filter((x) => x.page && !STATE.closedSession.includes(x.id));
  const pinned = ordered.filter((x) => STATE.pinned.includes(x.id));
  const rest = ordered.filter((x) => !STATE.pinned.includes(x.id));
  return { pinned, rest, current };
}

function render() {
  if (!stripEl) return;
  stripEl.className = `tabstrip ${dockEdgeClass()}`;
  stripEl.setAttribute('aria-orientation', vertical() ? 'vertical' : 'horizontal');
  stripEl.textContent = '';
  const { pinned, rest, current } = visibleTabs();

  const makeTab = ({ id }) => {
    const page = PAGES.find((p) => p.id === id);
    const lockedHere = !!getLock(id) && !isUnlocked(id);
    const btn = el('a', {
      class: 'tab' + (id === current ? ' is-active' : '') + (lockedHere ? ' is-locked' : ''),
      href: page.href,
      role: 'tab',
      'aria-selected': id === current ? 'true' : 'false',
      tabindex: id === current ? '0' : '-1',
      draggable: 'true',
      dataset: { tabId: id },
      title: labelOf(id),
    });
    const nameSpan = el('span', { class: 'tab-name' });
    applyLabel(nameSpan, id);
    btn.append(nameSpan);
    if (STATE.pinned.includes(id)) btn.append(el('span', { class: 'tab-pin', 'aria-hidden': 'true', text: '📌' }));
    if (lockedHere) {
      btn.append(el('span', { class: 'tab-lockicon', 'aria-hidden': 'true', text: '🔒' }));
      btn.setAttribute('aria-describedby', 'locked-note');
    }
    applyCustomStyle(btn, id);

    btn.addEventListener('click', (e) => {
      if (getLock(id) && !isUnlocked(id)) {
        e.preventDefault();
        promptUnlock(id, labelOf(id), btn, () => { location.href = page.href; });
      }
    });
    btn.addEventListener('keydown', (e) => {
      if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        moveByKeyboard(id, e.key);
        return;
      }
      // roving focus along strip orientation
      const fwdKeys = vertical() ? ['ArrowDown'] : ['ArrowRight'];
      const backKeys = vertical() ? ['ArrowUp'] : ['ArrowLeft'];
      if (fwdKeys.includes(e.key) || backKeys.includes(e.key)) {
        e.preventDefault();
        const all = Array.from(stripEl.querySelectorAll('a.tab'));
        const idx = all.indexOf(btn);
        const nextIdx = clamp(idx + (fwdKeys.includes(e.key) ? 1 : -1), 0, all.length - 1);
        all[nextIdx].focus();
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        openContextMenu(btn, id);
      }
    });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(btn, id); });
    btn.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/mr-tab', id); });
    btn.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/mr-tab')) e.preventDefault(); });
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      const dragged = e.dataTransfer.getData('text/mr-tab');
      if (!dragged || dragged === id) return;
      reorder(dragged, id);
    });
    return btn;
  };

  // pinned region first
  if (pinned.length) {
    const pinZone = el('div', { class: 'tabstrip-pinned', 'aria-label': 'pinned' });
    for (const item of pinned) pinZone.append(makeTab(item));
    stripEl.append(pinZone);
  }

  // groups + ungrouped tabs
  const groupedIds = new Set(Object.keys(STATE.membership).filter((k) => STATE.membership[k]));
  for (const group of STATE.groups) {
    const members = rest.filter((x) => groupedIds.has(x.id) && STATE.membership[x.id] === group.id);
    const header = el('button', {
      type: 'button',
      class: 'tab-group-header' + (group.collapsed ? ' is-collapsed' : ''),
      'aria-expanded': group.collapsed ? 'false' : 'true',
    });
    header.style.setProperty('--group-color', group.color || 'var(--md-sys-color-primary)');
    const nameSpan = el('span', { class: 'tab-group-name', text: group.name });
    header.append(
      el('span', { class: 'tab-group-caret', 'aria-hidden': 'true', text: group.collapsed ? '▸' : '▾' }),
      nameSpan,
      el('span', { class: 'tab-group-count', text: String(members.length) }),
    );
    header.addEventListener('click', () => {
      group.collapsed = !group.collapsed;
      save(); render();
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openGroupMenu(header, group.id);
    });
    const wrap = el('div', { class: 'tab-group', dataset: { groupId: group.id } });
    wrap.append(header);
    if (!group.collapsed) {
      const zone = el('div', { class: 'tab-group-zone' });
      for (const m of members) zone.append(makeTab(m));
      zone.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/mr-tab')) e.preventDefault(); });
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        const dragged = e.dataTransfer.getData('text/mr-tab');
        if (dragged) { STATE.membership[dragged] = group.id; save(); render(); }
      });
      wrap.append(zone);
    }
    stripEl.append(wrap);
  }
  const ungrouped = rest.filter((x) => !groupedIds.has(x.id));
  for (const item of ungrouped) stripEl.append(makeTab(item));

  // overflow: measure after paint; anything clipped lands in the menu
  requestAnimationFrame(applyOverflow);
}

function applyLabel(span, id) {
  const page = PAGES.find((p) => p.id === id);
  if (STATE.labels[id]) { span.textContent = STATE.labels[id]; return; }
  // bilingual mode shows both tracks inside the tab
  const lang = getSettings().language;
  span.textContent = t(page.labelKey);
  if (lang === 'bi' && page.labelZh) span.textContent += ` · ${page.labelZh}`;
}

function labelOf(id) {
  return STATE.labels[id] || t(PAGES.find((p) => p.id === id).labelKey);
}

function applyCustomStyle(btn, id) {
  const c = STATE.custom[id];
  if (!c) return;
  if (c.color) {
    btn.style.background = c.color;
    btn.style.borderColor = c.color;
  }
  if (c.fontSize) btn.style.fontSize = `${c.fontSize}%`;
  if (c.weight) btn.style.fontWeight = String(c.weight);
  if (c.italic) btn.style.fontStyle = 'italic';
  else btn.style.removeProperty('font-style');
  if (c.underline) btn.style.textDecoration = 'underline';
  if (c.strike) btn.style.textDecoration = `${btn.style.textDecoration || ''} line-through`.trim();
  if (c.radius != null) btn.style.borderRadius = `${c.radius}px`;
}

/* ---------- overflow ---------- */
function applyOverflow() {
  let overflowBtn = stripEl.parentElement.querySelector('.tab-overflow-btn');
  if (overflowBtn) overflowBtn.remove();
  const stripRect = stripEl.getBoundingClientRect();
  const overflowHidden = [];
  for (const tab of Array.from(stripEl.querySelectorAll('a.tab'))) {
    const r = tab.getBoundingClientRect();
    const clipped = vertical()
      ? (r.bottom > stripRect.bottom + 1 || r.top < stripRect.top - 1)
      : (r.right > stripRect.right + 1 || r.left < stripRect.left - 1);
    if (clipped) {
      overflowHidden.push(tab.dataset.tabId);
      tab.dataset.overflowed = 'true';
    } else {
      delete tab.dataset.overflowed;
    }
  }
  if (!overflowHidden.length) return;
  overflowBtn = el('button', {
    type: 'button', class: 'mr-btn mr-btn--tonal tab-overflow-btn',
    'aria-haspopup': 'menu', 'aria-label': t('tb.overflow'), text: '⋯',
  });
  overflowBtn.addEventListener('click', () => openOverflowMenu(overflowBtn, overflowHidden));
  stripEl.parentElement.appendChild(overflowBtn);
}

function openOverflowMenu(anchor, ids) {
  closeMenus();
  const menu = el('div', { class: 'ctx-menu', role: 'menu', 'aria-label': t('tb.overflow') });
  for (const id of ids) {
    const page = PAGES.find((p) => p.id === id);
    const mi = el('button', { type: 'button', class: 'ctx-item', role: 'menuitem', text: STATE.labels[id] || t(page.labelKey) });
    mi.addEventListener('click', () => { closeMenus(); location.href = page.href; });
    menu.append(mi);
  }
  placeMenu(menu, anchor);
}

/* ---------- context menus ---------- */
let openMenu = null;
function closeMenus() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}
function placeMenu(menu, anchor) {
  menu.style.position = 'fixed';
  document.body.append(menu);
  openMenu = menu;
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  let x = Math.min(r.left, window.innerWidth - mr.width - 8);
  let y = (r.bottom + 4 < window.innerHeight) ? r.bottom + 4 : Math.max(8, r.top - mr.height - 4);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  const first = menu.querySelector('button');
  if (first) first.focus();
  setTimeout(() => {
    const dismiss = (e) => {
      if (!menu.contains(e.target)) { closeMenus(); document.removeEventListener('pointerdown', dismiss); }
    };
    document.addEventListener('pointerdown', dismiss);
  });
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('button'));
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); anchor.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(idx + 1, items.length - 1)].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(idx - 1, 0)].focus(); }
  });
}

function menuItem(label, fn, { danger = false } = {}) {
  const b = el('button', { type: 'button', class: 'ctx-item' + (danger ? ' is-danger' : ''), role: 'menuitem', text: label });
  b.addEventListener('click', () => { closeMenus(); fn(); });
  return b;
}

function openContextMenu(tabBtn, id) {
  closeMenus();
  const menu = el('div', { class: 'ctx-menu', role: 'menu', 'aria-label': t('tb.tablist') });

  const isPinned = STATE.pinned.includes(id);
  menu.append(
    menuItem(isPinned ? t('tb.unpin') : t('tb.pin'), () => {
      STATE.pinned = isPinned ? STATE.pinned.filter((x) => x !== id) : [...STATE.pinned, id];
      save(); render();
    }),
    menuItem(t('tb.rename'), () => renameDialog(id)),
    menuItem(t('tb.movegroup'), () => moveToGroupPicker(id)),
    menuItem(t('tb.editAppearance'), () => editTabAppearance(id)),
    menuItem(t('tb.lock'), () => createLockWizard(id, labelOf(id), () => render())),
    menuItem(t('tb.close'), () => {
      const page = PAGES.find((p) => p.id === id);
      if (page.href === (location.pathname.split('/').pop() || 'index.html')) return;
      STATE.closedSession.push(id);
      save(); render();
    }),
    menuItem(t('tb.closeOthers'), () => {
      const current = currentPageId();
      STATE.closedSession = STATE.order.filter((x) => x !== current && !STATE.pinned.includes(x));
      save(); render();
    }, { danger: true }),
  );
  placeMenu(menu, tabBtn);

  function labelOf(x) {
    return STATE.labels[x] || t(PAGES.find((p) => p.id === x).labelKey);
  }
}

function openGroupMenu(header, groupId) {
  closeMenus();
  const menu = el('div', { class: 'ctx-menu', role: 'menu', 'aria-label': t('tb.groups') });
  const renameItem = el('button', { type: 'button', class: 'ctx-item', role: 'menuitem', text: t('tb.rename') });
  renameItem.addEventListener('click', () => {
    closeMenus();
    const g = STATE.groups.find((x) => x.id === groupId);
    const name = window.prompt(t('tb.groupName'), g.name);
    if (name && name.trim()) { g.name = name.trim().slice(0, 40); save(); render(); }
  });
  const colorWrap = el('div', { class: 'ctx-colors', role: 'group', 'aria-label': t('tb.appearance.color') });
  for (const c of ['', '#6750a4', '#7d5260', '#146c2e', '#7a5900', '#006a6a', '#b3261e']) {
    const sw = el('button', { type: 'button', class: 'swatch', style: c ? `background:${c}` : '', 'aria-label': c || 'default', title: c || 'default' });
    sw.addEventListener('click', () => {
      const g = STATE.groups.find((x) => x.id === groupId);
      g.color = c;
      save(); render(); closeMenus();
    });
    colorWrap.append(sw);
  }
  menu.append(renameItem, colorWrap,
    menuItem(t('tb.close'), () => {
      // removing a group keeps its members as ungrouped tabs
      STATE.groups = STATE.groups.filter((g) => g.id !== groupId);
      for (const k of Object.keys(STATE.membership)) {
        if (STATE.membership[k] === groupId) STATE.membership[k] = '';
      }
      save(); render();
    }, { danger: true }));
  placeMenu(menu, header);
}

/* ---------- reorder ---------- */
function reorder(draggedId, targetId) {
  const order = STATE.order.filter((x) => x !== draggedId);
  const at = order.indexOf(targetId);
  order.splice(at < 0 ? order.length : at, 0, draggedId);
  STATE.order = order;
  save(); render();
}

function moveByKeyboard(id, key) {
  const order = [...STATE.order];
  const idx = order.indexOf(id);
  const delta = (key === 'ArrowLeft' || key === 'ArrowUp') ? -1 : 1;
  const to = clamp(idx + delta, 0, order.length - 1);
  if (to === idx) return;
  order.splice(idx, 1);
  order.splice(to, 0, id);
  STATE.order = order;
  save(); render();
  const again = stripEl.querySelector(`a.tab[data-tab-id="${CSS.escape(id)}"]`);
  if (again) again.focus();
}

/* ---------- dialogs ---------- */
function renameDialog(id) {
  const currentLabel = STATE.labels[id];
  const name = window.prompt(t('tb.rename'), currentLabel || '');
  if (name == null) return; // cancelled
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) delete STATE.labels[id];
  else STATE.labels[id] = trimmed;
  save(); render();
}

function moveToGroupPicker(tabId) {
  const scrim = el('div', { class: 'modal-scrim' });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mv-title' });
  box.append(el('h2', { id: 'mv-title', class: 'modal-title', text: t('tb.moveTo') }));

  const searchMount = el('div', {});
  box.append(searchMount);
  const list = el('div', { class: 'picker-list', role: 'listbox', 'aria-label': t('tb.groups') });
  box.append(list);

  const renderList = (query = '') => {
    list.textContent = '';
    const q = query.trim().toLowerCase();
    const options = [
      ...STATE.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, count: Object.values(STATE.membership).filter((m) => m === g.id).length })),
      { id: '', name: t('tb.noGroupOption'), color: '', count: 0 },
    ].filter((o) => !q || o.name.toLowerCase().includes(q));

    if (!options.filter((o) => o.id !== '').length) {
      list.append(el('p', { class: 'empty-state', text: t('tb.noGroups') }));
    }
    for (const opt of options) {
      const rowEl = el('button', {
        type: 'button', class: 'picker-row', role: 'option',
        'aria-selected': (STATE.membership[tabId] || '') === opt.id ? 'true' : 'false',
      });
      if (opt.color) rowEl.append(el('span', { class: 'swatch', style: `background:${opt.color}`, 'aria-hidden': 'true' }));
      rowEl.append(el('span', { text: opt.name }), el('span', { class: 'centre-count', text: String(opt.count) }));
      rowEl.addEventListener('click', () => {
        STATE.membership[tabId] = opt.id;
        save(); render(); close();
      });
      rowEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') rowEl.click(); });
      list.append(rowEl);
    }
  };
  import('./searchbar.js').then(({ createSearchBar }) => {
    createSearchBar(searchMount, {
      ariaLabel: t('tb.groups'),
      onQuery(state) { renderList(state.pattern); },
    });
  });
  renderList();

  const newBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('tb.newGroup') });
  newBtn.addEventListener('click', () => {
    const name = window.prompt(t('tb.groupName'), '');
    if (name && name.trim()) {
      const g = { id: uid('grp'), name: name.trim().slice(0, 40), color: '#6750a4', collapsed: false };
      STATE.groups.push(g);
      STATE.membership[tabId] = g.id;
      save(); render(); close();
    }
  });
  const cancelB = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('dlg.cancel') });
  cancelB.addEventListener('click', () => close());
  const actionsRow = el('div', { class: 'modal-actions' }, [newBtn, cancelB]);
  box.append(actionsRow);

  scrim.append(box);
  document.body.append(scrim);
  const escHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', escHandler);
  function close() { scrim.remove(); document.removeEventListener('keydown', escHandler); }
}

/* Per-tab appearance editor: non-modal, anchored beside the tab. */
function editTabAppearance(id) {
  closeMenus();
  const pop = el('div', { class: 'builder-pop tab-appearance-pop', role: 'dialog', 'aria-label': t('tb.appearance.title') });
  const custom = STATE.custom[id] || {};
  const set = (patch) => {
    STATE.custom[id] = { ...custom, ...patch };
    save(); render();
    keepPopAnchored();
  };

  const colorIn = el('input', { type: 'text', class: 'mr-input mono', value: custom.color || '', spellcheck: 'false', 'aria-label': t('tb.appearance.color') });
  colorIn.addEventListener('change', () => set({ color: colorIn.value.trim() }));
  const fontSize = el('input', { type: 'number', min: '70', max: '160', value: String(custom.fontSize || 100), class: 'mr-input', 'aria-label': t('tb.appearance.fontSize') });
  fontSize.addEventListener('change', () => set({ fontSize: Number(fontSize.value) || 100 }));
  const weightSel = el('select', { class: 'mr-select', 'aria-label': t('tb.appearance.weight') },
    [300, 400, 500, 600, 700].map((w) => el('option', { value: String(w), selected: (custom.weight || 400) === w ? '' : null, text: String(w) })));
  weightSel.addEventListener('change', () => set({ weight: Number(weightSel.value) }));
  const italic = el('input', { type: 'checkbox' }); italic.checked = !!custom.italic;
  italic.addEventListener('change', () => set({ italic: italic.checked }));
  const underline = el('input', { type: 'checkbox' }); underline.checked = !!custom.underline;
  underline.addEventListener('change', () => set({ underline: underline.checked }));
  const strike = el('input', { type: 'checkbox' }); strike.checked = !!custom.strike;
  strike.addEventListener('change', () => set({ strike: strike.checked }));
  const iconIn = el('input', { type: 'text', maxlength: '4', value: custom.icon || '', class: 'mr-input', 'aria-label': t('tb.appearance.icon') });
  iconIn.addEventListener('change', () => set({ icon: iconIn.value.slice(0, 4) }));
  const radius = el('input', { type: 'number', min: '0', max: '999', value: String(custom.radius ?? 8), class: 'mr-input', 'aria-label': t('tb.appearance.radius') });
  radius.addEventListener('change', () => set({ radius: Number(radius.value) || 0 }));

  const row = (labelText, ctrl) => el('label', { class: 'setting-label' }, [document.createTextNode(labelText), ctrl]);
  pop.append(
    el('h3', { class: 'modal-title', text: t('tb.appearance.title') }),
    row(t('tb.appearance.color'), colorIn),
    row(t('tb.appearance.fontSize'), fontSize),
    row(t('tb.appearance.weight'), weightSel),
    el('div', { class: 'checkrow' },
      [el('label', {}, [italic, document.createTextNode(` ${t('tb.appearance.italic')}`)]),
        el('label', {}, [underline, document.createTextNode(` ${t('tb.appearance.underline')}`)]),
        el('label', {}, [strike, document.createTextNode(` ${t('tb.appearance.strike')}`)])]),
    row(t('tb.appearance.icon'), iconIn),
    row(t('tb.appearance.radius'), radius),
  );

  const resetB = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('tb.appearance.reset') });
  resetB.addEventListener('click', () => {
    delete STATE.custom[id];
    save(); render(); close();
  });
  const closeB = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: '✕', 'aria-label': t('dlg.cancel') });
  closeB.addEventListener('click', () => close());
  pop.append(el('div', { class: 'builder-actions' }, [resetB, closeB]));

  const tabNode = stripEl.querySelector(`a.tab[data-tab-id="${CSS.escape(id)}"]`);
  document.body.append(pop);
  pop.style.position = 'fixed';
  function keepPopAnchored() {
    if (!pop.isConnected) return;
    const target = stripEl.querySelector(`a.tab[data-tab-id="${CSS.escape(id)}"]`) || tabNode;
    if (!target) return;
    const r = target.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let x = r.right + 8;
    if (x + pr.width > window.innerWidth - 8) x = Math.max(8, r.left - pr.width - 8);
    let y = clamp(r.top, 8, window.innerHeight - pr.height - 8);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  }
  keepPopAnchored();
  const escHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', escHandler);
  function close() {
    pop.remove();
    document.removeEventListener('keydown', escHandler);
    const back = stripEl.querySelector(`a.tab[data-tab-id="${CSS.escape(id)}"]`);
    if (back) back.focus();
  }
  colorIn.focus();
}

/* Dock switcher rendered into the settings page / palette host. */
export function buildDockSwitcher(mount) {
  const sel = el('select', { class: 'mr-select', 'aria-label': t('tb.dock') },
    ['left', 'right', 'top', 'bottom'].map((d) => el('option', { value: d, selected: STATE.dock === d ? '' : null, text: t(`tb.dock.${d}`) })));
  sel.addEventListener('change', () => {
    STATE.dock = sel.value;
    save(); render();
  });
  mount.append(sel);
}

/* Group manager used by the settings page. */
export function buildGroupManager(mount) {
  mount.textContent = '';
  const newBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('tb.newGroup') });
  newBtn.addEventListener('click', () => {
    const name = window.prompt(t('tb.groupName'), '');
    if (name && name.trim()) {
      STATE.groups.push({ id: uid('grp'), name: name.trim().slice(0, 40), color: '#6750a4', collapsed: false });
      save(); render(); buildGroupManager(mount);
    }
  });
  mount.append(newBtn);
  if (!STATE.groups.length) mount.append(el('p', { class: 'empty-state', text: t('tb.noGroups') }));
  for (const g of STATE.groups) {
    const count = Object.values(STATE.membership).filter((m) => m === g.id).length;
    const rm = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('tb.close') });
    rm.addEventListener('click', () => {
      STATE.groups = STATE.groups.filter((x) => x.id !== g.id);
      for (const k of Object.keys(STATE.membership)) {
        if (STATE.membership[k] === g.id) STATE.membership[k] = '';
      }
      save(); render(); buildGroupManager(mount);
    });
    mount.append(el('div', { class: 'centre-row' }, [
      el('span', { class: 'swatch', style: `background:${g.color || 'var(--md-sys-color-primary)'}`, 'aria-hidden': 'true' }),
      el('span', { text: `${g.name} (${count})` }),
      rm,
    ]));
  }
}
