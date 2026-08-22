// Purpose: toy element locks. Every element that dispatches
// 'mr:tab-lock-element' can be locked with its own password OR its own TOTP
// credential (vault id convention lock:<elementId>, shared with the
// authenticator lane's id space). Anchored non-modal wizard beside the
// target, honest rate-limited unlocking with the ladder offered after three
// failures, per-lock unlock durations, a searchable manageable list, and the
// toy-not-security disclosure everywhere it matters.
// Owned by Delight lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { invoke } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { toast, announce } from '../../core/toasts.js';
import { record as historyRecord } from '../../core/history.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import { destructiveConfirmSuper } from './dialogs-super.js';
import { dc, schoolActive, getUserDataPath } from './common.js';
import { offerLadder, ladderState } from './ladder.js';

const state = {
  /** @type{Map<string,{label:string,method:string,durationKind:string,durationMinutes:number|null,unlockedUntil:number|null}>} */
  locks: new Map(),
};

async function refreshLocks() {
  try {
    const res = await invoke('vault:delight-lock-list');
    state.locks.clear();
    for (const l of res.locks ?? []) {
      state.locks.set(l.elementId, {
        label: l.label,
        method: l.method,
        durationKind: l.durationKind,
        durationMinutes: l.durationMinutes ?? null,
        unlockedUntil: l.unlockedUntil ? Number(l.unlockedUntil) : null,
      });
    }
  } catch { /* surfaces render empty honestly */ }
}

function isLocked(elementId) {
  const l = state.locks.get(elementId);
  if (!l) return false;
  if (l.unlockedUntil && Date.now() < Number(l.unlockedUntil)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Boot wiring (module side effects, run when the app imports this module).
// ---------------------------------------------------------------------------

let booted = false;
export function bootLocks() {
  if (booted) return;
  booted = true;

  window.addEventListener('mr:tab-lock-element', (e) => {
    const { tabId, anchor } = e.detail ?? {};
    openWizard({ elementId: tabId ? `tab:${tabId}` : deriveId(anchor), label: labelFor(tabId, anchor), anchor });
  });

  // Block activation of locked tab buttons before their own handlers run.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.mr-tab-btn');
    if (!btn) return;
    const id = `tab:${btn.dataset.tabId}`;
    if (!isLocked(id)) return;
    e.preventDefault();
    e.stopPropagation();
    openUnlockPrompt(id);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const btn = e.target.closest?.('.mr-tab-btn');
    if (!btn) return;
    const id = `tab:${btn.dataset.tabId}`;
    if (!isLocked(id)) return;
    e.preventDefault();
    e.stopPropagation();
    openUnlockPrompt(id);
  }, true);

  // Leaving the surface relocks surface-scoped unlocks.
  let lastActive = null;
  settings.onChange((key) => {
    if (key !== 'ui.tabstrip.activeId') return;
    const now = settings.get('ui.tabstrip.activeId', null);
    if (lastActive !== null && now !== lastActive) {
      for (const [id, l] of state.locks) {
        if (l.durationKind === 'surface' && !isLocked(id)) {
          invoke('vault:delight-lock-relock', { elementId: id }).then(refreshLocks).catch(() => {});
        }
      }
    }
    lastActive = now;
  });

  // Decorate locked tab buttons whenever the strip rebuilds.
  const observer = new MutationObserver(() => decorateStrip());
  const attachObserver = () => {
    const strip = document.getElementById('mr-tabstrip');
    if (strip) {
      observer.observe(strip, { childList: true, subtree: false });
      decorateStrip();
    } else {
      setTimeout(attachObserver, 200);
    }
  };
  attachObserver();

  refreshLocks().then(() => decorateStrip());
}

function deriveId(anchor) {
  if (anchor?.dataset?.mrLockId) return anchor.dataset.mrLockId;
  const text = (anchor?.textContent ?? '').trim().slice(0, 40);
  let hash = 5381;
  for (const ch of text) hash = ((hash << 5) + hash + ch.charCodeAt(0)) | 0;
  return `el:${(anchor?.tagName ?? 'node').toLowerCase()}${(hash >>> 0).toString(36)}`;
}

function labelFor(tabId, anchor) {
  if (anchor?.textContent) return anchor.textContent.trim().slice(0, 80);
  if (tabId) return String(tabId);
  return t('dl.locks.title');
}

