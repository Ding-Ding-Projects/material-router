/* Toy locks on tabs: password OR local TOTP, one credential per lock,
   stored only in this browser. A user-experience speed bump, not security:
   the stated recovery is clearing this site's storage in the browser.
   Lockout waits escalate and are cleared by the unlock ladder — which ends
   the waiting only and never the credential. */

import { el, uid, fmtDateTime } from './util.js';
import { hashPassword, verifyTotp, parseOtpauth } from './totp.js';
import { runLadder, computeWaitSeconds } from './ladder.js';
import { t } from './i18n.js';

const STORE_KEY = 'tab-locks';

export function registerLockBundle(addBundle) {
  addBundle('locks', {
    en: {
      'lk.create': 'Lock this tab…',
      'lk.title': 'Create a tab lock',
      'lk.method': 'Method',
      'lk.password': 'Password',
      'lk.totp': 'Authenticator code (TOTP)',
      'lk.secret': 'Secret (paste an otpauth:// URI or a base32 secret)',
      'lk.duration': 'Unlock lasts',
      'lk.dur.this': 'This page visit only',
      'lk.dur.min': 'Minutes',
      'lk.dur.session': 'Until the browser closes',
      'lk.disclosure': 'Just for fun: this is a self-imposed speed bump, not encryption and not protection from anyone else using this computer. Forgotten it? Clear this site\'s browser storage to reset every lock.',
      'lk.unlock': 'This tab is locked',
      'lk.enterPw': 'Enter password',
      'lk.enterCode': 'Enter the 6-digit code',
      'lk.try': 'Try',
      'lk.wrong': 'That did not match. The recovery route is clearing this site\'s browser storage.',
      'lk.waiting': 'Too many tries — wait, or clear the ladder below.',
      'lk.lockedBadge': 'Locked',
      'lk.manage': 'Tab locks',
      'lk.remove': 'Remove lock',
      'lk.change': 'Change credential',
      'lk.none': 'No locks yet. Right-click any tab to add one.',
      'lk.unlockBtn': 'Unlock…',
      'lk.pwshort': 'Use at least 4 characters.',
    },
    zh: {
      'lk.create': '鎖上呢個分頁……',
      'lk.title': '整一個分頁鎖',
      'lk.method': '方法',
      'lk.password': '密碼',
      'lk.totp': '驗證器一次性密碼（TOTP）',
      'lk.secret': '秘密碼（貼 otpauth:// 條link或者 base32 秘密都得）',
      'lk.duration': '解鎖有效期',
      'lk.dur.this': '淨係呢次瀏覽',
      'lk.dur.min': '若干分鐘',
      'lk.dur.session': '直至個瀏覽器閂埋',
      'lk.disclosure': '純粹好玩：呢個係自己畀自己嘅小關卡，唔係加密，亦保護唔到俾第二個人用呢部機。唔記得咗？清走呢個網站喺瀏覽器嘲儲存，全部鎖就會重置。',
      'lk.unlock': '呢個分頁上咗鎖',
      'lk.enterPw': '輸入密碼',
      'lk.enterCode': '輸入六位數碼',
      'lk.try': '試下',
      'lk.wrong': '對唔上喎。補救方法係清除呢個網站喺瀏覽器嘅儲存。',
      'lk.waiting': '試太多次 —— 等一陣，或者玩下面個梯階。',
      'lk.lockedBadge': '已上鎖',
      'lk.manage': '分頁鎖',
      'lk.remove': '移除鎖',
      'lk.change': '換憑證',
      'lk.none': '仲未有鎖。右擊任何分頁就可以加。',
      'lk.unlockBtn': '解鎖……',
      'lk.pwshort': '起碼四個字符。',
    },
  });
}

export function listLocks() {
  try { return JSON.parse(localStorage.getItem(`mr-site:${STORE_KEY}`) || '{}'); }
  catch { return {}; }
}
function saveLocks(locks) {
  localStorage.setItem(`mr-site:${STORE_KEY}`, JSON.stringify(locks));
}
export function getLock(tabId) { return listLocks()[tabId] || null; }

