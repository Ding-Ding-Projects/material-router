// Purpose: Providers & Keys tab - provider cards (type badge, enabled switch,
// last-test status, edit/test/delete), the add/edit dialog, connection
// testing through the providers:test bridge, and the routing-rules editor.
// Data lives in the main-process stores via IPC providers:* / vault:*;
// this surface owns presentation only.
//
// NOTE on the i18n namespace: this module registers bundle ns 'providers',
// replacing the foundation placeholder bundle that carried exactly two keys
// (countProviders / countRules). Both keys are carried forward verbatim so
// nothing else reading t('providers.*') changes meaning.
//
// Owned by Providers lane - keep the registerTab call and tab id 'providers'.

import { h, fmtTimestamp } from '../../core/util.js';
import { addBundle, t, copy } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import { destructiveConfirm } from '../../core/dialogs.js';
import { toast } from '../../core/toasts.js';
import * as history from '../../core/history.js';
import * as palette from '../../core/palette.js';
import { en } from './providers.en.js';
import { zh } from './providers.zh.js';
import { openProviderDialog, TYPE_LABEL_KEYS } from './provider-form.js';
import { createRulesEditor } from './rules-editor.js';
import { snapFor, registerProvidersRestore, setRestoreRefresh } from './restore.js';
import { uid } from '../../core/util.js';

addBundle('providers', { en, zh });

// Restore hooks must exist before the history panel is ever opened, so they
// are registered at module load (app.js imports this module for its side
// effects on startup), not on first tab visit.
registerProvidersRestore();

const TEST_DEADLINE_MS = 35_000; // bridge clamps its own fetch to <= 30s
const STATUS_KEY = 'mr.providers.testStatus.v1';

const data = {
  providers: [],
  rules: [],
};
/** providerId -> Array<{id, owned_by?}> from the latest test / main cache */
const modelOptions = new Map();
/** providerId -> {ok:boolean, ts:string, message:string} (local-only UI state) */
let testStatus = loadTestStatus();

let searchApi = null;
let listEl = null;
let rulesEditor = null;
let languageUnsub = null;

function loadTestStatus() {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistTestStatus() {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(testStatus));
  } catch {
    // Status dots are best-effort UI state; a full storage never blocks use.
  }
}

/** Rejecting deadline wrapper for renderer-side IPC waits. */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('providers.err.deadline'))), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function statusFor(providerId) {
  return testStatus[providerId] ?? null;
}

function markStatus(providerId, entry) {
  testStatus[providerId] = entry;
  persistTestStatus();
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

function render(container) {
  container.append(
    h('div', { class: 'mr-prov-head' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.providers')),
      h('p', { class: 'mr-typography-body-medium mr-prov-sub' }, copy('providers.subtitle')),
    ),
  );

  searchApi = createSearchBar({
    placeholder: copy('providers.searchPlaceholder'),
    label: copy('providers.searchPlaceholder'),
    onQuery: () => renderProviders(),
  });

  const addBtn = h('button', {
    class: 'm3-btn m3-btn--filled',
    onclick: () => openAdd(),
  }, t('providers.addProvider'));

  listEl = h('div', { class: 'mr-prov-list', role: 'list', 'aria-label': t('tabs.providers') });

  rulesEditor = createRulesEditor({
    getProviders: () => data.providers,
    onChange: reload,
  });

  // Restore hooks refresh this surface after a compensating mutation; safe
  // only now that listEl and rulesEditor exist.
  setRestoreRefresh(reload);

  container.append(
    h('div', { class: 'mr-prov-toolbar' }, searchApi.el, h('span', { class: 'mr-grow' }), addBtn),
    listEl,
    rulesEditor.el,
  );

  refreshPaletteTitles();
  ensureLanguagePass();
  reload();
}

/**
 * Live retranslate: rebuild the mounted panel from the existing render
 * function when the language mode changes or School mode forces English.
 * Provider data lives in the main stores, so the rebuild re-fetches through
 * the same reload() path; the search query is re-adopted into the fresh bar.
 * No free-text drafts live on this surface (the add/edit dialog is a separate
 * modal that keeps its own text until closed).
 */
function ensureLanguagePass() {
  if (languageUnsub) return;
  languageUnsub = settings.onChange((key) => {
    if (key !== 'general.languageMode' && key !== 'school.active') return;
    const panel = document.getElementById('mr-tab-panel-providers');
    if (!panel?.isConnected) return;
    const scroll = panel.scrollTop;
    const q = searchApi?.get?.() ?? null;
    panel.textContent = '';
    render(panel);
    if (q?.text) searchApi.set(q.text);
    if (q?.mode === 'regex') searchApi.setMode('regex');
    panel.scrollTop = scroll;
  });
}

async function reload() {
  let fresh = null;
  try {
    fresh = await invoke('providers:list');
  } catch (err) {
    listEl.textContent = '';
    listEl.append(h('div', { class: 'm3-card m3-card--outlined mr-prov-error' },
      h('p', {}, t('providers.loadFailed')),
      h('p', { class: 'mr-typography-body-small' }, err.message),
      h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: () => reload() },
        t('providers.retry')),
    ));
    return;
  }
  data.providers = Array.isArray(fresh?.providers) ? fresh.providers : [];
  data.rules = Array.isArray(fresh?.rules) ? fresh.rules : [];
  await hydrateModels();
  renderProviders();
  rulesEditor.update(data.rules);
}

