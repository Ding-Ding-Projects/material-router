/* Anchored full regex builder. Every search field on this site carries one,
   attached beside the field it belongs to (never a detached global dialog).
   Guided construction, raw pattern editor, flags, sample text with live
   matches and capture groups, insert / copy / export. */

import { el, escapeHtml } from './util.js';
import { matchText, STEP_BUDGET } from './regex-core.js';
import { copy as i18nCopy, t } from './i18n.js';

let openBuilder = null;

export function closeOpenBuilder() {
  if (openBuilder) openBuilder.close();
}

const BUNDLE = {
  en: {
    'rb.title': 'Regex builder',
    'rb.mode': 'Match mode',
    'rb.plain': 'Plain text',
    'rb.regex': 'Regular expression',
    'rb.pattern': 'Pattern',
    'rb.flags': 'Flags',
    'rb.flag.i': 'i — ignore case',
    'rb.flag.m': 'm — multiline',
    'rb.flag.s': 's — dot matches newline',
    'rb.flag.u': 'u — unicode',
    'rb.build': 'Build',
    'rb.literal': 'Literal text',
    'rb.class': 'Character class',
    'rb.anchor.start': 'Anchor: start',
    'rb.anchor.end': 'Anchor: end',
    'rb.group': 'Group',
    'rb.alternation': 'Alternation',
    'rb.quantifier': 'Quantifier',
    'rb.insert': 'Insert into pattern',
    'rb.sample': 'Sample text to try the pattern against',
    'rb.matches': 'Matches',
    'rb.noMatches': 'No matches in the sample text.',
    'rb.invalid': 'Invalid pattern',
    'rb.budget': 'Step budget reached; results may be partial.',
    'rb.apply': 'Apply to search',
    'rb.copy': 'Copy pattern',
    'rb.export': 'Export builder state',
    'rb.engine': 'Engine: JavaScript RegExp (this browser). The step budget bounds match attempts, not internal backtracking per attempt.',
    'rb.close': 'Close regex builder',
  },
  zh: {
    'rb.title': '正則表達式產生器',
    'rb.mode': '配對模式',
    'rb.plain': '純文字',
    'rb.regex': '正則表達式',
    'rb.pattern': '模式',
    'rb.flags': '旗標',
    'rb.flag.i': 'i —— 忽略大小寫',
    'rb.flag.m': 'm —— 多行模式',
    'rb.flag.s': 's —— 點號包括換行',
    'rb.flag.u': 'u —— Unicode 模式',
    'rb.build': '砌式',
    'rb.literal': '字面文字',
    'rb.class': '字符類別',
    'rb.anchor.start': '錨點：開頭',
    'rb.anchor.end': '錨點：結尾',
    'rb.group': '群組',
    'rb.alternation': '多選一',
    'rb.quantifier': '次數',
    'rb.insert': '插入去模式度',
    'rb.sample': '攞嚟試模式的範例文字',
    'rb.matches': '配對結果',
    'rb.noMatches': '範例文字入面搵唔到配對。',
    'rb.invalid': '模式無效',
    'rb.budget': '已到步數預算上限；結果可能唔完整。',
    'rb.apply': '套用去搜尋',
    'rb.copy': '複製模式',
    'rb.export': '匯出產生器狀態',
    'rb.engine': '引擎：呢個瀏覽器嘅 JavaScript RegExp。步數預算限制配對嘅嘗試次數，唔限制每次嘗試入面引擎內部嘅回溯。',
    'rb.close': '閂埋正則產生器',
  },
};
export function registerRegexBundle(addBundle) {
  addBundle('regex-builder', BUNDLE);
}

/* Create the anchored builder for a search field.
   anchor: the field wrapper element the popover attaches beside.
   state: {mode,pattern,flags} shared with the field (mutated in place).
   onChange(): called after Apply so the field re-filters. */
