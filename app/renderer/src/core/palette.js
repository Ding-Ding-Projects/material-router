// Purpose: command palette (Ctrl+Shift+F) over registered items with fuzzy
// filtering, rich inline row controls wired to their origin handlers, section
// grouping, bounded-card/full-window toggle, and teleport-to-element.
// Owned by Foundation Core lane.

import { h, svgIcon, ICONS, attachRipple } from './util.js';
import { t, copy } from './i18n.js';
import * as settings from './settings.js';
import { createSearchBar } from './searchbar.js';

export const SECTIONS = ['Tabs', 'Settings', 'Appearance', 'Docs', 'Actions'];

const state = {
  /** @type {Array<{id,title,keywords,section,run?,control?,target?}>} */
  items: [],
  open: false,
  full: false,
  scrimEl: null,
  listEl: null,
  search: null,
  focusedIdx: -1,
  visibleRows: [],
};

export function register(item) {
  const entry = {
    id: item.id,
    title: String(item.title ?? ''),
    keywords: Array.isArray(item.keywords) ? item.keywords.join(' ') : String(item.keywords ?? ''),
    section: SECTIONS.includes(item.section) ? item.section : 'Actions',
    run: typeof item.run === 'function' ? item.run : null,
    control: typeof item.control === 'function' ? item.control : null,
    target: item.target instanceof HTMLElement ? item.target : null,
  };
  const existing = state.items.findIndex((x) => x.id === entry.id);
  if (existing >= 0) state.items[existing] = entry;
  else state.items.push(entry);
}

/** Scroll an element into view, focus it, and ring-highlight for 1.2s. */
export function teleport(el) {
  if (!el || !el.isConnected) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
  el.classList.remove('mr-flash-highlight');
  // Force restart of the animation.
  void el.offsetWidth;
  el.classList.add('mr-flash-highlight');
  setTimeout(() => el.classList.remove('mr-flash-highlight'), 1300);
}

export function init() {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggle();
    }
  });
}

export function toggle() {
  if (state.open) close();
  else open();
}

export function isOpen() {
  return state.open;
}

export function open() {
  if (state.open) return;
  state.open = true;
  state.full = Boolean(settings.get('ui.paletteFull', false));
  build();
}

export function close() {
  if (!state.open) return;
  state.open = false;
  state.scrimEl?.remove();
  state.scrimEl = null;
}

function build() {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const sizeBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => {
      state.full = !state.full;
      settings.set('ui.paletteFull', state.full).catch(() => {});
      applySizeClass();
      renderList('');
    },
  }, () => {});

  function applySizeClass() {
    paletteEl.classList.toggle('mr-palette--full', state.full);
    sizeBtn.textContent = state.full ? t('palette.boundedView') : t('palette.fullWindow');
  }

  const listEl = h('div', { class: 'mr-palette__list', role: 'listbox', 'aria-label': t('palette.title') });
  state.listEl = listEl;

  state.search = createSearchBar({
    placeholder: t('palette.placeholder'),
    label: t('palette.title'),
    regexDefault: true,
    onQuery: () => renderList(state.search.get().text),
  });

  const hint = h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant);white-space:nowrap' },
    t('palette.hint'));

  const headRow = h('div', { class: 'mr-row', style: 'padding:12px 12px 4px' }, state.search.el, sizeBtn);
  const footerRow = h('div', { class: 'mr-row', style: 'padding:0 16px 10px' }, hint);

  const paletteEl = h('div', { class: 'mr-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('palette.title') },
    headRow,
    listEl,
    footerRow,
  );
  applySizeClass();

  const scrim = h('div', {
    class: 'mr-palette-scrim',
    onclick: (e) => { if (e.target === scrim) close(); },
  }, paletteEl);
  state.scrimEl = scrim;
  document.body.append(scrim);

  function onKeydown(e) {
    if (!state.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      opener?.focus?.();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateFocused(e.shiftKey);
    }
  }
  document.addEventListener('keydown', onKeydown, true);
  const observer = new MutationObserver(() => {
    if (!state.scrimEl) {
      document.removeEventListener('keydown', onKeydown, true);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  renderList('');
  queueMicrotask(() => state.search.focus());
}

function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const hay = `${text}`.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] === q[qi]) {
      streak += 1;
      score += 2 + streak + (i === 0 ? 3 : 0);
      qi += 1;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) {
    // Fall back to substring containment so typos still surface something.
    return hay.includes(q) ? 1 : 0;
  }
  return score / (q.length * 6);
}

function renderList(query) {
  const listEl = state.listEl;
  listEl.textContent = '';
  state.visibleRows = [];

  const scored = state.items
    .map((item) => ({ item, score: fuzzyScore(query, `${item.title} ${item.keywords} ${item.section}`) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const bySection = new Map();
  for (const { item } of scored) {
    if (!bySection.has(item.section)) bySection.set(item.section, []);
    bySection.get(item.section).push(item);
  }

  let any = false;
  state.focusedIdx = -1;
  for (const section of SECTIONS) {
    const rows = bySection.get(section);
    if (!rows?.length) continue;
    any = true;
    listEl.append(h('div', { class: 'mr-palette__section' }, sectionLabel(section)));
    for (const item of rows) {
      const row = makeRow(item);
      listEl.append(row);
      state.visibleRows.push(row);
    }
  }

  if (!any) {
    listEl.append(h('div', { class: 'mr-palette__empty' }, copy('palette.noResults')));
  }
  setRowFocus(0);
}

function sectionLabel(section) {
  try {
    return t(`palette.section.${section.toLowerCase()}`);
  } catch {
    return section;
  }
}

function makeRow(item) {
  const row = h('div', {
    class: 'mr-palette__row',
    role: 'option',
    tabindex: '-1',
    dataset: { itemId: item.id },
  });

  const main = h('button', {
    class: 'm3-btn m3-btn--text',
    style: 'flex:1;justify-content:flex-start;border-radius:var(--md-sys-shape-corner-sm)',
    onclick: () => {
      close();
      setTimeout(() => item.run?.(), 30);
    },
  }, item.title);
  attachRipple(main);
  row.append(main);

  if (item.control) {
    const holder = h('div', { class: 'mr-palette__control' });
    try {
      item.control(holder);
    } catch { /* a broken rich control never blocks its row's action */ }
    row.append(holder);
  }

  row.addEventListener('mousemove', () => {
    const idx = state.visibleRows.indexOf(row);
    if (idx >= 0) setRowFocus(idx, false);
  });
  row.addEventListener('click', (e) => {
    // Clicks that land on the rich control area are handled there.
    if (e.target.closest('.mr-palette__control')) return;
    close();
    setTimeout(() => item.run?.(), 30);
  });
  return row;
}

function moveFocus(delta) {
  if (state.visibleRows.length === 0) return;
  const next = Math.min(state.visibleRows.length - 1, Math.max(0, state.focusedIdx + delta));
  setRowFocus(next);
}

function setRowFocus(idx, scroll = true) {
  state.focusedIdx = idx;
  state.visibleRows.forEach((row, i) => row.classList.toggle('focused', i === idx));
  const row = state.visibleRows[idx];
  if (row && scroll) row.scrollIntoView({ block: 'nearest' });
}

function activateFocused() {
  const row = state.visibleRows[state.focusedIdx];
  if (!row) return;
  const item = state.items.find((x) => x.id === row.dataset.itemId);
  close();
  setTimeout(() => {
    if (item?.target?.isConnected) teleport(item.target);
    item?.run?.();
  }, 30);
}
