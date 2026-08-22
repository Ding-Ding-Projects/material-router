/* Command palette: Ctrl+Shift+F everywhere. Rows cover every page, every
   article section, every site setting, and commands. Setting rows carry
   their live control inline (rich rows), and selecting any result teleports
   to the exact element: right page, right section, focused and highlighted.
   Bounded card by default; full-window is a persisted choice. */

import { el, clamp, storage, flashElement } from './util.js';
import { PAGES } from './pages-data.js';
import { t } from './i18n.js';
import { getSettings, updateSettings } from './store.js';
import { matchText } from './regex-core.js';

export function registerPaletteBundle(addBundle) {
  addBundle('palette', {
    en: {
      'pl.title': 'Command palette',
      'pl.open': 'Open command palette',
      'pl.hint': 'Type to search commands, pages, sections and settings. Ctrl+Shift+F opens this anywhere.',
      'pl.fullWindow': 'Full window',
      'pl.noResults': 'Nothing matches. Try fewer words, or switch the field to regex mode.',
      'pl.section': 'Section',
      'pl.setting': 'Setting',
      'pl.command': 'Command',
      'pl.page': 'Page',
    },
    zh: {
      'pl.title': '指令面板',
      'pl.open': '開啟指令面板',
      'pl.hint': '打字搜尋指令、頁面、段落同設定。任何地方都㩒得 Ctrl+Shift+F 開。',
      'pl.fullWindow': '全視窗',
      'pl.noResults': '搵唔到。試少幾隻字，或者將搜尋欄轉做正則模式。',
      'pl.section': '段落',
      'pl.setting': '設定',
      'pl.command': '指令',
      'pl.page': '頁面',
    },
  });
}

let paletteNode = null;
let lastFocus = null;

function buildItems() {
  const s = getSettings();
  const items = [];
  for (const p of PAGES) {
    items.push({
      kind: 'page',
      id: `page-${p.id}`,
      label: t(p.labelKey),
      labelZh: p.labelZh,
      href: p.href,
      keywords: p.labelKey,
    });
  }
  // every article section (h2 ids) on the current page + all article pages
  document.querySelectorAll('main section[id], main h2[id]').forEach((sec) => {
    const heading = sec.querySelector('h2') || sec;
    items.push({
      kind: 'section',
      id: `sec-${sec.id}`,
      label: heading.textContent.trim().slice(0, 80),
      href: `${location.pathname.split('/').pop() || 'index.html'}#${sec.id}`,
      anchor: sec.id,
      keywords: 'section',
    });
  });
  // site settings as rich rows
  items.push(
    {
      kind: 'setting', id: 'set-language', label: t('set.language'), keywords: 'language 中文 english bilingual',
      control: () => {
        const sel = el('select', { class: 'mr-select pl-inline', 'aria-label': t('set.language') });
        for (const v of ['en', 'zh', 'bi']) sel.append(el('option', { value: v, selected: s.language === v ? '' : null, text: t(`set.lang.${v}`) }));
        sel.addEventListener('click', (e) => e.stopPropagation());
        sel.addEventListener('change', () => { updateSettings({ language: sel.value }); rerenderRows(); });
        return sel;
      },
      href: 'settings.html#language',
    },
    {
      kind: 'setting', id: 'set-funny-en', label: t('set.funnyEn'), keywords: 'funny english humor level',
      control: () => sliderRow('funnyEn', s.funnyEn),
      href: 'settings.html#tone',
    },
    {
      kind: 'setting', id: 'set-funny-zh', label: t('set.funnyZh'), keywords: 'funny chinese cantonese humor level',
      control: () => sliderRow('funnyZh', s.funnyZh),
      href: 'settings.html#tone',
    },
    {
      kind: 'setting', id: 'set-emoji', label: t('set.emoji'), keywords: 'emoji dialogs toggle',
      control: () => switchRow('emojiOn', s.emojiOn),
      href: 'settings.html#tone',
    },
    {
      kind: 'setting', id: 'set-theme', label: t('set.theme'), keywords: 'theme dark light system',
      control: () => {
        const sel = el('select', { class: 'mr-select pl-inline', 'aria-label': t('set.theme') });
        for (const v of ['system', 'light', 'dark']) sel.append(el('option', { value: v, selected: s.appearance.theme === v ? '' : null, text: t(`ap.theme.${v}`) }));
        sel.addEventListener('click', (e) => e.stopPropagation());
        sel.addEventListener('change', () => { updateSettings({ appearance: { theme: sel.value } }); });
        return sel;
      },
      href: 'settings.html#appearance',
    },
    {
      kind: 'setting', id: 'set-school', label: t('set.school'), keywords: 'school mode suppression',
      control: () => switchRow('schoolMode', s.schoolMode),
      href: 'settings.html#modes',
    },
  );
  items.push(
    { kind: 'command', id: 'cmd-notifications', label: t('toast.center'), keywords: 'notifications bell', run: () => document.getElementById('notif-bell')?.click() },
    { kind: 'command', id: 'cmd-export-settings', label: t('set.export'), keywords: 'export settings json', run: () => { location.href = 'settings.html#data'; setTimeout(() => document.getElementById('btn-export-settings')?.click(), 400); } },
    { kind: 'command', id: 'cmd-dock', label: t('tb.dock'), keywords: 'dock tab strip position', run: () => { location.href = 'settings.html#tabs'; } },
  );
  return items;
}

