// Purpose: language modes completion - the persisted English / Cantonese-HK /
// Bilingual picker, both per-language funny-level sliders (1-5, default 5),
// and the Show-emojis-in-dialogs toggle. Includes the honest disclosure that
// tone levels style every category of message including errors and warnings.
// Under School mode these controls are ABSENT (not disabled-with-message).
// Owned by Delight lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import * as settings from '../../core/settings.js';
import { record as historyRecord } from '../../core/history.js';
import { dc, schoolActive, schoolLabel } from './common.js';

/**
 * Render the controls into `container`. Re-renders itself when settings or
 * School mode change. Returns nothing.
 */
export function renderModesSection(container) {
  let unsub = [];
  const render = () => {
    unsub.forEach((u) => u());
    unsub = [];
    container.replaceChildren();

    if (schoolActive()) {
      // Absent entirely: School mode hides Cantonese/bilingual options and
      // both funny sliders outright. No message replaces them.
      return;
    }

    const card = h('div', { class: 'm3-card m3-card--outlined' });
    card.append(h('h2', { class: 'm3-card__title' }, dc('dl.modes.title')));
    card.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant);margin-top:0' }, dc('dl.modes.desc')));

    // Language mode ---------------------------------------------------------
    const mode = String(settings.get('general.languageMode', 'en'));
    const select = h('select', {
      class: 'm3-select',
      'aria-label': t('dl.modes.languageLabel'),
      onchange: async (e) => {
        await settings.set('general.languageMode', e.target.value);
        historyRecord('settings changed', t('dl.modes.languageLabel'), e.target.value);
      },
    },
      h('option', { value: 'en', selected: mode === 'en' ? true : null }, t('dl.modes.langEn')),
      h('option', { value: 'zh', selected: mode === 'zh' ? true : null }, t('dl.modes.langZh')),
      h('option', { value: 'bilingual', selected: mode === 'bilingual' ? true : null }, t('dl.modes.langBilingual')),
    );
    card.append(h('div', { class: 'm3-select', style: 'max-width:280px;margin-bottom:12px' },
      h('label', { for: null }), select));
    select.id = 'mr-modes-language';

    // Funny sliders ------------------------------------------------------------
    function sliderRow({ key, label }) {
      const val = Number(settings.get(key, 5));
      const out = h('output', {
        class: 'mr-typography-label-large',
        style: 'min-width:32px;text-align:right',
        for: null,
      }, String(val));
      const input = h('input', {
        type: 'range',
        class: 'm3-slider',
        min: '1',
        max: '5',
        step: '1',
        value: String(val),
        id: `mr-slider-${key.replace(/\./g, '-')}`,
        'aria-valuetext': `${val} / 5`,
        onchange: async (e) => {
          const v = Math.min(5, Math.max(1, Number(e.target.value)));
          e.target.setAttribute('aria-valuetext', `${v} / 5`);
          out.textContent = String(v);
          await settings.set(key, v);
          historyRecord('settings changed', label(), String(v));
        },
        oninput: (e) => {
          const v = e.target.value;
          out.textContent = v;
          e.target.setAttribute('aria-valuetext', `${v} / 5`);
        },
      });
      const row = h('div', { class: 'mr-col', style: 'gap:2px;margin-bottom:10px;max-width:420px' },
        h('div', { class: 'mr-row', style: 'justify-content:space-between' },
          h('label', { for: input.id, class: 'mr-typography-body-medium' }, label()), out),
        input,
      );
      return row;
    }
    card.append(
      sliderRow({ key: 'general.funnyLevelEn', label: () => t('dl.modes.funnyEn') }),
      sliderRow({ key: 'general.funnyLevelZh', label: () => t('dl.modes.funnyZh') }),
    );

    // Emoji toggle -----------------------------------------------------------------
    const emojiOn = Boolean(settings.get('general.emojiInDialogs', false));
    const emojiInput = h('input', {
      type: 'checkbox',
      checked: emojiOn ? true : null,
      id: 'mr-modes-emoji',
      'aria-describedby': 'mr-modes-emoji-desc',
      onchange: async (e) => {
        await settings.set('general.emojiInDialogs', Boolean(e.target.checked));
        historyRecord('settings changed', t('dl.modes.emojiToggle'), String(Boolean(e.target.checked)));
      },
    });
    card.append(h('div', { class: 'm3-switch' },
      emojiInput,
      h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'thumb' })),
      h('label', { class: 'label-text', for: 'mr-modes-emoji' }, t('dl.modes.emojiToggle')),
    ));
    card.append(h('p', {
      id: 'mr-modes-emoji-desc',
      class: 'mr-typography-body-small',
      style: 'color:var(--md-sys-color-on-surface-variant);margin:4px 0 12px',
    }, dc('dl.modes.emojiDesc')));

    // Disclosure ----------------------------------------------------------------------
    card.append(h('details', { class: 'mr-disclosure' },
      h('summary', {}, t('common.moreInfo')),
      h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, dc('dl.modes.disclosure')),
    ));

    container.append(card);

    // Live re-render on relevant changes (School mode toggling hides/shows all of it).
    unsub.push(settings.onChange((key) => {
      if (key.startsWith('school.') || key.startsWith('general.')) render();
    }));
  };
  render();
}

/** Settings-tab section registration (searchable + teleport targets). */
export function registerModesSettingsSection(registerSettingsSection) {
  let anchorEl = null;
  registerSettingsSection({
    id: 'modes-language',
    label: { en: 'Language & tone', zh: '語言同語氣' },
    render(container) {
      container.id = 'mr-setsec-host-modes';
      renderModesSection(container);
      anchorEl = container.querySelector('.m3-card');
    },
    entries: [
      { label: { en: 'Language mode (English / Cantonese / bilingual)', zh: '語言模式（英文／廣東話／雙語）' }, keywords: ['language', 'english', 'cantonese', 'bilingual', '語言'], resolve: () => anchorEl ?? document.getElementById('mr-modes-language') },
      { label: { en: 'English playfulness level', zh: '英文趣味程度' }, keywords: ['funny', 'tone', 'playful', 'level'], resolve: () => document.getElementById('mr-slider-general-funnyLevelEn') },
      { label: { en: 'Chinese playfulness level', zh: '中文趣味程度' }, keywords: ['funny', 'tone', 'playful', 'level'], resolve: () => document.getElementById('mr-slider-general-funnyLevelZh') },
      { label: { en: 'Emojis in dialogs toggle', zh: '對話框顯示 emoji 開關' }, keywords: ['emoji', 'dialog', 'message'], resolve: () => document.getElementById('mr-modes-emoji') },
    ],
  });
  void schoolLabel;
}
