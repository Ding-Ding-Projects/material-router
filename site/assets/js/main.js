/* Site boot: registers every bundle, applies settings, builds the chrome
   (tabs, palette, notification centre), runs the dim-sum draw once per load,
   and dispatches page-specific initialisers. */

import { registerContentBundles } from './content-i18n.js';
import { addBundle, applyDom } from './i18n.js';
import { getSettings, onSettings } from './store.js';
import { registerSearchBundle } from './searchbar.js';
import { registerRegexBundle } from './regex-builder.js';
import { registerDialogBundle } from './dialogs.js';
import { registerToastBundle, initNotificationCenter } from './toasts.js';
import { registerTabsBundle, initTabs } from './tabs.js';
import { registerPaletteBundle, initPalette } from './palette.js';
import { initAppearance } from './appearance.js';
import { registerColorBundle } from './color-picker.js';
import { registerLockBundle } from './locks.js';
import { registerLadderBundle } from './ladder.js';
import { registerScheduleBundle } from './schedule.js';
import { registerHistoryBundle, initHistoryBridge } from './history.js';
import { registerDimsumBundle, maybeShowSurprise } from './dimsum.js';
import { registerSupportBundle } from './support-tickets.js';
import { registerDownloadsBundle } from './downloads.js';
import { registerChangelogBundle } from './changelog.js';
import { registerAdhdBundle, initFocusAids } from './adhd.js';

function registerAll() {
  registerContentBundles();
  registerSearchBundle(addBundle);
  registerRegexBundle(addBundle);
  registerDialogBundle(addBundle);
  registerToastBundle(addBundle);
  registerTabsBundle(addBundle);
  registerPaletteBundle(addBundle);
  registerColorBundle(addBundle);
  registerLockBundle(addBundle);
  registerLadderBundle(addBundle);
  registerScheduleBundle(addBundle);
  registerHistoryBundle(addBundle);
  registerDimsumBundle(addBundle);
  registerSupportBundle(addBundle);
  registerDownloadsBundle(addBundle);
  registerChangelogBundle(addBundle);
  registerAdhdBundle(addBundle);
}

function bootChrome() {
  applyDom();
  initAppearance();
  initTabs();
  initNotificationCenter();
  initPalette();
  initHistoryBridge();
  initFocusAids();

  // language / tone changes re-render static copy and the tab strip labels
  onSettings(() => {
    applyDom();
    import('./tabs.js').then((m) => m.initTabs()).catch(() => { /* strip already present */ });
  });

  const yearEl = document.getElementById('footer-year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
}

function bootPage() {
  const page = document.body.dataset.page || '';
  const mount = (id) => document.getElementById(id);

  if (page === 'home' && mount('downloads-mount')) {
    import('./downloads.js').then(async (m) => {
      await m.initDownloads(mount('downloads-mount'));
      applyDom();
    });
  }
  if (page === 'changelog' && mount('changelog-mount')) {
    import('./changelog.js').then(async (m) => {
      await m.initChangelog(mount('changelog-mount'));
      applyDom();
    });
  }
  if (page === 'settings') {
    import('./settings-page.js').then(() => {
      // settings-page wires itself on import via DOMContentLoaded-safe init
      window.dispatchEvent(new Event('mr-settings-ready'));
    });
  }
  if (page === 'docs') {
    import('./docs-page.js').then(() => window.dispatchEvent(new Event('mr-docs-ready')));
  }
}

registerAll();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bootChrome();
    bootPage();
    maybeShowSurprise();
  });
} else {
  bootChrome();
  bootPage();
  maybeShowSurprise();
}

export function currentSettingsSnapshot() {
  return getSettings();
}
