// Purpose: Routing-rules editor. The displayed order IS the priority order:
// the resolver sorts by priority descending (ties break by specificity, exact
// > prefix > catch-all, then insertion order), so this surface rewrites every
// priority whenever the order changes and keeps the two views identical.
// Catch-all rows are labelled as the fallback they are. Edits are drafted per
// row and applied explicitly; structural changes (add / move / delete /
// enable) persist immediately.
// Owned by Providers lane.

import { h } from '../../core/util.js';
import { t, copy } from '../../core/i18n.js';
import { invoke } from '../../core/bridge.js';
import { destructiveConfirm } from '../../core/dialogs.js';
import { toast } from '../../core/toasts.js';
import { record as historyRecord } from '../../core/history.js';

/** Model-prefix suggestions drawn from the families users actually route. */
const PATTERN_CHIPS = ['gpt-4o', 'gpt-4*', 'o3*', 'claude-*', 'claude-sonnet-*', 'gemini-*'];

const MATCH_KEYS = {
  prefix: 'providers.rules.matchPrefix',
  exact: 'providers.rules.matchExact',
  catchall: 'providers.rules.matchCatchall',
};

/**
 * @param {object} opts
 * @param {()=>Array<object>} opts.getProviders live provider list
 * @param {()=>Promise<void>} opts.onChange parent reload after persistence
 */
