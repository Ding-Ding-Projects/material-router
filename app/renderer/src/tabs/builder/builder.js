// Purpose: API Builder tab - PLACEHOLDER.
// Owned by Builder lane - replace contents freely; keep the registerTab call
// and the exported tab id ('builder') stable so the registry stays valid.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';

function render(container) {
  container.append(
    h('div', { class: 'mr-placeholder' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.builder')),
      h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('placeholder.generic')),
      h('div', { class: 'lane-note' }, t('placeholder.laneBuilder')),
    ),
  );
}

registerTab({
  id: 'builder',
  label: { en: 'API Builder', zh: 'API 建造器' },
  get icon() { return iconFromPath('M11 3h2v6h-2V3Zm-8 9h18v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7Zm2 2v4h14v-4H5Zm5 2h4v1h-4v-1ZM4 5a1 1 0 0 1 1-1h3v2H6v2H4V5Zm16 0v3h-2V6h-2V4h3a1 1 0 0 1 1 1Z'); },
  init: render,
});