function decorateStrip() {
  for (const btn of document.querySelectorAll('.mr-tab-btn')) {
    const id = `tab:${btn.dataset.tabId}`;
    const locked = isLocked(id);
    btn.classList.toggle('mr-tab-locked', locked);
    let badge = btn.querySelector('.mr-tab-btn__lock');
    if (locked && !badge) {
      badge = h('span', { class: 'mr-tab-btn__lock', 'aria-hidden': 'true' }, '🔒');
      badge.style.marginLeft = 'auto';
      btn.append(badge);
    } else if (!locked && badge) {
      badge.remove();
    }
    if (locked) {
      btn.setAttribute('aria-label', t('dl.locks.lockedAria', { label: btn.getAttribute('aria-label') || btn.dataset.tabId }));
    }
  }
}

// ---------------------------------------------------------------------------
// Anchored non-modal panel (paints its own surface, never covers its anchor)
// ---------------------------------------------------------------------------

function anchoredPanel(anchor, buildContent, { onClose = null } = {}) {
  const opener = anchor?.isConnected ? anchor : document.activeElement;
  const panel = h('div', {
    class: 'mr-anchorpanel',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': t('dl.locks.wizardTitle'),
  });

  function close() {
    panel.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', close);
    onClose?.();
    if (opener?.isConnected) opener.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      // Soft focus containment while open.
      const focusables = [...panel.querySelectorAll('button,input,select,[tabindex]:not([tabindex="-1"])')]
        .filter((n) => n.offsetParent !== null && !n.disabled);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function onOutside(e) {
    if (!panel.contains(e.target)) close();
  }

  panel.append(buildContent(close));
  document.body.append(panel);

  const r = (anchor?.getBoundingClientRect()) ?? { left: 80, bottom: 80, width: 0 };
  const pw = Math.min(420, window.innerWidth - 24);
  let left = r.left;
  let top = r.bottom + 8;
  requestAnimationFrame(() => {
    const ph = panel.getBoundingClientRect().height;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    left = Math.min(Math.max(8, left), window.innerWidth - pw - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${pw}px`;
    panel.classList.add('ready');
    panel.querySelector('input,select,button')?.focus();
  });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', close);
  return { close };
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export function openWizard({ elementId, label, anchor }) {
  let method = 'password';

  function content(close) {
    const wrap = h('div', { class: 'mr-col', style: 'gap:8px' });
    wrap.append(h('strong', {}, t('dl.locks.wizardTitle')));
    wrap.append(h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' },
      `${t('dl.locks.target')}: ${label}`));

    // Method radios ------------------------------------------------------------
    const methodRow = h('div', { role: 'radiogroup', 'aria-label': t('dl.locks.method'), class: 'mr-row' });
    const pwRadio = h('input', { type: 'radio', name: 'mr-lock-method', value: 'password', checked: true, id: 'mr-lock-m-pw' });
    const totpRadio = h('input', { type: 'radio', name: 'mr-lock-method', value: 'totp', id: 'mr-lock-m-totp' });
    methodRow.append(
      h('label', { class: 'm3-checkbox', for: 'mr-lock-m-pw' }, pwRadio, h('span', {}, t('dl.locks.methodPassword'))),
      h('label', { class: 'm3-checkbox', for: 'mr-lock-m-totp' }, totpRadio, h('span', {}, t('dl.locks.methodTotp'))),
    );
    pwRadio.addEventListener('change', () => switchMethod('password'));
    totpRadio.addEventListener('change', () => switchMethod('totp'));

    // Credential inputs -----------------------------------------------------------
    const credHost = h('div', {});
    const pwInput = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': t('dl.locks.password1') });
    const totpSecret = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('dl.locks.totpSecret'), placeholder: 'JBSWY3DPEHPK3PXP' });
    const totpConfirm = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': t('dl.locks.totpConfirm') });
    const errorLine = h('p', { role: 'alert', class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-error);min-height:16px;margin:0' }, '');

    function fieldSetTotp() {
      return h('div', { class: 'mr-col', style: 'gap:6px' },
        labelled(t('dl.locks.totpSecret'), totpSecret),
        labelled(t('dl.locks.totpConfirm'), totpConfirm),
        h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:0' }, t('dl.locks.totpNote')),
      );
    }
    function switchMethod(m) {
      method = m;
      credHost.replaceChildren(...(m === 'password'
        ? [labelled(t('dl.locks.password1'), pwInput)]
        : [fieldSetTotp()]));
    }

    // Duration -----------------------------------------------------------------------
    const durSelect = h('select', { class: 'm3-select', 'aria-label': t('dl.locks.duration'), style: 'min-width:220px' },
      h('option', { value: 'surface' }, t('dl.locks.durSurface')),
      h('option', { value: 'minutes' }, t('dl.locks.durMinutes')),
      h('option', { value: 'session' }, t('dl.locks.durSession')),
    );
    const minutesInput = h('input', { type: 'number', min: '1', max: '10080', value: '15', class: 'm3-textfield', 'aria-label': t('dl.locks.minutes'), disabled: true, style: 'width:90px' });
    durSelect.addEventListener('change', () => { minutesInput.disabled = durSelect.value !== 'minutes'; });

    async function create() {
      errorLine.textContent = '';
      const id = elementId;
      try {
        if (method === 'password') {
          if (pwInput.value.length < 4) throw new Error(t('dl.locks.password1'));
          await invoke('vault:delight-credential-set', { scope: id, password: pwInput.value });
        } else {
          let secret = totpSecret.value.trim();
          const uriMatch = /^otpauth:\/\/totp\/[^?]*\?secret=([A-Za-z2-7]+)$/i.exec(secret);
          if (uriMatch) secret = uriMatch[1];
          await invoke('vault:delight-totp-set', { elementId: id, secret });
          const check = await invoke('vault:delight-totp-verify', { elementId: id, code: totpConfirm.value });
          if (!check.ok) throw new Error(t('dl.locks.totpConfirm'));
        }
        await invoke('vault:delight-lock-add', {
          lock: {
            elementId: id,
            label,
            method,
            durationKind: durSelect.value,
            durationMinutes: durSelect.value === 'minutes' ? Number(minutesInput.value) : null,
          },
        });
        historyRecord('lock added', label);
        toast(t('common.ok'), `${t('dl.locks.title')}: ${label}`, { kind: 'success' });
        await refreshLocks();
        decorateStrip();
        close();
      } catch (err) {
        errorLine.textContent = err.message;
      }
    }

    const createBtn = h('button', { class: 'm3-btn m3-btn--filled', onclick: create }, t('dl.locks.create'));
    const cancelBtn = h('button', { class: 'm3-btn m3-btn--text', onclick: close }, t('common.cancel'));

    wrap.append(
      methodRow,
      credHost,
      h('div', { class: 'mr-row', style: 'flex-wrap:wrap' }, durSelect, minutesInput),
      errorLine,
      h('p', { class: 'mr-typography-body-small mr-toy-line', style: 'margin:0' }, dc('dl.locks.toyLine')),
      recoveryLine(),
      h('div', { class: 'mr-row', style: 'flex-wrap:wrap;margin-top:4px' }, createBtn, cancelBtn),
    );
    switchMethod('password');
    pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    return wrap;
  }

  anchoredPanel(anchor, content);
}

function labelled(text, control) {
  control.id ||= `mr-lf-${Math.random().toString(36).slice(2, 8)}`;
  return h('div', { class: 'mr-col', style: 'gap:2px' },
    h('label', { for: control.id, class: 'mr-typography-body-medium' }, text), control);
}

function recoveryLine() {
  const p = h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' });
  getUserDataPath().then((path) => { p.textContent = dc('dl.locks.recovery', { path }); });
  return p;
}

// ---------------------------------------------------------------------------
// Unlock prompt
// ---------------------------------------------------------------------------

export function openUnlockPrompt(elementId, anchor = null) {
  const lock = state.locks.get(elementId);
  if (!lock) return;
  const anchorEl = anchor ?? document.getElementById(`mr-tab-btn-${elementId.slice(4)}`);

  anchoredPanel(anchorEl, (close) => {
    const wrap = h('div', { class: 'mr-col', style: 'gap:8px' });
    wrap.append(h('strong', {}, t('dl.locks.unlockTitle')));
    wrap.append(h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' }, lock.label));

    const status = h('p', { role: 'alert', class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-error);min-height:16px;margin:0' }, '');
    let input;
    if (lock.method === 'totp') {
      input = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': t('dl.locks.unlockCode') });
    } else {
      input = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': t('dl.locks.unlockPassword') });
    }
    const ladderWrap = h('div', {});

    async function attempt() {
      status.textContent = '';
      try {
        // Expected outcomes arrive as returned results (ipc.js strips custom
        // fields from thrown errors).
        const r = lock.method === 'totp'
          ? await invoke('vault:delight-totp-verify', { elementId, code: input.value })
          : await invoke('vault:delight-credential-verify', { scope: elementId, password: input.value });
        if (!r.ok) {
          if (r.reason === 'rate-limited') return showLadder(r.waitRemainingMs ?? 0, r.attempts ?? 3);
          const s = await ladderState(elementId);
          if (s.attempts >= 3 && s.eligible) return showLadder(s.waitRemainingMs, s.attempts);
          status.textContent = r.reason === 'missing'
            ? t('dl.locks.totpNote')
            : (r.waitRemainingMs > 0
              ? t('dl.locks.rateLimited', { seconds: String(Math.ceil(r.waitRemainingMs / 1000)) })
              : t('dl.locks.wrong', { attempts: String((r.attempts ?? 0) + 1) }));
          announce(status.textContent);
          return;
        }
        const dur = await applyUnlockChoice(elementId);
        await refreshLocks();
        decorateStrip();
        historyRecord('unlocked', lock.label);
        toast(t('common.ok'), `${lock.label}${dur ? ` (${dur})` : ''}`, { kind: 'success' });
        close();
      } catch (err) {
        status.textContent = err.message;
        announce(status.textContent);
      }
    }

    function showLadder(waitMs, tries) {
      status.textContent = t('dl.locks.rateLimited', { seconds: String(Math.max(1, Math.ceil(waitMs / 1000))) });
      ladderWrap.replaceChildren(h('button', {
        class: 'm3-btn m3-btn--tonal',
        onclick: () => offerLadder({ scope: elementId }).then((won) => {
          if (won) {
            status.textContent = '';
            announce(t('dl.ladder.win'));
          } else {
            status.textContent = t('dl.ladder.expired');
          }
        }),
      }, `${t('dl.ladder.play')} (${tries})`));
    }

    async function applyUnlockChoice(id) {
      // The duration chosen when the lock was created governs each unlock.
      const l = state.locks.get(id);
      const kind = l?.durationKind ?? 'minutes';
      const minutes = Number(l?.durationMinutes ?? 15);
      await invoke('vault:delight-lock-mark-unlocked', { elementId: id, durationKind: kind, minutes });
      return kind === 'session'
        ? t('dl.locks.durSession')
        : (kind === 'surface' ? t('dl.locks.durSurface') : `${minutes} ${t('dl.locks.minutes')}`);
    }

    const unlockBtn = h('button', { class: 'm3-btn m3-btn--filled', onclick: attempt }, t('dl.locks.unlock'));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

    const forgotBtn = h('button', {
      class: 'm3-btn m3-btn--text m3-btn--sm',
      onclick: () => window.dispatchEvent(new CustomEvent('mr:open-support-tickets', { detail: { topic: 'lockout' } })),
    }, t('dl.locks.forgotLink'));

    wrap.append(
      labelled(lock.method === 'totp' ? t('dl.locks.unlockCode') : t('dl.locks.unlockPassword'), input),
      status,
      ladderWrap,
      forgotBtn,
      recoveryLine(),
      unlockBtn,
    );
    queueMicrotask(() => input.focus());
    return wrap;
  });
}

// ---------------------------------------------------------------------------
// Manage list (rendered inside the Delight tab)
// ---------------------------------------------------------------------------

export function renderLocksSection(container) {
  const card = h('div', { class: 'm3-card m3-card--outlined' });
  card.append(h('h2', { class: 'm3-card__title' }, dc('dl.locks.section')));
  card.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant);margin-top:0' }, dc('dl.locks.desc')));

  const listEl = h('div', { class: 'mr-col', style: 'gap:4px' });
  const search = createSearchBar({
    placeholder: t('dl.locks.searchPlaceholder'),
    label: t('dl.locks.searchPlaceholder'),
    onQuery: () => renderList(),
  });

  function renderList() {
    listEl.replaceChildren();
    const q = search.get();
    const rows = [...state.locks.entries()].filter(([id, l]) => matchesQuery(q, `${l.label} ${id}`));
    if (rows.length === 0) {
      listEl.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, t('dl.locks.listEmpty')));
      return;
    }
    for (const [id, l] of rows) {
      const removeBtn = h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        style: 'color:var(--md-sys-color-error)',
        onclick: async () => {
          const ok = await destructiveConfirmSuper({
            title: t('dl.locks.removeConfirmTitle'),
            body: t('dl.locks.removeConfirmBody', { label: l.label }),
            confirmLabel: t('dl.locks.remove'),
          });
          if (!ok) return;
          await invoke('vault:delight-lock-remove', { elementId: id });
          await refreshLocks();
          decorateStrip();
          historyRecord('lock removed', l.label);
          renderList();
        },
      }, t('dl.locks.remove'));
      const lockedNow = isLocked(id);
      listEl.append(h('div', { class: 'mr-row mr-lock-row' },
        h('span', { class: 'mr-grow' }, l.label),
        h('span', { class: 'mr-typography-label-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
          lockedNow ? t('dl.locks.lockedTag') : t('dl.locks.unlockedTag')),
        removeBtn,
      ));
    }
  }

  card.append(search.el, listEl, recoveryLine());
  container.append(card);
  refreshLocks().then(renderList);
}
