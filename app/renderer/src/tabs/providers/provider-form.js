// Purpose: Add/Edit provider dialog. Guided-form discipline: pickers prefilled
// from real data, inline plain-words validation, every disabled control names
// its unmet condition. Keys are written through vault:set-secret under a
// stable per-provider id; only that id reference is ever kept on the provider
// record. No secret value is logged, echoed back, or retained beyond the call.
// Owned by Providers lane.

import { h, uid } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { openModal, destructiveConfirm } from '../../core/dialogs.js';
import { invoke } from '../../core/bridge.js';
import { toast } from '../../core/toasts.js';
import { record as historyRecord } from '../../core/history.js';
import { snapFor } from './restore.js';

/** Canonical prefilled base URL per provider type ('' = user must supply). */
export const TYPE_DEFAULT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  'openai-compatible': '',
};

/** Suggested display names per type ('' = no sensible suggestion). */
const NAME_SUGGESTIONS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'openai-compatible': '',
};

export const TYPE_LABEL_KEYS = {
  openai: 'providers.type.openai',
  anthropic: 'providers.type.anthropic',
  'openai-compatible': 'providers.type.compatible',
};

/** http:// is legitimate for local model runtimes; https everywhere else. */
function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host.endsWith('.localhost') || host.endsWith('.local');
}

/** Returns an i18n error key, or null when the URL is acceptable. */
export function baseUrlErrorKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'providers.form.errUrlRequired';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'providers.form.errUrlFormat';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return null;
  return 'providers.form.errUrlFormat';
}

/**
 * Open the add/edit dialog.
 * @param {object} opts
 * @param {object|null} opts.provider existing record when editing
 * @param {Array<{id:string}>} opts.models cached model ids for the picker
 * @param {(saved:object)=>void} opts.onSave called after a confirmed save
 */