/* Create a lock for a tab. Opens its own anchored wizard dialog. */
export function createLockWizard(tabId, tabTitle, onDone) {
  const scrim = el('div', { class: 'modal-scrim' });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lock-wizard-title' });

  const methodSel = el('select', { class: 'mr-select', id: 'lw-method' },
    ['password', 'totp'].map((v) => el('option', { value: v, text: t(v === 'password' ? 'lk.password' : 'lk.totp') })));
  const pwIn = el('input', { type: 'password', class: 'mr-input', id: 'lw-pw', autocomplete: 'new-password' });
  const secretIn = el('input', { type: 'text', class: 'mr-input mono', id: 'lw-secret', spellcheck: 'false' });
  const durSel = el('select', { class: 'mr-select', id: 'lw-dur' },
    [['visit', t('lk.dur.this')], ['min5', `5 ${t('lk.dur.min')}`], ['min15', `15 ${t('lk.dur.min')}`], ['session', t('lk.dur.session')]]
      .map(([v, l]) => el('option', { value: v, text: l })));

  const secretRow = el('label', { class: 'setting-label', hidden: '' }, [document.createTextNode(t('lk.secret')), secretIn]);
  const pwRow = el('label', { class: 'setting-label' }, [document.createTextNode(t('lk.enterPw')), pwIn]);
  methodSel.addEventListener('change', () => {
    const isPw = methodSel.value === 'password';
    pwRow.hidden = !isPw;
    secretRow.hidden = isPw;
  });

  const err = el('p', { class: 'form-error', role: 'alert', hidden: '' });
  const disclosure = el('p', { class: 'modal-hint', text: t('lk.disclosure') });

  async function submit() {
    err.hidden = true;
    const now = Date.now();
    if (methodSel.value === 'password') {
      if (pwIn.value.length < 4) {
        err.textContent = t('lk.pwshort');
        err.hidden = false;
        return;
      }
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const verifier = await hashPassword(pwIn.value, salt);
      save(tabId, { kind: 'password', salt, verifier, createdAt: now, duration: durSel.value }, tabTitle);
    } else {
      let parsed = parseOtpauth(secretIn.value.trim());
      let secret = parsed ? parsed.secret : secretIn.value.trim();
      const digits = parsed ? parsed.digits : 6;
      const period = parsed ? parsed.period : 30;
      if (!/^[A-Z2-7=\s-]+$/i.test(secret) || secret.replace(/[\s-=]/g, '').length < 8) {
        err.hidden = false;
        return;
      }
      save(tabId, { kind: 'totp', secret: secret.toUpperCase(), digits, period, createdAt: now, duration: durSel.value }, tabTitle);
    }
    close();
    if (onDone) onDone();
  }

  function save(id, lockRecord, titleForLog) {
    const locks = listLocks();
    locks[id] = { ...lockRecord, tabTitle: titleForLog };
    saveLocks(locks);
    appendJournal({
      action: 'lock-created',
      labelKey: null,
      label: `${t('lk.create')} «${titleForLog}»`,
    });
  }

  const actions = el('div', { class: 'modal-actions' });
  const cancelBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('dlg.cancel') });
  cancelBtn.addEventListener('click', close);
  const okBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--filled', text: t('lk.create') });
  okBtn.addEventListener('click', submit);
  actions.append(cancelBtn, okBtn);

  box.append(
    el('h2', { id: 'lock-wizard-title', class: 'modal-title', text: t('lk.title') }),
    el('p', { class: 'modal-target mono', text: `« ${tabTitle} »` }),
    el('label', { class: 'setting-label' }, [document.createTextNode(t('lk.method')), methodSel]),
    pwRow, secretRow,
    el('label', { class: 'setting-label' }, [document.createTextNode(t('lk.duration')), durSel]),
    disclosure, err, actions,
  );
  scrim.append(box);
  document.body.append(scrim);
  const prevFocus = document.activeElement;
  const escHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', escHandler);
  function close() {
    scrim.remove();
    document.removeEventListener('keydown', escHandler);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }
  pwIn.focus();
}

function appendJournal(entry) {
  // history journal integration without a circular import
  document.dispatchEvent(new CustomEvent('site-history-record', { detail: entry }));
}

function unlockDurationExpired(lock) {
  if (!lock || !lock.unlockedUntil) return true;
  return Date.now() > lock.unlockedUntil;
}

/* Is a tab currently usable? */
export function isUnlocked(tabId) {
  const session = JSON.parse(sessionStorage.getItem(`mr-site:unlock-${tabId}`) || 'null');
  const lock = getLock(tabId);
  if (!lock) return true;
  if (session && Date.now() < session.until) return true;
  if (sessionStorage.getItem(`mr-site:unlock-${tabId}`)) sessionStorage.removeItem(`mr-site:unlock-${tabId}`);
  return false;
}

