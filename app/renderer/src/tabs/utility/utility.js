// Purpose: Toolbox tab - PLACEHOLDER (file converter, bulk tools and the
// extended docs browser live here).
// Owned by Utility lane - replace contents freely; keep the registerTab call
// and the exported tab id ('utility') stable.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';

function render(container) {
  container.append(
    h('div', { class: 'mr-placeholder' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.utility')),
      h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('placeholder.generic')),
      h('div', { class: 'lane-note' }, t('placeholder.laneUtility')),
    ),
  );
}

registerTab({
  id: 'utility',
  label: { en: 'Toolbox', zh: '工具箱' },
  get icon() { return iconFromPath('M22 13h-8v-2h8v2Zm0-6h-8v2h8V7Zm-8 10h8v-2h-8v2Zm-2-8H2v8h10v-8ZM9 15H5v-4h4v4Z'); },
  init: render,
});
