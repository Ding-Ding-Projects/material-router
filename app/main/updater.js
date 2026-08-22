// Purpose: Chrome-style automatic updates over the project's GitHub releases,
// following the Squirrel.Windows model. Checks releases/latest on startup and
// every six hours, compares semver against the running version, validates the
// Squirrel RELEASES manifest entry (and the package digest it carries), then
// streams Setup.exe into a staging directory under application data with
// progress broadcast on the 'update-status' event channel. Installation only
// ever happens after the user chooses Restart - the staged installer spawns
// detached and this instance exits.
//
// The feed is UNSIGNED, permanently by policy. Nothing here claims signature
// verification: integrity comes from HTTPS transport plus the RELEASES
// digest when one is present, and the UI says exactly that.
//
// Every network request carries an aborting deadline; every failure state is
// broadcast honestly instead of being swallowed. No secret is ever logged -
// this module holds none.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { app } from 'electron';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_ATTEMPTS = 8;
const RETRY_DELAY_MS = 50;
const PROGRESS_THROTTLE_MS = 400;
const STARTUP_DELAY_MS = 8_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, max = 200) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/** Compare "vX.Y.Z" style versions numerically. Returns true if a > b. */
export function isNewerVersion(candidate, current) {
  const parse = (v) => String(v ?? '').trim().replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(candidate);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(current);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}

/**
 * Parse a Squirrel RELEASES manifest: lines of "<sha1> <filename> <size>".
 * Tolerates a leading UTF-8 BOM (a feed re-encoded through a text writer
 * carries EF BB BF ahead of the first SHA1), CRLF or LF line endings, and
 * trailing whitespace on each line. Garbage lines are skipped rather than
 * poisoning the rest of the manifest. Returns a Map keyed by lowercased
 * filename -> { hash, size }.
 */
export function parseReleasesManifest(text) {
  const entries = new Map();
  // Strip the BOM explicitly instead of leaning on String.prototype.trim():
  // today's ECMAScript WhiteSpace table happens to include U+FEFF, so trim()
  // absorbs it - but the digest comparison downstream must never depend on
  // that trivia. Make the guarantee local and obvious.
  let body = String(text ?? '');
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [hash, filename, size] = parts;
    entries.set(filename.toLowerCase(), {
      hash: String(hash ?? '').toLowerCase(),
      size: size != null ? Number.parseInt(size, 10) : null,
    });
  }
  return entries;
}

/** One https GET with redirect following and a rejecting deadline. */
function httpGet(url, { headers = {}, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error(`request timed out after ${timeoutMs} ms: ${url}`)), timeoutMs);

    const attempt = (target, redirectsLeft) => {
      const req = https.get(target, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return done(reject, new Error(`too many redirects fetching ${url}`));
          const next = new URL(res.headers.location, target).toString();
          return attempt(next, redirectsLeft - 1);
        }
        done(resolve, res);
      });
      req.on('timeout', () => req.destroy(new Error(`socket timeout fetching ${url}`)));
      req.on('error', (err) => done(reject, err));
    };
    try {
      attempt(url, MAX_REDIRECTS);
    } catch (err) {
      done(reject, err);
    }
  });
}

async function getJson(url, timeoutMs) {
  const res = await httpGet(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'material-router-updater',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    timeoutMs,
  });
  if (res.statusCode === 404) {
    const err = new Error('no published release found');
    err.code = 'NO_RELEASE';
    throw err;
  }
  if (res.statusCode !== 200) throw new Error(`feed responded ${res.statusCode}`);
  const body = await readBody(res, 4 * 1024 * 1024);
  return JSON.parse(body.toString('utf8'));
}

