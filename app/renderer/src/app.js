// Purpose: renderer bootstrap. Init order matters: i18n bundles -> settings
// cache -> theme -> tab strip -> palette -> toasts/history drawers -> tabs.
// Owned by Foundation Core lane.

import { h, svgIcon, ICONS } from './core/util.js';
import { invoke, on } from './core/bridge.js';
import * as settings from './core/settings.js';
import * as i18n from './core/i18n.js';
import { en } from './i18n/core.en.js';
import { zh } from './i18n/core.zh.js';
import * as theme from './core/theme.js';
import * as tabStrip from './core/tabs.js';
import * as palette from './core/palette.js';
import * as toasts from './core/toasts.js';
import * as history from './core/history.js';
import { registerAboutSection } from './core/settings-ui.js';

// Tab modules register themselves on import. Import order = default strip order.
import './tabs/builder/builder.js';
import './tabs/providers/providers.js';
import './tabs/server/server.js';
import './tabs/docs/docs.js';
import './tabs/appearance/appearance.js';
import './tabs/delight/delight.js';
import './tabs/utility/utility.js';
import './tabs/authenticator/authenticator.js';
// Auto-update ready banner (integration edit: plumbing lane owns the module,
// this single import line is the one cross-lane wiring it could not make).
import './core/updater-banner.js';

void h;
void svgIcon;
void ICONS;

async function boot() {
  // 1) i18n bundles first so early renders translate.
  i18n.addBundle('core', { en, zh });
  settings.onChange(() => i18n.invalidateCache());

  // 2) settings cache before anything reads a setting.
  try {
    await settings.init();
  } catch (err) {
    console.error('[material-router] settings unavailable, using defaults:', err.message);
  }

  // 3) theme applies tokens + window background.
  theme.init();

  const appEl = document.getElementById('mr-app');

  // 4) titlebar with drag region + window controls + drawer buttons.
  buildTitlebar(appEl);

  // 5) command palette global shortcut + built-in items.
  palette.init();
  registerBuiltinPaletteItems();

  // 6) toasts + notification center wiring (live region included).
  toasts.init({
    onUnreadChange: (count) => updateBadge(count),
  });
  on('toast', (payload) => {
    if (payload && typeof payload === 'object') {
      toasts.toast(payload.title ?? '', payload.body ?? '', {
        kind: payload.kind ?? 'info',
        actions: Array.isArray(payload.actions) ? payload.actions : [],
      });
    }
  });

  // 7) server status events refresh nothing yet (Server lane owns the view)
  // but are consumed so the channel stays warm.
  on('server-status', () => {});
  on('log', () => {});

  // 8) About settings section, then the tab strip over all registered tabs.
  registerAboutSection();
  // Settings is itself a real tab; it registers last in the strip.
  const { TABS, registerTab } = await import('./tabs/registry.js');
  const { settingsTabDef } = await import('./core/settings-ui.js');
  if (!TABS.some((d) => d.id === 'settings')) {
    registerTab(settingsTabDef());
  }

  tabStrip.init({ defs: TABS, appEl });

  // 9) Apply the persisted language mode to <html lang> + shell chrome, then
  // keep applying it live whenever the mode changes (School mode forcing
  // English presentation re-applies too). Tab panels retranslate through
  // their own settings.onChange subscriptions.
  applyLanguageMode();
  settings.onChange((key) => {
    if (key === 'general.languageMode' || key === 'school.active') applyLanguageMode();
  });
}

/**
 * Live language application for everything the shell owns: the document lang
 * attribute, the frameless titlebar labels/aria, tab-strip labels, and the
 * builtin palette item titles (palette.register replaces entries by id).
 * Runs at boot and on every general.languageMode / school.active change.
 */
function applyLanguageMode() {
  document.documentElement.lang = i18n.documentLangTag();
  registerBuiltinPaletteItems();
  const appEl = document.getElementById('mr-app');
  if (appEl) buildTitlebar(appEl);
  updateBadge(toasts.unreadCount());
  tabStrip.refreshChrome();
}

