// Purpose: history restore implementations for the Providers lane's journal
// actions. The journal stores display strings only, so each record site also
// stashes a small machine-readable snapshot out of band, keyed by the same
// restore id it passes to history.record(). Restore hooks read that snapshot,
// apply a compensating mutation through the providers:* IPC domain, and append
// a compensating journal entry - history itself is never rewritten.
//
// Snapshots live in localStorage next to the journal (same lifetime), carry no
// secret values (vault ids only - keys themselves never leave the vault), and
// are pruned against the ids still present in the journal so the two cannot
// drift apart indefinitely. A snapshot that has aged out fails loudly with a
// localized message instead of guessing.
//
// Owned by Providers lane.

import { t } from '../../core/i18n.js';
import { invoke } from '../../core/bridge.js';
import { record as historyRecord, list as journalList, onRestore } from '../../core/history.js';

const SNAPS_KEY = 'mr.providers.restoreSnaps.v1';
const SNAPS_MAX = 500; // >= journal ring size, so pruning is what binds them

/** @type {null | (() => Promise<void>)} set by the tab once its DOM exists */
let refresh = null;

/** Wire the live reload callback once the tab surface can refresh safely. */
export function setRestoreRefresh(fn) {
  refresh = typeof fn === 'function' ? fn : null;
}

function loadSnaps() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPS_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Drop snapshots no journal entry references any more, then cap by age. */
function pruneSnaps(snaps) {
  const live = new Set(journalList().map((e) => e.rid).filter(Boolean));
  const kept = {};
  for (const [rid, payload] of Object.entries(snaps)) {
    if (!live.has(rid)) delete snaps[rid];
    else kept[rid] = payload;
  }
  const excess = Object.keys(kept).length - SNAPS_MAX;
  if (excess > 0) {
    for (const rid of Object.keys(kept).slice(0, excess)) delete kept[rid];
  }
  return kept;
}

/**
 * Stash the restore snapshot for one journal entry under `rid`. Best effort:
 * a full storage keeps journaling working and simply makes that entry's
 * restore fail honestly later.
 */
export function snapFor(rid, payload) {
  const id = String(rid || '');
  if (!id) return;
  try {
    const snaps = pruneSnaps(loadSnaps());
    snaps[id] = payload;
    localStorage.setItem(SNAPS_KEY, JSON.stringify(snaps));
  } catch { /* storage full - restore will report the missing snapshot */ }
}

function takeSnap(entry) {
  const rid = entry?.rid;
  if (!rid) throw new Error(t('providers.restore.snapMissing'));
  const snaps = loadSnaps();
  const payload = snaps[rid];
  if (!payload) throw new Error(t('providers.restore.snapMissing'));
  return payload;
}

async function afterChange() {
  if (refresh) await refresh();
}

// -- provider hooks -----------------------------------------------------------

/** Undo a providers.add: remove the record created at that time. */
async function undoProviderAdd(entry) {
  const snap = takeSnap(entry);
  const id = String(snap?.provider?.id ?? '');
  if (!id) throw new Error(t('providers.restore.snapMissing'));
  const list = await invoke('providers:list');
  if (!list.providers.some((p) => p.id === id)) {
    throw new Error(t('providers.restore.providerGone'));
  }
  await invoke('providers:delete', { id });
  // The vault entry is deliberately kept: destroying key material silently,
  // from a history panel, is not a trade this surface makes. The compensating
  // entry says so.
  const ref = snap.provider.keyRef;
  historyRecord('providers.delete', entry.target,
    ref ? t('providers.restore.detailKeyKept', { ref }) : t('providers.restore.detailNoKey'));
  await afterChange();
}

/** Undo a providers.update: write the pre-edit values back over the record. */
async function revertProviderUpdate(entry) {
  const snap = takeSnap(entry);
  const before = snap?.provider;
  if (!before?.id) throw new Error(t('providers.restore.snapMissing'));
  // Guard the create-path of providers:save: without this, undoing an edit
  // whose provider was deleted afterwards would resurrect the record.
  const current = await invoke('providers:list');
  if (!current.providers.some((p) => p.id === before.id)) {
    throw new Error(t('providers.restore.providerMissingForEdit'));
  }
  const saved = await invoke('providers:save', { provider: before });
  historyRecord('providers.update', saved?.name ?? before.name ?? entry.target,
    t('providers.restore.detailReverted'));
  await afterChange();
}

