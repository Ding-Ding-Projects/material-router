// Purpose: the full regex builder popover. Insert buttons, raw pattern editor,
// flags, sample text with live matches and capture groups, honest validation
// line stating the JS RegExp engine, copy pattern/snippet, 64KB sample bound,
// zero-width-safe matching, and a step-budgeted matcher wrapper.
// Owned by Foundation Core lane.

import { h } from './util.js';
import { writeClipboard } from './util.js';
import { t } from './i18n.js';

export const SAMPLE_MAX_BYTES = 64 * 1024;
const STEP_BUDGET = 100_000;

const INSERTS = [
  ['.', '.'], [t('regex.anyDigit'), '\\d'], [t('regex.anyWord'), '\\w'],
  [t('regex.anySpace'), '\\s'], ['[abc]', '[abc]'], ['[^abc]', '[^abc]'],
  ['a-z', 'a-z'], ['^', '^'], ['$', '$'],
  ['()', '( )'], ['(capture)', '(...)'], ['(?:)', '(?:...)'],
  ['(?<name>)', '(?<name>...)'], ['|', '|'],
  ['*', '*'], ['+', '+'], ['?', '?'], ['{n,m}', '{2,5}'],
  ['\\b', '\\b'], ['\\.', '\\.'],
];

const FLAG_DEFS = [
  ['g', t('regex.flagGlobal')],
  ['i', t('regex.flagIgnoreCase')],
  ['m', t('regex.flagMultiline')],
  ['s', t('regex.flagDotAll')],
  ['u', t('regex.flagUnicode')],
  ['y', t('regex.flagSticky')],
];

/**
 * Budgeted matcher: scans start positions one by one using a sticky clone so
 * a runaway pattern cannot loop forever across the input. The native engine's
 * internal backtracking per attempt is not instrumentable; the budget bounds
 * the number of attempts and the UI says so honestly.
 */
export function budgetedMatch(pattern, flags, sample) {
  const errors = validate(pattern, flags);
  if (errors) return { error: errors };
  if (!sample) return { matches: [], truncated: false };
  const stickyFlags = flags.includes('y') ? flags : `${flags}y`;
  let re;
  try {
    re = new RegExp(pattern, stickyFlags);
  } catch (err) {
    return { error: err.message };
  }
  const globalWanted = !flags.includes('g');
  const matches = [];
  let steps = 0;
  let pos = 0;
  let truncated = false;
  while (pos <= sample.length) {
    steps += 1;
    if (steps > STEP_BUDGET) {
      truncated = true;
      break;
    }
    re.lastIndex = pos;
    const m = re.exec(sample);
    if (!m) {
      pos += 1;
      continue;
    }
    matches.push({
      index: m.index,
      text: m[0],
      groups: m.slice(1),
      named: m.groups ? { ...m.groups } : null,
    });
    pos = m[0].length > 0 ? m.index + m[0].length : m.index + 1; // zero-width safety
    if (!flags.includes('g')) break;
  }
  void globalWanted;
  return { matches, truncated };
}

function validate(pattern, flags) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags.replace(/[^dgimsuvy]/g, ''));
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Build the builder popover anchored to an element.
 * opts: {pattern, flags, sample, onApply({pattern,flags})}
 */
export class RegexBuilder {
  constructor(opts = {}) {
    this.pattern = opts.pattern ?? '';
    this.flags = opts.flags ?? 'g';
    this.sample = (opts.sample ?? '').slice(0, SAMPLE_MAX_BYTES);
    this.onApply = opts.onApply ?? null;
    this.anchor = null;
    this.popover = null;
    this.el = this._build();
  }

  /** Static helper: open anchored to `anchorEl`, close on Escape/apply. */
  static attach(anchorEl, opts = {}) {
    const builder = new RegexBuilder(opts);
    builder.open(anchorEl);
    return builder;
  }