function sliderRow(key, value) {
  const range = el('input', { type: 'range', min: '1', max: '5', step: '1', value: String(value), class: 'pl-inline', 'aria-label': t(key === 'funnyEn' ? 'set.funnyEn' : 'set.funnyZh') });
  range.addEventListener('click', (e) => e.stopPropagation());
  range.addEventListener('input', () => updateSettings({ [key]: Number(range.value) }));
  return range;
}
function switchRow(key, value) {
  const sw = el('input', { type: 'checkbox', class: 'mr-switch pl-inline', role: 'switch' });
  sw.checked = !!value;
  sw.setAttribute('aria-label', t(key === 'emojiOn' ? 'set.emoji' : 'set.school'));
  sw.addEventListener('click', (e) => e.stopPropagation());
  sw.addEventListener('change', () => updateSettings({ [key]: sw.checked }));
  return sw;
}

export function initPalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openPalette();
    }
  });
  const btn = document.getElementById('palette-open');
  if (btn) btn.addEventListener('click', openPalette);
}

function openPalette() {
  if (paletteNode) { closePalette(); return; }
  lastFocus = document.activeElement;
  const full = storage.get('palette-full-window', false);
  paletteNode = el('div', { class: 'modal-scrim palette-scrim' });
  const panel = el('div', { class: `palette-panel ${full ? 'is-full' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('pl.title') });
  panel.append(el('h2', { class: 'visually-hidden', text: t('pl.title') }));

  const searchMount = el('div', { class: 'palette-search' });
  panel.append(searchMount);

  const fullToggle = el('button', {
    type: 'button', class: 'mr-btn mr-btn--text', 'aria-pressed': String(full),
    text: t('pl.fullWindow'),
  });
  fullToggle.addEventListener('click', () => {
    const next = !storage.get('palette-full-window', false);
    storage.set('palette-full-window', next);
    panel.classList.toggle('is-full', next);
    fullToggle.setAttribute('aria-pressed', String(next));
  });

  const list = el('ul', { class: 'palette-list', role: 'listbox', 'aria-label': t('pl.title') });
  const hint = el('p', { class: 'palette-hint', text: t('pl.hint') });
  panel.append(list, el('div', { class: 'palette-foot' }, [hint, fullToggle]));
  paletteNode.append(panel);
  document.body.append(paletteNode);

  const items = buildItems();
  const state = { mode: 'plain', pattern: '', flags: 'i' };
  import('./searchbar.js').then(({ createSearchBar }) => {
    createSearchBar(searchMount, {
      ariaLabel: t('pl.title'),
      onQuery(next) { Object.assign(state, next); rerenderRows(); },
    });
  });

  let activeIdx = 0;

  function rerenderRows() {
    list.textContent = '';
    const q = state.pattern.trim();
    let rows = items;
    if (q) {
      rows = [];
      for (const item of items) {
        const hay = `${item.label}\n${item.labelZh || ''}\n${item.kind}`;
        const res = matchText(hay, state);
        if (res.error) continue;
        if (res.matches.length) rows.push(item);
      }
    }
    if (!rows.length) {
      list.append(el('li', { class: 'palette-empty', role: 'option', 'aria-selected': 'false', text: t('pl.noResults') }));
      return;
    }
    rows.slice(0, 60).forEach((item, idx) => {
      const li = el('li', { class: 'palette-row', role: 'option', 'aria-selected': idx === activeIdx ? 'true' : 'false', dataset: { idx: String(idx) } });
      li.append(
        el('span', { class: `palette-kind kind-${item.kind}`, text: t(`pl.${item.kind === 'section' ? 'section' : item.kind}`) }),
        el('span', { class: 'palette-label', text: item.label }),
        item.labelZh && getSettings().language !== 'en' ? el('span', { class: 'palette-sub', text: item.labelZh }) : null,
      );
      if (item.control) li.append(item.control());
      li.addEventListener('click', () => choose(item));
      li.addEventListener('pointermove', () => setActive(idx));
      list.append(li);
    });
    activeIdx = clamp(activeIdx, 0, rows.length - 1);
  }

  function setActive(idx) {
    activeIdx = idx;
    Array.from(list.querySelectorAll('.palette-row')).forEach((n, i) => {
      n.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      if (i === idx) n.scrollIntoView({ block: 'nearest' });
    });
  }

  function choose(item) {
    closePalette();
    if (item.run) { item.run(); return; }
    const [href, hash] = item.href.split('#');
    const here = location.pathname.split('/').pop() || 'index.html';
    if (href === here) {
      if (hash) {
        const target = document.getElementById(hash);
        if (target) { flashElement(target); return; }
      }
      if (item.anchor) {
        const target = document.getElementById(item.anchor);
        if (target) { flashElement(target); return; }
      }
      return;
    }
    location.href = hash ? `${href}#${hash}` : href;
  }

  list.addEventListener('keydown', (e) => {
    const rows = Array.from(list.querySelectorAll('.palette-row'));
    if (!rows.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, rows.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = rows[activeIdx];
      if (item) item.click();
    }
  });

  rerenderRows();
  const firstInput = searchMount.querySelector('input');
  if (firstInput) firstInput.focus();
  paletteNode.addEventListener('pointerdown', (e) => { if (e.target === paletteNode) closePalette(); });
}

function closePalette() {
  if (paletteNode) paletteNode.remove();
  paletteNode = null;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
