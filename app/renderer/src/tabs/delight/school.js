// Purpose: School mode - one universal, user-renamable switch stored in a
// dedicated main-process record every surface reads. Turning it on forces
// English presentation everywhere; turning it OFF requires the unlock
// credential (scrypt-verified in the vault). Wrong attempts are honestly
// rate-limited, and after three failures the unlock ladder is offered instead
// of the wait. Recovery (deleting the application-data folder) is stated in
// plain words wherever the lock can bite.
// Owned by Delight lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { invoke, on } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { openModal } from '../../core/dialogs.js';
import { toast, announce } from '../../core/toasts.js';
import { record as historyRecord } from '../../core/history.js';
import { dc, schoolActive, schoolLabel, getUserDataPath, refreshVocabCache } from './common.js';
import { offerLadder, ladderState } from './ladder.js';

// Live propagation of the shared record: main broadcasts after every school
// mutation; mirroring into the settings cache fires the change listeners that
// every open surface (i18n hooks included) reacts to.
let wired = false;
function wireSchoolBroadcasts() {
  if (wired) return;
  wired = true;
  on('delight-school', (p) => {
    if (!p || typeof p !== 'object') return;
    if (Boolean(settings.get('school.active', false)) !== Boolean(p.active)) {
      settings.set('school.active', Boolean(p.active)).catch(() => {});
    }
    if (String(settings.get('school.label', '') || '') !== String(p.label ?? '')) {
      settings.set('school.label', String(p.label ?? '')).catch(() => {});
    }
    settings.set('school.hasCredential', Boolean(p.hasCredential)).catch(() => {});
  });
}

/**
 * Render the School mode card into `container`. Re-renders live when the
 * shared record changes anywhere.
 */
export function renderSchoolSection(container) {
  wireSchoolBroadcasts();
  let unsub = null;
  const render = () => {
    if (unsub) unsub();
    container.replaceChildren();

    const name = schoolLabel();
    const active = schoolActive();
    let hasCred = Boolean(settings.get('school.hasCredential', false));

    const card = h('div', { class: 'm3-card m3-card--outlined mr-school-card' });
    card.append(h('h2', { class: 'm3-card__title' }, dc('dl.school.title')));
    card.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant);margin-top:0' }, dc('dl.school.desc')));

    // Rename ---------------------------------------------------------------
    const nameInput = h('input', {
      type: 'text',
      class: 'm3-textfield',
      value: String(settings.get('school.label', '') || ''),
      maxlength: '60',
      id: 'mr-school-name',
      'aria-label': t('dl.school.nameLabel'),
      placeholder: name,
    });
    const renameBtn = h('button', {
      class: 'm3-btn m3-btn--tonal',
      onclick: async () => {
        await invoke('vault:delight-school-set', { active, label: nameInput.value });
        historyRecord('settings changed', t('dl.school.nameLabel'), nameInput.value.trim() || name);
        toast(t('dl.common.saved'), '', { kind: 'success' });
      },
    }, t('dl.school.rename'));
    card.append(
      h('div', { class: 'mr-col', style: 'max-width:420px;margin-bottom:8px' },
        h('label', { for: 'mr-school-name', class: 'mr-typography-body-medium' }, t('dl.school.nameLabel')),
        h('div', { class: 'mr-row' }, nameInput, renameBtn),
        h('span', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, dc('dl.school.nameHint')),
      ),
    );

    // The one universal switch -----------------------------------------------
    if (!active) {
      const onBtn = h('button', {
        class: 'm3-btn m3-btn--filled',
        onclick: () => turnOn(),
      }, t('dl.school.turnOn'));
      card.append(h('div', { class: 'mr-row', style: 'flex-wrap:wrap;margin:8px 0' },
        h('span', { class: 'mr-typography-body-large' }, `${name}: off`), onBtn));
    } else {
      const offBtn = h('button', {
        class: 'm3-btn m3-btn--filled mr-school-offbtn',
        onclick: () => turnOffFlow(),
      }, t('dl.school.turnOff'));
      card.append(h('div', { class: 'mr-row', style: 'flex-wrap:wrap;margin:8px 0' },
        h('strong', {}, t('dl.school.switchOn', { name })), offBtn));
      card.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:4px 0 0' }, dc('dl.school.onSummary')));
    }

    // Credential + recovery facts ---------------------------------------------
    credRow().then((row) => card.append(row));
    getUserDataPath().then((p) => {
      card.append(h('p', { class: 'mr-typography-body-small mr-recovery-line', style: 'color:var(--md-sys-color-error);word-break:break-all' },
        dc('dl.school.recovery', { path: p })));
    });

    container.append(card);

    async function turnOn() {
      // A gated mode needs its credential to exist BEFORE it can bite.
      const ok = await ensureCredential({ titleText: t('dl.school.credRequired') });
      if (!ok) return;
      try {
        await invoke('vault:delight-school-set', { active: true });
        historyRecord('school mode on', name);
        announce(dc('dl.school.nowActive', { name }));
        toast(dc('dl.school.nowActive', { name }), '', { kind: 'info' });
        render();
      } catch (err) {
        toast(t('common.errorTitle'), err.message, { kind: 'error' });
      }
    }

    async function credRow() {
      try {
        hasCred = await invoke('vault:delight-credential-has', { scope: 'school' });
        settings.set('school.hasCredential', hasCred).catch(() => {});
      } catch { /* leave previous knowledge */ }
      const row = h('div', { class: 'mr-row', style: 'flex-wrap:wrap;border-top:1px solid var(--md-sys-color-outline-variant);padding-top:10px' });
      row.append(h('button', {
        class: 'm3-btn m3-btn--text',
        onclick: () => ensureCredential({ changing: true }),
      }, t('dl.school.credChange')));
      return row;
    }

    async function turnOffFlow() {
      const state = await ladderState('school');
      if (state.attempts >= 3 && (state.eligible || state.clockOnly)) {
        openUnlockDialog({ startWithLadderOffer: true, attempts: state.attempts, waitRemainingMs: state.waitRemainingMs });
      } else {
        openUnlockDialog({});
      }
    }
  };

  render();
  unsub = settings.onChange((key) => {
    if (key.startsWith('school.')) render();
  });

  // Live propagation from OTHER windows/sources of the shared record.
  invoke; // eslint no-op keeps import shape stable
}