export function createRulesEditor({ getProviders, onChange }) {
  let rules = [];
  /** @type {object|null} unsaved new-rule draft */
  let pending = null;

  const root = h('section', { class: 'mr-rules', 'aria-label': t('providers.rules.title') });
  const listEl = h('ol', { class: 'mr-rules__list' });

  root.append(
    h('h2', { class: 'mr-typography-title-large' }, t('providers.rules.title')),
    h('p', { class: 'mr-typography-body-medium mr-rules__note' }, copy('providers.rules.note')),
    listEl,
  );

  const addBtn = h('button', {
    class: 'm3-btn m3-btn--tonal',
    type: 'button',
    onclick: () => {
      if (pending) {
        // One draft at a time: focus the existing unsaved row instead of
        // silently discarding it.
        listEl.querySelector('.mr-rule--pending select')?.focus();
        return;
      }
      pending = { matchType: 'prefix', pattern: '', providerId: '', enabled: true };
      renderAll();
      const firstSelect = listEl.querySelector('.mr-rule--pending select');
      firstSelect?.focus();
    },
  }, t('providers.rules.add'));
  root.append(addBtn);

  function update(nextRules) {
    rules = Array.isArray(nextRules) ? [...nextRules] : [];
    renderAll();
  }

  function renderAll() {
    const providers = getProviders();
    addBtn.disabled = providers.length === 0;
    addBtn.title = providers.length === 0 ? t('providers.rules.addNeedsProvider') : '';
    listEl.textContent = '';
    if (rules.length === 0 && !pending) {
      listEl.append(h('li', { class: 'mr-rules__empty' }, copy('providers.rules.empty')));
    }
    rules.forEach((rule, i) => listEl.append(buildRow({ rule, index: i, providers })));
    if (pending) listEl.append(buildRow({ rule: null, index: rules.length, providers }));
  }

  /** Rewrite priorities so display order == resolution order, persist diffs. */
  async function persistOrder(ordered) {
    const updates = [];
    ordered.forEach((r, i) => {
      const p = ordered.length - i;
      if (r.priority !== p) updates.push(invoke('providers:save-rule', { rule: { id: r.id, priority: p } }));
    });
    if (updates.length) {
      await Promise.all(updates);
      historyRecord('rules.reorder', `${ordered.length} rules`, 'priorities rewritten to list order');
    }
    await onChange();
  }

  function ruleSummary(matchType, pattern) {
    return matchType === 'catchall' ? '** (fallback)' : `${matchType}:${pattern}`;
  }

  /**
   * One editable rule row. When `rule` is null the row edits the pending
   * new-rule draft instead.
   */
  function buildRow({ rule, index, providers }) {
    const isPending = rule === null;
    const draft = isPending
      ? { ...pending }
      : { matchType: rule.matchType, pattern: rule.pattern ?? '', providerId: rule.providerId ?? '' };

    const row = h('li', {
      class: `mr-rule${isPending ? ' mr-rule--pending' : ''}`,
      'aria-label': t('providers.rules.rowLabel', { n: index + 1 }),
    });

    const idx = h('span', { class: 'mr-rule__index', 'aria-hidden': 'true' }, `#${index + 1}`);
    const fallbackBadge = h('span', { class: 'mr-badge mr-badge--fallback', hidden: true }, t('providers.rules.fallbackBadge'));

    // Match type -----------------------------------------------------------
    const matchSelect = h('select', { 'aria-label': t('providers.rules.matchType') });
    for (const [value, key] of Object.entries(MATCH_KEYS)) {
      matchSelect.append(h('option', { value }, t(key)));
    }
    matchSelect.value = draft.matchType;
    matchSelect.addEventListener('change', () => {
      draft.matchType = matchSelect.value;
      syncMatchUi();
      validate();
    });
    const matchWrap = h('span', { class: 'm3-select' }, matchSelect);

    // Pattern ---------------------------------------------------------------
    const patternInput = h('input', {
      type: 'text',
      class: 'mr-rule__pattern-input',
      value: draft.pattern,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': t('providers.rules.pattern'),
      placeholder: t('providers.rules.patternPlaceholder'),
    });
    patternInput.addEventListener('input', () => { draft.pattern = patternInput.value; validate(); });

    const chipsRow = h('div', { class: 'mr-chips', role: 'group', 'aria-label': t('providers.rules.chipsLabel') });
    for (const chip of PATTERN_CHIPS) {
      chipsRow.append(h('button', {
        class: 'm3-chip m3-chip--sm',
        type: 'button',
        title: t('providers.rules.chipTip'),
        onclick: () => {
          // A prefix rule matches ONE pattern, so a chip replaces the value.
          patternInput.value = chip;
          draft.pattern = chip;
          validate();
        },
      }, chip));
    }

    const patternErr = h('div', { class: 'mr-inline-error', hidden: true });
    const patternWrap = h('div', { class: 'mr-rule__pattern' },
      patternInput,
      chipsRow,
      patternErr,
      h('div', { class: 'm3-textfield__helper mr-rule__catchall-note', hidden: true },
        t('providers.rules.catchallNote')),
    );

    // Target ----------------------------------------------------------------
    const targetSelect = h('select', { 'aria-label': t('providers.rules.target') });
    syncTargetOptions();
    targetSelect.value = draft.providerId;
    targetSelect.addEventListener('change', () => { draft.providerId = targetSelect.value; validate(); });
    const targetErr = h('div', { class: 'mr-inline-error', hidden: true });
    const targetWrap = h('div', { class: 'mr-rule__target' },
      h('span', { class: 'm3-select' }, targetSelect),
      targetErr);

    function syncTargetOptions() {
      targetSelect.textContent = '';
      if (providers.length === 0) {
        targetSelect.disabled = true;
        targetSelect.append(h('option', { value: '' }, t('providers.rules.errTargetNone')));
        return;
      }
      targetSelect.disabled = false;
      targetSelect.append(h('option', { value: '' }, t('providers.rules.targetPlaceholder')));
      for (const p of providers) {
        targetSelect.append(h('option', { value: p.id }, `${p.name} (${t(TYPE_LABEL(p.type))})`));
      }
      if (draft.providerId && !providers.some((p) => p.id === draft.providerId)) {
        targetSelect.append(h('option', { value: draft.providerId }, t('providers.rules.targetRemoved')));
      }
    }

    // Enabled ---------------------------------------------------------------
    const enableInput = h('input', {
      type: 'checkbox',
      checked: (isPending ? pending.enabled : rule.enabled !== false) ? true : null,
      'aria-label': t('providers.rules.enabled'),
    });
    const enableSwitch = h('label', { class: 'm3-switch' },
      enableInput,
      h('span', { class: 'track' }, h('span', { class: 'thumb' })),
      h('span', { class: 'label-text' }, t('providers.rules.enabled')),
    );
    if (!isPending) {
      enableInput.addEventListener('change', async () => {
        const next = enableInput.checked;
        enableInput.disabled = true;
        try {
          await invoke('providers:save-rule', { rule: { id: rule.id, enabled: next } });
          historyRecord('rule.update', ruleSummary(draft.matchType, effectivePattern()), `enabled=${next}`);
          await onChange();
        } catch (err) {
          enableInput.checked = !next;
          enableInput.disabled = false;
          toast(t('common.errorTitle'), err.message, { kind: 'error' });
        }
      });
    } else {
      enableInput.addEventListener('change', () => { pending.enabled = enableInput.checked; });
    }

    // Move / delete ----------------------------------------------------------
    const upBtn = iconBtn('↑', t('providers.rules.moveUp'), async () => {
      const next = [...rules];
      const [moved] = next.splice(index, 1);
      next.splice(index - 1, 0, moved);
      await guard(() => persistOrder(next));
    });
    const downBtn = iconBtn('↓', t('providers.rules.moveDown'), async () => {
      const next = [...rules];
      const [moved] = next.splice(index, 1);
      next.splice(index + 1, 0, moved);
      await guard(() => persistOrder(next));
    });
    upBtn.disabled = !isPending && index === 0;
    downBtn.disabled = !isPending && index === rules.length - 1;
    if (!isPending && index === 0) upBtn.title = t('providers.rules.cannotMoveUp');
    if (!isPending && index === rules.length - 1) downBtn.title = t('providers.rules.cannotMoveDown');

    const delBtn = iconBtn('✕', t('common.delete'), async () => {
      if (isPending) {
        pending = null;
        renderAll();
        return;
      }
      const targetName = providers.find((p) => p.id === rule.providerId)?.name ?? '?';
      const ok = await destructiveConfirm({
        title: t('providers.rules.deleteTitle'),
        body: t('providers.rules.deleteBody', {
          rule: ruleSummary(rule.matchType, rule.pattern),
          provider: targetName,
        }),
      });
      if (!ok) return;
      await guard(async () => {
        await invoke('providers:delete-rule', { id: rule.id });
        historyRecord('rule.delete', ruleSummary(rule.matchType, rule.pattern), `was -> ${targetName}`);
        await onChange();
      });
    });

    // Save / revert (visible while dirty or pending) -------------------------
    const saveBtn = h('button', { class: 'm3-btn m3-btn--filled m3-btn--sm', type: 'button' }, t('common.save'));
    const revertBtn = h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', type: 'button' }, t('providers.rules.revert'));
    saveBtn.addEventListener('click', () => attemptSave());
    revertBtn.addEventListener('click', () => {
      if (isPending) {
        pending = null;
        renderAll();
        return;
      }
      draft.matchType = rule.matchType;
      draft.pattern = rule.pattern ?? '';
      draft.providerId = rule.providerId ?? '';
      patternInput.value = draft.pattern;
      matchSelect.value = draft.matchType;
      syncTargetOptions();
      targetSelect.value = draft.providerId;
      validate();
    });

    function isDirty() {
      if (isPending) return true;
      return draft.matchType !== rule.matchType
        || draft.pattern !== (rule.pattern ?? '')
        || draft.providerId !== (rule.providerId ?? '');
    }

    function effectivePattern() {
      return draft.matchType === 'catchall' ? '**' : draft.pattern.trim();
    }

    function validate() {
      let ok = true;
      if (draft.matchType !== 'catchall' && !effectivePattern()) {
        patternErr.textContent = t('providers.rules.errPattern');
        patternErr.hidden = false;
        ok = false;
      } else {
        patternErr.hidden = true;
      }
      const known = providers.some((p) => p.id === draft.providerId);
      if (!known) {
        targetErr.textContent = providers.length === 0
          ? t('providers.rules.errTargetNone')
          : t('providers.rules.errTarget');
        targetErr.hidden = false;
        ok = false;
      } else {
        targetErr.hidden = true;
      }
      saveBtn.disabled = !ok;
      return ok;
    }

    async function attemptSave() {
      if (!validate()) return;
      const payload = {
        matchType: draft.matchType,
        pattern: effectivePattern(),
        providerId: draft.providerId,
      };
      await guard(async () => {
        if (isPending) {
          const created = await invoke('providers:save-rule', { rule: payload });
          pending = null;
          historyRecord('rule.add', ruleSummary(created.matchType, created.pattern),
            `-> ${providers.find((p) => p.id === created.providerId)?.name ?? '?'}`);
          await persistOrder([...rules, created]);
        } else {
          const saved = await invoke('providers:save-rule', {
            rule: { ...payload, id: rule.id },
          });
          historyRecord('rule.update', ruleSummary(saved.matchType, saved.pattern),
            `-> ${providers.find((p) => p.id === saved.providerId)?.name ?? '?'}`);
          await onChange();
        }
      });
    }

    function syncMatchUi() {
      const catchall = draft.matchType === 'catchall';
      patternInput.disabled = catchall;
      chipsRow.hidden = catchall;
      patternWrap.querySelector('.mr-rule__catchall-note').hidden = !catchall;
      fallbackBadge.hidden = !catchall;
      if (catchall) patternInput.value = '';
    }

    // Assemble ---------------------------------------------------------------
    row.append(
      h('div', { class: 'mr-rule__cell mr-rule__cell--idx' }, idx),
      h('div', { class: 'mr-rule__cell' },
        h('span', { class: 'mr-typography-label-medium' }, t('providers.rules.matchType')),
        h('div', { class: 'mr-row' }, matchWrap, fallbackBadge),
      ),
      h('div', { class: 'mr-rule__cell mr-grow' }, patternWrap),
      h('div', { class: 'mr-rule__cell' }, targetWrap),
      h('div', { class: 'mr-rule__cell' }, enableSwitch),
      h('div', { class: 'mr-rule__cell mr-rule__cell--actions' },
        upBtn, downBtn, delBtn,
        isDirty() ? saveBtn : null,
        isDirty() && !isPending ? revertBtn : null,
      ),
    );

    syncMatchUi();
    validate();
    return row;
  }

  async function guard(fn) {
    try {
      await fn();
    } catch (err) {
      toast(t('common.errorTitle'), err.message, { kind: 'error' });
    }
  }

  return { el: root, update };
}

function TYPE_LABEL(type) {
  return {
    openai: 'providers.type.openai',
    anthropic: 'providers.type.anthropic',
    'openai-compatible': 'providers.type.compatible',
  }[type] ?? 'providers.type.compatible';
}

function iconBtn(char, ariaLabel, onClick) {
  const b = h('button', {
    class: 'm3-btn m3-btn--outlined m3-btn--sm m3-btn--icon-only mr-rule__iconbtn',
    type: 'button',
    'aria-label': ariaLabel,
    title: ariaLabel,
    onclick: onClick,
  }, char);
  return b;
}
