// Purpose: the auto-update surface for the renderer - a persistent,
// non-blocking ready banner (GitHub-Desktop style) plus localized toasts for
// every honest failure state, and the manual Check-for-updates command in
// the palette.
//
// The update feed is UNSIGNED, permanently by project policy, and this
// surface says so wherever an installer is offered. Restarting installs the
// staged Squirrel package detached and quits this instance; it happens only
// after the user chooses Restart AND any registered unsaved-work guard
// passes. Nothing here ever installs without that explicit choice.
//
// Integration seam: import this module once from src/app.js. Import alone
// initializes it (idempotent), so the wiring line stays one line long.

import { h } from './util.js';
import { invoke, on } from './bridge.js';
import { addBundle, copy, languageMode } from './i18n.js';
import * as palette from './palette.js';
import * as toasts from './toasts.js';
import * as history from './history.js';

// ---------------------------------------------------------------------------
// Copy: en + zh-HK colloquial. Facts (versions, messages, what will happen)
// stay exact at every funny level; flourishes may decorate around them.
// ---------------------------------------------------------------------------

const BUNDLE = {
  en: {
    bannerAria: 'Update available',
    bannerTitle: 'Version {version} is ready to install',
    unsignedWarning: 'This update is not code-signed (project policy). It comes over HTTPS and its digest was checked against the release manifest.',
    restartToInstall: 'Restart to install update',
    later: 'Later',
    releaseNotes: 'Release notes',
    checkUpdates: 'Check for updates',
    checking: 'Checking for updates…',
    upToDate: 'You are on the latest version.',
    available: 'Update {version} found. Downloading in the background.',
    failed: 'Update check failed: {message}. Nothing was changed or staged.',
    stagedCorrupt: 'The downloaded update did not match its recorded digest and was deleted. Nothing was staged.',
    cancelDownload: 'Cancel update download',
    cancelled: 'Update download cancelled. Nothing was staged.',
    installing: 'Restarting to install version {version}…',
    installFailed: 'Could not start the installation: {message}',
    disabledNote: 'Automatic updates are switched off in settings.',
  },
  zh: {
    bannerAria: '有更新裝緊',
    bannerTitle: '{version} 版本已經準備好安裝',
    unsignedWarning: '呢個更新冇簽名（項目政策係咁）。佢行 HTTPS 下載，而且已經同發布清單核對咗摘要。',
    restartToInstall: '重新開機嚟安裝',
    later: '遲啲先',
    releaseNotes: '版本說明',
    checkUpdates: '檢查更新',
    checking: '睇緊有冇更新…',
    upToDate: '你已經用緊最新版本。',
    available: '搵到 {version} 更新，背景下載緊。',
    failed: '檢查更新失敗：{message}。乜都冇改過、冇裝過。',
    stagedCorrupt: '下載咗嘅更新同記錄嘅摘要對唔上，已經刪咗。乜都冇留低。',
    cancelDownload: '取消下載更新',
    cancelled: '已經取消下載更新，乜都冇留低。',
    installing: '重新開機安裝 {version} 當中…',
    installFailed: '開唔到安裝程序：{message}',
    disabledNote: '自動更新喺設定入面已經關咗。',
  },
};

addBundle('plumbing', BUNDLE);

const SNOOZE_KEY = 'mr.updates.snoozedVersion';

const state = {
    initialized: false,
    bannerEl: null,
    lastErrorToast: '',
};

/** Guards run before Restart; return false (or a promise resolving false) to veto. */
const beforeInstallGuards = new Set();

/** Register an async unsaved-work guard. Return false to veto the restart. */
export function onBeforeInstall(fn) {
  if (typeof fn === 'function') beforeInstallGuards.add(fn);
  return () => beforeInstallGuards.delete(fn);
}

async function passesGuards() {
  for (const guard of [...beforeInstallGuards]) {
    let verdict = true;
    try {
      verdict = await guard();
    } catch {
      verdict = false; // a throwing guard vetoes, never waves through
    }
    if (!verdict) return false;
  }
  return true;
}

function snoozed(version) {
  try {
    return localStorage.getItem(SNOOZE_KEY) === String(version ?? '');
  } catch {
    return false;
  }
}

function setSnooze(version) {
  try {
    localStorage.setItem(SNOOZE_KEY, String(version ?? ''));
  } catch {
    /* storage unavailable - snooze just does not persist */
  }
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function removeBanner() {
  state.bannerEl?.remove();
  state.bannerEl = null;
}

function showReadyBanner(status) {
  const version = String(status.version ?? '');
  if (!version || snoozed(version)) return;

  removeBanner();

  const notesBtn = status.notesUrl
    ? h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm',
        'aria-label': copy('plumbing.releaseNotes'),
        onclick: () => invoke('shell:open-external', { url: status.notesUrl }).catch(() => {}),
      }, copy('plumbing.releaseNotes'))
    : null;

  const restartBtn = h('button', {
    class: 'm3-btn m3-btn--filled m3-btn--sm',
    'aria-label': copy('plumbing.restartToInstall'),
    onclick: () => restartIntoUpdate(status),
  }, copy('plumbing.restartToInstall'));

  const laterBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    'aria-label': copy('plumbing.later'),
    onclick: () => {
      setSnooze(version);
      history.record('update-snoozed', `v${version}`, copy('plumbing.later'));
      removeBanner();
    },
  }, copy('plumbing.later'));

  state.bannerEl = h('div', {
    id: 'mr-updater-banner',
    role: 'status',
    'aria-live': 'polite',
    'aria-label': copy('plumbing.bannerAria'),
    style: [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',
      'bottom:20px',
      'z-index:60',
      'max-width:min(560px, calc(100vw - 32px))',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'padding:14px 16px',
      'border-radius:var(--md-sys-shape-corner-md, 12px)',
      'background:var(--md-sys-color-surface-container-high)',
      'color:var(--md-sys-color-on-surface)',
      'border:1px solid var(--md-sys-color-outline-variant)',
      'box-shadow:var(--md-sys-elevation-2)',
      'font-family:inherit',
    ].join(';'),
  },
    h('strong', { style: 'font-size:14px' }, copy('plumbing.bannerTitle', { version })),
    h('div', {
      style: 'font-size:12px;line-height:1.45;color:var(--md-sys-color-on-surface-variant)',
    }, copy('plumbing.unsignedWarning')),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end' },
      notesBtn,
      laterBtn,
      restartBtn,
    ),
  );

  document.body.append(state.bannerEl);
}

