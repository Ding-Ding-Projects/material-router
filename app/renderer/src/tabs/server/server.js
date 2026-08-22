// Purpose: Server & Logs tab - router server controls (start/stop/restart,
// port, bind, bearer auth, CORS), local access-token management with
// reveal-once display, the live redacted request log (filterable, pausable,
// capped render window, JSON/CSV/Markdown export), and a health-endpoint
// explainer with copyable examples built from the configured port.
// Owned by Server lane - keep the registerTab id ('server') stable.

import {
  h, fmtBytes, fmtDuration, fmtTimestamp,
  writeClipboard, saveText, attachRipple,
} from '../../core/util.js';
import { t, copy, addBundle } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke, on } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import { openModal, destructiveConfirm, showMenu } from '../../core/dialogs.js';
import { toast } from '../../core/toasts.js';
import * as history from '../../core/history.js';
import * as palette from '../../core/palette.js';
import { en, zh } from './server.i18n.js';

addBundle('server', { en, zh });

const LOG_BUFFER_MAX = 2000; // mirrors the main-process ring
const RENDER_MAX = 300;      // bounded render window
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const ERROR_KINDS = new Set(['error', 'upstream_error', 'translate_error', 'stream_error', 'no_route']);

const state = {
  status: null,
  statusFetchedAt: 0,
  configState: null,
  logs: [],
  logKeys: new Set(),
  paused: false,
  pausedNew: 0,
  levelFilter: 'all',
  query: null,
  stats: { stored: 0, totalReceived: 0, routed: 0, dropped: 0 },
  tokenPresent: false,
  tokenRevealed: null,
  tokenEncrypted: true,
  reqDelta: 0,
  busy: false,
  dirty: false,
  atBottom: true,
};

/** @type {Record<string, any>} */
let els = {};
let unsubscribers = [];
let languageUnsub = null;
let renderQueued = false;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isErrorEntry(e) {
  return Boolean(
    e.error != null
    || (typeof e.status === 'number' && e.status >= 400)
    || ERROR_KINDS.has(e.kind),
  );
}

function passesFilters(e) {
  if (state.levelFilter === 'errors' && !isErrorEntry(e)) return false;
  const hay = [
    e.ts, e.id, e.kind, e.direction, e.model, e.provider, e.endpoint,
    e.ms, e.bytes, e.status, e.detail, e.error,
  ].map((v) => (v == null ? '' : String(v))).join(' ');
  return matchesQuery(state.query, hay);
}

function filteredEntries() {
  return state.logs.filter(passesFilters);
}

/** True only when the tab's panel is actually on screen; hidden panels defer rendering. */
function tabVisible() {
  if (!els.root?.isConnected) return false;
  const panel = els.root.closest('.mr-panel');
  return !panel || !panel.hidden;
}

function dirLabel(direction) {
  if (direction === 'inbound') return t('server.dirInbound');
  if (direction === 'outbound') return t('server.dirOutbound');
  return '—';
}

function dash(v) {
  return v == null || v === '' ? '—' : String(v);
}

function announceError(err) {
  toast(copy('common.errorTitle'), err?.message ?? String(err), { kind: 'error' });
}

function recordHist(actionKey, targetKey, detail = '') {
  history.record(t(actionKey), t(targetKey), detail);
}

// ---------------------------------------------------------------------------
// status card
// ---------------------------------------------------------------------------

async function refreshStatus() {
  try {
    const [status, configState] = await Promise.all([
      invoke('server:get-status'),
      invoke('server:config-state'),
    ]);
    state.status = status;
    state.statusFetchedAt = Date.now();
    state.configState = configState;
    state.reqDelta = 0;
    renderStatus();
  } catch (err) {
    announceError(err);
  }
}

function liveRequestsServed() {
  const base = state.status?.requestsServed ?? 0;
  return base + state.reqDelta;
}

function liveUptimeMs() {
  if (!state.status?.running) return 0;
  return (state.status.uptimeMs ?? 0) + (Date.now() - state.statusFetchedAt);
}

function statCell(labelKey, valueEl) {
  return h('div', { class: 'mr-srv__stat' },
    h('div', { class: 'mr-typography-label-medium mr-srv__statlabel' }, t(labelKey)),
    valueEl,
  );
}

