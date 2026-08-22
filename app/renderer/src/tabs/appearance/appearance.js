// Purpose: Appearance tab - PLACEHOLDER (M3 tokens + theme switching already
// work; this surface hosts the per-element editors).
// Owned by Appearance lane - replace contents freely; keep the registerTab
// call and the exported tab id ('appearance') stable.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';

function render(container) {
  container.append(
    h('div', { class: 'mr-placeholder' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.appearance')),
      h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('placeholder.generic')),
      h('div', { class: 'lane-note' }, t('placeholder.laneAppearance')),
    ),
  );
}

registerTab({
  id: 'appearance',
  label: { en: 'Appearance', zh: '外觀' },
  get icon() { return iconFromPath('M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8Zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z'); },
  init: render,
});
