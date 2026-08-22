// Purpose: the one search-bar factory every surface uses. Plain text by
// default; regex opt-in; the anchored builder button opens a RegexBuilder
// popover bound to THIS field's pattern/flags (each field owns its own).
// Owned by Foundation Core lane.

import { h, svgIcon, ICONS } from './util.js';
import { t } from './i18n.js';
import { RegexBuilder } from './regexbuilder.js';

/**
 * createSearchBar({placeholder, onQuery(queryState), regexDefault=false,
 *                  label})
 *
 * onQuery receives:
 *   { text, mode:'plain'|'regex', pattern, flags, error }
 *   - plain mode: text is the raw query
 *   - regex mode: pattern+flags describe the live builder state and `text`
 *     mirrors it so the two stay bidirectionally synchronized.
 */
export function createSearchBar({
  placeholder = '',
  label = '',
  regexDefault = false,
  onQuery = () => {},
} = {}) {
  let mode = regexDefault ? 'regex' : 'plain';
  let pattern = '';
  let flags = 'g';

  const input = h('input', {
    type: 'text',
    placeholder,
    'aria-label': label || placeholder || t('common.search'),
    spellcheck: 'false',
  });

  const modeBtn = h('button', {
    class: 'mr-searchbar__mode',
    type: 'button',
    title: t('search.toggleMode'),
    'aria-label': t('search.toggleMode'),
    onclick: () => setMode(mode === 'plain' ? 'regex' : 'plain'),
  }, mode === 'regex' ? '.*' : 'abc');

  const builderBtn = h('button', {
    class: 'mr-searchbar__builder',
    type: 'button',
    title: t('regex.openBuilder'),
    'aria-label': t('regex.openBuilder'),
  }, svgIcon(ICONS.search));

  const el = h('div', { class: 'mr-searchbar', role: 'search' }, input, modeBtn, builderBtn);

  let suppressEmit = false;

  function emit() {
    if (suppressEmit) return;
    if (mode === 'regex') {
      // Validate eagerly so consumers get an honest error instead of silence.
      let error = null;
      try {
        // eslint-disable-next-line no-new
        new RegExp(pattern, flags.replace(/[^dgimsuvy]/g, ''));
      } catch (err) {
        error = err.message;
      }
      input.classList.add('mr-regex-active');
      onQuery({ text: input.value, mode, pattern, flags, error });
    } else {
      input.classList.remove('mr-regex-active');
      onQuery({ text: input.value, mode, pattern: '', flags: '', error: null });
    }
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    modeBtn.textContent = mode === 'regex' ? '.*' : 'abc';
    if (mode === 'regex') {
      pattern = input.value;
      suppressEmit = true;
      input.value = pattern; // keep visible text identical while switching
      suppressEmit = false;
    } else {
      input.value = pattern || '';
    }
    emit();
  }

  builderBtn.addEventListener('click', () => {
    RegexBuilder.attach(builderBtn, {
      pattern,
      flags,
      sample: '',
      onApply: ({ pattern: p, flags: f }) => {
        pattern = p;
        flags = f;
        if (mode !== 'regex') {
          suppressEmit = true;
          mode = 'regex';
          modeBtn.textContent = '.*';
          suppressEmit = false;
        }
        input.value = p;
        emit();
      },
    });
  });

  input.addEventListener('input', emit);
  el.addEventListener('keydown', (e) => e.stopPropagation()); // don't leak into global shortcuts

  const api = {
    el,
    focus: () => input.focus(),
    get() {
      return mode === 'regex'
        ? { text: input.value, mode, pattern, flags }
        : { text: input.value, mode };
    },
    set(text) {
      input.value = text ?? '';
      if (mode === 'regex') pattern = input.value;
      emit();
    },
    clear() {
      input.value = '';
      pattern = '';
      emit();
    },
    setMode,
  };
  return api;
}

/** True when a queryState from createSearchBar matches a candidate string. */
export function matchesQuery(qs, candidate) {
  if (!qs) return true;
  const hay = String(candidate);
  if (qs.mode === 'regex' && qs.pattern) {
    try {
      const re = new RegExp(qs.pattern, qs.flags.includes('g') ? qs.flags.replace('g', '') + 'g' : qs.flags);
      re.lastIndex = 0;
      return re.test(hay);
    } catch {
      return false;
    }
  }
  return hay.toLowerCase().includes((qs.text || '').toLowerCase());
}