function renderStatus() {
  if (!els.statusDot) return;
  const s = state.status;
  const running = Boolean(s?.running);

  els.statusDot.classList.toggle('mr-srv__dot--on', running);
  els.statusText.textContent = running ? t('server.statusRunning') : t('server.statusStopped');

  els.statPort.textContent = dash(s?.port);
  els.statHost.textContent = dash(s?.host);
  els.statUptime.textContent = running ? fmtDuration(liveUptimeMs()) : '—';
  els.statReq.textContent = String(liveRequestsServed());
  els.statProviders.textContent = dash(s?.providers);
  els.statRoutes.textContent = dash(s?.routes);

  els.startBtn.disabled = running || state.busy;
  els.stopBtn.disabled = !running || state.busy;

  // Config controls reflect persisted settings; they are editable whether the
  // server runs or not (changes apply on restart for port/host, immediately
  // for auth/CORS).
  const desired = state.configState?.desired ?? {};
  if (document.activeElement !== els.portInput) els.portInput.value = String(desired.port ?? '');
  const loopback = LOOPBACK_HOSTS.has(String(desired.host ?? '127.0.0.1'));
  if (els.loopbackSwitch.checked !== loopback) els.loopbackSwitch.checked = loopback;
  if (els.authSwitch.checked !== Boolean(desired.authRequired)) els.authSwitch.checked = Boolean(desired.authRequired);
  if (els.corsSwitch.checked !== Boolean(desired.corsEnabled)) els.corsSwitch.checked = Boolean(desired.corsEnabled);
  els.loopbackWarn.hidden = loopback;

  renderDriftBanner();
  renderHealthExamples();
}

function renderDriftBanner() {
  const drift = state.configState?.drift ?? [];
  const running = Boolean(state.configState?.running);
  const show = running && drift.length > 0;
  els.driftBanner.hidden = !show;
  if (!show) return;
  const names = drift.map((f) => (f === 'port' ? t('server.port') : t('server.bindHost')));
  els.driftBody.textContent = t('server.restartRequiredBody', { fields: names.join(', ') });
}

async function lifecycleAction(channel, busyLabel, doneKey, toastKind, histKey) {
  if (state.busy) return;
  const prevStart = els.startBtn.textContent;
  const prevStop = els.stopBtn.textContent;
  state.busy = true;
  els.startBtn.disabled = true;
  els.stopBtn.disabled = true;
  if (channel === 'server:start') els.startBtn.textContent = busyLabel;
  else els.stopBtn.textContent = busyLabel;
  try {
    await invoke(channel);
    recordHist(histKey, 'server.histServer');
    toast(copy(doneKey), '', { kind: toastKind });
  } catch (err) {
    announceError(err);
  } finally {
    state.busy = false;
    els.startBtn.textContent = prevStart;
    els.stopBtn.textContent = prevStop;
    await refreshStatus();
  }
}

const startServer = () =>
  lifecycleAction('server:start', t('server.starting'), 'server.startedToast', 'success', 'server.histActionStart');
const stopServer = () =>
  lifecycleAction('server:stop', t('server.stopping'), 'server.stoppedToast', 'info', 'server.histActionStop');

async function restartServer() {
  if (state.busy) return;
  state.busy = true;
  els.startBtn.disabled = true;
  els.stopBtn.disabled = true;
  els.startBtn.textContent = t('server.restarting');
  try {
    await invoke('server:restart');
    recordHist('server.histActionRestart', 'server.histServer');
    toast(copy('server.restartedToast'), '', { kind: 'success' });
  } catch (err) {
    toast(copy('server.restartFailed'), err?.message ?? String(err), { kind: 'error' });
  } finally {
    state.busy = false;
    await refreshStatus();
  }
}

async function applySetting(key, value, factDetail) {
  try {
    await settings.set(key, value);
    recordHist('server.histActionSetting', 'server.histServer', factDetail);
  } catch (err) {
    announceError(err);
  } finally {
    await refreshStatus();
  }
}

let lastAppliedPort = null;
let portApplyTimer = null;

function setPort(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1024 || num > 65535) {
    els.portField.classList.add('m3-textfield--error');
    els.portHelper.textContent = t('server.portInvalid');
    return;
  }
  els.portField.classList.remove('m3-textfield--error');
  els.portHelper.textContent = t('server.portHelper');
  els.portInput.value = String(num);
  // Enter and blur both commit; an unchanged value records nothing, and rapid
  // stepper clicks coalesce into one persisted write.
  if (num === lastAppliedPort) return;
  lastAppliedPort = num;
  clearTimeout(portApplyTimer);
  portApplyTimer = setTimeout(() => {
    void applySetting('server.port', num, `server.port = ${num}`);
  }, 350);
}

function nudgePort(delta) {
  const current = Math.floor(Number(els.portInput.value)) || 8787;
  const next = Math.min(65535, Math.max(1024, current + delta));
  els.portInput.value = String(next);
  setPort(next);
}

// ---------------------------------------------------------------------------
// token card
// ---------------------------------------------------------------------------

async function refreshTokenStatus() {
  try {
    const res = await invoke('server:token-status');
    state.tokenPresent = Boolean(res.present);
    if (!state.tokenPresent) state.tokenRevealed = null;
    renderToken();
  } catch (err) {
    announceError(err);
  }
}

