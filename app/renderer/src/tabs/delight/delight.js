// Purpose: Modes & Delights tab - PLACEHOLDER (School mode gate, element toy
// locks + unlock ladder, super-confirmation upgrade, emoji toggle live here;
// hooks already exist in i18n.js / dialogs.js / tabs context menus).
// Owned by Delight lane - replace contents freely; keep the registerTab call
// and the exported tab id ('delight') stable.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';

function render(container) {
  container.append(
    h('div', { class: 'mr-placeholder' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.delight')),
      h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('placeholder.generic')),
      h('div', { class: 'lane-note' }, t('placeholder.laneDelight')),
    ),
  );
}

registerTab({
  id: 'delight',
  label: { en: 'Modes & Delights', zh: '模式與趣味' },
  get icon() { return iconFromPath('M12 2l1.9 5.7L19.6 9.6l-5.7 1.9L12 17.2l-1.9-5.7L4.4 9.6l5.7-1.9L12 2Zm6 13 .95 2.85 2.85.95-2.85.95L18 22.6l-.95-2.85-2.85-.95 2.85-.95L18 15Z'); },
  init: render,
});