/** Pull cached model lists from the main TTL cache for pickers (best effort). */
async function hydrateModels() {
  await Promise.all(data.providers
    .filter((p) => !modelOptions.has(p.id))
    .map((p) => invoke('providers:get-models', { id: p.id })
      .then((models) => { if (Array.isArray(models) && models.length) modelOptions.set(p.id, models); })
      .catch(() => { /* picker simply stays empty until a test runs */ })));
}

function renderProviders() {
  if (!listEl) return;
  const q = searchApi.get();
  const visible = data.providers.filter((p) =>
    matchesQuery(q, `${p.name}\n${p.type}\n${p.baseUrl}\n${p.defaultModel}`));

  listEl.textContent = '';
  if (data.providers.length === 0) {
    listEl.append(h('div', { class: 'm3-card m3-card--outlined mr-prov-empty' },
      h('h2', { class: 'mr-typography-title-medium' }, copy('providers.emptyTitle')),
      h('p', { class: 'mr-typography-body-medium' }, copy('providers.emptyBody')),
    ));
    return;
  }
  if (visible.length === 0) {
    listEl.append(h('p', { class: 'mr-palette__empty' }, copy('providers.noMatch')));
    return;
  }
  for (const p of visible) listEl.append(buildCard(p));
}

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

function buildCard(p) {
  const st = statusFor(p.id);
  const card = h('div', { class: 'm3-card m3-card--outlined mr-prov-card', role: 'listitem' });

  // Status dot + words (never colour alone).
  const dotClass = st ? (st.ok ? 'mr-dot--ok' : 'mr-dot--fail') : 'mr-dot--unknown';
  const dotText = st
    ? (st.ok
      ? t('providers.status.okAt', { time: fmtTimestamp(st.ts) })
      : t('providers.status.failAt', { time: fmtTimestamp(st.ts) }))
    : t('providers.status.untested');
  const dot = h('span', {
    class: `mr-dot ${dotClass}`,
    role: 'img',
    'aria-label': dotText,
    title: st && !st.ok ? String(st.message || '').slice(0, 160) : '',
  });

  const typeBadge = h('span', { class: 'mr-badge' }, t(TYPE_LABEL_KEYS[p.type] ?? TYPE_LABEL_KEYS['openai-compatible']));

  const enabledInput = h('input', {
    type: 'checkbox',
    checked: p.enabled !== false ? true : null,
    'aria-label': t('providers.enabledAria', { name: p.name }),
  });
  const enabledSwitch = h('label', { class: 'm3-switch' },
    enabledInput,
    h('span', { class: 'track' }, h('span', { class: 'thumb' })),
    h('span', { class: 'label-text' }, t('providers.enabledLabel')),
  );
  enabledInput.addEventListener('change', async () => {
    const next = enabledInput.checked;
    enabledInput.disabled = true;
    try {
      await withDeadline(invoke('providers:save', { provider: { id: p.id, enabled: next } }), 10_000);
      history.record('providers.toggle', p.name, `enabled=${next}`);
      await reload();
    } catch (err) {
      enabledInput.checked = !next;
      toast(t('common.errorTitle'), err.message, { kind: 'error' });
    } finally {
      enabledInput.disabled = false;
    }
  });

  card.append(
    h('div', { class: 'mr-prov-card__head' },
      dot,
      h('span', { class: 'mr-prov-card__name mr-typography-title-medium' }, p.name),
      typeBadge,
      h('span', { class: 'mr-grow' }),
      enabledSwitch,
    ),
    h('div', { class: 'mr-prov-meta' },
      h('span', { class: 'mr-status-text' }, dotText),
      h('span', {}, '·'),
      h('code', { class: 'mr-code' }, p.baseUrl || t('providers.noBaseUrl')),
      p.defaultModel
        ? h('span', {}, t('providers.defaultModelLine', { model: p.defaultModel }))
        : h('span', { class: 'mr-status-text' }, t('providers.noDefaultModel')),
      h('span', {}, '·'),
      p.keyRef
        ? h('span', {}, t('providers.keyStoredLine'), h('code', { class: 'mr-code' }, p.keyRef))
        : h('span', { class: 'mr-status-text' }, t('providers.keyMissingLine')),
    ),
  );

  const testBtn = h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm' }, t('providers.action.test'));
  testBtn.addEventListener('click', () => testProvider(p, testBtn));

  const editBtn = h('button', { class: 'm3-btn m3-btn--text m3-btn--sm' }, t('providers.action.edit'));
  editBtn.addEventListener('click', () => openProviderDialog({
    provider: p,
    models: modelOptions.get(p.id) ?? [],
    onSave: () => {
      toast(copy('providers.toast.savedTitle'), copy('providers.toast.savedBody', { name: p.name }), { kind: 'success' });
      reload();
    },
  }));

  const delBtn = h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', style: 'color:var(--md-sys-color-error)' },
    t('providers.action.delete'));
  delBtn.addEventListener('click', () => deleteProvider(p));

  card.append(h('div', { class: 'mr-prov-actions' }, testBtn, editBtn, delBtn));
  return card;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openAdd() {
  openProviderDialog({
    models: [],
    onSave: (saved) => {
      toast(copy('providers.toast.addedTitle'), copy('providers.toast.savedBody', { name: saved?.name ?? '' }), { kind: 'success' });
      reload();
    },
  });
}