function renderToken() {
  if (!els.tokenStatusLine) return;
  if (state.tokenRevealed) {
    els.tokenStatusLine.textContent = '';
    els.tokenBox.hidden = false;
    els.tokenValue.value = state.tokenRevealed;
    els.tokenStoredLine.hidden = true;
    els.tokenMissingLine.hidden = true;
  } else {
    els.tokenBox.hidden = true;
    els.tokenValue.value = '';
    els.tokenStoredLine.hidden = !state.tokenPresent;
    els.tokenMissingLine.hidden = state.tokenPresent;
    els.tokenStoredLine.textContent = state.tokenPresent && !state.tokenEncrypted
      ? t('server.tokenStoredObfuscated')
      : t('server.tokenStored');
  }
  els.regenBtn.disabled = !state.tokenPresent;
}

async function generateToken(isRegen = false) {
  try {
    const res = await invoke('server:generate-token');
    state.tokenRevealed = res.token;
    state.tokenEncrypted = res.encryptionAvailable !== false;
    state.tokenPresent = true;
    renderToken();
    els.tokenValue.focus();
    els.tokenValue.select();
    recordHist(isRegen ? 'server.histActionRegenerate' : 'server.histActionGenerate', 'server.histToken');
    toast(copy('server.tokenGeneratedToast'), '', { kind: 'success' });
  } catch (err) {
    announceError(err);
  }
}

async function regenerateToken() {
  const ok = await destructiveConfirm({
    title: copy('server.tokenRegenConfirmTitle'),
    body: copy('server.tokenRegenConfirmBody'),
    confirmLabel: copy('server.tokenRegenerate'),
  });
  if (ok) await generateToken(true);
}

async function copyToken() {
  if (!state.tokenRevealed) return;
  await writeClipboard(state.tokenRevealed);
  toast(copy('server.tokenCopied'), '', { kind: 'info', timeout: 2500 });
}

// ---------------------------------------------------------------------------
// log stream
// ---------------------------------------------------------------------------

function ingest(entry) {
  if (!entry || typeof entry !== 'object') return;
  const key = [
    entry.ts, entry.id, entry.kind, entry.direction, entry.model, entry.provider,
    entry.endpoint, entry.ms, entry.bytes, entry.status, entry.detail, entry.error,
  ].join('|');
  if (state.logKeys.has(key)) return;
  state.logKeys.add(key);
  state.logs.push(entry);
  if (state.logs.length > LOG_BUFFER_MAX) {
    const overflow = state.logs.length - LOG_BUFFER_MAX;
    for (let i = 0; i < overflow; i++) {
      const old = state.logs[i];
      state.logKeys.delete([
        old.ts, old.id, old.kind, old.direction, old.model, old.provider,
        old.endpoint, old.ms, old.bytes, old.status, old.detail, old.error,
      ].join('|'));
    }
    state.logs.splice(0, overflow);
  }
  if (entry.kind === 'route' || entry.kind === 'request') {
    state.reqDelta += 1;
    if (els.statReq) els.statReq.textContent = String(liveRequestsServed());
  }
  state.stats.stored = state.logs.length;
  // The meta line and table are owned by the rAF-batched renderLogs(); ingest
  // only touches the always-cheap counters.
  if (state.paused) {
    state.pausedNew += 1;
    updatePauseButton();
  }
  if (!tabVisible()) {
    state.dirty = true;
    return;
  }
  if (!state.paused) scheduleRender();
}

function scheduleRender() {
  if (renderQueued || !els.tbody) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderLogs();
  });
}

function rowSummary(e) {
  return [e.model, e.provider, e.endpoint, e.detail].filter(Boolean).join(' · ') || e.kind;
}

function buildRow(e) {
  const err = isErrorEntry(e);
  const tr = h('tr', {
    class: `mr-srv__row${err ? ' mr-srv__row--error' : ''}`,
    tabindex: '0',
    'aria-label': t('server.rowLabel', {
      time: fmtTimestamp(e.ts),
      kind: e.kind,
      summary: rowSummary(e),
    }),
  });
  const open = () => openDetail(e);
  tr.addEventListener('click', open);
  tr.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      open();
    }
  });
  tr.append(
    h('td', { class: 'mr-srv__cell mr-srv__cell--time' }, fmtTimestamp(e.ts)),
    h('td', { class: 'mr-srv__cell' }, dirLabel(e.direction)),
    h('td', { class: 'mr-srv__cell' }, dash(e.model)),
    h('td', { class: 'mr-srv__cell' }, dash(e.provider)),
    h('td', { class: `mr-srv__cell mr-srv__cell--num${typeof e.status === 'number' && e.status >= 400 ? ' mr-srv__cell--bad' : ''}` },
      dash(e.status)),
    h('td', { class: 'mr-srv__cell mr-srv__cell--num' }, dash(e.ms)),
    h('td', { class: 'mr-srv__cell mr-srv__cell--num' }, e.bytes == null ? '—' : fmtBytes(e.bytes)),
  );
  return tr;
}

