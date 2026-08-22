// Purpose: Server & Logs tab - PLACEHOLDER (the server itself already runs in
// the main process; this surface will expose its controls and log stream).
// Owned by Server lane - replace contents freely; keep the registerTab call
// and the exported tab id ('server') stable.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke } from '../../core/bridge.js';

function render(container) {
  const statusLine = h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, '');
  invoke('server:get-status').then((s) => {
    statusLine.textContent = s.running
      ? `${t('server.statusRunning')} · ${s.host}:${s.port}`
      : t('server.statusStopped');
  }).catch(() => {});

  container.append(
    h('div', { class: 'mr-placeholder' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.server')),
      statusLine,
      h('p', { class: 'mr-typography-body-medium' }, t('placeholder.generic')),
      h('div', { class: 'lane-note' }, t('placeholder.laneServer')),
    ),
  );
}

registerTab({
  id: 'server',
  label: { en: 'Server & Logs', zh: '伺服器同日誌' },
  get icon() { return iconFromPath('M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 9h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Zm2 2v3h2v-3H6Zm10.5-9.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm0 9a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z'); },
  init: render,
});