/**
 * Create or change the school unlock credential. Resolves true when a
 * credential is confirmed present afterwards.
 */
export function ensureCredential({ changing = false, titleText = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let currentInput = null;
    const newInput = h('input', { type: 'password', class: 'mr-grow', autocomplete: 'new-password', 'aria-label': t('dl.school.newCred') });
    const confirmInput = h('input', { type: 'password', class: 'mr-grow', autocomplete: 'new-password', 'aria-label': t('dl.school.confirmCred') });
    const errorLine = h('p', { class: 'mr-typography-body-small', role: 'alert', style: 'color:var(--md-sys-color-error);min-height:16px;margin:4px 0 0' }, '');

    const body = h('div', { class: 'mr-col', style: 'gap:8px' });
    body.append(
      h('p', { class: 'mr-typography-body-medium', style: 'margin:0' }, titleText ?? t('dl.school.credRequired')),
    );
    const build = async () => {
      const has = await invoke('vault:delight-credential-has', { scope: 'school' }).catch(() => false);
      if (has) {
        currentInput = h('input', { type: 'password', class: 'mr-grow', autocomplete: 'current-password', 'aria-label': t('dl.school.currentCred') });
        body.append(fieldWrap(t('dl.school.currentCred'), currentInput));
      }
      body.append(
        fieldWrap(t('dl.school.newCred'), newInput),
        fieldWrap(t('dl.school.confirmCred'), confirmInput),
        errorLine,
      );
      queueMicrotask(() => (currentInput ?? newInput).focus());
    };
    build().catch(() => {});

    const dlg = openModal({
      title: changing ? t('dl.school.credChange') : t('dl.school.credSet'),
      body,
      onClose: () => { if (!settled) resolve(false); },
      actions: [
        { label: t('common.cancel'), kind: 'm3-btn--text', run: () => {} },
        {
          label: t('dl.school.credSet'),
          kind: 'm3-btn--filled',
          run: async () => {
            errorLine.textContent = '';
            if (newInput.value !== confirmInput.value) {
              errorLine.textContent = t('dl.school.confirmCred');
              return false;
            }
            try {
              await invoke('vault:delight-credential-set', {
                scope: 'school',
                password: newInput.value,
                currentPassword: currentInput?.value ?? '',
              });
              settings.set('school.hasCredential', true).catch(() => {});
              historyRecord('credential set', t('dl.common.sectionSchool'));
              settled = true;
              resolve(true);
              return true;
            } catch (err) {
              errorLine.textContent = err.code === 'CRED_MISMATCH'
                ? t('dl.school.wrongCredential')
                : err.message;
              return false;
            }
          },
        },
      ],
    });
    void dlg;
  });
}