/** Undo a providers.delete: recreate the record with its previous values. */
async function restoreProviderDelete(entry) {
  const snap = takeSnap(entry);
  const before = snap?.provider;
  if (!before?.id) throw new Error(t('providers.restore.snapMissing'));
  const list = await invoke('providers:list');
  if (list.providers.some((p) => p.id === before.id)) {
    throw new Error(t('providers.restore.providerBack'));
  }
  const saved = await invoke('providers:save', { provider: before });
  // Routing rules removed by the original cascade deletion are not
  // resurrected here, and a vault key removed by the original delete cannot
  // come back either - the compensating detail states whichever applies.
  let detailKey = '';
  if (before.keyRef) {
    const has = await invoke('vault:has', { id: before.keyRef }).catch(() => false);
    detailKey = has
      ? t('providers.restore.detailKeyIntact', { ref: before.keyRef })
      : t('providers.restore.detailKeyGone', { ref: before.keyRef });
  }
  historyRecord('providers.add', saved?.name ?? before.name ?? entry.target,
    `${t('providers.restore.detailProviderRestored')}${detailKey ? ` ${detailKey}` : ''}`);
  await afterChange();
}

// -- rule hooks ---------------------------------------------------------------

function ruleLabel(rule) {
  if (!rule) return '?';
  return rule.matchType === 'catchall' ? '** (fallback)' : `${rule.matchType}:${rule.pattern ?? ''}`;
}

/** Undo a rule.add: remove the rule created at that time. */
async function undoRuleAdd(entry) {
  const snap = takeSnap(entry);
  const id = String(snap?.rule?.id ?? '');
  if (!id) throw new Error(t('providers.restore.snapMissing'));
  const list = await invoke('providers:list');
  if (!list.rules.some((r) => r.id === id)) throw new Error(t('providers.restore.ruleGone'));
  await invoke('providers:delete-rule', { id });
  historyRecord('rule.delete', entry.target, t('providers.restore.detailUndoRuleAdd'));
  await afterChange();
}

/** Undo a rule.update: write the pre-edit values back over the rule. */
async function revertRuleUpdate(entry) {
  const snap = takeSnap(entry);
  const before = snap?.rule;
  if (!before?.id) throw new Error(t('providers.restore.snapMissing'));
  // Same create-path guard as revertProviderUpdate: a rule deleted after the
  // edit must not be resurrected by an undo.
  const current = await invoke('providers:list');
  if (!current.rules.some((r) => r.id === before.id)) {
    throw new Error(t('providers.restore.ruleMissingForEdit'));
  }
  const saved = await invoke('providers:save-rule', { rule: before });
  historyRecord('rule.update', ruleLabel(saved), t('providers.restore.detailRuleReverted'));
  await afterChange();
}

/** Undo a rule.delete: recreate the rule with its previous values/priority. */
async function restoreRuleDelete(entry) {
  const snap = takeSnap(entry);
  const before = snap?.rule;
  if (!before?.id) throw new Error(t('providers.restore.snapMissing'));
  const list = await invoke('providers:list');
  if (list.rules.some((r) => r.id === before.id)) throw new Error(t('providers.restore.ruleBack'));
  const created = await invoke('providers:save-rule', { rule: before });
  historyRecord('rule.add', ruleLabel(created), t('providers.restore.detailRuleRestored'));
  await afterChange();
}

/** Undo a rules.reorder: rewrite priorities back to the stashed order. */
async function restoreRulesOrder(entry) {
  const snap = takeSnap(entry);
  const order = Array.isArray(snap?.order) ? snap.order : null;
  if (!order || order.length === 0) throw new Error(t('providers.restore.snapMissing'));
  await Promise.all(order.map((r) =>
    invoke('providers:save-rule', { rule: { id: r.id, priority: r.priority } })));
  historyRecord('rules.reorder', `${order.length}`, t('providers.restore.detailReordered'));
  await afterChange();
}

/** Register every Providers-lane restore hook. Called once at module load. */
export function registerProvidersRestore() {
  onRestore('providers.add', undoProviderAdd);
  onRestore('providers.update', revertProviderUpdate);
  onRestore('providers.delete', restoreProviderDelete);
  onRestore('rule.add', undoRuleAdd);
  onRestore('rule.update', revertRuleUpdate);
  onRestore('rule.delete', restoreRuleDelete);
  onRestore('rules.reorder', restoreRulesOrder);
}