async function restartIntoUpdate(status) {
  // Unsaved-work protection runs first; a veto keeps everything as it was.
  if (!(await passesGuards())) return;
  history.record('update-install', `v${status.version}`, copy('plumbing.restartToInstall'));
  try {
    await invoke('shell:updater-install');
    toasts.toast(copy('plumbing.installing', { version: status.version }), '', { kind: 'info' });
    removeBanner();
  } catch (err) {
    toasts.toast(copy('plumbing.installFailed', { message: err?.message ?? 'unknown error' }), '', { kind: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Status handling + manual check
// ---------------------------------------------------------------------------

let lastKnownStatus = null;

function handleStatus(status) {
  if (!status || typeof status !== 'object') return;
  lastKnownStatus = status;

  switch (status.state) {
    case 'ready':
      showReadyBanner(status);
      break;
    case 'error':
      removeBanner();
      announceFailure(status);
      break;
    case 'idle':
      // Covers cancellation and rollback: the main process deleted anything
      // partial before returning to idle, and the cancelling surface (the
      // palette command below) announces that itself.
      removeBanner();
      break;
    default:
      break;
  }
}

function announceFailure(status) {
  const message = String(status.error ?? 'unknown error');
  const digestShaped = /digest|manifest/i.test(message);
  const key = digestShaped ? 'plumbing.stagedCorrupt' : 'plumbing.failed';
  const text = copy(key, { message });
  // One toast per distinct failure, not one per broadcast repeat.
  if (state.lastErrorToast === text) return;
  state.lastErrorToast = text;
  toasts.toast(copy('plumbing.checkUpdates'), text, { kind: 'error' });
}

async function manualCheck() {
  toasts.toast(copy('plumbing.checking'), '', { kind: 'info', timeout: 2500 });
  let status;
  try {
    status = await invoke('shell:updater-check');
  } catch (err) {
    toasts.toast(copy('plumbing.failed', { message: err?.message ?? 'unknown error' }), '', { kind: 'error' });
    return;
  }
  history.record('update-check', `v${status.currentVersion ?? ''}`, status.state);

  if (status.state === 'error') {
    announceFailure(status);
    return;
  }
  if ((status.state === 'available' || status.state === 'downloading' || status.state === 'ready') && status.version) {
    if (status.state !== 'ready') {
      toasts.toast(copy('plumbing.available', { version: status.version }), '', { kind: 'info' });
    }
    handleStatus(status);
    return;
  }
  if (!status.enabled) {
    toasts.toast(copy('plumbing.disabledNote'), '', { kind: 'info' });
    return;
  }
  toasts.toast(copy('plumbing.upToDate'), '', { kind: 'success' });
}

/** Cancel an in-flight download; main deletes partials and reports idle. */
async function manualCancel() {
  try {
    const status = await invoke('shell:updater-cancel');
    history.record('update-cancelled', status.version ? `v${status.version}` : '', status.state);
    toasts.toast(copy('plumbing.cancelled'), '', { kind: 'info' });
  } catch (err) {
    toasts.toast(copy('plumbing.failed', { message: err?.message ?? 'unknown error' }), '', { kind: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initUpdaterBanner() {
  if (state.initialized) return;
  state.initialized = true;

  on('update-status', handleStatus);

  palette.register({
    id: 'updates.check',
    title: copy('plumbing.checkUpdates'),
    keywords: ['update', 'upgrade', 'version', 'check'],
    section: 'Actions',
    run: manualCheck,
  });

  palette.register({
    id: 'updates.cancelDownload',
    title: copy('plumbing.cancelDownload'),
    keywords: ['update', 'cancel', 'download'],
    section: 'Actions',
    run: manualCancel,
  });

  // Re-render banner copy when the language mode changes mid-session.
  window.addEventListener('mr:language-changed', () => {
    if (lastKnownStatus?.state === 'ready' && state.bannerEl) {
      showReadyBanner(lastKnownStatus);
    }
  });

  // Ask main for its current state so a banner survives a reload.
  invoke('shell:updater-status').then((s) => handleStatus(s)).catch(() => {});
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUpdaterBanner, { once: true });
  } else {
    initUpdaterBanner();
  }
}

void languageMode;