function renderLogs() {
  if (!els.tbody) return;
  const wrap = els.logWrap;
  const stick = state.atBottom && !state.paused;
  els.tbody.textContent = '';

  const matching = filteredEntries();
  const rows = matching.slice(-RENDER_MAX);
  for (const e of rows) els.tbody.append(buildRow(e));

  const hasAny = state.logs.length > 0;
  els.logsEmptyAll.hidden = hasAny;
  els.logsEmptyFiltered.hidden = !(hasAny && rows.length === 0);
  els.logTable.hidden = rows.length === 0;
  els.logMetaLine.textContent = t('server.logsCount', {
    shown: rows.length,
    total: matching.length,
  });
  els.logDroppedLine.hidden = !(state.stats.dropped > 0);
  if (state.stats.dropped > 0) {
    els.logDroppedLine.textContent = t('server.logsDropped', { n: state.stats.dropped });
  }
  if (stick) wrap.scrollTop = wrap.scrollHeight;
}

function updatePauseButton() {
  els.pauseBtn.textContent = state.paused
    ? (state.pausedNew > 0 ? t('server.resumeWithCount', { n: state.pausedNew }) : t('server.resume'))
    : t('server.pause');
  els.pauseBtn.setAttribute('aria-pressed', String(state.paused));
}

function setPaused(next) {
  state.paused = next;
  if (!next) {
    state.pausedNew = 0;
    renderLogs();
  }
  updatePauseButton();
}

async function refreshStats() {
  try {
    state.stats = await invoke('logs:stats');
    if (els.tbody) renderLogs();
  } catch { /* the meta lines simply stay at their last honest values */ }
}

async function clearLogs() {
  const ok = await destructiveConfirm({
    title: copy('server.clearConfirmTitle'),
    body: copy('server.clearConfirmBody', { n: state.stats.stored }),
    confirmLabel: copy('server.clearLogs'),
  });
  if (!ok) return;
  try {
    await invoke('logs:clear');
    state.logs.length = 0;
    state.logKeys.clear();
    state.pausedNew = 0;
    state.paused = false;
    updatePauseButton();
    recordHist('server.histActionClear', 'server.histLogs');
    toast(copy('server.logsCleared'), '', { kind: 'success' });
    await refreshStats();
    renderLogs();
  } catch (err) {
    announceError(err);
  }
}

// -- export ------------------------------------------------------------------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const EXPORT_COLUMNS = ['ts', 'id', 'kind', 'direction', 'model', 'provider', 'endpoint', 'ms', 'bytes', 'status', 'detail', 'error'];