function fieldWrap(label, input) {
  input.id ||= `mr-field-${Math.random().toString(36).slice(2)}`;
  return h('div', { class: 'mr-col', style: 'gap:2px' },
    h('label', { for: input.id, class: 'mr-typography-body-medium' }, label), input);
}

/**
 * The verify-to-turn-off dialog. Honest rate limiting, ladder offered after
 * three failures, and the Forgotten-password route into Support Tickets.
 */
function openUnlockDialog({ startWithLadderOffer = false, attempts = 0, waitRemainingMs = 0 } = {}) {
  let pwInput;
  let statusLine;
  let ladderBtnWrap;

  const name = schoolLabel();

  async function attempt() {
    statusLine.textContent = '';
    try {
      const r = await invoke('vault:delight-school-unlock', { password: pwInput.value });
      if (!r.ok) {
        // ipc.js strips custom fields from thrown errors, so expected
        // verification outcomes arrive as returned results.
        if (r.reason === 'rate-limited') return showLadderOffer(r.waitRemainingMs ?? 0, r.attempts ?? 3);
        const s = await ladderState('school');
        if (s.attempts >= 3 && s.eligible) return showLadderOffer(s.waitRemainingMs, s.attempts);
        statusLine.textContent = r.reason === 'missing'
          ? t('dl.school.credRequired')
          : (r.waitRemainingMs > 0
            ? t('dl.school.rateLimited', { seconds: String(Math.ceil(r.waitRemainingMs / 1000)) })
            : t('dl.school.wrongCredential'));
        announce(statusLine.textContent);
        return;
      }
      historyRecord('school mode off', name);
      toast(dc('dl.school.nowOff', { name }), '', { kind: 'success' });
      dlg.close();
      refreshVocabCache();
    } catch (err) {
      statusLine.textContent = err.message;
      announce(statusLine.textContent);
    }
  }

  function showLadderOffer(waitMs, tries) {
    ladderBtnWrap.replaceChildren();
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    statusLine.textContent = t('dl.school.rateLimited', { seconds: String(seconds) });
    ladderBtnWrap.append(h('button', {
      class: 'm3-btn m3-btn--tonal',
      onclick: () => {
        offerLadder({ scope: 'school' }).then((won) => {
          if (won) {
            // Waiting cleared only: back to the normal sign-in state.
            statusLine.textContent = t('dl.ladder.win');
            announce(t('dl.ladder.win'));
            ladderBtnWrap.replaceChildren();
          } else {
            ladderState('school').then((s2) => {
              statusLine.textContent = s2.clockOnly
                ? t('dl.ladder.clockBody', { seconds: String(Math.ceil(s2.waitRemainingMs / 1000)) })
                : t('dl.ladder.expired');
            });
          }
        });
      },
    }, `${t('dl.ladder.play')} (${tries})`));
  }

  const forgotBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => {
      window.dispatchEvent(new CustomEvent('mr:open-support-tickets', { detail: { topic: 'lockout' } }));
    },
  }, t('dl.locks.forgotLink'));

  const body = h('div', { class: 'mr-col', style: 'gap:8px' },
    h('p', { class: 'mr-typography-body-medium', style: 'margin:0' }, t('dl.school.unlockPrompt')),
  );
  pwInput = h('input', { type: 'password', class: 'mr-grow', autocomplete: 'current-password', 'aria-label': t('dl.school.unlockPassword') });
  body.append(fieldWrap(t('dl.locks.unlockPassword'), pwInput));
  statusLine = h('p', { class: 'mr-typography-body-small', role: 'alert', style: 'color:var(--md-sys-color-error);min-height:16px;margin:4px 0 0' }, '');
  body.append(statusLine);
  ladderBtnWrap = h('div', {});
  body.append(ladderBtnWrap);
  getUserDataPath().then((p) => body.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);word-break:break-all' }, t('dl.school.recovery', { path: p }))));
  body.append(forgotBtn);

  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

  const dlg = openModal({
    title: t('dl.school.unlockTitle', { name }),
    body,
    actions: [
      { label: t('common.cancel'), kind: 'm3-btn--text', run: () => {} },
      { label: t('common.ok'), kind: 'm3-btn--filled', run: () => { attempt(); return false; } },
    ],
  });
  queueMicrotask(() => pwInput.focus());

  if (startWithLadderOffer) showLadderOffer(waitRemainingMs, attempts, true);
}
