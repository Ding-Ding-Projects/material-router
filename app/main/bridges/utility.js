// Purpose: Toolbox lane - local file converter. Owns the adapter registry,
// the persistent resumable batch queue (JSONStore, concurrency 2), byte
// signature detection, per-format inspection, destination pickers, free-space
// preflight, and the sandboxed child-process execution of conversions
// (allowlisted argv = one temp job file; wall-clock deadline kill).
//
// Raster image work runs in the renderer's offscreen canvas engine (no bundled
// native codec exists in plain Node); those jobs round-trip through this
// bridge and are still written atomically here after validation.
//
// Owned by the Utility (Toolbox) lane.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, dialog, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { registerHandler, broadcast as mainBroadcast } from '../ipc.js';
import { JSONStore, atomicWriteFile } from '../store.js';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'utility-worker.cjs');

const CONCURRENCY = 2;
const DETECT_DEADLINE_MS = 20_000;
const INSPECT_DEADLINE_MS = 30_000;
const CONVERT_DEADLINE_MS = 10 * 60_000;
const RENDER_JOB_DEADLINE_MS = 150_000;
const IN_MEMORY_LIMIT = 64 * 1024 * 1024;
const MIN_FREE_BYTES = 64 * 1024 * 1024;

/** @type {JSONStore|null} */
let store = null;
let tmpDir = null;
let running = 0;
/** @type {Map<string,{child:import('child_process').ChildProcess, timer:NodeJS.Timeout}>} */
const activeChildren = new Map();
/** @type {Map<string,{resolve:Function,reject:Function,timer:NodeJS.Timeout}>} */
const pendingRenderJobs = new Map();

// ---------------------------------------------------------------------------
// adapter registry (single source of truth surfaced to the UI verbatim)
// ---------------------------------------------------------------------------

/**
 * Every adapter declares its category, source formats, targets, engine,
 * bundled status, lossiness notes and resource limits. Entries with
 * bundled:false stay visible in the catalog but are disabled with their exact
 * missing-dependency reason - gaps are never hidden.
 */
