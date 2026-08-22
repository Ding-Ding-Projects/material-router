// Purpose: the Settings tab SHELL. Sections register through
// registerSettingsSection(); each section declares searchable entries so the
// global settings search can teleport to any setting. Foundation ships one
// About section; other lanes add their own sections without touching this file.
// Owned by Foundation Core lane.

import { h } from './util.js';
import { t, copy, languageMode, funnyLevel } from './i18n.js';
import * as settings from './settings.js';
import { createSearchBar, matchesQuery } from './searchbar.js';
import { teleport } from './palette.js';
import { invoke } from './bridge.js';

const state = {
  /** @type {Array<{id,label:{en,zh},render:Function,entries:Array}>} */
  sections: [],
  activeId: null,
};

/** Search-bar API of the currently mounted shell (for query re-adoption). */
let shellSearch = null;
/** Section host of the currently mounted shell (for scroll preservation). */
let shellSectionHost = null;
let languageUnsub = null;

/**
 * Register a settings section.
 * entries: [{label:{en,zh}|string, keywords:string[], resolve():HTMLElement|null}]
 */
export function registerSettingsSection(section) {
  if (!section?.id) throw new Error('settings section requires an id');
  const normalized = {
    id: String(section.id),
    label: section.label ?? { en: section.id, zh: section.id },
    render: typeof section.render === 'function' ? section.render : () => {},
    entries: Array.isArray(section.entries) ? section.entries : [],
  };
  const existing = state.sections.findIndex((s) => s.id === normalized.id);
  if (existing >= 0) state.sections[existing] = normalized;
  else state.sections.push(normalized);
}

function sectionLabel(s) {
  const mode = languageMode();
  if (mode === 'zh') return s.label.zh ?? s.label.en ?? s.id;
  return s.label.en ?? s.id;
}

/** Entry labels flattened for search. */
function entryText(entry) {
  const label = typeof entry.label === 'string' ? entry.label : `${entry.label?.en ?? ''} ${entry.label?.zh ?? ''}`;
  return `${label} ${(entry.keywords ?? []).join(' ')}`;
}

// -- The Settings tab definition (registered by tabs/registry consumers) -------

export function settingsTabDef() {
  return {
    id: 'settings',
    label: { en: 'Settings', zh: '設定' },
    iconPath: 'M19.14 12.94a7.07 7.07 0 0 0 .06-.94 7.07 7.07 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.62-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.68.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54a6.8 6.8 0 0 0 1.62-.94l2.39.96c.26.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z',
    init(container) {
      renderShell(container);
      ensureLanguagePass();
    },
  };
}

/**
 * Live retranslate for the Settings tab itself: sub-tab labels, search
 * placeholder, and the mounted section's content. Sections that carry their
 * own settings.onChange subscriptions re-render through those as well; this
 * pass covers the shell chrome and re-invokes the active section's render
 * function so nothing waits for a restart. Runs once per mount; the guard
 * keeps repeated tab visits from stacking listeners.
 */
function ensureLanguagePass() {
  if (languageUnsub) return;
  languageUnsub = settings.onChange((key) => {
    if (key !== 'general.languageMode' && key !== 'school.active') return;
    const panel = document.getElementById('mr-tab-panel-settings');
    if (!panel?.isConnected) return;
    const scroll = panel.scrollTop;
    const q = shellSearch?.get?.() ?? null;
    const hostScroll = shellSectionHost?.scrollTop ?? 0;
    renderShell(panel);
    if (q?.text) shellSearch.set(q.text);
    if (q?.mode === 'regex') shellSearch.setMode('regex');
    if (shellSectionHost) shellSectionHost.scrollTop = hostScroll;
    panel.scrollTop = scroll;
  });
}