  open(anchorEl) {
    this.close();
    this.anchor = anchorEl;
    this.popover = h('div', { class: 'mr-popover mr-regexbuilder', role: 'dialog', 'aria-label': t('regex.title') }, this.el);
    document.body.append(this.popover);

    this._onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
      }
    };
    this._onPointerDown = (e) => {
      if (!this.popover.contains(e.target) && e.target !== anchorEl && !anchorEl?.contains?.(e.target)) {
        this.close();
      }
    };
    document.addEventListener('keydown', this._onKeydown, true);
    setTimeout(() => document.addEventListener('pointerdown', this._onPointerDown, true), 0);

    this._position();
    this._update();
    this.rawInput.focus();
  }

  _position() {
    const rect = this.anchor?.getBoundingClientRect() ?? { left: 40, bottom: 40, top: 0, right: window.innerWidth - 40 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.popover.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const r = this.popover.getBoundingClientRect();
      let left = Math.min(rect.left, vw - r.width - 8);
      left = Math.max(8, left);
      let top = rect.bottom + 6;
      if (top + r.height > vh - 8) top = Math.max(8, rect.top - r.height - 6);
      this.popover.style.left = `${left}px`;
      this.popover.style.top = `${top}px`;
      this.popover.style.visibility = '';
    });
  }

  close(focusAnchor = false) {
    if (!this.popover) return;
    document.removeEventListener('keydown', this._onKeydown, true);
    document.removeEventListener('pointerdown', this._onPointerDown, true);
    this.popover.remove();
    this.popover = null;
    if (focusAnchor && this.anchor?.isConnected) this.anchor.focus();
    else if (this.anchor?.isConnected) this.anchor.focus();
  }

  _build() {
    const root = h('div', {});

    root.append(h('h3', {}, t('regex.title')));

    // Insert buttons
    const inserts = h('div', { class: 'inserts', role: 'toolbar', 'aria-label': t('regex.insertTokens') });
    for (const [label, token] of INSERTS) {
      inserts.append(h('code', {
        tabindex: '0',
        role: 'button',
        onclick: () => this._insert(token),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._insert(token); } },
      }, label));
    }
    root.append(inserts);

    // Raw pattern editor
    this.rawInput = h('textarea', {
      rows: 2,
      'aria-label': t('regex.patternLabel'),
      spellcheck: 'false',
      style: 'font-family:Consolas,monospace;width:100%',
    });
    this.rawInput.value = this.pattern;
    this.rawInput.addEventListener('input', () => {
      this.pattern = this.rawInput.value;
      this._update();
    });
    root.append(this.rawInput);

    // Flags
    const flagsRow = h('div', { class: 'flags', role: 'group', 'aria-label': t('regex.flags') });
    this.flagButtons = new Map();
    for (const [flag, label] of FLAG_DEFS) {
      const btn = h('button', {
        class: `m3-chip${this.flags.includes(flag) ? ' m3-chip--selected' : ''}`,
        'aria-pressed': String(this.flags.includes(flag)),
        title: label,
        onclick: () => this._toggleFlag(flag),
      }, flag);
      this.flagButtons.set(flag, btn);
      flagsRow.append(btn);
    }
    root.append(flagsRow);

    // Sample text
    this.sampleInput = h('textarea', {
      rows: 4,
      'aria-label': t('regex.sample'),
      placeholder: t('regex.samplePlaceholder'),
      style: 'width:100%',
    });
    this.sampleInput.value = this.sample;
    this.sampleInput.addEventListener('input', () => {
      const next = this.sampleInput.value.slice(0, SAMPLE_MAX_BYTES);
      if (next.length !== this.sampleInput.value.length) {
        this.sampleInput.value = next;
        this.errorLine.textContent = t('regex.sampleTooBig');
      }
      this.sample = next;
      this._update();
    });
    root.append(this.sampleInput);

    this.errorLine = h('div', { class: 'error-line', role: 'status' });
    root.append(this.errorLine);

    this.matchesBox = h('div', { class: 'matches', 'aria-live': 'polite' });
    root.append(this.matchesBox);

    // Actions
    const actions = h('div', { class: 'mr-row' },
      h('button', {
        class: 'm3-btn m3-btn--tonal m3-btn--sm',
        onclick: async () => {
          await writeClipboard(this.pattern);
          this.errorLine.textContent = t('common.copied');
        },
      }, t('regex.copyPattern')),
      h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        onclick: async () => {
          await writeClipboard(`new RegExp(${JSON.stringify(this.pattern)}, ${JSON.stringify(this.flags)})`);
          this.errorLine.textContent = t('common.copied');
        },
      }, t('regex.copySnippet')),
      h('span', { class: 'mr-grow' }),
      h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('regex.engineNote')),
      h('button', {
        class: 'm3-btn m3-btn--filled m3-btn--sm',
        onclick: () => {
          this.onApply?.({ pattern: this.pattern, flags: this.flags });
          this.close(true);
        },
      }, t('regex.apply')),
    );
    root.append(actions);
    return root;
  }

  _insert(token) {
    const el = this.rawInput;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    // Replace a selection or the "..." marker inside a just-inserted template.
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const caretTokenOffset = token.indexOf('...');
    el.value = before + token + after;
    if (caretTokenOffset >= 0) {
      const caret = before.length + caretTokenOffset + 3;
      el.setSelectionRange(caret, caret);
    } else {
      const caret = before.length + token.length;
      el.setSelectionRange(caret, caret);
    }
    this.pattern = el.value;
    this._update();
    el.focus();
  }

  _toggleFlag(flag) {
    this.flags = this.flags.includes(flag)
      ? this.flags.replace(flag, '')
      : this.flags + flag;
    const order = 'dgimsuy';
    this.flags = [...this.flags].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('');
    for (const [f, btn] of this.flagButtons) {
      btn.classList.toggle('m3-chip--selected', this.flags.includes(f));
      btn.setAttribute('aria-pressed', String(this.flags.includes(f)));
    }
    this._update();
  }

  _update() {
    const result = budgetedMatch(this.pattern, this.flags.replace(/[^dgimsuvy]/g, ''), this.sample);
    this.matchesBox.textContent = '';

    if (result.error) {
      this.errorLine.textContent = `${t('regex.errorPrefix')} ${result.error}`;
      return;
    }
    this.errorLine.textContent = '';

    if (result.truncated) {
      this.errorLine.textContent = t('regex.stepBudgetExceeded');
    }
    if (result.matches.length === 0) {
      this.matchesBox.append(h('div', { class: 'match-row' }, t('regex.noMatches')));
      return;
    }
    for (const m of result.matches.slice(0, 50)) {
      this.matchesBox.append(h('div', { class: 'match-row' },
        h('strong', {}, JSON.stringify(m.text)),
        ` @ ${m.index}`,
        m.groups.some((g) => g !== undefined) || m.named
          ? this._groupsTable(m)
          : null,
      ));
    }
    if (result.matches.length > 50) {
      this.matchesBox.append(h('div', { class: 'match-row' }, t('regex.moreMatches', { count: result.matches.length - 50 })));
    }
  }

  _groupsTable(m) {
    const table = h('table', {});
    const body = h('tbody', {});
    m.groups.forEach((g, i) => {
      body.append(h('tr', {},
        h('td', {}, `$${i + 1}`),
        h('td', {}, g === undefined ? t('regex.groupUnset') : JSON.stringify(g)),
      ));
    });
    if (m.named) {
      for (const [name, val] of Object.entries(m.named)) {
        body.append(h('tr', {},
          h('td', {}, `<${name}>`),
          h('td', {}, val === undefined ? t('regex.groupUnset') : JSON.stringify(val)),
        ));
      }
    }
    table.append(body);
    return table;
  }
}