function buildTitlebar(appEl) {
  // Idempotent: a language-mode change rebuilds the bar in place (grid-area
  // layout is position-independent, so re-appending is safe).
  appEl.querySelector(':scope > .mr-titlebar')?.remove();
  const logo = h('span', { class: 'mr-titlebar__logo', 'aria-hidden': 'true' },
    svgIcon(ICONS.route));
  const name = h('span', { class: 'mr-titlebar__name' }, 'Material Router');

  const notifBtn = h('button', {
    'aria-label': i18n.t('shell.notifications'),
    'data-tip': i18n.t('shell.notifications'),
    onclick: (e) => openDrawer('notifications', e.currentTarget),
  }, svgIcon(ICONS.bell), h('span', { class: 'badge', id: 'mr-notif-badge', hidden: true }, '0'));

  const historyBtn = h('button', {
    'aria-label': i18n.t('shell.history'),
    'data-tip': i18n.t('shell.history'),
    onclick: (e) => openDrawer('history', e.currentTarget),
  }, svgIcon(ICONS.history));

  const spacer = h('span', { class: 'mr-titlebar__spacer' });

  const minBtn = h('button', {
    class: '', 'aria-label': i18n.t('shell.minimize'),
    onclick: () => invoke('shell:window-control', { action: 'minimize' }),
  }, svgIcon(ICONS.minimize));
  const maxBtn = h('button', {
    'aria-label': i18n.t('shell.maximize'),
    onclick: () => invoke('shell:window-control', { action: 'maximize' }),
  }, svgIcon(ICONS.maximize));
  const closeBtn = h('button', {
    class: 'close',
    'aria-label': i18n.t('shell.closeWindow'),
    onclick: () => invoke('shell:window-control', { action: 'close' }),
  }, svgIcon(ICONS.close));

  const bar = h('header', { class: 'mr-titlebar' },
    logo, name,
    h('button', {
      style: 'width:auto;padding:0 10px;font-size:12px',
      'aria-label': i18n.t('shell.commandPalette'),
      onclick: () => palette.toggle(),
    }, `${i18n.t('palette.title')} ⌘`),
    spacer,
    notifBtn, historyBtn,
    minBtn, maxBtn, closeBtn,
  );
  appEl.append(bar);
}

let badgeCount = 0;
function updateBadge(count) {
  badgeCount = count;
  const badge = document.getElementById('mr-notif-badge');
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function openDrawer(kind, opener) {
  const scrim = h('div', { class: 'mr-drawer-scrim' });
  const head = h('div', { class: 'mr-drawer__head' });
  const body = h('div', { class: 'mr-drawer__body' });
  const foot = h('div', { class: 'mr-drawer__foot' });

  let footerActions = [];
  if (kind === 'notifications') {
    toasts.markAllRead();
    updateBadge(0);
    head.append(h('strong', {}, i18n.t('notif.searchPlaceholder').replace('…', '')));
    footerActions = toasts.renderNotificationCenter(body).footer;
  } else {
    head.append(h('strong', {}, i18n.t('history.panelTitle')));
    footerActions = history.renderHistoryPanel(body).footer;
  }
  foot.append(...footerActions);

  function closeDrawer() {
    drawer.remove();
    scrim.remove();
    document.removeEventListener('keydown', escHandler, true);
    opener?.focus?.();
  }
  function escHandler(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawer();
    }
  }

  const drawer = h('aside', {
    class: 'mr-drawer',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': kind === 'history' ? i18n.t('history.panelTitle') : i18n.t('shell.notifications'),
  },
    head,
    h('button', {
      style: 'position:absolute;top:8px;right:8px;border:none;background:transparent;cursor:pointer;color:var(--md-sys-color-on-surface-variant)',
      'aria-label': i18n.t('common.close'),
      onclick: closeDrawer,
    }, svgIcon(ICONS.close)),
    body, foot,
  );

  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', escHandler, true);
  document.body.append(scrim, drawer);
}

function registerBuiltinPaletteItems() {
  palette.register({
    id: 'theme.light',
    title: i18n.t('appearance.themeLight'),
    section: 'Appearance',
    run: () => theme.setTheme('light'),
  });
  palette.register({
    id: 'theme.dark',
    title: i18n.t('appearance.themeDark'),
    section: 'Appearance',
    run: () => theme.setTheme('dark'),
  });
  palette.register({
    id: 'theme.system',
    title: i18n.t('appearance.themeSystem'),
    section: 'Appearance',
    control: (holder) => {
      const select = h('select', { class: 'm3-select', 'aria-label': i18n.t('settings.title') },
        h('option', { value: 'system' }, i18n.t('appearance.themeSystem')),
        h('option', { value: 'light' }, i18n.t('appearance.themeLight')),
        h('option', { value: 'dark' }, i18n.t('appearance.themeDark')),
      );
      select.value = theme.currentMode();
      select.addEventListener('change', () => theme.setTheme(select.value));
      holder.append(select);
    },
    run: () => theme.setTheme('system'),
  });
  palette.register({
    id: 'language.en',
    title: i18n.t('language.modeEn'),
    section: 'Settings',
    run: () => settings.set('general.languageMode', 'en'),
  });
  palette.register({
    id: 'language.zh',
    title: i18n.t('language.modeZh'),
    section: 'Settings',
    run: () => settings.set('general.languageMode', 'zh'),
  });
  palette.register({
    id: 'language.bilingual',
    title: i18n.t('language.modeBilingual'),
    section: 'Settings',
    run: () => settings.set('general.languageMode', 'bilingual'),
  });
  palette.register({
    id: 'server.start',
    title: i18n.t('actions.serverStart'),
    section: 'Actions',
    run: () => invoke('server:start').then(() =>
      toasts.toast(i18n.t('actions.serverStart'), '', { kind: 'success' })),
  });
  palette.register({
    id: 'server.stop',
    title: i18n.t('actions.serverStop'),
    section: 'Actions',
    run: () => invoke('server:stop').then(() =>
      toasts.toast(i18n.t('actions.serverStop'), '', { kind: 'info' })),
  });
}

boot().catch((err) => {
  console.error('[material-router] boot failed:', err);
  document.body.textContent = `Boot failed: ${err.message}`;
});