function readBody(res, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        res.destroy();
        reject(new Error(`response exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

export class AutoUpdater {
  /**
   * @param {object} deps
   * @param {import('./store.js').JSONStore} deps.settingsStore
   * @param {(type: string, data: unknown) => void} deps.broadcast
   * @param {string} [deps.repo] owner/name pair of the release feed
   */
  constructor({ settingsStore, broadcast, repo = 'Ding-Ding-Projects/material-router' }) {
    this.settingsStore = settingsStore;
    this.broadcastFn = broadcast;
    this.repo = repo;
    this.intervalMs = Number(settingsStore?.get?.('updates.checkIntervalMs', DEFAULT_INTERVAL_MS)) || DEFAULT_INTERVAL_MS;
    this.updatesDir = path.join(app.getPath('userData'), 'updates');
    this.state = 'idle'; // idle | checking | available | downloading | ready | error
    this.lastError = null;
    this.available = null; // { version, setupName, setupUrl, releasesUrl, notesUrl, publishedAt }
    this.stagedFile = null;
    this.progress = null; // { receivedBytes, totalBytes }
    this.aborted = false;
    this.activeRequest = null;
    this.timers = [];
    this.started = false;
    this.feedKind = 'unsigned';
  }

  enabled() {
    return Boolean(this.settingsStore?.get?.('updates.enabled', true));
  }

  getStatus() {
    return {
      state: this.state,
      enabled: this.enabled(),
      currentVersion: app.getVersion(),
      version: this.available?.version ?? null,
      notesUrl: this.available?.notesUrl ?? null,
      stagedFile: this.state === 'ready' ? this.stagedFile : null,
      receivedBytes: this.progress?.receivedBytes ?? null,
      totalBytes: this.progress?.totalBytes ?? null,
      error: this.state === 'error' ? truncate(this.lastError) : null,
      feedKind: this.feedKind,
    };
  }

  emit() {
    const snapshot = this.getStatus();
    try {
      this.broadcastFn('update-status', snapshot);
    } catch (err) {
      console.error('[updater] failed to broadcast update-status:', truncate(err.message));
    }
    return snapshot;
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.enabled()) {
      console.log('[updater] disabled by setting updates.enabled=false');
      this.emit();
      return;
    }
    const startupTimer = setTimeout(() => {
      this.checkNow().catch(() => {}); // failures already emitted as state=error
    }, STARTUP_DELAY_MS);
    const intervalTimer = setInterval(() => {
      this.checkNow().catch(() => {});
    }, this.intervalMs);
    intervalTimer.unref?.();
    this.timers.push(startupTimer, intervalTimer);
    this.emit();
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
    this.started = false;
  }

  async checkNow({ manual = false } = {}) {
    if (!this.enabled()) {
      if (manual) {
        this.lastError = 'updates are disabled in settings';
        this.state = 'error';
        this.emit();
      }
      return this.getStatus();
    }
    if (this.state === 'checking' || this.state === 'downloading') return this.getStatus();

    this.state = 'checking';
    this.lastError = null;
    this.emit();

    try {
      const release = await getJson(`https://api.github.com/repos/${this.repo}/releases/latest`, 20_000);
      const version = String(release.tag_name ?? '');
      const assets = Array.isArray(release.assets) ? release.assets : [];

      if (!isNewerVersion(version, app.getVersion())) {
        this.state = 'idle';
        this.available = null;
        this.emit();
        return this.getStatus();
      }

      const setupAsset = assets.find((a) => /-setup\.exe$/i.test(String(a.name ?? '')));
      const releasesAsset = assets.find((a) => /^releases$/i.test(String(a.name ?? '')));
      if (!setupAsset) throw new Error(`release ${version} has no Setup.exe asset attached`);

      this.available = {
        version,
        setupName: String(setupAsset.name),
        setupUrl: String(setupAsset.browser_download_url),
        setupSize: Number(setupAsset.size ?? 0),
        releasesUrl: releasesAsset ? String(releasesAsset.browser_download_url) : null,
        notesUrl: String(release.html_url ?? ''),
        publishedAt: String(release.published_at ?? ''),
      };
      this.state = 'available';
      this.emit();

      // Non-blocking background stage; the user still chooses to install.
      this.download().catch((err) => {
        if (err.code === 'CANCELLED' || this.aborted) return; // cancelDownload already reported
        this.state = 'error';
        this.lastError = err.message;
        this.emit();
      });
    } catch (err) {
      this.state = 'error';
      this.lastError = err.code === 'NO_RELEASE' ? 'no published release to update to yet' : err.message;
      this.emit();
    }
    return this.getStatus();
  }

  /** Validate the RELEASES entry for the pending setup package, if present. */
  async validateReleasesEntry() {
    if (!this.available?.releasesUrl) return null;
    const res = await httpGet(this.available.releasesUrl, { timeoutMs: 20_000 });
    if (res.statusCode !== 200) throw new Error(`RELEASES manifest responded ${res.statusCode}`);
    const text = (await readBody(res, 1024 * 1024)).toString('utf8');
    const entries = parseReleasesManifest(text);
    const entry = entries.get(this.available.setupName.toLowerCase());
    if (!entry) {
      throw new Error(`RELEASES manifest does not list ${this.available.setupName}`);
    }
    if (Number.isFinite(entry.size) && entry.size > 0 && this.available.setupSize > 0 && entry.size !== this.available.setupSize) {
      throw new Error('RELEASES manifest size disagrees with the release asset metadata');
    }
    return entry;
  }

  async download() {
    if (!this.available || this.state === 'downloading' || this.state === 'ready') return;
    const meta = await this.validateReleasesEntry(); // throws on inconsistent manifest

    this.state = 'downloading';
    this.progress = { receivedBytes: 0, totalBytes: this.available.setupSize || 0 };
    this.aborted = false;
    this.emit();

    fs.mkdirSync(this.updatesDir, { recursive: true });
    const tmpFile = path.join(
      this.updatesDir,
      `.${this.available.setupName}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.part`,
    );

    const res = await httpGet(this.available.setupUrl, { timeoutMs: 30_000 });
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`installer download responded ${res.statusCode}`);
    }
    this.activeRequest = res.req ?? res.request ?? null;

    const hasher = crypto.createHash('sha1');
    const out = fs.createWriteStream(tmpFile);
    let lastEmit = 0;

    const cleanupPartial = () => {
      try { out.destroy(); } catch { /* already gone */ }
      fs.promises.unlink(tmpFile).catch(() => {});
    };

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          err ? reject(err) : resolve();
        };
        const watchdog = setTimeout(() => {
          res.destroy();
          settle(new Error('installer download timed out'));
        }, 120_000);

        res.on('data', (chunk) => {
          hasher.update(chunk);
          out.write(chunk);
          this.progress.receivedBytes += chunk.length;
          const now = Date.now();
          if (now - lastEmit > PROGRESS_THROTTLE_MS) {
            lastEmit = now;
            this.emit();
          }
        });
        res.on('end', () => {
          out.end(() => {
            clearTimeout(watchdog);
            setImmediate(() => settle(null));
          });
        });
        res.on('error', (err) => {
          cleanupPartial();
          settle(err);
        });
        res.on('aborted', () => {
          cleanupPartial();
          settle(new Error('installer download aborted'));
        });
        out.on('error', (err) => {
          res.destroy();
          settle(err);
        });

        if (this.aborted) {
          res.destroy();
          settle(Object.assign(new Error('download cancelled'), { code: 'CANCELLED' }));
        }
      });
    } catch (err) {
      if (this.aborted || err.code === 'CANCELLED') {
        // cancelDownload() already broadcast the honest idle state.
        this.state = 'idle';
        this.progress = null;
        this.emit();
        return this.getStatus();
      }
      throw err;
    }

    // Digest verification against the RELEASES manifest entry. A mismatch
    // deletes everything staged and reports honestly rather than offering a
    // corrupt installer.
    const actualSha1 = hasher.digest('hex').toLowerCase();
    if (meta?.hash && meta.hash !== actualSha1) {
      cleanupPartial();
      this.state = 'error';
      this.lastError = `downloaded installer digest does not match the RELEASES manifest (expected ${meta.hash.slice(0, 12)}..., got ${actualSha1.slice(0, 12)}...)`;
      this.emit();
      return;
    }

    const target = path.join(this.updatesDir, this.available.setupName);
    try {
      await renameWithRetry(tmpFile, target);
    } catch (err) {
      cleanupPartial();
      this.state = 'error';
      this.lastError = `could not stage the installer: ${truncate(err.message)}`;
      this.emit();
      return;
    }

    this.stagedFile = target;
    this.state = 'ready';
    this.progress = null;
    this.emit();
  }

  cancelDownload() {
    if (this.state !== 'downloading' && this.state !== 'available') {
      return this.getStatus();
    }
    this.aborted = true;
    try {
      this.activeRequest?.destroy?.(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    } catch { /* request may have finished */ }
    this.state = 'idle';
    this.progress = null;
    this.emit();
    return this.getStatus();
  }

  /**
   * Spawn the staged installer detached and exit. Squirrel.Windows applies
   * the update and relaunches the app itself; nothing here force-kills work
   * in flight because the renderer has already passed its unsaved-work guard
   * before this call arrives.
   */
  install() {
    if (this.state !== 'ready' || !this.stagedFile || !fs.existsSync(this.stagedFile)) {
      this.state = 'error';
      this.lastError = 'no staged installer is ready to install';
      this.emit();
      return false;
    }
    const child = spawn(this.stagedFile, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(this.stagedFile),
    });
    child.unref();
    console.log(`[updater] spawned staged installer ${this.stagedFile}; exiting`);
    setTimeout(() => app.quit(), 500).unref?.();
    return true;
  }
}

/** Rename with bounded retry for Windows transient sharing violations. */
async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      if (!RETRY_CODES.has(err.code)) throw err;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}