function exportLogs(format) {
  const rows = filteredEntries();
  if (rows.length === 0) {
    toast(copy('server.exportEmpty'), '', { kind: 'info' });
    return;
  }
  const base = `material-router-log-${stamp()}`;
  if (format === 'json') {
    saveText(`${base}.json`, `${JSON.stringify(rows, null, 2)}\n`, 'application/json;charset=utf-8');
  } else if (format === 'csv') {
    const head = EXPORT_COLUMNS.map(csvCell).join(',');
    const body = rows.map((e) => EXPORT_COLUMNS.map((c) => csvCell(e[c])).join(',')).join('\n');
    saveText(`${base}.csv`, `${head}\n${body}\n`, 'text/csv;charset=utf-8');
  } else {
    const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const lines = [
      `# Material Router log export`,
      '',
      `- Generated: ${new Date().toISOString()}`,
      `- Entries: ${rows.length} (filtered view)`,
      '',
      `| ${EXPORT_COLUMNS.join(' | ')} |`,
      `| ${EXPORT_COLUMNS.map(() => '---').join(' | ')} |`,
      ...rows.map((e) => `| ${EXPORT_COLUMNS.map((c) => esc(e[c])).join(' | ')} |`),
      '',
    ];
    saveText(`${base}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  }
  toast(copy('server.exportDone', { n: rows.length }), '', { kind: 'success', timeout: 3000 });
}

// -- detail drawer -------------------------------------------------------------

function detailRow(labelKey, value) {
  return h('div', { class: 'mr-srv__detail-row' },
    h('span', { class: 'mr-srv__detail-label' }, t(labelKey)),
    h('span', { class: 'mr-srv__detail-value' }, dash(value)),
  );
}

function openDetail(e) {
  openModal({
    title: copy('server.detailTitle'),
    body: (container) => {
      container.append(
        h('div', { class: 'mr-srv__detail' },
          detailRow('server.fieldTime', `${e.ts} (${fmtTimestamp(e.ts)})`),
          detailRow('server.fieldKind', e.kind),
          detailRow('server.fieldId', e.id),
          detailRow('server.fieldEndpoint', e.endpoint),
          detailRow('server.colDir', e.direction),
          detailRow('server.colModel', e.model),
          detailRow('server.colProvider', e.provider),
          detailRow('server.colStatus', e.status),
          detailRow('server.colMs', e.ms),
          detailRow('server.colBytes', e.bytes),
        ),
        e.detail ? h('p', { class: 'mr-srv__detail-block' },
          h('strong', {}, `${t('server.fieldDetail')}: `), e.detail) : null,
        e.error ? h('p', { class: 'mr-srv__detail-block mr-srv__detail-error' },
          h('strong', {}, `${t('server.fieldError')}: `), e.error) : null,
        h('p', { class: 'mr-srv__redact-note mr-typography-body-small' }, copy('server.detailRedactionNote')),
      );
    },
    actions: [
      {
        label: copy('server.copyDetails'),
        kind: 'm3-btn--tonal',
        run: () => {
          void writeClipboard(JSON.stringify(e, null, 2));
          toast(copy('common.copied'), '', { kind: 'info', timeout: 2000 });
        },
      },
      { label: copy('common.close'), kind: 'm3-btn--text', run: () => {} },
    ],
  });
}

// ---------------------------------------------------------------------------
// health card
// ---------------------------------------------------------------------------

function curlBlock(labelKey, command) {
  const pre = h('pre', { class: 'mr-srv__curl' }, h('code', {}, command));
  const btn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    'aria-label': `${copy('common.copy')} — ${t(labelKey)}`,
    onclick: async () => {
      await writeClipboard(command);
      toast(copy('common.copied'), t(labelKey), { kind: 'info', timeout: 2200 });
    },
  }, copy('common.copy'));
  attachRipple(btn);
  return h('div', { class: 'mr-srv__curlblock' },
    h('div', { class: 'mr-srv__curllabel mr-typography-label-medium' }, t(labelKey)),
    pre,
    h('div', { class: 'mr-srv__curlactions' }, btn),
  );
}

function renderHealthExamples() {
  if (!els.healthBlocks) return;
  const cfg = state.configState ?? {};
  const port = cfg.desired?.port ?? state.status?.port ?? 8787;
  const host = cfg.applied?.host ?? cfg.desired?.host ?? '127.0.0.1';
  const auth = cfg.desired?.authRequired ?? false;
  const authHeaders = auth ? ` \\\n  -H "Authorization: Bearer <token>"` : '';
  const base = `http://127.0.0.1:${port}`;
  const cmds = [
    ['server.curlHealth', `curl ${base}/health`],
    ['server.curlModels', `curl ${base}/v1/models${authHeaders}`],
    ['server.curlOpenai', `curl ${base}/v1/chat/completions \\\n  -H "Content-Type: application/json"${authHeaders} \\\n  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}'`],
    ['server.curlAnthropic', `curl ${base}/v1/messages \\\n  -H "Content-Type: application/json" \\\n  -H "anthropic-version: 2023-06-01"${authHeaders} \\\n  -d '{"model":"your-model","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'`],
  ];
  els.healthBlocks.textContent = '';
  for (const [key, cmd] of cmds) els.healthBlocks.append(curlBlock(key, cmd));
  els.healthAuthNote.hidden = auth;
  els.healthBindNote.textContent = t('server.healthBindNote', { host });
}

// ---------------------------------------------------------------------------
// skeleton
// ---------------------------------------------------------------------------

function makeSwitch(labelKey, helperKey, onchange) {
  const input = h('input', { type: 'checkbox', onchange: (e) => onchange(e.target.checked) });
  const sw = h('label', { class: 'm3-switch' },
    input,
    h('span', { class: 'track' }, h('span', { class: 'thumb' })),
    h('span', { class: 'label-text' }, t(labelKey)),
  );
  const wrap = h('div', { class: 'mr-srv__switchwrap' }, sw);
  if (helperKey) wrap.append(h('p', { class: 'mr-typography-body-small mr-srv__helper' }, t(helperKey)));
  return { wrap, input };
}

function buildSkeleton(container) {
  els = { root: container };

  // -- status card ------------------------------------------------------------
  els.statusDot = h('span', { class: 'mr-srv__dot', 'aria-hidden': 'true' });
  els.statusText = h('span', { class: 'mr-typography-title-medium' }, '');

  els.statPort = h('div', { class: 'mr-typography-title-large' }, '—');
  els.statHost = h('div', { class: 'mr-typography-title-large' }, '—');
  els.statUptime = h('div', { class: 'mr-typography-title-large' }, '—');
  els.statReq = h('div', { class: 'mr-typography-title-large' }, '—');
  els.statProviders = h('div', { class: 'mr-typography-title-large' }, '—');
  els.statRoutes = h('div', { class: 'mr-typography-title-large' }, '—');

  els.startBtn = h('button', { class: 'm3-btn m3-btn--filled', onclick: startServer }, t('server.start'));
  els.stopBtn = h('button', { class: 'm3-btn m3-btn--outlined', onclick: stopServer }, t('server.stop'));
  attachRipple(els.startBtn);
  attachRipple(els.stopBtn);

  els.driftBanner = h('div', { class: 'mr-srv__banner', role: 'status', hidden: true },
    h('div', { class: 'mr-grow' },
      h('strong', {}, copy('server.restartRequiredTitle')),
      h('div', { id: 'mr-srv-drift-body', class: 'mr-typography-body-small' }, ''),
    ),
    h('button', {
      class: 'm3-btn m3-btn--tonal m3-btn--sm',
      onclick: restartServer,
    }, t('server.restartNow')),
  );
  els.driftBody = els.driftBanner.querySelector('#mr-srv-drift-body');

  // Port stepper: minus / typed value / plus, validated inline.
  els.portField = h('div', { class: 'm3-textfield' });
  els.portInput = h('input', {
    type: 'number',
    min: '1024',
    max: '65535',
    step: '1',
    inputmode: 'numeric',
    id: 'mr-srv-port',
    'aria-describedby': 'mr-srv-port-helper',
    onchange: (e) => setPort(e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter') setPort(e.target.value);
      if (e.key === 'ArrowUp') { e.preventDefault(); nudgePort(1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); nudgePort(-1); }
    },
  });
  const portLabel = h('label', { for: 'mr-srv-port' }, t('server.port'));
  els.portHelper = h('div', { class: 'm3-textfield__helper', id: 'mr-srv-port-helper' }, t('server.portHelper'));
  els.portField.append(els.portInput, portLabel, els.portHelper);

  const minusBtn = h('button', {
    class: 'm3-btn m3-btn--outlined m3-btn--icon-only m3-btn--sm',
    'aria-label': `${t('server.port')} −1`,
    onclick: () => nudgePort(-1),
  }, '−');
  const plusBtn = h('button', {
    class: 'm3-btn m3-btn--outlined m3-btn--icon-only m3-btn--sm',
    'aria-label': `${t('server.port')} +1`,
    onclick: () => nudgePort(1),
  }, '+');
  attachRipple(minusBtn);
  attachRipple(plusBtn);

  const loopback = makeSwitch('server.bindLoopback', null, (on2) => {
    els.loopbackWarn.hidden = on2;
    void applySetting('server.host', on2 ? '127.0.0.1' : '0.0.0.0', `server.host = ${on2 ? '127.0.0.1' : '0.0.0.0'}`);
  });
  els.loopbackSwitch = loopback.input;
  els.loopbackWarn = h('p', {
    class: 'mr-typography-body-small mr-srv__warn',
    hidden: true,
  }, copy('server.bindLoopbackOffWarn'));

  const auth = makeSwitch('server.authRequired', 'server.authHelper',
    (on2) => void applySetting('server.authRequired', on2, `server.authRequired = ${on2}`));
  els.authSwitch = auth.input;
  const cors = makeSwitch('server.cors', 'server.corsHelper',
    (on2) => void applySetting('server.corsEnabled', on2, `server.corsEnabled = ${on2}`));
  els.corsSwitch = cors.input;

  const statusCard = h('section', { class: 'm3-card', 'aria-labelledby': 'mr-srv-status-title' },
    h('h2', { class: 'm3-card__title', id: 'mr-srv-status-title' }, t('server.sectionStatus')),
    h('div', { class: 'mr-row' }, els.statusDot, els.statusText),
    h('div', { class: 'mr-srv__stats' },
      statCell('server.requestsServed', els.statReq),
      statCell('server.uptime', els.statUptime),
      statCell('server.port', els.statPort),
      statCell('server.bindHost', els.statHost),
      statCell('server.providersReady', els.statProviders),
      statCell('server.routes', els.statRoutes),
    ),
    h('div', { class: 'mr-row' }, els.startBtn, els.stopBtn),
    els.driftBanner,
    h('div', { class: 'mr-srv__config' },
      h('div', { class: 'mr-row mr-srv__portrow' }, minusBtn, els.portField, plusBtn),
      loopback.wrap,
      els.loopbackWarn,
      auth.wrap,
      cors.wrap,
    ),
  );

  // -- token card ---------------------------------------------------------------
  els.tokenStoredLine = h('p', { class: 'mr-typography-body-medium' }, '');
  els.tokenMissingLine = h('p', { class: 'mr-typography-body-medium' }, t('server.tokenNone'));
  els.tokenValue = h('input', {
    type: 'text',
    readonly: true,
    class: 'mr-srv__tokenvalue',
    'aria-label': copy('server.sectionToken'),
    onfocus: (e) => e.target.select(),
  });
  els.tokenBox = h('div', { class: 'mr-srv__tokenbox', hidden: true },
    els.tokenValue,
    h('p', { class: 'mr-typography-body-small mr-srv__warn' }, copy('server.tokenRevealWarn')),
  );

  const genBtn = h('button', {
    class: 'm3-btn m3-btn--tonal',
    onclick: () => generateToken(false),
  }, t('server.tokenGenerate'));
  els.regenBtn = h('button', {
    class: 'm3-btn m3-btn--text',
    style: 'color:var(--md-sys-color-error)',
    onclick: regenerateToken,
  }, t('server.tokenRegenerate'));
  const copyBtn = h('button', {
    class: 'm3-btn m3-btn--filled m3-btn--sm',
    onclick: copyToken,
  }, copy('common.copy'));
  const doneBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => {
      state.tokenRevealed = null;
      renderToken();
      genBtn.focus();
    },
  }, t('server.tokenDone'));
  attachRipple(genBtn);
  attachRipple(els.regenBtn);
  attachRipple(copyBtn);
  attachRipple(doneBtn);

  const tokenCard = h('section', { class: 'm3-card', 'aria-labelledby': 'mr-srv-token-title' },
    h('h2', { class: 'm3-card__title', id: 'mr-srv-token-title' }, t('server.sectionToken')),
    els.tokenStoredLine,
    els.tokenMissingLine,
    els.tokenBox,
    h('div', { class: 'mr-row mr-srv__wrap' }, genBtn, els.regenBtn, copyBtn, doneBtn),
    h('p', { class: 'mr-typography-body-small mr-srv__helper' }, copy('server.tokenUsedWhenOn')),
  );

  // -- log stream card -------------------------------------------------------------

  const search = createSearchBar({
    placeholder: copy('server.searchPlaceholder'),
    label: copy('server.searchPlaceholder'),
    onQuery: (qs) => {
      state.query = qs;
      renderLogs();
    },
  });
  els.searchApi = search;

  const allChip = h('button', {
    class: `m3-chip${state.levelFilter === 'all' ? ' m3-chip--selected' : ''}`,
    'aria-pressed': String(state.levelFilter === 'all'),
    onclick: () => setLevel('all'),
  }, t('server.levelAll'));
  const errChip = h('button', {
    class: `m3-chip${state.levelFilter === 'errors' ? ' m3-chip--selected' : ''}`,
    'aria-pressed': String(state.levelFilter === 'errors'),
    onclick: () => setLevel('errors'),
  }, t('server.levelErrors'));

  function setLevel(level) {
    state.levelFilter = level;
    allChip.classList.toggle('m3-chip--selected', level === 'all');
    errChip.classList.toggle('m3-chip--selected', level === 'errors');
    allChip.setAttribute('aria-pressed', String(level === 'all'));
    errChip.setAttribute('aria-pressed', String(level === 'errors'));
    renderLogs();
  }

  els.pauseBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    'aria-pressed': 'false',
    onclick: () => setPaused(!state.paused),
  }, t('server.pause'));
  attachRipple(els.pauseBtn);

  const exportBtn = h('button', { class: 'm3-btn m3-btn--text m3-btn--sm' }, t('server.exportLogs'));
  attachRipple(exportBtn);
  exportBtn.addEventListener('click', () => {
    const r = exportBtn.getBoundingClientRect();
    showMenu([
      { label: t('server.exportJson'), run: () => exportLogs('json') },
      { label: t('server.exportCsv'), run: () => exportLogs('csv') },
      { label: t('server.exportMd'), run: () => exportLogs('md') },
    ], { x: r.left, y: r.bottom + 4, anchor: exportBtn });
  });

  const clearBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    style: 'color:var(--md-sys-color-error)',
    onclick: clearLogs,
  }, t('server.clearLogs'));
  attachRipple(clearBtn);

  els.logMetaLine = h('span', {
    class: 'mr-typography-label-medium mr-srv__meta',
  }, t('server.logsCount', { shown: 0, total: 0 }));
  els.logDroppedLine = h('span', {
    class: 'mr-typography-label-medium mr-srv__meta mr-srv__meta--dropped',
    hidden: true,
  }, '');

  els.tbody = h('tbody');
  els.logTable = h('table', { class: 'mr-srv__table' },
    h('caption', { class: 'mr-visually-hidden' }, t('server.sectionLogs')),
    h('thead', {},
      h('tr', {},
        h('th', { scope: 'col' }, t('server.colTime')),
        h('th', { scope: 'col' }, t('server.colDir')),
        h('th', { scope: 'col' }, t('server.colModel')),
        h('th', { scope: 'col' }, t('server.colProvider')),
        h('th', { scope: 'col' }, t('server.colStatus')),
        h('th', { scope: 'col' }, t('server.colMs')),
        h('th', { scope: 'col' }, t('server.colBytes')),
      ),
    ),
    els.tbody,
  );
  els.logWrap = h('div', {
    class: 'mr-srv__logwrap',
    onscroll: () => {
      state.atBottom = els.logWrap.scrollHeight - els.logWrap.scrollTop - els.logWrap.clientHeight < 48;
    },
  }, els.logTable);
  els.logsEmptyAll = h('p', { class: 'mr-palette__empty' }, copy('server.logsEmpty'));
  els.logsEmptyFiltered = h('p', { class: 'mr-palette__empty', hidden: true }, copy('server.logsFilteredEmpty'));

  const logCard = h('section', { class: 'm3-card', 'aria-labelledby': 'mr-srv-logs-title' },
    h('div', { class: 'mr-row mr-srv__wrap' },
      h('h2', { class: 'm3-card__title', id: 'mr-srv-logs-title' }, t('server.sectionLogs')),
      els.logMetaLine,
      els.logDroppedLine,
    ),
    h('div', { class: 'mr-row mr-srv__wrap' }, allChip, errChip, els.searchApi.el, els.pauseBtn, exportBtn, clearBtn),
    els.logWrap,
    els.logsEmptyAll,
    els.logsEmptyFiltered,
  );

  // -- health card -----------------------------------------------------------------
  els.healthBlocks = h('div', { class: 'mr-col' });
  els.healthAuthNote = h('p', { class: 'mr-typography-body-small mr-srv__helper', hidden: true },
    copy('server.healthAuthNote'));
  els.healthBindNote = h('p', { class: 'mr-typography-body-small mr-srv__helper' }, '');

  const healthCard = h('section', { class: 'm3-card', 'aria-labelledby': 'mr-srv-health-title' },
    h('h2', { class: 'm3-card__title', id: 'mr-srv-health-title' }, t('server.sectionHealth')),
    h('p', { class: 'mr-typography-body-medium' }, copy('server.healthBody')),
    els.healthBlocks,
    els.healthAuthNote,
    els.healthBindNote,
  );

  container.append(h('div', { class: 'mr-server' }, statusCard, tokenCard, logCard, healthCard));

  // Kept for the language-change rebuild and palette actions.
  els.setLevel = setLevel;
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