/* Anchored unlock prompt beside the locked element; runs the ladder during waits. */
export function promptUnlock(tabId, tabTitle, anchorEl, onSuccess) {
  const lock = getLock(tabId);
  if (!lock) return;
  const scrim = el('div', { class: 'modal-scrim' });
  const box = el('div', { class: 'modal modal--anchored', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'unlock-title' });

  const input = el('input', {
    type: lock.kind === 'password' ? 'password' : 'text',
    class: 'mr-input',
    autocomplete: 'off',
    inputmode: lock.kind === 'totp' ? 'numeric' : undefined,
    maxlength: lock.kind === 'totp' ? String(lock.digits || 6) : undefined,
  });
  input.setAttribute('aria-label', lock.kind === 'password' ? t('lk.enterPw') : t('lk.enterCode'));
  const msg = el('p', { class: 'form-error', role: 'alert', hidden: '' });
  const ladderMount = el('div', {});
  const err2 = el('p', { class: 'form-error', hidden: '' });

  let waiting = false;
  let waitTimer = null;

  async function attempt() {
    if (waiting) return;
    msg.hidden = true;
    let ok = false;
    if (lock.kind === 'password') {
      const candidate = await hashPassword(input.value, lock.salt);
      ok = candidate === lock.verifier;
    } else {
      ok = await verifyTotp(lock.secret, input.value.trim(), { digits: lock.digits || 6, period: lock.period || 30 });
    }
    if (ok) {
      const untilByDur = {
        visit: Date.now() + 1000 * 60 * 60 * 12,
        min5: Date.now() + 1000 * 60 * 5,
        min15: Date.now() + 1000 * 60 * 15,
        session: 10 ** 13,
      };
      sessionStorage.setItem(`mr-site:unlock-${tabId}`, JSON.stringify({ until: untilByDur[lock.duration] || Date.now() }));
      sessionStorage.removeItem('mr-site:failcount');
      appendJournal({ action: 'unlocked', label: `${t('lk.unlock')} «${tabTitle}»` });
      close();
      if (onSuccess) onSuccess();
      return;
    }
    const fails = Number(sessionStorage.getItem('mr-site:failcount') || '0') + 1;
    sessionStorage.setItem('mr-site:failcount', String(fails));
    msg.textContent = t('lk.wrong');
    msg.hidden = false;
    input.value = '';
    if (fails >= 3) {
      waiting = true;
      err2.textContent = t('lk.waiting');
      err2.hidden = false;
      const seconds = computeWaitSeconds(fails);
      runLadder(ladderMount, {
        secondsLeft: seconds,
        onCleared() {
          waiting = false;
          err2.hidden = true;
          ladderMount.textContent = '';
          input.focus();
        },
      });
    }
  }

  const tryBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--filled', text: t('lk.try') });
  tryBtn.addEventListener('click', attempt);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

  const recovery = el('button', {
    type: 'button', class: 'mr-btn mr-btn--text',
    text: t('support.forgot', 'Forgotten your password?'),
  });
  recovery.addEventListener('click', () => {
    import('./support-tickets.js').then((m) => m.openSupportTickets()).catch(() => { /* never blocks */ });
  });

  const actions = el('div', { class: 'modal-actions' });
  const cancelBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('dlg.cancel') });
  cancelBtn.addEventListener('click', () => close());
  actions.append(cancelBtn, recovery, tryBtn);

  box.id = '';
  box.append(
    (() => { const h = el('h2', { class: 'modal-title', text: t('lk.unlock'), id: 'unlock-title' }); h.id = 'unlock-title'; return h; })(),
    el('p', { class: 'modal-target mono', text: `« ${tabTitle} »` }),
    input, msg, err2, ladderMount, disclosureLine(), actions,
  );
  scrim.append(box);
  document.body.append(scrim);
  setTimeout(() => { try { box.style.top = ''; } catch { /* layout */ } }, 0);
  const prevFocus = document.activeElement;
  const escHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', escHandler);
  function close() {
    clearInterval(waitTimer);
    scrim.remove();
    document.removeEventListener('keydown', escHandler);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }
  input.focus();
}

function disclosureLine() {
  return el('p', { class: 'modal-hint', text: t('lk.disclosure') });
}

/* Manage existing locks (list, remove). */
export function buildLockManager(mount, onChanged) {
  mount.textContent = '';
  const locks = listLocks();
  const ids = Object.keys(locks);
  if (!ids.length) {
    mount.append(el('p', { class: 'empty-state', text: t('lk.none') }));
    return;
  }
  for (const id of ids) {
    const rec = locks[id];
    const rowEl = el('div', { class: 'centre-row' }, [
      el('div', { class: 'centre-row-main' }, [
        el('div', { class: 'centre-row-title', text: rec.tabTitle || id }),
        el('div', { class: 'centre-row-body', text: `${rec.kind} · ${fmtDateTime(rec.createdAt)}` }),
      ]),
    ]);
    const rm = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('lk.remove') });
    rm.addEventListener('click', () => {
      const all = listLocks();
      delete all[id];
      saveLocks(all);
      appendJournal({ action: 'lock-removed', label: `${t('lk.remove')} «${rec.tabTitle || id}»` });
      buildLockManager(mount, onChanged);
      if (onChanged) onChanged();
    });
    rowEl.append(rm);
    mount.append(rowEl);
  }
}