export function openProviderDialog({ provider = null, models = [], onSave = () => {} } = {}) {
  const isEdit = Boolean(provider?.id);
  const state = {
    id: provider?.id || uid('prov'),
    type: TYPE_DEFAULT_BASE_URL[provider?.type] !== undefined ? provider.type : 'openai',
    hadStoredKey: false,     // resolved async below; true once vault confirms
    keyRef: provider?.keyRef || null,
    removeStoredKey: false,  // removal applied only on Save
    replacingKey: false,
    newKey: '',
    showKey: false,
    enabled: provider?.enabled !== false,
  };

  // -- fields ---------------------------------------------------------------

  const nameField = makeTextField({
    inputAttrs: { type: 'text', value: provider?.name ?? '', spellcheck: 'false', autocomplete: 'off' },
    label: t('providers.form.name'),
    helper: t('providers.form.nameHelper'),
  });
  const nameInput = nameField.input;
  nameInput.addEventListener('input', () => validate());

  const typeGroup = h('div', {
    class: 'mr-seg',
    role: 'radiogroup',
    'aria-label': t('providers.form.type'),
  });
  const typeRadios = {};
  for (const typeKey of Object.keys(TYPE_DEFAULT_BASE_URL)) {
    const radio = h('input', {
      type: 'radio',
      name: `mr-prov-type-${state.id}`,
      value: typeKey,
      checked: state.type === typeKey ? true : null,
    });
    radio.addEventListener('change', () => { if (radio.checked) onTypeChange(typeKey); });
    typeRadios[typeKey] = radio;
    typeGroup.append(
      h('label', { class: 'mr-seg__opt' },
        radio,
        h('span', {}, t(TYPE_LABEL_KEYS[typeKey])),
      ),
    );
  }

  const urlField = makeTextField({
    inputAttrs: {
      type: 'text',
      value: typeof provider?.baseUrl === 'string'
        ? provider.baseUrl
        : TYPE_DEFAULT_BASE_URL[state.type],
      spellcheck: 'false',
      autocomplete: 'off',
    },
    label: t('providers.form.baseUrl'),
  });
  const urlInput = urlField.input;
  urlInput.addEventListener('input', () => validate());

  const restoreBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    type: 'button',
    onclick: () => {
      urlInput.value = TYPE_DEFAULT_BASE_URL[state.type];
      validate();
    },
  }, t('providers.form.restoreDefault'));
  const urlRow = h('div', { class: 'mr-row' }, h('div', { class: 'mr-grow' }, urlField.el), restoreBtn);

  // API key: exactly one of [presence row | removal note | entry row] shows.
  const keyRefLabel = h('code', { class: 'mr-code' }, '');
  const replaceBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    type: 'button',
    onclick: () => { state.replacingKey = true; syncKeyUi(); validate(); },
  }, t('providers.form.keyReplace'));

  const removeBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    type: 'button',
    onclick: async () => {
      const ok = await destructiveConfirm({
        title: t('providers.form.keyRemoveConfirmTitle'),
        body: t('providers.form.keyRemoveConfirmBody', { id: state.keyRef ?? '' }),
      });
      if (!ok) return;
      state.removeStoredKey = true;
      state.replacingKey = false;
      state.newKey = '';
      keyInput.value = '';
      syncKeyUi();
      validate();
    },
  }, t('providers.form.keyRemove'));

  const keyPresence = h('div', { class: 'mr-keyrow', hidden: true },
    h('span', { class: 'mr-keyrow__label' }, t('providers.form.keyStored')),
    keyRefLabel,
    h('span', { class: 'mr-grow' }),
    replaceBtn,
    removeBtn,
  );

  const keyUndoRemoveBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    type: 'button',
    onclick: () => { state.removeStoredKey = false; syncKeyUi(); validate(); },
  }, t('providers.form.keyUndoRemove'));
  const keyRemovalNote = h('div', { class: 'mr-keyrow mr-keyrow--pending', hidden: true },
    h('span', { class: 'mr-grow' }, t('providers.form.keyPendingRemoval')),
    keyUndoRemoveBtn,
  );

  const keyInput = h('input', {
    type: 'password',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': t('providers.form.apiKey'),
    placeholder: t('providers.form.apiKeyPlaceholder'),
  });
  keyInput.addEventListener('input', () => { state.newKey = keyInput.value; });

  const showKeyBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    type: 'button',
    'aria-pressed': 'false',
    onclick: () => {
      state.showKey = !state.showKey;
      keyInput.type = state.showKey ? 'text' : 'password';
      showKeyBtn.setAttribute('aria-pressed', String(state.showKey));
      showKeyBtn.textContent = state.showKey
        ? t('providers.form.hideKey')
        : t('providers.form.showKey');
    },
  }, t('providers.form.showKey'));

  const keyHelper = h('div', { class: 'm3-textfield__helper' }, t('providers.form.keyHelper'));
  const keyEntry = h('div', { class: 'mr-keyrow' },
    h('div', { class: 'm3-textfield mr-grow' }, keyInput, keyHelper),
    showKeyBtn,
  );

  // Default model: suggestions come from the last successful connection test;
  // free text stays available because no endpoint lists every valid model.
  const datalistId = `mr-models-${state.id}`;
  const datalist = h('datalist', { id: datalistId });
  for (const m of models) datalist.append(h('option', { value: m.id }));
  const modelField = makeTextField({
    inputAttrs: {
      type: 'text',
      value: provider?.defaultModel ?? '',
      spellcheck: 'false',
      autocomplete: 'off',
      list: datalistId,
    },
    label: t('providers.form.defaultModel'),
    helper: models.length ? t('providers.form.modelHelper') : t('providers.form.modelHelperEmpty'),
  });
  const modelInput = modelField.input;

  const enabledInput = h('input', {
    type: 'checkbox',
    checked: state.enabled ? true : null,
    'aria-label': t('providers.form.enabled'),
  });
  enabledInput.addEventListener('change', () => { state.enabled = enabledInput.checked; });
  const enabledSwitch = h('label', { class: 'm3-switch' },
    enabledInput,
    h('span', { class: 'track' }, h('span', { class: 'thumb' })),
    h('span', { class: 'label-text' }, t('providers.form.enabled')),
  );

  const form = h('form', { class: 'mr-form', novalidate: true },
    nameField.el,
    h('div', { class: 'mr-form__group' },
      h('span', { class: 'mr-typography-label-large' }, t('providers.form.type')),
      typeGroup,
    ),
    urlRow,
    keyPresence,
    keyRemovalNote,
    keyEntry,
    h('div', { class: 'mr-form__group' }, modelField.el, datalist),
    h('div', { class: 'mr-form__group' }, enabledSwitch),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); attemptSave(); });

  const saveReasons = h('div', {
    class: 'mr-typography-body-small',
    role: 'status',
    style: 'color:var(--md-sys-color-error)',
  });

  // -- behaviour ------------------------------------------------------------

  function onTypeChange(nextType) {
    const prevDefault = TYPE_DEFAULT_BASE_URL[state.type];
    const prevSuggestion = NAME_SUGGESTIONS[state.type];
    state.type = nextType;
    // Prefill the URL while it is untouched or still holding the old default.
    const currentUrl = urlInput.value.trim();
    if (!currentUrl || currentUrl === prevDefault) {
      urlInput.value = TYPE_DEFAULT_BASE_URL[nextType];
    }
    // Suggested name follows the type until the user writes their own.
    const currentName = nameInput.value.trim();
    if (!currentName || currentName === prevSuggestion) {
      const suggestion = NAME_SUGGESTIONS[nextType];
      if (suggestion) nameInput.value = suggestion;
    }
    validate();
  }

  function currentErrors() {
    const errs = {};
    if (!nameInput.value.trim()) errs.name = t('providers.form.errNameRequired');
    const urlErrKey = baseUrlErrorKey(urlInput.value);
    if (urlErrKey) errs.baseUrl = t(urlErrKey);
    return errs;
  }

  function validate() {
    const errs = currentErrors();
    nameField.setError(errs.name ?? null);
    urlField.setError(errs.baseUrl ?? null);
    const urlDefault = TYPE_DEFAULT_BASE_URL[state.type];
    const atDefault = urlInput.value === urlDefault;
    restoreBtn.disabled = atDefault;
    restoreBtn.title = atDefault
      ? t('providers.form.alreadyDefault')
      : t('providers.form.restoreDefaultTip');
    if (saveBtn) {
      saveBtn.disabled = Object.keys(errs).length > 0;
    }
    saveReasons.textContent = errs.name ?? errs.baseUrl ?? '';
    return Object.keys(errs).length === 0;
  }

  function syncKeyUi() {
    const storedVisible = state.hadStoredKey && !state.replacingKey && !state.removeStoredKey;
    keyPresence.hidden = !storedVisible;
    keyRefLabel.textContent = state.keyRef ?? '';
    keyRemovalNote.hidden = !state.removeStoredKey;
    keyEntry.hidden = storedVisible || state.removeStoredKey;
    keyHelper.textContent = state.hadStoredKey && state.replacingKey
      ? t('providers.form.keyReplaceHelper')
      : t('providers.form.keyHelper');
  }

  async function attemptSave() {
    if (!validate()) {
      if (!nameInput.value.trim()) nameInput.focus();
      else if (baseUrlErrorKey(urlInput.value)) urlInput.focus();
      return false;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = t('providers.form.saving');

    const name = nameInput.value.trim();
    const baseUrl = urlInput.value.trim();
    const keyRefForProvider = state.keyRef || `mrkey_${state.id}`;
    const writingNewKey = Boolean(state.newKey);
    // Restore support: stash the pre-edit record (update) or the created id
    // (add) out of band, keyed to the journal entry via rid. Snapshots carry
    // vault ids only - never key values.
    const beforeEdit = isEdit && provider ? { ...provider } : null;
    const editRid = isEdit ? uid('rid') : '';
    const addRid = isEdit ? '' : uid('rid');
    if (isEdit) snapFor(editRid, { kind: 'prov-update', provider: beforeEdit });
    try {
      if (writingNewKey) {
        // Replacing an existing key overwrites the same vault id BEFORE the
        // record save, so a record-save failure cannot be rolled back to the
        // previous key value (reading it back is deliberately impossible).
        // The rollback below only fires when no key existed before.
        const encrypted = await invoke('vault:set-secret', {
          id: keyRefForProvider,
          value: state.newKey,
        });
        if (encrypted === false) {
          // Honest disclosure: OS-level encryption unavailable this session.
          toast(t('providers.warn.obfuscatedTitle'), t('providers.warn.obfuscatedBody'), { kind: 'info', timeout: 12000 });
        }
        historyRecord('providers.key.set', name, `vault id ${keyRefForProvider}`);
      }

      const saved = await invoke('providers:save', {
        provider: {
          id: state.id,
          name,
          type: state.type,
          baseUrl,
          keyRef: (writingNewKey || (state.hadStoredKey && !state.removeStoredKey))
            ? keyRefForProvider
            : null,
          enabled: state.enabled,
          defaultModel: modelInput.value.trim(),
        },
      });

      // Vault deletion happens AFTER the record save: a failure there is then
      // reportable without having lost the provider change itself.
      if (state.removeStoredKey && state.keyRef) {
        try {
          await invoke('vault:delete-secret', { id: state.keyRef });
          historyRecord('providers.key.remove', name, `vault id ${state.keyRef}`);
        } catch (err) {
          toast(t('providers.warn.orphanKeyTitle'), t('providers.warn.orphanKeyBody', { id: state.keyRef, msg: err.message }), { kind: 'error' });
        }
      }

      if (isEdit) {
        historyRecord('providers.update', saved?.name ?? name,
          `type=${state.type} baseUrl=${baseUrl}`, editRid);
      } else {
        snapFor(addRid, { kind: 'prov-add', provider: { ...(saved ?? {}), id: state.id, name } });
        historyRecord('providers.add', saved?.name ?? name,
          `type=${state.type} baseUrl=${baseUrl}`, addRid);
      }
      dlg.close();
      onSave(saved);
      return true;
    } catch (err) {
      // Roll back a freshly written secret ONLY when none existed before,
      // otherwise the rollback would destroy the key the user already had.
      if (writingNewKey && !state.hadStoredKey) {
        try { await invoke('vault:delete-secret', { id: keyRefForProvider }); } catch { /* best effort */ }
      }
      toast(t('providers.toast.saveFailedTitle'), err.message, { kind: 'error' });
      saveBtn.disabled = false;
      saveBtn.textContent = t('providers.form.save');
      return false;
    }
  }

  // -- shell ------------------------------------------------------------------

  const dlg = openModal({
    title: isEdit ? t('providers.form.titleEdit') : t('providers.form.titleAdd'),
    body: h('div', { class: 'mr-form-wrap' }, form, saveReasons),
    actions: [
      { label: t('common.cancel'), kind: 'm3-btn--text', run: () => {} },
      { label: t('providers.form.save'), kind: 'm3-btn--filled', run: () => attemptSave() },
    ],
  });
  const saveBtn = [...dlg.el.querySelectorAll('.m3-dialog__actions .m3-btn')]
    .find((b) => b.textContent === t('providers.form.save')) ?? null;

  // Resolve stored-key presence before showing the presence row.
  if (isEdit && state.keyRef) {
    invoke('vault:has', { id: state.keyRef })
      .then((has) => {
        state.hadStoredKey = Boolean(has);
        syncKeyUi();
      })
      .catch(() => {
        state.hadStoredKey = false;
        syncKeyUi();
      });
  }
  syncKeyUi();
  validate();
  queueMicrotask(() => nameInput.focus());
  return dlg;
}

// -- small local builders -----------------------------------------------------

function makeTextField({ inputAttrs, label, helper = '' }) {
  const input = h('input', { ...inputAttrs, 'aria-label': label });
  const helperEl = h('div', { class: 'm3-textfield__helper' }, helper);
  const el = h('div', { class: 'm3-textfield', style: 'width:100%' },
    input,
    h('label', { 'aria-hidden': 'true' }, label),
    helperEl,
  );
  return {
    el,
    input,
    helper: helperEl,
    setError(message) {
      el.classList.toggle('m3-textfield--error', Boolean(message));
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      helperEl.textContent = message || helper;
    },
  };
}