async function loadExistingEntries() {
  try {
    const entries = await invoke('logs:query', { limit: LOG_BUFFER_MAX });
    for (const e of entries) ingest(e);
    renderLogs();
  } catch (err) {
    announceError(err);
  }
}

function render(container) {
  buildSkeleton(container);

  // Re-mount after a tab close must not stack duplicate listeners.
  while (unsubscribers.length) unsubscribers.pop()();
  unsubscribers.push(on('log', ingest));
  unsubscribers.push(on('server-status', () => { void refreshStatus(); }));

  void loadExistingEntries();
  void refreshStatus();
  void refreshTokenStatus();
  void refreshStats();

  // One-second ticker keeps uptime honest between status events.
  if (!state._ticker) {
    state._ticker = setInterval(() => {
      if (state.status?.running && els.statUptime) {
        els.statUptime.textContent = fmtDuration(liveUptimeMs());
      }
    }, 1000);
  }

  // Re-render labels when the language mode changes (foundation caches i18n).
  // School mode forcing English presentation re-applies through the same pass.
  // State survives the rebuild; the fresh search bar re-adopts the live query.
  if (!languageUnsub) {
    languageUnsub = settings.onChange((key) => {
      if (key !== 'general.languageMode' && key !== 'school.active') return;
      registerServerPaletteItems();
      const root = els.root;
      if (!root?.isConnected) return;
      const q = state.query;
      root.textContent = '';
      buildSkeleton(root);
      if (q?.text) els.searchApi.set(q.text);
      if (q?.mode === 'regex') els.searchApi.setMode('regex');
      els.setLevel(state.levelFilter);
      updatePauseButton();
      renderLogs();
      renderToken();
      void refreshStats();
      void refreshStatus();
      void refreshTokenStatus();
    });
  }
}