async function testProvider(p, btn) {
  btn.disabled = true;
  btn.textContent = t('providers.status.testing');
  try {
    const res = await withDeadline(invoke('providers:test', {
      id: p.id,
      type: p.type,
      baseUrl: p.baseUrl,
      keyRef: p.keyRef || '',
    }), TEST_DEADLINE_MS);
    if (res?.ok) {
      modelOptions.set(p.id, Array.isArray(res.models) ? res.models : []);
      markStatus(p.id, { ok: true, ts: new Date().toISOString(), message: '' });
      toast(
        t('providers.toast.testOkTitle'),
        copy('providers.toast.testOkBody', { count: res.modelCount ?? 0 }),
        { kind: 'success' },
      );
    } else {
      markStatus(p.id, {
        ok: false,
        ts: new Date().toISOString(),
        message: res?.message || t('providers.status.untested'),
      });
      toast(t('providers.toast.testFailTitle'), res?.message || '', { kind: 'error' });
    }
  } catch (err) {
    markStatus(p.id, { ok: false, ts: new Date().toISOString(), message: err.message });
    toast(t('providers.toast.testFailTitle'), err.message, { kind: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = t('providers.action.test');
    renderProviders();
  }
}

async function deleteProvider(p) {
  const keyRefWording = p.keyRef
    ? t('providers.deleteBodyKeyRef', { id: p.keyRef })
    : t('providers.deleteBodyNoKey');
  const ok = await destructiveConfirm({
    title: t('providers.deleteTitle', { name: p.name }),
    body: `${t('providers.deleteBody', { name: p.name })} ${keyRefWording} ${copy('providers.deleteBodyRules')}`,
  });
  if (!ok) return;
  // Snapshot for the history panel's restore action BEFORE anything is
  // removed; a failed delete leaves an orphan snapshot that journal pruning
  // drops later.
  const delRid = uid('rid');
  snapFor(delRid, { kind: 'prov-delete', provider: { ...p } });
  try {
    await withDeadline(invoke('providers:delete', { id: p.id }), 10_000);
  } catch (err) {
    toast(t('common.errorTitle'), err.message, { kind: 'error' });
    return;
  }
  if (p.keyRef) {
    try {
      await invoke('vault:delete-secret', { id: p.keyRef });
    } catch (err) {
      // The provider is gone but its vault entry survived; say so instead of
      // leaving silent orphaned key material behind.
      toast(t('providers.warn.orphanKeyTitle'), t('providers.warn.orphanKeyBody', { id: p.keyRef, msg: err.message }), { kind: 'error' });
    }
  }
  history.record('providers.delete', p.name, `keyRef=${p.keyRef || 'none'}`, delRid);
  modelOptions.delete(p.id);
  delete testStatus[p.id];
  persistTestStatus();
  toast(copy('providers.toast.deletedTitle'), copy('providers.toast.savedBody', { name: p.name }), { kind: 'success' });
  await reload();
}

// ---------------------------------------------------------------------------
// Command palette coverage
// ---------------------------------------------------------------------------

let paletteRegisteredOnce = false;
function ensurePaletteItems() {
  palette.register({
    id: 'providers.addProvider',
    title: copy('providers.palette.add'),
    keywords: 'provider api key endpoint anthropic openai compatible add new',
    section: 'Actions',
    run: openAdd,
  });
  palette.register({
    id: 'providers.testAll',
    title: copy('providers.palette.testAll'),
    keywords: 'provider test connection models refresh',
    section: 'Actions',
    run: testAllEnabled,
  });
  paletteRegisteredOnce = true;
}

async function testAllEnabled() {
  const targets = data.providers.filter((p) => p.enabled !== false);
  if (targets.length === 0) {
    toast(copy('providers.palette.testAll'), copy('providers.emptyBody'), { kind: 'info' });
    return;
  }
  for (const p of targets) await runTestSilently(p);
  const okCount = targets.filter((p) => statusFor(p.id)?.ok).length;
  toast(
    copy('providers.palette.testAll'),
    t('providers.toast.testAllSummary', { ok: okCount, total: targets.length }),
    { kind: okCount === targets.length ? 'success' : 'info' },
  );
  renderProviders();
}

async function runTestSilently(p) {
  try {
    const res = await withDeadline(invoke('providers:test', {
      id: p.id, type: p.type, baseUrl: p.baseUrl, keyRef: p.keyRef || '',
    }), TEST_DEADLINE_MS);
    if (res?.ok) {
      modelOptions.set(p.id, Array.isArray(res.models) ? res.models : []);
      markStatus(p.id, { ok: true, ts: new Date().toISOString(), message: '' });
    } else {
      markStatus(p.id, { ok: false, ts: new Date().toISOString(), message: res?.message || '' });
    }
  } catch (err) {
    markStatus(p.id, { ok: false, ts: new Date().toISOString(), message: err.message });
  }
}

function refreshPaletteTitles() {
  // Re-register so titles follow the active language mode.
  ensurePaletteItems();
}

registerTab({
  id: 'providers',
  label: { en: 'Providers & Keys', zh: '供應商同金鑰' },
  get icon() { return iconFromPath('M12.65 10A6 6 0 0 0 3 12a6 6 0 0 0 9.65 4.79L16 20h2v2h4v-4l-5.35-5.35A5.99 5.99 0 0 0 17 12a6 6 0 0 0-4.35-2ZM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z'); },
  init: render,
});

// Eager palette coverage (English fallback titles) before first tab visit;
// refreshPaletteTitles() re-registers with localized titles on mount.
queueMicrotask(() => {
  if (!paletteRegisteredOnce) ensurePaletteItems();
});
