// Purpose: Providers & Keys tab - PLACEHOLDER (provider/rule CRUD and the
// encrypted vault already exist in the main process via IPC providers:* and
// vault:*; this surface hosts their GUI).
// Owned by Providers lane - replace contents freely; keep the registerTab
// call and the exported tab id ('providers') stable.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke } from '../../core/bridge.js';

function render(container) {
  const summary = h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, '');
  invoke('providers:list').then(({ providers, rules }) => {
    summary.textContent = `${providers.length} ${t('providers.countProviders')} · ${rules.length} ${t('providers.countRules')}`;
  }).catch(() => {});

  container.append(
    h('div', { class: 'mr-placeholder' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.providers')),
      summary,
      h('p', { class: 'mr-typography-body-medium' }, t('placeholder.generic')),
      h('div', { class: 'lane-note' }, t('placeholder.laneProviders')),
    ),
  );
}

registerTab({
  id: 'providers',
  label: { en: 'Providers & Keys', zh: '供應商同金鑰' },
  get icon() { return iconFromPath('M12.65 10A6 6 0 0 0 3 12a6 6 0 0 0 9.65 4.79L16 20h2v2h4v-4l-5.35-5.35A5.99 5.99 0 0 0 17 12a6 6 0 0 0-4.35-2ZM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z'); },
  init: render,
});