function onActivate() {
  if (state.dirty) {
    state.dirty = false;
    renderLogs();
  }
}

registerTab({
  id: 'server',
  label: { en: 'Server & Logs', zh: '伺服器同日誌' },
  get icon() { return iconFromPath('M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 9h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Zm2 2v3h2v-3H6Zm10.5-9.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm0 9a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z'); },
  init: render,
  mount: onActivate,
});

// -- command palette coverage ---------------------------------------------------
// Guarded so the module stays importable in non-DOM environments (palette
// internals touch HTMLElement); behavior in the renderer is unchanged.
// Wrapped so the language-change pass can re-register localized titles
// (palette.register replaces entries by id).

function registerServerPaletteItems() {
  if (typeof HTMLElement === 'undefined') return;
  palette.register({
    id: 'serverlane.start',
    title: t('server.paletteStart'),
    keywords: ['server', 'router', 'start'],
    section: 'Actions',
    run: () => startServer(),
  });
  palette.register({
    id: 'serverlane.stop',
    title: t('server.paletteStop'),
    keywords: ['server', 'router', 'stop'],
    section: 'Actions',
    run: () => stopServer(),
  });
  palette.register({
    id: 'serverlane.restart',
    title: t('server.paletteRestart'),
    keywords: ['server', 'router', 'restart', 'apply settings'],
    section: 'Actions',
    run: () => restartServer(),
  });
  palette.register({
    id: 'serverlane.token',
    title: t('server.paletteToken'),
    keywords: ['token', 'bearer', 'auth', 'generate'],
    section: 'Actions',
    run: () => generateToken(),
  });
  palette.register({
    id: 'serverlane.pause',
    title: t('server.palettePause'),
    keywords: ['log', 'pause', 'resume', 'stream'],
    section: 'Actions',
    run: () => {
      if (!els.pauseBtn?.isConnected) return;
      setPaused(!state.paused);
      els.pauseBtn.focus();
    },
  });
  palette.register({
    id: 'serverlane.clear',
    title: t('server.paletteClear'),
    keywords: ['log', 'clear', 'delete entries'],
    section: 'Actions',
    run: () => clearLogs(),
  });
}

registerServerPaletteItems();