export function attachBuilder(anchor, state, onChange) {
  const btn = el('button', {
    class: 'sb-builder-btn',
    type: 'button',
    title: t('rb.title'),
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    'aria-label': t('rb.title'),
  });
  btn.append(document.createTextNode('.*'));
  let pop = null;

  const close = () => {
    if (!pop) return;
    pop.remove();
    pop = null;
    btn.setAttribute('aria-expanded', 'false');
    if (openBuilder === api) openBuilder = null;
    btn.focus();
  };

  const api = { close };

  function buildPopover() {
    pop = el('div', { class: 'builder-pop', role: 'dialog', 'aria-label': t('rb.title') });

    // mode + flags row
    const modeRow = el('div', { class: 'builder-row' });
    const modeSel = el('select', { class: 'mr-select', id: '', 'aria-label': t('rb.mode') },
      ['plain', 'regex'].map((v) => el('option', { value: v, selected: state.mode === v ? '' : null, text: v === 'plain' ? t('rb.plain') : t('rb.regex') })));
    modeSel.addEventListener('change', () => { state.mode = modeSel.value; runSample(); onChange(); });
    modeRow.append(el('label', { class: 'field-label' }, [t('rb.mode'), modeSel]));

    const flagsWrap = el('div', { class: 'builder-flags', role: 'group', 'aria-label': t('rb.flags') });
    for (const f of ['i', 'm', 's', 'u']) {
      const cb = el('input', { type: 'checkbox', id: '' });
      cb.checked = String(state.flags || '').includes(f);
      cb.addEventListener('change', () => {
        const set = new Set(String(state.flags || '').split('').filter(Boolean));
        if (cb.checked) set.add(f); else set.delete(f);
        state.flags = Array.from(set).join('');
        syncField();
        runSample();
      });
      const lbl = el('label', { class: 'flag-chip' }, [cb, document.createTextNode(` ${f}`)]);
      lbl.title = t(`rb.flag.${f}`);
      flagsWrap.append(lbl);
    }
    modeRow.append(flagsWrap);
    pop.append(modeRow);

    // raw pattern editor
    const patLabel = el('label', { class: 'field-label' }, [t('rb.pattern')]);
    const patInput = el('input', { type: 'text', class: 'mr-input mono', spellcheck: 'false' });
    patInput.value = state.pattern || '';
    patInput.addEventListener('input', () => { state.pattern = patInput.value; syncField(); runSample(); });
    patLabel.append(patInput);
    pop.append(patLabel);

    // guided construction
    pop.append(el('div', { class: 'field-label' }, [t('rb.build')]));
    const grid = el('div', { class: 'builder-grid' });

    function piece(labelKey, make) {
      const input = el('input', { type: 'text', class: 'mr-input', placeholder: labelKey });
      const add = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal' }, [t('rb.insert')]);
      add.addEventListener('click', () => {
        const frag = make(input.value);
        if (!frag) return;
        const at = patInput.selectionStart ?? patInput.value.length;
        patInput.value = patInput.value.slice(0, at) + frag + patInput.value.slice(patInput.selectionEnd ?? at);
        state.pattern = patInput.value;
        patInput.focus();
        patInput.setSelectionRange(at + frag.length, at + frag.length);
        syncField();
        runSample();
      });
      return el('div', { class: 'builder-piece' }, [
        el('span', { class: 'piece-name', text: t(labelKey) }),
        input, add,
      ]);
    }

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    grid.append(
      piece('rb.literal', (v) => (v ? esc(v) : '')),
      piece('rb.class', (v) => `[${v || 'a-z'}]`),
      piece('rb.group', (v) => `(${v || ''})`),
      piece('rb.alternation', (v) => `(${(v || 'a|b').split('|').map(esc).join('|')})`),
    );
    const qWrap = el('div', { class: 'builder-piece' }, [
      el('span', { class: 'piece-name', text: t('rb.quantifier') }),
    ]);
    const qSel = el('select', { class: 'mr-select', 'aria-label': t('rb.quantifier') });
    for (const q of ['* (0+)', '+ (1+)', '? (0-1)', '{2}', '{2,}', '{2,5}']) {
      qSel.append(el('option', { value: q.split(' ')[0], text: q }));
    }
    const qAdd = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal' }, [t('rb.insert')]);
    const qTarget = el('input', { type: 'text', class: 'mr-input', placeholder: 'a' });
    qAdd.addEventListener('click', () => {
      const atom = qTarget.value.length === 1 ? qTarget.value : `(?:${qTarget.value || 'a'})`;
      const at = patInput.selectionStart ?? patInput.value.length;
      patInput.value = patInput.value.slice(0, at) + atom + qSel.value + patInput.value.slice(patInput.selectionEnd ?? at);
      state.pattern = patInput.value;
      syncField(); runSample();
    });
    qWrap.append(qTarget, qSel, qAdd);
    grid.append(qWrap);

    const aStart = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: '^' });
    aStart.setAttribute('aria-label', t('rb.anchor.start'));
    aStart.addEventListener('click', () => { patInput.value = '^' + patInput.value; state.pattern = patInput.value; syncField(); runSample(); });
    const aEnd = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: '$' });
    aEnd.setAttribute('aria-label', t('rb.anchor.end'));
    aEnd.addEventListener('click', () => { patInput.value += '$'; state.pattern = patInput.value; syncField(); runSample(); });
    const anchorRow = el('div', { class: 'builder-piece builder-anchors' }, [aStart, aEnd]);
    grid.append(anchorRow);
    pop.append(grid);

    // sample area
    const sampleLabel = el('label', { class: 'field-label' }, [t('rb.sample')]);
    const sample = el('textarea', { class: 'mr-input builder-sample', rows: '3' });
    sample.value = anchor.__sampleText || 'Material Router routes OpenAI and Anthropic traffic on 127.0.0.1.';
    sample.addEventListener('input', () => { anchor.__sampleText = sample.value; runSample(); });
    sampleLabel.append(sample);
    pop.append(sampleLabel);

    const outTitle = el('div', { class: 'field-label' }, [t('rb.matches')]);
    const out = el('div', { class: 'builder-out', 'aria-live': 'polite' });
    pop.append(outTitle, out);

    const note = el('p', { class: 'builder-note', text: t('rb.engine') });
    pop.append(note);

    const actions = el('div', { class: 'builder-actions' });
    const apply = el('button', { type: 'button', class: 'mr-btn mr-btn--filled' }, [t('rb.apply')]);
    apply.addEventListener('click', () => { onChange(); close(); });
    const cp = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal' }, [t('rb.copy')]);
    cp.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(state.pattern || ''); cp.textContent = '✓'; setTimeout(() => { cp.textContent = t('rb.copy'); }, 900); } catch { /* clipboard refused */ }
    });
    const ex = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal' }, [t('rb.export')]);
    ex.addEventListener('click', () => {
      const blobTxt = JSON.stringify({ exportedBy: 'material-router site regex builder', ...state }, null, 2);
      const url = URL.createObjectURL(new Blob([blobTxt], { type: 'application/json' }));
      const a = el('a', { href: url, download: 'regex-builder.json' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    });
    const x = el('button', { type: 'button', class: 'mr-btn mr-btn--text', 'aria-label': t('rb.close'), text: '✕' });
    x.addEventListener('click', close);
    actions.append(apply, cp, ex, x);
    pop.append(actions);

    function syncField() {
      // keep the host search input's visible text in step with the pattern
      const host = anchor.querySelector('input[type="search"], input[type="text"]');
      if (host && host !== patInput) host.value = state.pattern || '';
    }

    function runSample() {
      out.textContent = '';
      const res = matchText(sample.value, state);
      if (res.error) {
        out.append(el('div', { class: 'builder-error', text: `${t('rb.invalid')}: ${res.error}` }));
        return;
      }
      if (res.truncated) out.append(el('div', { class: 'builder-warn', text: t('rb.budget') }));
      if (!res.matches.length) {
        out.append(el('div', { class: 'builder-empty', text: t('rb.noMatches') }));
        return;
      }
      const shown = res.matches.slice(0, 50);
      const ul = el('ul', { class: 'builder-matchlist' });
      shown.forEach((m, i) => {
        ul.append(el('li', {
          html: `<b>#${i + 1}</b> @${m.index} <code>${escapeHtml(m.groups[0] || '')}</code>`
            + (m.groups.slice(1).some((g) => g != null)
              ? ` <span class="groups">(${escapeHtml(m.groups.slice(1).map((g) => (g == null ? '∅' : g)).join(', '))})</span>`
              : ''),
        }));
      });
      out.append(ul);
      if (res.matches.length > shown.length) {
        out.append(el('div', { class: 'builder-note', text: `+${res.matches.length - shown.length} …` }));
      }
    }

    runSample();
    return pop;
  }

  function toggle() {
    if (pop) { close(); return; }
    closeOpenBuilder();
    openBuilder = api;
    pop = buildPopover();
    pop.style.position = 'absolute';
    anchor.classList.add('has-builder');
    anchor.append(pop);
    // keep inside viewport, never covering the field it is anchored to
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - popRect.height - 8);
    let left = rect.left;
    if (left + popRect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - popRect.width - 8);
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    pop.style.maxHeight = `${Math.min(window.innerHeight - top - 8, 480)}px`;
    btn.setAttribute('aria-expanded', 'true');
    const firstInput = pop.querySelector('select, input');
    if (firstInput) firstInput.focus();
    const onDocDown = (e) => {
      if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        close();
        document.removeEventListener('pointerdown', onDocDown);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    document.addEventListener('pointerdown', onDocDown);
    pop.addEventListener('keydown', onKey);
  }

  btn.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
  return { button: btn, close };
}