function renderShell(container) {
  container.textContent = '';
  const shell = h('div', { class: 'mr-settings-shell' });

  // Global search across every registered section's declared entries.
  const resultsEl = h('div', {});
  const search = createSearchBar({
    placeholder: copy('settings.searchPlaceholder'),
    label: copy('settings.searchPlaceholder'),
    onQuery: (q) => renderResults(resultsEl, q),
  });
  shellSearch = search;

  const subTabs = h('div', { class: 'm3-tabs', role: 'tablist', 'aria-label': t('settings.title') });
  for (const s of state.sections) {
    subTabs.append(h('button', {
      class: 'm3-tab',
      role: 'tab',
      id: `mr-setsec-${s.id}`,
      'aria-selected': String(state.activeId === s.id || (!state.activeId && s === state.sections[0])),
      onclick: () => showSection(s.id),
    }, sectionLabel(s)));
  }

  const sectionHost = h('div', { class: 'mr-grow', style: 'overflow-y:auto;min-height:0' });
  shellSectionHost = sectionHost;

  shell.append(search.el, subTabs, sectionHost, resultsEl);
  container.append(shell);

  showSection(state.activeId ?? state.sections[0]?.id);

  function showSection(id) {
    state.activeId = id;
    for (const btn of subTabs.querySelectorAll('[role=tab]')) {
      btn.setAttribute('aria-selected', String(btn.id === `mr-setsec-${id}`));
    }
    sectionHost.textContent = '';
    const section = state.sections.find((s) => s.id === id);
    if (!section) {
      sectionHost.append(h('p', {}, t('settings.noSections')));
      return;
    }
    try {
      section.render(sectionHost);
    } catch (err) {
      sectionHost.append(h('p', { style: 'color:var(--md-sys-color-error)' },
        `${t('common.errorTitle')}: ${err.message}`));
    }
  }

  function renderResults(host, q) {
    host.textContent = '';
    if (!q?.text && q?.mode !== 'regex') return;
    const rows = [];
    for (const s of state.sections) {
      for (const entry of s.entries) {
        if (matchesQuery(q, entryText(entry))) rows.push({ s, entry });
      }
    }
    if (rows.length === 0) {
      host.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
        copy('palette.noResults')));
      return;
    }
    for (const { s, entry } of rows.slice(0, 30)) {
      const label = typeof entry.label === 'string' ? entry.label : entry.label.en ?? entry.label.zh ?? s.id;
      host.append(h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        onclick: () => {
          showSection(s.id);
          requestAnimationFrame(() => {
            const el = entry.resolve?.();
            if (el) teleport(el);
          });
        },
      }, `${sectionLabel(s)} › ${label}`));
    }
  }
}

// -- Foundation's own About section -----------------------------------------------

export function registerAboutSection() {
  let versionEl = null;
  registerSettingsSection({
    id: 'about',
    label: { en: 'About', zh: '關於' },
    render(container) {
      container.textContent = '';
      invoke('shell:app-info').then((info) => {
        versionEl.textContent = info.version;
        void info;
      }).catch(() => {});

      const card = h('div', { class: 'm3-card m3-card--outlined' },
        h('h2', { class: 'm3-card__title' }, 'Material Router'),
        h('p', { class: 'mr-row' },
          h('span', {}, `${copy('about.version')}: `),
          h('strong', {}, ''),
        ),
        h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
          copy('about.pitch')),
        h('div', { class: 'mr-col', style: 'margin-top:12px' },
          h('a', { href: '#', onclick: openExternal('https://github.com/Ding-Ding-Projects/material-router') }, copy('about.repo')),
          h('span', {}, copy('about.license')),
        ),
        h('p', { class: 'mr-typography-label-medium', style: 'margin-top:16px;color:var(--md-sys-color-on-surface-variant)' },
          copy('about.thirdPartyNote')),
      );
      versionEl = card.querySelector('strong');
      void funnyLevel;
      container.append(card);
    },
    entries: [
      { label: { en: 'App version', zh: '應用程式版本' }, keywords: ['version', 'about'], resolve: () => versionEl },
      { label: { en: 'Repository link', zh: '儲存庫連結' }, keywords: ['github', 'source'], resolve: () => null },
    ],
  });
}

function openExternal(url) {
  return (e) => {
    e.preventDefault();
    invoke('shell:open-external', { url }).catch(() => {});
  };
}