export const REGISTRY = {
  schemaVersion: 1,
  categories: [
    {
      id: 'documents',
      adapters: [
        {
          id: 'pdf-split',
          engine: 'worker',
          bundled: true,
          sources: ['pdf'],
          target: { format: 'pdf', ext: '.pdf' },
          args: [{ id: 'ranges', type: 'text', placeholder: 'e.g. 1,3-5 (empty = every page)' }],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.pdfStructural',
          requiresKeys: ['utility.req.pdfUnencrypted'],
        },
        {
          id: 'pdf-merge',
          engine: 'worker',
          bundled: true,
          sources: ['pdf'],
          multiSource: true,
          target: { format: 'pdf', ext: '.pdf' },
          args: [],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.pdfMerge',
          requiresKeys: ['utility.req.pdfUnencrypted'],
        },
        {
          id: 'pdf-reorder',
          engine: 'worker',
          bundled: true,
          sources: ['pdf'],
          target: { format: 'pdf', ext: '.pdf' },
          args: [{ id: 'order', type: 'page-order' }],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.pdfStructural',
          requiresKeys: ['utility.req.pdfUnencrypted'],
        },
        {
          id: 'pdf-rotate',
          engine: 'worker',
          bundled: true,
          sources: ['pdf'],
          target: { format: 'pdf', ext: '.pdf' },
          args: [{ id: 'rotate', type: 'select', options: [90, 180, 270], default: 90 }],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.pdfRotate',
          requiresKeys: ['utility.req.pdfUnencrypted'],
        },
        {
          id: 'docx-any',
          engine: 'worker',
          bundled: false,
          sources: ['docx'],
          target: { format: 'pdf', ext: '.pdf' },
          unavailableReasonKey: 'utility.unavailable.docx',
        },
      ],
    },
    {
      id: 'images',
      adapters: [
        {
          id: 'img-convert',
          engine: 'renderer',
          bundled: true,
          sources: ['png', 'jpeg', 'bmp', 'webp', 'gif'],
          target: { format: 'select', options: ['png', 'jpeg', 'webp', 'bmp'], ext: null },
          args: [{ id: 'scalePercent', type: 'number', min: 5, max: 400, default: 100 }],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: RENDER_JOB_DEADLINE_MS },
          lossy: true,
          notesKey: 'utility.notes.imgConvert',
        },
        {
          id: 'png-to-ico',
          engine: 'hybrid',
          bundled: true,
          sources: ['png'],
          target: { format: 'ico', ext: '.ico' },
          args: [{ id: 'sizes', type: 'multi', options: [16, 32, 48, 64, 128, 256], default: [16, 32, 48, 256] }],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: RENDER_JOB_DEADLINE_MS },
          lossy: true,
          notesKey: 'utility.notes.icoWrap',
        },
        {
          id: 'tiff-any',
          engine: 'renderer',
          bundled: false,
          sources: ['tiff'],
          target: { format: 'png', ext: '.png' },
          unavailableReasonKey: 'utility.unavailable.tiff',
        },
        {
          id: 'heic-any',
          engine: 'renderer',
          bundled: false,
          sources: ['heic'],
          target: { format: 'png', ext: '.png' },
          unavailableReasonKey: 'utility.unavailable.heic',
        },
      ],
    },
    {
      id: 'audio',
      adapters: [
        {
          id: 'wav-convert',
          engine: 'worker',
          bundled: true,
          sources: ['wav'],
          target: { format: 'wav', ext: '.wav' },
          args: [
            { id: 'sampleRate', type: 'number', min: 8000, max: 192000, default: null },
            { id: 'bits', type: 'select', options: [8, 16, 24, 32], default: null },
            { id: 'channels', type: 'number', min: 1, max: 8, default: null },
          ],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: true,
          notesKey: 'utility.notes.wavResample',
        },
        {
          id: 'wav-to-raw',
          engine: 'worker',
          bundled: true,
          sources: ['wav'],
          target: { format: 'pcm', ext: '.pcm' },
          args: [],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.wavRaw',
        },
        {
          id: 'raw-to-wav',
          engine: 'worker',
          bundled: true,
          sources: ['pcm'],
          target: { format: 'wav', ext: '.wav' },
          args: [
            { id: 'sampleRate', type: 'number', min: 8000, max: 192000, default: 44100 },
            { id: 'bits', type: 'select', options: [8, 16, 24, 32], default: 16 },
            { id: 'channels', type: 'number', min: 1, max: 8, default: 2 },
          ],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.rawWav',
        },
        {
          id: 'mp3-decode',
          engine: 'worker',
          bundled: false,
          sources: ['mp3', 'ogg', 'flac', 'm4a'],
          target: { format: 'wav', ext: '.wav' },
          unavailableReasonKey: 'utility.unavailable.audioCodec',
        },
      ],
    },
    {
      id: 'video',
      adapters: [
        {
          id: 'video-transcode',
          engine: 'worker',
          bundled: false,
          sources: ['mp4', 'mov', 'mkv', 'webm', 'avi'],
          target: { format: 'webm', ext: '.webm' },
          unavailableReasonKey: 'utility.unavailable.videoCodec',
        },
      ],
    },
    {
      id: 'archives',
      adapters: [
        {
          id: 'zip-extract',
          engine: 'worker',
          bundled: true,
          sources: ['zip'],
          target: { format: 'folder', ext: '' },
          folderTarget: true,
          args: [],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.zipExtract',
        },
        {
          id: 'zip-create',
          engine: 'worker',
          bundled: true,
          sources: ['*'],
          multiSource: true,
          target: { format: 'zip', ext: '.zip' },
          args: [],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: false,
          notesKey: 'utility.notes.zipCreate',
        },
        {
          id: '7z-any',
          engine: 'worker',
          bundled: false,
          sources: ['7z'],
          target: { format: 'folder', ext: '' },
          folderTarget: true,
          unavailableReasonKey: 'utility.unavailable.sevenZip',
        },
        {
          id: 'rar-any',
          engine: 'worker',
          bundled: false,
          sources: ['rar'],
          target: { format: 'folder', ext: '' },
          folderTarget: true,
          unavailableReasonKey: 'utility.unavailable.rar',
        },
      ],
    },
    {
      id: 'structured',
      adapters: [
        { id: 'json-to-yaml', engine: 'worker', bundled: true, sources: ['json'], target: { format: 'yaml', ext: '.yaml' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.yamlSubset' },
        { id: 'yaml-to-json', engine: 'worker', bundled: true, sources: ['yaml'], target: { format: 'json', ext: '.json' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.yamlSubsetRead' },
        { id: 'json-to-toml', engine: 'worker', bundled: true, sources: ['json'], target: { format: 'toml', ext: '.toml' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.tomlSubset' },
        { id: 'toml-to-json', engine: 'worker', bundled: true, sources: ['toml'], target: { format: 'json', ext: '.json' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.tomlSubsetRead' },
        { id: 'json-to-csv', engine: 'worker', bundled: true, sources: ['json'], target: { format: 'csv', ext: '.csv' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.csvNest' },
        { id: 'csv-to-json', engine: 'worker', bundled: true, sources: ['csv'], target: { format: 'json', ext: '.json' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.csvTyped' },
        { id: 'json-to-tsv', engine: 'worker', bundled: true, sources: ['json'], target: { format: 'tsv', ext: '.tsv' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.csvNest' },
        { id: 'tsv-to-json', engine: 'worker', bundled: true, sources: ['tsv'], target: { format: 'json', ext: '.json' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: true, notesKey: 'utility.notes.csvTyped' },
      ],
    },
    {
      id: 'text',
      adapters: [
        {
          id: 'text-convert',
          engine: 'worker',
          bundled: true,
          sources: ['text', 'json', 'yaml', 'toml', 'csv', 'tsv'],
          target: { format: 'text', ext: '.txt' },
          args: [
            { id: 'targetEncoding', type: 'select', options: ['utf8', 'utf16le', 'utf16be', 'latin1'], default: 'utf8' },
            { id: 'bom', type: 'select', options: ['none', 'utf8', 'utf16le', 'utf16be'], default: 'none' },
            { id: 'newlines', type: 'select', options: ['keep', 'lf', 'crlf', 'cr'], default: 'keep' },
          ],
          limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS },
          lossy: true,
          notesKey: 'utility.notes.textEnc',
        },
      ],
    },
    {
      id: 'binary',
      adapters: [
        { id: 'to-base64', engine: 'worker', bundled: true, sources: ['*'], target: { format: 'text', ext: '.base64.txt' }, args: [], limits: { inMemoryBytes: null, deadlineMs: CONVERT_DEADLINE_MS }, lossy: false, notesKey: 'utility.notes.base64' },
        { id: 'to-hex', engine: 'worker', bundled: true, sources: ['*'], target: { format: 'text', ext: '.hex.txt' }, args: [], limits: { inMemoryBytes: null, deadlineMs: CONVERT_DEADLINE_MS }, lossy: false, notesKey: 'utility.notes.hex' },
        { id: 'from-base64', engine: 'worker', bundled: true, sources: ['text'], target: { format: 'binary', ext: '.bin' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: false, notesKey: 'utility.notes.fromB64' },
        { id: 'from-hex', engine: 'worker', bundled: true, sources: ['text'], target: { format: 'binary', ext: '.bin' }, args: [], limits: { inMemoryBytes: IN_MEMORY_LIMIT, deadlineMs: CONVERT_DEADLINE_MS }, lossy: false, notesKey: 'utility.notes.fromHex' },
      ],
    },
  ],
};

function findAdapter(id) {
  for (const cat of REGISTRY.categories) {
    const a = cat.adapters.find((x) => x.id === id);
    if (a) return { ...a, category: cat.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// store / lifecycle
// ---------------------------------------------------------------------------

export function register(ctx) {
  const { broadcast } = ctx;
  store = new JSONStore(path.join(app.getPath('userData'), 'utility-converter.json'), {
    defaults: { schemaVersion: 1, jobs: [], paused: false },
  });
  tmpDir = path.join(app.getPath('userData'), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  recoverInterrupted();

  registerHandler('utility', 'registry', () => REGISTRY);
  registerHandler('utility', 'detect', (payload) => runDetect(payload));
  registerHandler('utility', 'inspect', (payload) => runInspect(payload));
  registerHandler('utility', 'read-bytes', ({ path: p, maxBytes } = {}) => readBytes(String(p || ''), Number(maxBytes) || IN_MEMORY_LIMIT));
  registerHandler('utility', 'stage-bytes', ({ name, bytes } = {}) => stageBytes(String(name || 'dropped.bin'), bytes));
  registerHandler('utility', 'pick-save', ({ title, defaultName, filters } = {}, event) => pickSave(title, defaultName, filters, event));
  registerHandler('utility', 'pick-folder', ({ title } = {}, event) => pickFolder(title, event));
  registerHandler('utility', 'enqueue', ({ specs } = {}) => enqueue(specs, broadcast));
  registerHandler('utility', 'queue', () => snapshot());
  registerHandler('utility', 'set-paused', ({ paused } = {}) => {
    store.set('paused', Boolean(paused));
    pump(broadcast);
    return snapshot();
  });
  registerHandler('utility', 'cancel-job', ({ id } = {}) => cancelJob(String(id || ''), broadcast));
  registerHandler('utility', 'retry-job', ({ id } = {}) => retryJob(String(id || ''), broadcast));
  registerHandler('utility', 'remove-job', ({ id } = {}) => removeJob(String(id || ''), broadcast));
  registerHandler('utility', 'clear-finished', () => clearFinished(broadcast));
  registerHandler('utility', 'render-result', ({ jobId, ok, bytes, text, auxFiles, error } = {}) => {
    const pending = pendingRenderJobs.get(String(jobId || ''));
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingRenderJobs.delete(String(jobId));
    if (ok === false) pending.reject(new Error(error || 'image engine reported failure'));
    else pending.resolve({ bytes: bytes ?? null, text: text ?? null, auxFiles: Array.isArray(auxFiles) ? auxFiles : [] });
    return true;
  });

  // Drain anything left runnable once the window exists (renderer jobs need it).
  app.whenReady().then(() => setTimeout(() => pump(broadcast), 1500));

  return { snapshot: () => snapshot() };
}

function recoverInterrupted() {
  const jobs = store.get('jobs', []);
  let changed = false;
  for (const job of jobs) {
    if (job.state === 'converting') {
      job.state = 'interrupted';
      job.error = 'the app closed while this conversion was running; nothing partial was written - retry to run it again';
      job.finishedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) store.set('jobs', jobs);
}

function snapshot() {
  return {
    jobs: store.get('jobs', []),
    paused: Boolean(store.get('paused', false)),
    concurrency: CONCURRENCY,
  };
}

function persistJobs(jobs) {
  store.set('jobs', jobs);
}

// ---------------------------------------------------------------------------
// detection / inspection / read
// ---------------------------------------------------------------------------

async function runDetect({ path: p } = {}) {
  if (!p) throw new Error('detect needs a file path');
  const result = await runWorker({
    op: 'detect',
    in: String(p),
  }, DETECT_DEADLINE_MS);
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
  return result.result;
}

async function runInspect({ path: p, format } = {}) {
  if (!p || !format) throw new Error('inspect needs a path and format');
  const result = await runWorker({
    op: 'inspect',
    in: String(p),
    args: { format: String(format) },
  }, INSPECT_DEADLINE_MS);
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
  return result.result;
}

async function readBytes(p, maxBytes) {
  const st = await fs.promises.stat(p).catch(() => null);
  if (!st || !st.isFile()) throw Object.assign(new Error(`not a readable file: ${path.basename(p)}`), { code: 'NO_SOURCE' });
  if (st.size > maxBytes) {
    throw Object.assign(
      new Error(`file is ${st.size} bytes; the in-app image engine holds input in memory and is capped at ${maxBytes} bytes`),
      { code: 'TOO_BIG' },
    );
  }
  const buf = await fs.promises.readFile(p);
  // Return an owned copy so structured clone hands the renderer a stable view.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Drag-dropped files arrive as bytes (the sandboxed renderer has no paths).
 *  They are staged into the app's temp dir so the sandboxed worker can read
 *  them like any other source. Bounded by the honest in-memory cap. */
async function stageBytes(name, bytes) {
  const buf = Buffer.from(bytes ?? null);
  if (buf.length === 0) throw Object.assign(new Error('dropped file was empty'), { code: 'EMPTY' });
  if (buf.length > IN_MEMORY_LIMIT) {
    throw Object.assign(
      new Error(`dropped file is ${buf.length} bytes; staging is capped at ${IN_MEMORY_LIMIT} bytes - use "Choose file" for larger files`),
      { code: 'TOO_BIG' },
    );
  }
  const safeBase = path.basename(name).replace(/[\\/:*?"<>|]/g, '_') || 'dropped.bin';
  const target = path.join(tmpDir, `staged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}`);
  await atomicWriteFile(target, buf);
  return { path: target, name: safeBase, size: buf.length };
}

async function pickSave(title, defaultName, filters, event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    title: typeof title === 'string' ? title : 'Save output',
    defaultPath: defaultName ? path.join(app.getPath('downloads'), defaultName) : undefined,
    filters: Array.isArray(filters) ? filters : undefined,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  return result.canceled ? null : result.filePath;
}

async function pickFolder(title, event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: typeof title === 'string' ? title : 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

// ---------------------------------------------------------------------------
// sandboxed worker execution
// ---------------------------------------------------------------------------

let jobCounter = 0;

function runWorker(jobSpec, deadlineMs, jobId = null) {
  return new Promise((resolve, reject) => {
    jobCounter += 1;
    const jobFile = path.join(tmpDir, `conv-${process.pid}-${Date.now()}-${jobCounter}.json`);
    let settled = false;
    let child;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (jobId) activeChildren.delete(jobId);
      try { fs.rmSync(jobFile, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(`${jobFile}.result`, { force: true }); } catch { /* best effort */ }
      fn(value);
    };

    let payload = { ...jobSpec };

    const writeJobThenSpawn = () => {
      fs.writeFile(jobFile, JSON.stringify(payload), (err) => {
        if (err) return finish(reject, err);
        child = spawn(process.execPath, [WORKER_PATH, jobFile], {
          cwd: tmpDir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        });
        let stderr = '';
        child.stderr?.on('data', (d) => { stderr += String(d); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
        if (jobId) activeChildren.set(jobId, { child, timer });
        child.on('error', (spawnErr) => finish(reject, spawnErr));
        child.on('close', (code) => {
          fs.readFile(`${jobFile}.result`, 'utf8', (readErr, raw) => {
            if (readErr) {
              finish(reject, new Error(`converter worker exited (${code}) without a result${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
              return;
            }
            try {
              finish(resolve, JSON.parse(raw));
            } catch (parseErr) {
              finish(reject, new Error(`converter worker produced an unreadable result: ${parseErr.message}`));
            }
          });
        });
      });
    };

    const timer = setTimeout(() => {
      if (child && child.exitCode === null) {
        try { child.kill(); } catch { /* already gone */ }
      }
      finish(reject, Object.assign(new Error(`conversion exceeded its ${Math.round(deadlineMs / 1000)}s deadline and was stopped`), { code: 'DEADLINE' }));
    }, deadlineMs);

    writeJobThenSpawn();
  });
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

function enqueue(specs, broadcast) {
  if (!Array.isArray(specs)) throw new Error('enqueue needs a specs array');
  if (specs.length > 5000) throw new Error(`refusing to queue more than 5000 items in one action (got ${specs.length})`);
  const jobs = store.get('jobs', []);
  const now = new Date().toISOString();
  for (const spec of specs) {
    const adapter = findAdapter(String(spec.adapterId || ''));
    if (!adapter || adapter.bundled === false) throw new Error(`unknown or disabled adapter "${spec.adapterId}"`);
    const entry = {
      id: `job_${now.replace(/[-:.TZ]/g, '')}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      adapterId: adapter.id,
      category: adapter.category,
      engine: adapter.engine,
      sourcePath: String(spec.sourcePath || ''),
      sourceName: path.basename(String(spec.sourcePath || '')),
      extraSources: Array.isArray(spec.extraSources) ? spec.extraSources.map(String) : [],
      args: spec.args && typeof spec.args === 'object' ? spec.args : {},
      targetLabel: String(spec.targetLabel || adapter.target?.format || ''),
      destinationPath: String(spec.destinationPath || ''),
      destinationDir: String(spec.destinationDir || ''),
      overwriteConfirmed: Boolean(spec.overwriteConfirmed),
      state: 'pending',
      error: null,
      skipReason: null,
      outputBytes: null,
      startedAt: null,
      finishedAt: null,
    };
    if (!entry.sourcePath && adapter.id !== 'zip-create') throw new Error('enqueue needs a sourcePath');
    if (!entry.destinationPath) throw new Error('enqueue needs a destinationPath');
    jobs.push(entry);
  }
  persistJobs(jobs);
  broadcast('utility-queue', snapshot());
  pump(broadcast);
  return snapshot();
}

function updateJob(id, patch, broadcast) {
  const jobs = store.get('jobs', []);
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  Object.assign(job, patch);
  persistJobs(jobs);
  broadcast('utility-queue', snapshot());
  return job;
}

function pump(broadcast) {
  if (!store || store.get('paused', false)) return;
  const jobs = store.get('jobs', []);
  const pending = jobs.filter((j) => j.state === 'pending');
  while (running < CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    running += 1;
    runJob(job.id, broadcast).finally(() => {
      running -= 1;
      pump(broadcast);
    });
  }
}

async function runJob(id, broadcast) {
  const jobsAtStart = store.get('jobs', []);
  const job = jobsAtStart.find((j) => j.id === id);
  if (!job || job.state !== 'pending') return;
  try {
    // Preflight: source present, destination writable, disk headroom.
    const st = await fs.promises.stat(job.sourcePath).catch(() => null);
    if (!st || !st.isFile()) {
      updateJob(id, { state: 'failed', error: `source is gone: ${job.sourceName}`, finishedAt: new Date().toISOString() }, broadcast);
      return;
    }
    const dir = path.dirname(job.destinationPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const exists = await fs.promises.stat(job.destinationPath).then(() => true).catch(() => false);
    if (exists && !job.overwriteConfirmed) {
      updateJob(id, { state: 'skipped', skipReason: 'destination exists and was not confirmed for replacement', finishedAt: new Date().toISOString() }, broadcast);
      return;
    }
    const free = await freeBytes(dir);
    const required = Math.max(MIN_FREE_BYTES, st.size * 2);
    if (free !== null && free < required) {
      updateJob(id, {
        state: 'failed',
        error: `insufficient disk space: ${Math.round(free / 1048576)} MB free, this conversion reserves about ${Math.round(required / 1048576)} MB`,
        finishedAt: new Date().toISOString(),
      }, broadcast);
      return;
    }

    updateJob(id, { state: 'converting', startedAt: new Date().toISOString(), error: null, skipReason: null }, broadcast);

    const out = await execute(job, st.size);
    // A cancellation that landed mid-run discards the finished output.
    const liveState = store.get('jobs', []).find((j) => j.id === id)?.state;
    if (liveState === 'cancelling') {
      throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    }
    const validated = validateOutput(job.adapterId, out);
    if (!validated.ok) throw new Error(`output failed validation: ${validated.reason}`);

    await atomicWriteFile(job.destinationPath, out.bytes);
    updateJob(id, {
      state: 'done',
      outputBytes: out.bytes.length,
      finishedAt: new Date().toISOString(),
      detail: validated.detail ?? null,
    }, broadcast);
  } catch (err) {
    // Never leave partial output behind: atomicWriteFile means the destination
    // either receives the full validated bytes or nothing at all.
    const cancelled = err?.code === 'CANCELLED'
      || store.get('jobs', []).find((j) => j.id === id)?.state === 'cancelling';
    updateJob(id, {
      state: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? 'cancelled before the output was written' : (err?.message || 'conversion failed'),
      finishedAt: new Date().toISOString(),
    }, broadcast);
  }
}

async function freeBytes(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null; // statfs unsupported: skip the bound rather than block the queue
  }
}

async function execute(job, sourceSize) {
  const adapter = findAdapter(job.adapterId);
  const args = { ...job.args };

  if (adapter.engine === 'worker') {
    const spec = {
      op: 'convert',
      adapter: job.adapterId,
      in: job.sourcePath,
      args: buildWorkerArgs(job, adapter, args),
    };
    const result = await runWorker(spec, adapter.limits?.deadlineMs ?? CONVERT_DEADLINE_MS, job.id);
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    if (result.bytes) return { bytes: Buffer.from(result.bytes) };
    if (result.text != null) return { bytes: Buffer.from(result.text, 'utf8') };
    throw new Error('worker returned neither bytes nor text');
  }

  if (adapter.engine === 'renderer' || adapter.engine === 'hybrid') {
    if (adapter.engine === 'hybrid' && adapter.id === 'png-to-ico') return executeIco(job, args);
    const rendered = await requestRenderJob(job, { kind: 'convert', adapterId: job.adapterId, args, sourcePath: job.sourcePath, sourceBytes: sourceSize });
    if (rendered.text != null) return { bytes: Buffer.from(rendered.text, 'utf8') };
    if (rendered.bytes) return { bytes: Buffer.from(rendered.bytes) };
    throw new Error('image engine returned no output');
  }

  throw new Error(`adapter "${job.adapterId}" has no executable engine`);
}

function buildWorkerArgs(job, adapter, args) {
  const clean = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined || v === '') continue;
    clean[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) : v;
  }
  if (adapter.id === 'pdf-merge') clean.sources = [job.sourcePath, ...job.extraSources];
  if (adapter.id === 'zip-extract') clean.destDir = job.destinationDir || path.dirname(job.destinationPath);
  if (adapter.id === 'zip-create') {
    clean.files = [
      { path: job.sourcePath, name: path.basename(job.sourcePath) },
      ...job.extraSources.map((p) => ({ path: p, name: path.basename(p) })),
    ];
  }
  return clean;
}

/** Hybrid icon pipeline: the renderer encodes each size as PNG, this side wraps
 *  them into the ICO container through the same sandboxed worker. */
async function executeIco(job, args) {
  const sizes = (Array.isArray(args.sizes) && args.sizes.length ? args.sizes : [16, 32, 48, 256])
    .map(Number).filter((n) => n >= 16 && n <= 256);
  const rendered = await requestRenderJob(job, { kind: 'ico-layers', sourcePath: job.sourcePath, sizes });
  if (!Array.isArray(rendered.auxFiles) || rendered.auxFiles.length === 0) {
    // Fall back to inline layers delivered as one concatenated payload.
    if (!rendered.bytes) throw new Error('icon engine returned no layers');
    return { bytes: Buffer.from(rendered.bytes) };
  }
  const layerPaths = [];
  try {
    let i = 0;
    for (const layer of rendered.auxFiles) {
      i += 1;
      const p = path.join(tmpDir, `ico-${job.id}-${i}.png`);
      await fs.promises.writeFile(p, Buffer.from(layer.bytes));
      layerPaths.push(p);
    }
    const result = await runWorker({
      op: 'convert',
      adapter: 'png-to-ico',
      in: layerPaths[0],
      args: { pngFiles: layerPaths },
    }, CONVERT_DEADLINE_MS);
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    return { bytes: Buffer.from(result.bytes) };
  } finally {
    for (const p of layerPaths) fs.promises.rm(p, { force: true }).catch(() => {});
  }
}

function requestRenderJob(job, payload) {
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, timer: null };
    pending.timer = setTimeout(() => {
      pendingRenderJobs.delete(job.id);
      reject(Object.assign(new Error('no response from the in-window image engine (is the Toolbox tab able to run?)'), { code: 'RENDER_TIMEOUT' }));
    }, RENDER_JOB_DEADLINE_MS);
    pendingRenderJobs.set(job.id, pending);
    mainBroadcast('utility-render-job', { jobId: job.id, ...payload });
  });
}

const VALIDATORS = {
  'pdf-split': pdfValidator,
  'pdf-merge': pdfValidator,
  'pdf-reorder': pdfValidator,
  'pdf-rotate': pdfValidator,
};

function pdfValidator(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, reason: 'output does not start with %PDF-' };
  if (!buf.subarray(Math.max(0, buf.length - 64)).toString('latin1').includes('%%EOF')) return { ok: false, reason: 'output has no %%EOF terminator' };
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page(?![sA-Za-z])/g) || []).length;
  return { ok: pages > 0, reason: pages > 0 ? null : 'output contains no page objects', detail: `${pages} page(s)` };
}

function validateOutput(adapterId, out) {
  const buf = out.bytes;
  switch (adapterId) {
    case 'zip-create': {
      const idx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (idx === -1) return { ok: false, reason: 'archive has no end-of-central-directory record' };
      return { ok: true };
    }
    case 'raw-to-wav':
    case 'wav-convert': {
      if (buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WAVE') {
        return { ok: false, reason: 'output is not a RIFF/WAVE file' };
      }
      return { ok: true };
    }
    case 'png-to-ico': {
      if (!(buf.length > 6) || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
        return { ok: false, reason: 'output is not an ICO container' };
      }
      const declared = buf.readUInt16LE(4);
      return declared >= 1 ? { ok: true, detail: `${declared} size layer(s)` } : { ok: false, reason: 'ICO declares zero images' };
    }
    case 'json-to-yaml': case 'json-to-toml': case 'json-to-csv': case 'json-to-tsv':
    case 'csv-to-json': case 'tsv-to-json': case 'yaml-to-json': case 'toml-to-json': {
      if (adapterId.endsWith('to-json')) {
        try {
          JSON.parse(buf.toString('utf8'));
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: `round-trip JSON parse failed: ${err.message.slice(0, 120)}` };
        }
      }
      return buf.length > 0 ? { ok: true } : { ok: false, reason: 'empty output' };
    }
    case 'json-to-json': return { ok: true };
    default: {
      const custom = VALIDATORS[adapterId];
      if (custom) return custom(buf);
      return buf.length > 0 ? { ok: true } : { ok: false, reason: 'empty output' };
    }
  }
}

// ---------------------------------------------------------------------------
// queue mutations
// ---------------------------------------------------------------------------

function cancelJob(id, broadcast) {
  const jobs = store.get('jobs', []);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`no such job "${id}"`);
  if (['done', 'failed', 'cancelled', 'skipped'].includes(job.state)) return snapshot();
  if (job.state === 'converting' || job.state === 'cancelling') {
    // Mark intent; kill the sandboxed child if one is running. The run loop
    // turns this into the terminal cancelled state when execution unwinds.
    job.state = 'cancelling';
    persistJobs(jobs);
    const active = activeChildren.get(job.id);
    if (active) {
      clearTimeout(active.timer);
      try { active.child.kill(); } catch { /* already gone */ }
    }
    const pendingRender = pendingRenderJobs.get(job.id);
    if (pendingRender) {
      clearTimeout(pendingRender.timer);
      pendingRenderJobs.delete(job.id);
      pendingRender.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    }
    broadcast('utility-queue', snapshot());
    return snapshot();
  }
  job.state = 'cancelled';
  job.finishedAt = new Date().toISOString();
  persistJobs(jobs);
  broadcast('utility-queue', snapshot());
  return snapshot();
}

function retryJob(id, broadcast) {
  const jobs = store.get('jobs', []);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`no such job "${id}"`);
  job.state = 'pending';
  job.error = null;
  job.skipReason = null;
  job.startedAt = null;
  job.finishedAt = null;
  persistJobs(jobs);
  broadcast('utility-queue', snapshot());
  pump(broadcast);
  return snapshot();
}

function removeJob(id, broadcast) {
  const jobs = store.get('jobs', []);
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) throw new Error(`no such job "${id}"`);
  if (jobs[idx].state === 'converting') throw new Error('cancel the running job before removing it');
  jobs.splice(idx, 1);
  persistJobs(jobs);
  broadcast('utility-queue', snapshot());
  return snapshot();
}

function clearFinished(broadcast) {
  const jobs = store.get('jobs', []).filter((j) => !['done', 'failed', 'cancelled', 'skipped'].includes(j.state));
  persistJobs(jobs);
  broadcast('utility-queue', snapshot());
  return snapshot();
}


