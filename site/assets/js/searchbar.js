/* Search bar component: every search field on this site is created through
   createSearchBar, so every one carries its own anchored regex builder.
   Plain text is the default mode; regex is an explicit opt-in. */

import { el, debounce } from './util.js';
import { attachBuilder } from './regex-builder.js';
import { t } from './i18n.js';

export function registerSearchBundle(addBundle) {
  addBundle('searchbar', {
    en: {
      'sb.placeholder': 'Search… (plain text by default)',
      'sb.clear': 'Clear search',
      'sb.search': 'Search',
    },
    zh: {
      'sb.placeholder': '搜尋……（預設純文字）',
      'sb.clear': '清除搜尋',
      'sb.search': '搜尋',
    },
  });
}

/* container: element to render into.
   opts: { placeholder, onQuery(state), sampleText, initial }
   state shape: { mode:'plain'|'regex', pattern:'', flags:'' } — mutated live;
   onQuery fires (debounced) with the state. Returns { root, input, state, setFilter } */
export function createSearchBar(container, opts = {}) {
  const state = opts.initial || { mode: 'plain', pattern: '', flags: 'i' };
  const wrap = el('div', { class: 'sb-wrap', role: 'search' });
  const input = el('input', {
    type: 'text',
    class: 'mr-input sb-input',
    placeholder: opts.placeholder || '',
    'aria-label': opts.ariaLabel || undefined,
    spellcheck: 'false',
  });
  input.value = state.pattern || '';
  const clear = el('button', {
    type: 'button',
    class: 'sb-clear mr-btn mr-btn--text',
    'aria-label': opts.ariaLabel ? `${opts.ariaLabel} — ${t('sb.clear')}` : t('sb.clear'),
    text: '✕',
  });
  clear.hidden = !input.value;
  clear.addEventListener('click', () => {
    input.value = '';
    state.pattern = '';
    fire();
    input.focus();
  });

  const fire = () => {
    clear.hidden = !input.value;
    opts.onQuery && opts.onQuery({ ...state });
  };
  const debounced = debounce(fire, 160);
  input.addEventListener('input', () => {
    // typing edits the pattern in the current mode; the builder stays in sync
    state.pattern = input.value;
    debounced();
  });

  const fieldWrap = el('div', { class: 'sb-field' }, [input, clear]);
  const builder = attachBuilder(fieldWrap, state, fire);
  wrap.append(el('label', { class: 'visually-hidden' }, [document.createTextNode(opts.ariaLabel || ''), input]), fieldWrap, builder.button);

  container.append(wrap);
  return {
    root: wrap,
    input,
    state,
    setFilter(next) {
      Object.assign(state, next || {});
      if ('pattern' in (next || {})) input.value = state.pattern || '';
      fire();
    },
    focus() { input.focus(); },
  };
}
