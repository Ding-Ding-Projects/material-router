// Purpose: Toolbox tab - the local file converter and the local Ollama suite
// manager. Converter: byte-signature detection, a fully declared adapter
// catalog (unavailable formats stay visible with their exact reason), honest
// pre-convert disclosure, destination pickers with overwrite super-confirm,
// and a persistent resumable batch queue. Ollama: service diagnosis, installed
// models, the official Model Store with conservative hardware verdicts, a
// batch-pull cart, streaming local chat with sessions, and a harness launcher
// with file-picker profile registration, preflight review and snapshot
// rollback. All copy goes through t()/copy() with en + zh-HK bundles.
// Owned by the Utility lane - replace freely; keep tab id 'utility'.

import { h, fmtBytes, saveText } from '../../core/util.js';
import { invoke, on } from '../../core/bridge.js';
import { addBundle, t, copy } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import { destructiveConfirm, openModal, promptText } from '../../core/dialogs.js';
import { toast } from '../../core/toasts.js';
import * as history from '../../core/history.js';
import * as palette from '../../core/palette.js';
import { renderInto } from '../../core/md.js';
import { en } from './utility.en.js';
import { zh } from './utility.zh.js';

addBundle('utility', { en, zh });
// The Ollama half shares this bundle under its own namespace prefix.
addBundle('ollama', { en, zh });

// ===========================================================================
// in-window raster engine: serves the queue's renderer-engine jobs
// ===========================================================================

/** BMP decode for the formats createImageBitmap cannot always take; honest
 *  about the subset (BI_RGB, 8/24/32-bit). */
function parseBmp(bytes) {
  const dv = new DataView(bytes.buffer ?? bytes);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP');
  const dataOffset = dv.getUint32(10, true);
  const headerSize = dv.getUint32(14, true);
  const width = dv.getInt32(18, true);
  const heightRaw = dv.getInt32(22, true);
  const height = Math.abs(heightRaw);
  const planes = dv.getUint16(26, true);
  const bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);
  if (compression !== 0) throw new Error(`BMP compression ${compression} is outside the bundled decoder (BI_RGB only)`);
  if (![1, 4, 8, 24, 32].includes(bpp)) throw new Error(`BMP bit depth ${bpp} is outside the bundled decoder`);
  if (planes !== 1) throw new Error('unexpected BMP planes value');
  const out = new Uint8ClampedArray(width * height * 4);
  const palette = [];
  if (bpp <= 8) {
    const numColors = dv.getUint32(46, true) || (1 << bpp);
    const palStart = 14 + headerSize;
    for (let i = 0; i < numColors; i++) {
      palette.push([bytes[palStart + i * 4 + 2], bytes[palStart + i * 4 + 1], bytes[palStart + i * 4]]);
    }
  }
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  for (let y = 0; y < height; y++) {
    const srcY = heightRaw > 0 ? height - 1 - y : y; // bottom-up is the norm
    const rowStart = dataOffset + srcY * rowSize;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpp === 24) {
        const p = rowStart + x * 3;
        out[o] = bytes[p + 2]; out[o + 1] = bytes[p + 1]; out[o + 2] = bytes[p]; out[o + 3] = 255;
      } else if (bpp === 32) {
        const p = rowStart + x * 4;
        out[o] = bytes[p + 2]; out[o + 1] = bytes[p + 1]; out[o + 2] = bytes[p]; out[o + 3] = 255;
      } else {
        const idx = bpp === 8
          ? bytes[rowStart + x]
          : (bpp === 4
            ? (x % 2 === 0 ? bytes[rowStart + (x >> 1)] >> 4 : bytes[rowStart + (x >> 1)] & 0xf)
            : (bytes[rowStart + (x >> 3)] >> (7 - (x & 7))) & 1);
        const c = palette[idx] ?? [0, 0, 0];
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
    }
  }
  return { width, height, data: out };
}

async function loadSourceCanvas(sourcePath) {
  const buf = await invoke('utility:read-bytes', { path: sourcePath });
  const bytes = new Uint8Array(buf);
  try {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return { canvas, width: bitmap.width, height: bitmap.height };
  } catch {
    const img = parseBmp(bytes);
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return { canvas, width: img.width, height: img.height };
  }
}

async function canvasToBytes(canvas, format) {
  if (format === 'bmp') {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const src = ctx.getImageData(0, 0, width, height).data;
    const rowSize = Math.floor((24 * width + 31) / 32) * 4;
    const pixelBytes = rowSize * height;
    const out = new ArrayBuffer(54 + pixelBytes);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    u8[0] = 0x42; u8[1] = 0x4d;
    dv.setUint32(2, 54 + pixelBytes, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, width, true);
    dv.setInt32(22, height, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(34, pixelBytes, true);
    for (let y = 0; y < height; y++) {
      const dstRow = 54 + (height - 1 - y) * rowSize;
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4;
        const d = dstRow + x * 3;
        u8[d] = src[s + 2]; u8[d + 1] = src[s + 1]; u8[d + 2] = src[s];
      }
    }
    return out;
  }
  const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 });
  return blob.arrayBuffer();
}

function scaledCanvas(src, width, height) {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

on('utility-render-job', async (job) => {
  if (!job || !job.jobId) return;
  try {
    if (job.kind === 'ico-layers') {
      const { canvas } = await loadSourceCanvas(job.sourcePath);
      const auxFiles = [];
      for (const size of job.sizes ?? []) {
        const scaled = scaledCanvas(canvas, size, size);
        auxFiles.push({ size, bytes: await canvasToBytes(scaled, 'png') });
      }
      await invoke('utility:render-result', { jobId: job.jobId, ok: true, auxFiles });
      return;
    }
    // plain raster conversion
    const { canvas, width, height } = await loadSourceCanvas(job.sourcePath);
    const pct = Math.min(400, Math.max(5, Number(job.args?.scalePercent) || 100));
    const target = String(job.args?.targetFormat || 'png');
    const outCanvas = pct === 100
      ? canvas
      : scaledCanvas(canvas, Math.round((width * pct) / 100), Math.round((height * pct) / 100));
    const bytes = await canvasToBytes(outCanvas, target);
    await invoke('utility:render-result', { jobId: job.jobId, ok: true, bytes });
  } catch (err) {
    await invoke('utility:render-result', { jobId: job.jobId, ok: false, error: err?.message || 'image engine failed' }).catch(() => {});
  }
});

// ===========================================================================
// small shared pieces
// ===========================================================================

const FORMAT_LABELS = {
  pdf: 'PDF', png: 'PNG', jpeg: 'JPEG', bmp: 'BMP', webp: 'WebP', gif: 'GIF', ico: 'ICO',
  wav: 'WAV', pcm: 'raw PCM', mp3: 'MP3', ogg: 'OGG', flac: 'FLAC',
  mp4: 'MP4', mov: 'QuickTime', mkv: 'Matroska', webm: 'WebM', avi: 'AVI',
  zip: 'ZIP', '7z': '7-Zip', gzip: 'gzip',
  json: 'JSON', yaml: 'YAML', toml: 'TOML', csv: 'CSV', tsv: 'TSV',
  text: 'plain text', binary: 'binary', unknown: 'unknown',
};

function fmtLabel(format) {
  return FORMAT_LABELS[format] ?? String(format ?? '?');
}

function stateChipClass(state) {
  switch (state) {
    case 'done': return 'mr-util-chip--ok';
    case 'failed': case 'interrupted': return 'mr-util-chip--err';
    case 'converting': case 'cancelling': return 'mr-util-chip--busy';
    default: return '';
  }
}

function sectionCard(title, ...children) {
  return h('section', { class: 'm3-card mr-util-card' },
    h('h2', { class: 'm3-card__title' }, title),
    h('div', { class: 'm3-card__body mr-util-cardbody' }, ...children),
  );
}

function verdictLabel(verdict) {
  const map = {
    'Runs well': 'ollama.verdict.runsWell',
    'Runs with limits': 'ollama.verdict.runsWithLimits',
    Unlikely: 'ollama.verdict.unlikely',
    Unknown: 'ollama.verdict.unknown',
  };
  return t(map[verdict] ?? 'ollama.verdict.unknown');
}

function verdictChipClass(verdict) {
  switch (verdict) {
    case 'Runs well': return 'mr-util-chip--ok';
    case 'Runs with limits': return 'mr-util-chip--warn';
    case 'Unlikely': return 'mr-util-chip--err';
    default: return '';
  }
}

// ===========================================================================
// converter state + view
// ===========================================================================

const converter = {
  registry: null,
  source: null, // {path,name,size,detection}
  extraSources: [],
  adapterId: null,
  args: {},
  destinationPath: null,
  destinationDir: null,
  overwriteConfirmed: false,
  queue: { jobs: [], paused: false },
};

async function detectPath(p, name) {
  const detection = await invoke('utility:detect', { path: p });
  converter.source = {
    path: p,
    name: name ?? p.split(/[\\/]/).pop(),
    size: detection.size,
    detection,
  };
  converter.extraSources = [];
  converter.adapterId = null;
  converter.destinationPath = null;
  converter.destinationDir = null;
  converter.overwriteConfirmed = false;
  renderConverter();
}

async function chooseSource() {
  try {
    const paths = await invoke('dialog:file-open', { title: t('utility.src.choose'), multi: false });
    if (paths && paths[0]) await detectPath(paths[0]);
  } catch (err) {
    toast(copy('utility.err.prefix'), err.message, { kind: 'error' });
  }
}

async function addMergeInput() {
  try {
    const paths = await invoke('dialog:file-open', { title: t('utility.mergePick'), multi: true });
    if (paths?.length) {
      converter.extraSources.push(...paths);
      renderConverter();
    }
  } catch (err) {
    toast(copy('utility.err.prefix'), err.message, { kind: 'error' });
  }
}

async function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('mr-util-dropzone--over');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  try {
    const staged = await invoke('utility:stage-bytes', {
      name: files[0].name,
      bytes: await files[0].arrayBuffer(),
    });
    await detectPath(staged.path, staged.name);
  } catch (err) {
    toast(copy('utility.err.stageFailed'), err.message, { kind: 'error' });
  }
}

function compatibleAdapter(adapter) {
  const fmt = converter.source?.detection?.format;
  if (!fmt) return null;
  if (adapter.sources.includes('*')) return true;
  return adapter.sources.includes(fmt);
}

function adapterRow(adapter) {
  const compatible = compatibleAdapter(adapter);
  const bundled = adapter.bundled !== false;
  const selected = converter.adapterId === adapter.id;
  const btn = h('button', {
    class: `mr-util-adapter${selected ? ' mr-util-adapter--selected' : ''}${bundled ? '' : ' mr-util-adapter--disabled'}`,
    disabled: bundled ? null : true,
    'aria-label': `${adapter.id} — ${bundled ? t('utility.adapter.bundled') : t('utility.adapter.unbundled')}`,
    onclick: () => {
      converter.adapterId = adapter.id;
      converter.args = {};
      for (const arg of adapter.args ?? []) {
        converter.args[arg.id] = arg.default ?? (arg.type === 'multi' ? [...(arg.default ?? [])] : null);
      }
      if (adapter.target?.format === 'select') converter.args.targetFormat = 'png';
      converter.destinationPath = null;
      converter.destinationDir = null;
      converter.overwriteConfirmed = false;
      renderConverter();
    },
  },
    h('span', { class: 'mr-util-adapter__name' }, adapter.id),
    compatible === true ? h('span', { class: 'mr-util-chip mr-util-chip--ok' }, t('utility.src.detected')) : null,
    compatible === false ? h('span', { class: 'mr-util-chip' }, fmtLabel(adapter.sources[0])) : null,
    h('span', { class: 'mr-util-adapter__spacer' }),
    bundled
      ? h('span', { class: `mr-util-chip${adapter.lossy ? ' mr-util-chip--warn' : ''}` }, adapter.lossy ? t('utility.adapter.lossy') : t('utility.adapter.lossless'))
      : h('span', { class: 'mr-util-chip mr-util-chip--err' }, t('utility.adapter.unbundled')),
  );
  if (!bundled) {
    const reasonKey = adapter.unavailableReasonKey || `utility.unavailable.${adapter.id}`;
    btn.title = t(reasonKey);
    btn.setAttribute('aria-description', t(reasonKey));
  }
  return btn;
}

function argControl(arg) {
  const id = `arg_${arg.id}`;
  if (arg.type === 'select') {
    const sel = h('select', { class: 'm3-select__inner', id, 'aria-label': arg.id });
    for (const opt of arg.options) sel.append(h('option', { value: String(opt) }, String(opt)));
    sel.value = String(converter.args[arg.id] ?? arg.default ?? '');
    sel.addEventListener('change', () => {
      converter.args[arg.id] = Number.isNaN(Number(sel.value)) ? sel.value : Number(sel.value);
    });
    return h('div', { class: 'm3-select' }, h('label', { for: id }, arg.id), sel);
  }
  if (arg.type === 'multi') {
    const wrap = h('div', { class: 'mr-row', role: 'group', 'aria-label': arg.id, style: 'flex-wrap:wrap' });
    for (const opt of arg.options) {
      wrap.append(h('label', { class: 'm3-checkbox' },
        h('input', {
          type: 'checkbox',
          checked: (converter.args[arg.id] ?? []).includes(opt) ? true : null,
          'aria-label': `${arg.id}: ${opt}px`,
          onchange: (e) => {
            const list = converter.args[arg.id] ?? [];
            const next = e.target.checked ? [...new Set([...list, opt])] : list.filter((x) => x !== opt);
            converter.args[arg.id] = next.sort((a, b) => a - b);
          },
        }),
        ` ${opt}px`,
      ));
    }
    return h('div', {}, h('span', { class: 'mr-typography-label-medium' }, t('utility.adapter.sizesHint')), wrap);
  }
  if (arg.type === 'number') {
    const input = h('input', {
      type: 'number', id, min: arg.min != null ? String(arg.min) : null, max: arg.max != null ? String(arg.max) : null,
      value: converter.args[arg.id] ?? '', 'aria-label': arg.id,
      oninput: (e) => {
        const v = e.target.value === '' ? null : Number(e.target.value);
        converter.args[arg.id] = v;
      },
    });
    return h('div', { class: 'm3-textfield' }, input, h('label', { for: id }, arg.id));
  }
  const input = h('input', {
    type: 'text', id, value: converter.args[arg.id] ?? '',
    placeholder: arg.placeholder ?? '', 'aria-label': arg.id,
    oninput: (e) => { converter.args[arg.id] = e.target.value; },
  });
  return h('div', { class: 'm3-textfield mr-util-textfield-wide' }, input, h('label', { for: id }, arg.id));
}

async function pickDestination(adapter) {
  if (adapter.folderTarget || adapter.id === 'zip-extract') {
    const dir = await invoke('utility:pick-folder', { title: t('utility.dest.pickFolder') });
    if (!dir) return;
    converter.destinationDir = dir;
    converter.destinationPath = dir;
  } else {
    const ext = adapter.target?.format === 'select'
      ? `.${converter.args.targetFormat || 'png'}`
      : (adapter.target?.ext ?? '.out');
    const base = (converter.source?.name ?? 'output').replace(/\.[^.]+$/, '');
    const suggested = `${base}${ext}`;
    const dest = await invoke('utility:pick-save', {
      title: t('utility.dest.saveAs'),
      defaultName: suggested,
    });
    if (!dest) return;
    converter.destinationPath = dest;
    converter.destinationDir = path_dirname(dest);
    converter.overwriteConfirmed = false;
  }
  renderConverter();
}

function path_dirname(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
}

async function convertNow() {
  const adapter = findAdapter(converter.adapterId);
  if (!adapter) return;
  if (!converter.source?.path) {
    toast(t('utility.src.choose'), '', { kind: 'error' });
    return;
  }
  if (!converter.destinationPath) {
    toast(t('utility.dest.none'), '', { kind: 'error' });
    return;
  }
  if (adapter.id === 'pdf-reorder') {
    const order = String(converter.args.order ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number);
    if (order.some((n) => !Number.isInteger(n))) {
      toast(t('utility.adapter.pageOrderHint'), '', { kind: 'error' });
      return;
    }
    converter.args.order = order;
  }
  // Overwrite gate: destructive confirmation names the exact file.
  try {
    const st = await invoke('utility:detect', { path: converter.destinationPath }).catch(() => null);
    const exists = Boolean(st);
    if (exists && !converter.overwriteConfirmed) {
      const ok = await destructiveConfirm({
        title: t('utility.overwrite.title'),
        body: t('utility.overwrite.body', { name: converter.destinationPath.split(/[\\/]/).pop() }),
      });
      if (!ok) return;
      converter.overwriteConfirmed = true;
    }
    await invoke('utility:enqueue', {
      specs: [{
        adapterId: adapter.id,
        sourcePath: converter.source.path,
        extraSources: converter.extraSources,
        args: { ...converter.args, targetFormat: converter.args.targetFormat },
        targetLabel: adapter.target?.format ?? '',
        destinationPath: converter.destinationPath,
        destinationDir: converter.destinationDir ?? path_dirname(converter.destinationPath),
        overwriteConfirmed: converter.overwriteConfirmed,
      }],
    });
    toast(copy('utility.convertQueued'), `${adapter.id} → ${converter.destinationPath.split(/[\\/]/).pop()}`, { kind: 'success' });
    history.record('conversion queued', `${adapter.id}: ${converter.source.name}`, `→ ${converter.destinationPath}`);
    renderConverter();
  } catch (err) {
    toast(copy('utility.err.prefix'), err.message, { kind: 'error' });
  }
}

function findAdapter(id) {
  for (const cat of converter.registry?.categories ?? []) {
    const found = cat.adapters.find((a) => a.id === id);
    if (found) return found;
  }
  return null;
}

// ---- converter rendering ----------------------------------------------------

let converterEls = null;
let converterSearch = null;

function renderConverter() {
  const root = converterEls;
  if (!root) return;
  root.textContent = '';

  // -- source picker ----------------------------------------------------------
  const src = converter.source;
  const dropzone = h('div', {
    class: 'mr-util-dropzone',
    role: 'button',
    tabindex: '0',
    'aria-label': t('utility.src.drop'),
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('mr-util-dropzone--over'); },
    ondragleave: () => e.currentTarget.classList.remove('mr-util-dropzone--over'),
    ondrop: handleDrop,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseSource(); } },
  },
    h('div', { class: 'mr-util-dropzone__label' }, t('utility.src.drop')),
    h('div', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, t('utility.src.dropHint')),
  );

  const det = src?.detection;
  const srcCard = sectionCard(t('utility.src.choose'),
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('button', { class: 'm3-btn m3-btn--filled', onclick: chooseSource }, t('utility.src.choose')),
      src ? h('button', { class: 'm3-btn m3-btn--text', onclick: () => { converter.source = null; renderConverter(); } }, t('utility.src.clear')) : null,
    ),
    dropzone,
    src ? h('div', { class: 'mr-util-detect' },
      h('div', { class: 'mr-row' },
        h('strong', {}, `${t('utility.src.detected')}: ${fmtLabel(det.format)}`),
        h('span', { class: 'mr-util-chip' }, `${t('utility.src.confidence')}: ${det.confidence}`),
        h('span', { class: 'mr-typography-body-small' }, fmtBytes(src.size)),
      ),
      h('div', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
        `${src.name} — ${det.reasons.join('; ')}`),
      det.format === 'pdf' ? renderPdfProbe(src.path) : null,
    ) : null,
  );
  root.append(srcCard);

  // -- merge inputs for multi-source adapters -----------------------------------
  const mergeCard = sectionCard(t('utility.mergeList'),
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: addMergeInput }, t('utility.mergePick')),
      h('span', { class: 'mr-typography-body-small' },
        converter.extraSources.length
          ? converter.extraSources.map((p) => p.split(/[\\/]/).pop()).join(' → ')
          : t('utility.queue.empty')),
    ),
  );
  mergeCard.hidden = true; // shown only when a multi-source adapter is selected

  // -- catalog (always visible: gaps stay visible even with no source yet) -------
  const catalogCard = h('section', { class: 'm3-card mr-util-card' },
    h('h2', { class: 'm3-card__title' }, t('utility.adapter.search')),
  );
  const body = h('div', { class: 'm3-card__body mr-util-cardbody' });
  catalogCard.append(body);

  if (!converterSearch) {
    converterSearch = createSearchBar({
      placeholder: t('utility.adapter.search'),
      label: t('utility.adapter.search'),
      onQuery: () => renderCatalogList(body),
    });
  }
  body.append(converterSearch.el);
  const listWrap = h('div', { class: 'mr-util-catalog' });
  body.append(listWrap);
  root.append(mergeCard, catalogCard);

  function renderCatalogList(container) {
    container.textContent = '';
    const q = converterSearch.get();
    let any = false;
    for (const cat of converter.registry?.categories ?? []) {
      const rows = cat.adapters
        .map((a) => ({ a, match: matchesQuery(q, `${a.id} ${t(`utility.cat.${cat.id}`)} ${cat.id}`) }))
        .filter(({ match }) => match);
      if (!rows.length) continue;
      any = true;
      container.append(h('h3', { class: 'mr-util-cat-title' }, t(`utility.cat.${cat.id}`)));
      for (const { a } of rows) container.append(adapterRow(a));
    }
    if (!any) container.append(h('p', { class: 'mr-palette__empty' }, t('utility.adapter.none')));
  }
  renderCatalogList(listWrap);

  // -- selected adapter: disclosure + args + destination + convert ----------------
  const adapter = findAdapter(converter.adapterId);
  if (!adapter) return;
  mergeCard.hidden = !(adapter.multiSource);

  const detailCard = sectionCard(`${adapter.id} — ${t('utility.adapter.notes')}`);
  detailCard.append(h('p', { class: 'mr-typography-body-medium' }, t(adapter.notesKey ?? 'utility.adapter.notes')));
  for (const reqKey of adapter.requiresKeys ?? []) {
    detailCard.append(h('p', { class: 'mr-util-requirement' }, t(reqKey)));
  }
  const argsWrap = h('div', { class: 'mr-util-args' });
  for (const arg of adapter.args ?? []) argsWrap.append(argControl(arg));
  if (adapter.target?.format === 'select') {
    const fmtSelect = argControl({ id: 'targetFormat', type: 'select', options: adapter.target.options, default: converter.args.targetFormat ?? 'png' });
    argsWrap.append(fmtSelect);
  }
  if (adapter.args?.length || adapter.target?.format === 'select') {
    detailCard.append(h('h3', { class: 'mr-util-subtitle' }, t('utility.adapter.args')), argsWrap);
  }

  const destRow = h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
    h('button', { class: 'm3-btn m3-btn--tonal', onclick: () => pickDestination(adapter) },
      adapter.folderTarget || adapter.id === 'zip-extract' ? t('utility.dest.pickFolder') : t('utility.dest.saveAs')),
    h('span', { class: 'mr-typography-body-small', style: 'word-break:break-all' },
      converter.destinationPath ?? t('utility.dest.none')),
  );
  detailCard.append(h('h3', { class: 'mr-util-subtitle' }, t('utility.disclosure.title')), destRow);
  detailCard.append(h('div', { class: 'mr-row' },
    h('button', { class: 'm3-btn m3-btn--filled', onclick: convertNow }, t('utility.convert')),
  ));
  root.append(detailCard);
}

/** PDF capability probe shown inline after detection (honest limits up front). */
async function renderPdfProbe(p) {
  const holder = h('div', { class: 'mr-util-pdfprobe', 'aria-live': 'polite' }, t('utility.src.detecting'));
  invoke('utility:inspect', { path: p, format: 'pdf' }).then((info) => {
    holder.textContent = '';
    if (info.encrypted) {
      holder.append(h('span', { class: 'mr-util-chip mr-util-chip--err' }, t('utility.req.pdfUnencrypted')));
      return;
    }
    holder.append(h('span', { class: 'mr-util-chip' }, `${info.pages?.length ?? 0} pages`));
    if (info.objectStreams) {
      holder.append(h('span', { class: 'mr-util-chip mr-util-chip--warn' }, t('utility.req.pdfUnencrypted')));
    }
    if (info.metadata?.title) holder.append(h('span', { class: 'mr-typography-body-small' }, info.metadata.title));
  }).catch(() => { holder.textContent = ''; });
  return holder;
}

function renderQueueInto(container) {
  container.textContent = '';
  const q = converter.queue;
  container.append(h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
    h('strong', {}, t('utility.queue.title')),
    q.paused ? h('span', { class: 'mr-util-chip mr-util-chip--warn' }, t('utility.queue.pausedBadge')) : null,
    h('span', { class: 'mr-typography-body-small' }, t('utility.queue.concurrency')),
    h('span', { class: 'mr-grow' }),
    h('button', {
      class: 'm3-btn m3-btn--text m3-btn--sm',
      onclick: () => invoke('utility:set-paused', { paused: !q.paused }),
    }, q.paused ? t('utility.queue.resume') : t('utility.queue.pause')),
    h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => invoke('utility:clear-finished') }, t('utility.queue.clearFinished')),
  ));
  if (!q.jobs.length) {
    container.append(h('p', { class: 'mr-palette__empty' }, t('utility.queue.empty')));
    return;
  }
  for (const job of [...q.jobs].reverse()) {
    const terminal = ['done', 'failed', 'cancelled', 'skipped', 'interrupted'].includes(job.state);
    container.append(h('div', { class: 'mr-util-job' },
      h('div', { class: 'mr-util-job__main' },
        h('div', { class: 'mr-row' },
          h('span', { class: `mr-util-chip ${stateChipClass(job.state)}` }, t(`utility.state.${job.state}`)),
          h('strong', {}, job.sourceName),
          h('span', { class: 'mr-typography-body-small' }, job.adapterId),
        ),
        h('div', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);word-break:break-all' },
          `→ ${job.destinationPath}`),
        job.error ? h('div', { class: 'mr-util-job__error' }, job.error) : null,
        job.skipReason ? h('div', { class: 'mr-util-job__error' }, job.skipReason) : null,
        job.outputBytes ? h('div', { class: 'mr-typography-body-small' }, fmtBytes(job.outputBytes)) : null,
      ),
      h('div', { class: 'mr-util-job__actions' },
        terminal && job.state !== 'done'
          ? h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: () => invoke('utility:retry-job', { id: job.id }) }, t('utility.queue.retry'))
          : null,
        ['pending', 'converting', 'cancelling'].includes(job.state)
          ? h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => invoke('utility:cancel-job', { id: job.id }) }, t('utility.queue.cancel'))
          : null,
        terminal
          ? h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => invoke('utility:remove-job', { id: job.id }).catch((e) => toast(copy('utility.err.prefix'), e.message, { kind: 'error' })) }, t('utility.queue.remove'))
          : null,
      ),
    ));
  }
}

// ===========================================================================
// ollama state + view
// ===========================================================================

const ollama = {
  status: null,
  installed: [],
  runningNames: new Set(),
  installedFilter: { runningOnly: false, sort: 'nameAsc' },
  catalog: { models: [], fetchedAt: null, stale: true },
  cart: [],
  expandedVariants: new Map(), // name -> {loading|error|tags[]}
  sessions: [],
  activeSessionId: null,
  streaming: new Map(), // chatId -> {sessionIdx, msgEl, text}
  selectedModel: null,
  modelCapabilities: new Map(),
  showInfo: new Map(),
};

async function refreshStatus() {
  try {
    ollama.status = await invoke('ollama:status');
  } catch (err) {
    ollama.status = { reachable: false, diagnosis: { state: 'error', reasonKey: 'ollama.state.error', actionKey: 'ollama.action.retry', detail: err.message } };
  }
  renderOllama();
  if (ollama.status.reachable) await refreshInstalled().catch(() => {});
}

async function refreshInstalled() {
  const data = await invoke('ollama:installed');
  ollama.installed = data.models ?? [];
  try {
    const ps = await invoke('ollama:running');
    ollama.runningNames = new Set((ps.models ?? []).map((m) => m.name));
  } catch { ollama.runningNames = new Set(); }
  renderOllama();
}

async function refreshCatalog(silent = false) {
  try {
    await invoke('ollama:catalog-refresh');
    if (!silent) toast(t('ollama.store.title'), t('ollama.store.fresh', { age: t('ollama.store.justNow') }), { kind: 'success' });
  } catch (err) {
    if (!silent) toast(t('ollama.store.title'), err.message, { kind: 'error' });
  }
  ollama.catalog = await invoke('ollama:catalog');
  renderOllama();
}

async function toggleVariants(name, holder) {
  if (ollama.expandedVariants.has(name)) {
    ollama.expandedVariants.delete(name);
    renderOllama();
    return;
  }
  ollama.expandedVariants.set(name, { loading: true });
  renderOllama();
  try {
    const data = await invoke('ollama:variants', { name });
    const resources = await invoke('ollama:host-resources');
    const installedSizes = ollama.installed.filter((m) => m.name.startsWith(`${name}:`)).map((m) => m.size ?? 0);
    for (const tag of data.tags ?? []) {
      tag.verdict = await invoke('ollama:fit-verdict', { sizeBytes: tag.fullSize });
      void resources;
    }
    ollama.expandedVariants.set(name, { tags: data.tags ?? [], fetchedAt: data.fetchedAt });
  } catch (err) {
    ollama.expandedVariants.set(name, { error: err.message });
    renderOllama();
    return;
  }
  renderOllama();
}

async function addToCart(tag, modelName, fullSize, verdict) {
  try {
    ollama.cart = await invoke('ollama:cart-add', { items: [{ tag, modelName, fullSize, verdict }] });
    renderOllama();
  } catch (err) {
    toast(t('ollama.cart.title'), err.message, { kind: 'error' });
  }
}

async function removeFromCart(tag) {
  ollama.cart = await invoke('ollama:cart-remove', { tag });
  renderOllama();
}

async function startDownloads() {
  const total = ollama.cart.filter((c) => ['queued', 'failed', 'cancelled'].includes(c.state));
  if (!total.length) return;
  const sizeSum = total.reduce((a, c) => a + (c.fullSize ?? 0), 0);
  const ok = await destructiveConfirm({
    title: t('ollama.cart.start'),
    body: t('ollama.cart.summary', {
      count: String(total.length),
      size: fmtBytes(sizeSum),
      need: fmtBytes(Math.round(sizeSum * 1.2)),
    }),
  });
  if (!ok) return;
  ollama.cart = await invoke('ollama:pull-start');
  renderOllama();
}

async function cancelCart(tag) {
  ollama.cart = await invoke('ollama:pull-cancel', { tag });
  renderOllama();
}

async function retryCart(tag) {
  await invoke('ollama:cart-remove', { tag });
  const item = ollama.cart.find((c) => c.tag === tag);
  ollama.cart = await invoke('ollama:cart-add', {
    items: [{ tag, modelName: item?.modelName ?? tag.split(':')[0], fullSize: item?.fullSize ?? null, verdict: item?.verdict ?? 'Unknown' }],
  });
  ollama.cart = await invoke('ollama:pull-start');
  renderOllama();
}

async function deleteModel(model) {
  const known = ollama.installed.find((m) => m.name === model);
  const ok = await destructiveConfirm({
    title: t('ollama.model.deleteTitle'),
    body: t('ollama.model.deleteBody', { name: model, size: fmtBytes(known?.size ?? 0) }),
    confirmLabel: t('ollama.model.delete'),
  });
  if (!ok) return;
  try {
    await invoke('ollama:delete-model', { model });
    history.record('model deleted', model);
    await refreshInstalled();
  } catch (err) {
    toast(t('ollama.model.delete'), err.message, { kind: 'error' });
  }
}

async function showModelInfo(model, holder) {
  if (ollama.showInfo.has(model)) {
    ollama.showInfo.delete(model);
    renderOllama();
    return;
  }
  try {
    const info = await invoke('ollama:show', { model });
    ollama.showInfo.set(model, info);
    ollama.modelCapabilities.set(model, info.capabilities ?? []);
  } catch (err) {
    toast(t('ollama.model.showInfo'), err.message, { kind: 'error' });
    return;
  }
  renderOllama();
}

// ---- chat ---------------------------------------------------------------------

function activeSession() {
  return ollama.sessions.find((s) => s.id === ollama.activeSessionId) ?? null;
}

function newSession(model = null) {
  const session = {
    id: `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: t('ollama.chat.title'),
    model: model ?? ollama.selectedModel ?? ollama.installed[0]?.name ?? '',
    system: '',
    messages: [],
    options: { num_predict: 2048 },
  };
  ollama.sessions.push(session);
  ollama.activeSessionId = session.id;
  persistSessions();
  renderOllama();
}

async function persistSessions() {
  try {
    await invoke('ollama:sessions-save', { sessions: ollama.sessions.slice(-500) });
  } catch { /* persistence is best-effort; the UI keeps its copy */ }
}

async function loadSessions() {
  try {
    ollama.sessions = (await invoke('ollama:sessions-load')) ?? [];
    ollama.activeSessionId = ollama.sessions.at(-1)?.id ?? null;
  } catch { ollama.sessions = []; }
}

async function deleteSession(session) {
  const ok = await destructiveConfirm({
    title: t('ollama.chat.deleteTitle'),
    body: t('ollama.chat.deleteBody', { name: session.name, messages: String(session.messages.length) }),
    confirmLabel: t('common.delete'),
  });
  if (!ok) return;
  ollama.sessions = ollama.sessions.filter((s) => s.id !== session.id);
  if (ollama.activeSessionId === session.id) ollama.activeSessionId = ollama.sessions.at(-1)?.id ?? null;
  history.record('chat deleted', session.name);
  persistSessions();
  renderOllama();
}

async function renameSession(session) {
  const name = await promptText({ title: t('ollama.chat.rename'), label: t('ollama.chat.sessions'), value: session.name });
  if (name === null || !name.trim()) return;
  session.name = name.trim();
  persistSessions();
  renderOllama();
}

function exportSessions() {
  const note = t('ollama.chat.exportNote');
  saveText(
    `ollama-chats-${Date.now()}.json`,
    JSON.stringify({ exportedAt: new Date().toISOString(), note, sessions: ollama.sessions }, null, 2),
    'application/json',
  );
}

async function sendChat(text, attachments = []) {
  const session = activeSession();
  if (!session || !session.model) {
    toast(t('ollama.chat.title'), t('ollama.installed.empty'), { kind: 'error' });
    return;
  }
  const content = text.trim();
  if (!content && !attachments.length) return;
  const message = { role: 'user', content };
  if (attachments.length) message.images = attachments.map((b) => b);
  session.messages.push(message);
  const assistantMsg = { role: 'assistant', content: '' };
  session.messages.push(assistantMsg);
  renderOllama();

  const payloadMessages = [];
  if (session.system?.trim()) payloadMessages.push({ role: 'system', content: session.system });
  payloadMessages.push(...session.messages.slice(0, -1));

  try {
    const { chatId } = await invoke('ollama:chat-start', {
      session: {
        chatId: session.id,
        model: session.model,
        messages: payloadMessages,
        options: session.options,
      },
    });
    ollama.streaming.set(session.id, { chatId, assistantMsg });
  } catch (err) {
    assistantMsg.content = `${t('ollama.chat.errorPrefix')}: ${err.message}`;
    ollama.streaming.delete(session.id);
    renderOllama();
  }
}

function stopChat() {
  const session = activeSession();
  if (!session) return;
  const stream = ollama.streaming.get(session.id);
  if (stream) invoke('ollama:chat-stop', { chatId: stream.chatId }).catch(() => {});
}

function regenerateChat() {
  const session = activeSession();
  if (!session || ollama.streaming.has(session.id)) return;
  // Drop back to the last user turn and resend it.
  while (session.messages.length && session.messages.at(-1).role !== 'user') session.messages.pop();
  const last = session.messages.pop();
  if (last) sendChat(last.content, last.images ?? []);
}

on('ollama-chat', (evt) => {
  if (!evt) return;
  const entry = [...ollama.streaming.entries()].find(([, v]) => v.chatId === evt.chatId);
  if (!entry) return;
  const [sessionId, stream] = entry;
  const session = ollama.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  if (evt.delta) {
    stream.assistantMsg.content += evt.delta;
    if (stream.msgEl?.isConnected) {
      stream.msgEl.textContent = stream.assistantMsg.content;
      stream.msgEl.scrollIntoView({ block: 'nearest' });
    }
  }
  if (evt.error) stream.assistantMsg.content += `\n${t('ollama.chat.errorPrefix')}: ${evt.error}`;
  if (evt.done || evt.error || evt.stopped) {
    ollama.streaming.delete(sessionId);
    persistSessions();
    renderOllama();
  }
});

// ---- harness ---------------------------------------------------------------------

async function launchProfileFlow(profile) {
  const model = ollama.selectedModel ?? ollama.installed[0]?.name ?? '';
  // Preflight preview comes from the bridge (same code the launch uses).
  let preview;
  try {
    preview = await invoke('ollama:profile-preflight', { id: profile.id, model });
  } catch (err) {
    toast(t('ollama.harness.launch'), err.message, { kind: 'error' });
    return;
  }
  const detail = h('div', { class: 'mr-util-preflight' },
    h('p', {}, t('ollama.harness.preflightIntro')),
    h('pre', {}, `${preview.executable} ${preview.args.join(' ')}`),
    h('p', { class: 'mr-typography-body-small' }, `${t('ollama.harness.cwd')}: ${preview.cwd}`),
    preview.envKeysRedacted?.length
      ? h('p', { class: 'mr-typography-body-small' }, preview.envKeysRedacted.join(', '))
      : null,
    preview.blockers?.length
      ? h('div', { class: 'mr-util-job__error' }, `${t('ollama.harness.blockers')}: ${preview.blockers.join('; ')}`)
      : null,
  );
  const dlg = openModal({
    title: t('ollama.harness.preflightTitle'),
    body: detail,
    actions: preview.blockers?.length ? [
      { label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} },
    ] : [
      { label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} },
      {
        label: t('ollama.harness.launchBtn'),
        kind: 'm3-btn--filled',
        run: () => {
          invoke('ollama:profile-launch', { id: profile.id, model }).then((result) => {
            if (result.launched) {
              toast(t('ollama.harness.title'), t('ollama.harness.launched', { pid: String(result.pid ?? '?'), health: result.healthCheck }), { kind: 'success' });
              history.record('harness launched', profile.name, `pid ${result.pid}`);
            } else {
              toast(t('ollama.harness.launchBlocked'), `${result.error ?? ''}${result.snapshotId ? ` ${t('ollama.harness.rolledBack', { id: result.snapshotId })}` : ''}`, { kind: 'error' });
            }
          }).catch((err) => toast(t('ollama.harness.title'), err.message, { kind: 'error' }));
        },
      },
    ],
  });
  void dlg;
}

let profileDraft = { name: '', executable: '', args: '', cwd: '', envKeys: '' };

async function pickExecutableForDraft() {
  const exe = await invoke('ollama:profile-pick-executable', { title: t('ollama.harness.pickExe') });
  if (exe) {
    profileDraft.executable = exe;
    renderOllama();
  }
}

async function browseCwdForDraft() {
  const dir = await invoke('utility:pick-folder', { title: t('ollama.harness.cwd') });
  if (dir) {
    profileDraft.cwd = dir;
    renderOllama();
  }
}

async function saveProfileDraft() {
  const profile = {
    name: profileDraft.name,
    executable: profileDraft.executable,
    args: profileDraft.args.split(/\s+/).map((s) => s.trim()).filter(Boolean),
    cwd: profileDraft.cwd,
    envKeys: profileDraft.envKeys.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
  };
  try {
    await invoke('ollama:profile-register', { profile });
    history.record('profile registered', profile.name);
    profileDraft = { name: '', executable: '', args: '', cwd: '', envKeys: '' };
    renderOllama();
  } catch (err) {
    toast(t('ollama.harness.register'), err.message, { kind: 'error' });
  }
}

async function restoreSnapshotFlow() {
  const { snapshots } = await invoke('ollama:profiles-list');
  if (!snapshots.length) return;
  const dlg = openModal({
    title: t('ollama.harness.restoreTitle'),
    body: (container) => {
      for (const snap of snapshots.slice().reverse()) {
        container.append(h('button', {
          class: 'm3-btn m3-btn--text',
          style: 'width:100%;justify-content:flex-start',
          onclick: async () => {
            await invoke('ollama:profile-snapshot-restore', { snapshotId: snap.id });
            toast(t('ollama.harness.restoreSnapshot'), t('ollama.harness.restored', { id: snap.id }), { kind: 'success' });
            dlg.close();
            renderOllama();
          },
        }, `${snap.id} — ${snap.createdAt} — ${snap.reason ?? ''}`));
      }
    },
  });
}

// ---- ollama rendering -------------------------------------------------------------

let ollamaEls = null;
let ollamaMounted = false;

function renderOllama() {
  const root = ollamaEls;
  if (!root) return;
  root.textContent = '';

  // -- status -------------------------------------------------------------------
  const st = ollama.status;
  const diag = st?.diagnosis ?? { state: 'error', reasonKey: 'ollama.state.error', actionKey: 'ollama.action.retry', detail: '' };
  const statusCard = sectionCard(t('ollama.status.title'),
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('span', { class: `mr-util-chip ${st?.reachable ? 'mr-util-chip--ok' : 'mr-util-chip--err'}` },
        t(st?.reachable ? 'ollama.state.ok' : diag.reasonKey)),
      st?.reachable ? h('span', { class: 'mr-typography-body-small' }, `${t('ollama.status.version')}: ${st.version ?? '?'}`) : null,
      !st?.reachable && diag.actionKey ? h('span', { class: 'mr-typography-body-small' }, t(diag.actionKey)) : null,
      st && st.diskOk === false ? h('span', { class: 'mr-util-chip mr-util-chip--warn' }, t('ollama.status.diskLow')) : null,
      h('span', { class: 'mr-grow' }),
      h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: refreshStatus }, t('ollama.status.refresh')),
    ),
  );
  root.append(statusCard);

  // -- installed models -----------------------------------------------------------
  const installedCard = h('section', { class: 'm3-card mr-util-card' },
    h('h2', { class: 'm3-card__title' }, t('ollama.installed.title')));
  const ibody = h('div', { class: 'm3-card__body mr-util-cardbody' });
  installedCard.append(ibody);

  let installedSearch = null;
  const installedList = h('div', { class: 'mr-util-modellist' });
  const filterRow = h('div', { class: 'mr-row', style: 'flex-wrap:wrap' });
  ibody.append(filterRow, installedList);

  const runningToggle = h('button', {
    class: `m3-chip${ollama.installedFilter.runningOnly ? ' m3-chip--selected' : ''}`,
    'aria-pressed': String(ollama.installedFilter.runningOnly),
    onclick: () => { ollama.installedFilter.runningOnly = !ollama.installedFilter.runningOnly; renderOllama(); },
  }, t('ollama.filter.runningOnly'));
  const sortSel = h('select', { class: 'm3-select', 'aria-label': t('ollama.sort.nameAsc'), onchange: (e) => { ollama.installedFilter.sort = e.target.value; renderOllama(); } },
    h('option', { value: 'nameAsc' }, t('ollama.sort.nameAsc')),
    h('option', { value: 'sizeDesc' }, t('ollama.sort.sizeDesc')),
  );
  sortSel.value = ollama.installedFilter.sort;
  const refreshBtn = h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => refreshInstalled().catch((e) => toast(t('ollama.installed.title'), e.message, { kind: 'error' })) }, t('ollama.installed.refresh'));
  filterRow.append(runningToggle, sortSel, refreshBtn);

  installedSearch = createSearchBar({
    placeholder: t('ollama.installed.search'),
    label: t('ollama.installed.search'),
    onQuery: () => renderInstalledList(installedList, installedSearch),
  });
  filterRow.append(installedSearch.el);
  renderInstalledList(installedList, installedSearch);
  root.append(installedCard);

  // -- Model Store ------------------------------------------------------------------
  const storeCard = h('section', { class: 'm3-card mr-util-card' },
    h('h2', { class: 'm3-card__title' }, t('ollama.store.title')));
  const sbody = h('div', { class: 'm3-card__body mr-util-cardbody' });
  storeCard.append(sbody);

  const age = ollama.catalog.ageHours;
  const ageLabel = age === null || age === undefined
    ? t('ollama.store.never')
    : age < 1 ? t('ollama.store.justNow') : t('ollama.store.ageHours', { n: String(Math.round(age)) });
  sbody.append(h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
    h('span', { class: `mr-util-chip${ollama.catalog.stale ? ' mr-util-chip--warn' : 'mr-util-chip--ok'}` },
      ollama.catalog.fetchedAt
        ? t(ollama.catalog.stale ? 'ollama.store.stale' : 'ollama.store.fresh', { age: ageLabel })
        : t('ollama.store.never')),
    h('span', { class: 'mr-grow' }),
    h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: () => refreshCatalog() }, t('ollama.store.refresh')),
  ));

  let storeSearch = null;
  const storeList = h('div', { class: 'mr-util-modellist' });
  sbody.append(storeList);
  storeSearch = createSearchBar({
    placeholder: t('ollama.store.search'),
    label: t('ollama.store.search'),
    onQuery: () => renderStoreList(storeList, storeSearch),
  });
  sbody.append(storeSearch.el);
  renderStoreList(storeList, storeSearch);
  root.append(storeCard);

  // -- cart ---------------------------------------------------------------------------
  const cartCard = sectionCard(t('ollama.cart.title'));
  const activeItems = ollama.cart.filter((c) => ['queued', 'pulling'].includes(c.state));
  const sizeSum = activeItems.reduce((a, c) => a + (c.fullSize ?? 0), 0);
  cartCard.append(h('p', { class: 'mr-typography-body-small' },
    ollama.cart.length
      ? t('ollama.cart.summary', { count: String(activeItems.length), size: fmtBytes(sizeSum), need: fmtBytes(Math.round(sizeSum * 1.2)) })
      : t('ollama.cart.empty')));
  cartCard.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, t('ollama.cart.parallel')));
  for (const item of ollama.cart) {
    const pct = item.progress?.percent;
    cartCard.append(h('div', { class: 'mr-util-job' },
      h('div', { class: 'mr-util-job__main' },
        h('div', { class: 'mr-row' },
          h('span', { class: `mr-util-chip ${stateChipClass(item.state === 'pulling' ? 'converting' : item.state === 'done' ? 'done' : item.state === 'failed' ? 'failed' : '')}` },
            t(`ollama.cart.state.${item.state}`)),
          h('strong', {}, item.tag),
          item.fullSize ? h('span', { class: 'mr-typography-body-small' }, fmtBytes(item.fullSize)) : null,
        ),
        item.state === 'pulling' && pct !== null && pct !== undefined
          ? h('progress', { class: 'mr-util-progress', max: '100', value: String(pct), 'aria-label': `${item.tag} ${pct}%` })
          : null,
        item.error ? h('div', { class: 'mr-util-job__error' }, item.error) : null,
      ),
      h('div', { class: 'mr-util-job__actions' },
        ['queued', 'pulling'].includes(item.state)
          ? h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => cancelCart(item.tag) }, t('ollama.cart.cancel'))
          : null,
        ['failed', 'cancelled'].includes(item.state)
          ? h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: () => retryCart(item.tag) }, t('ollama.cart.retry'))
          : null,
        ['queued', 'failed', 'cancelled', 'done'].includes(item.state)
          ? h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => removeFromCart(item.tag) }, t('ollama.cart.remove'))
          : null,
      ),
    ));
  }
  cartCard.append(h('div', { class: 'mr-row' },
    h('button', { class: 'm3-btn m3-btn--filled', onclick: startDownloads, disabled: activeItems.length ? null : true }, t('ollama.cart.start')),
  ));
  root.append(cartCard);

  // -- chat -----------------------------------------------------------------------------
  root.append(buildChatCard());

  // -- harness ----------------------------------------------------------------------------
  root.append(buildHarnessCard());
}

function renderInstalledList(container, search) {
  container.textContent = '';
  if (!ollama.installed.length) {
    container.append(h('p', { class: 'mr-palette__empty' }, t('ollama.installed.empty')));
    return;
  }
  const q = search?.get();
  let models = ollama.installed.filter((m) => matchesQuery(q, `${m.name} ${m.family ?? ''} ${(m.families ?? []).join(' ')}`));
  if (ollama.installedFilter.runningOnly) models = models.filter((m) => ollama.runningNames.has(m.name));
  models = [...models].sort((a, b) => ollama.installedFilter.sort === 'sizeDesc'
    ? (b.size ?? 0) - (a.size ?? 0)
    : a.name.localeCompare(b.name));
  if (!models.length) {
    container.append(h('p', { class: 'mr-palette__empty' }, t('utility.adapter.none')));
    return;
  }
  for (const m of models) {
    const row = h('div', { class: 'mr-util-job' },
      h('div', { class: 'mr-util-job__main' },
        h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
          h('strong', {}, m.name),
          ollama.runningNames.has(m.name) ? h('span', { class: 'mr-util-chip mr-util-chip--ok' }, t('ollama.filter.runningOnly')) : null,
          m.size ? h('span', { class: 'mr-typography-body-small' }, fmtBytes(m.size)) : null,
          m.parameterSize ? h('span', { class: 'mr-util-chip' }, m.parameterSize) : null,
          m.quantization ? h('span', { class: 'mr-util-chip' }, m.quantization) : null,
          m.family ? h('span', { class: 'mr-typography-body-small' }, m.family) : null,
        ),
      ),
      h('div', { class: 'mr-util-job__actions' },
        h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: (e) => showModelInfo(m.name, e.currentTarget) }, t('ollama.model.showInfo')),
        h('button', {
          class: 'm3-btn m3-btn--tonal m3-btn--sm',
          onclick: () => {
            ollama.selectedModel = m.name;
            if (!activeSession()) newSession(m.name);
            else { activeSession().model = m.name; persistSessions(); }
            switchSubTab('ollama');
            renderOllama();
          },
        }, t('ollama.model.chat')),
        h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', style: 'color:var(--md-sys-color-error)', onclick: () => deleteModel(m.name) }, t('ollama.model.delete')),
      ),
    );
    container.append(row);
    if (ollama.showInfo.has(m.name)) container.append(buildModelInfo(m.name));
  }
}

function buildModelInfo(model) {
  const info = ollama.showInfo.get(model);
  return h('div', { class: 'mr-util-modelinfo' },
    h('div', {}, h('strong', {}, t('ollama.model.capabilities')), ' ',
      info.capabilities?.length ? info.capabilities.join(', ') : t('ollama.model.noCapabilities')),
    info.parameterSize ? h('div', {}, `${t('ollama.model.parameters')}: ${info.parameterSize} · ${info.quantization ?? ''}`) : null,
    info.modelfile ? h('details', {},
      h('summary', {}, t('ollama.model.modelfile')),
      h('pre', { class: 'mr-util-pre' }, info.modelfile)) : null,
  );
}

function renderStoreList(container, search) {
  container.textContent = '';
  if (!ollama.catalog.models.length) {
    container.append(h('p', { class: 'mr-palette__empty' }, t('ollama.store.empty')));
    if (ollama.catalog.fetchedAt == null) {
      container.append(h('p', { class: 'mr-typography-body-small' }, t('ollama.store.offline')));
    }
    return;
  }
  const q = search?.get();
  const models = ollama.catalog.models.filter((m) => matchesQuery(q, `${m.name} ${m.description ?? ''}`));
  if (!models.length) {
    container.append(h('p', { class: 'mr-palette__empty' }, t('utility.adapter.none')));
    return;
  }
  for (const m of models) {
    const inCart = ollama.cart.some((c) => c.tag.startsWith(`${m.name}:`) || c.modelName === m.name);
    const row = h('div', { class: 'mr-util-job' },
      h('div', { class: 'mr-util-job__main' },
        h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
          h('strong', {}, m.name),
          m.pulls != null ? h('span', { class: 'mr-typography-body-small' }, `↓ ${m.pulls}`) : null,
        ),
        m.description ? h('div', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, m.description.slice(0, 200)) : null,
      ),
      h('div', { class: 'mr-util-job__actions' },
        h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: () => toggleVariants(m.name) }, t('ollama.store.variants')),
      ),
    );
    container.append(row);
    const expanded = ollama.expandedVariants.get(m.name);
    if (expanded) container.append(buildVariants(m, expanded));
    void inCart;
  }
}

function buildVariants(model, expanded) {
  const wrap = h('div', { class: 'mr-util-variants' });
  if (expanded.loading) {
    wrap.append(h('p', { class: 'mr-typography-body-small' }, t('ollama.store.variantsLoading')));
    return wrap;
  }
  if (expanded.error) {
    wrap.append(h('p', { class: 'mr-util-job__error' }, t('ollama.store.variantsError', { error: expanded.error })));
    return wrap;
  }
  for (const tag of expanded.tags ?? []) {
    const inCart = ollama.cart.some((c) => c.tag === tag.tag);
    wrap.append(h('div', { class: 'mr-util-variant' },
      h('div', { class: 'mr-util-variant__main' },
        h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
          h('code', {}, tag.tag),
          tag.fullSize != null ? h('span', { class: 'mr-typography-body-small' }, fmtBytes(tag.fullSize)) : null,
          tag.verdict ? h('span', { class: `mr-util-chip ${verdictChipClass(tag.verdict.verdict)}` }, verdictLabel(tag.verdict.verdict)) : null,
        ),
        tag.verdict?.evidence?.length
          ? h('details', { class: 'mr-util-evidence' },
            h('summary', {}, t('ollama.evidence.title')),
            h('ul', {}, tag.verdict.evidence.map((line) => h('li', {}, line))))
          : null,
      ),
      h('div', { class: 'mr-util-variant__actions' },
        h('button', {
          class: 'm3-btn m3-btn--tonal m3-btn--sm',
          disabled: inCart ? true : null,
          onclick: () => addToCart(tag.tag, model.name, tag.fullSize, tag.verdict?.verdict ?? 'Unknown'),
        }, inCart ? t('ollama.store.inCart') : t('ollama.store.addToCart')),
      ),
    ));
  }
  return wrap;
}

function buildChatCard() {
  const card = sectionCard(t('ollama.chat.title'));
  const session = activeSession();

  // sessions sidebar
  const sessionsCol = h('div', { class: 'mr-util-sessions' },
    h('button', {
      class: 'm3-btn m3-btn--tonal m3-btn--sm',
      disabled: ollama.installed.length ? null : true,
      onclick: () => newSession(),
    }, t('ollama.chat.new')),
  );
  for (const s of ollama.sessions) {
    sessionsCol.append(h('div', { class: `mr-util-session${s.id === ollama.activeSessionId ? ' mr-util-session--active' : ''}` },
      h('button', {
        class: 'mr-util-session__name',
        onclick: () => { ollama.activeSessionId = s.id; renderOllama(); },
        'aria-current': s.id === ollama.activeSessionId ? 'true' : null,
      }, s.name),
      h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', 'aria-label': t('ollama.chat.rename'), onclick: () => renameSession(s) }, '✎'),
      h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', style: 'color:var(--md-sys-color-error)', 'aria-label': t('ollama.chat.delete'), onclick: () => deleteSession(s) }, '✕'),
    ));
  }
  if (!ollama.sessions.length) sessionsCol.append(h('p', { class: 'mr-typography-body-small' }, t('ollama.chat.noSessions')));
  sessionsCol.append(h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: exportSessions }, t('ollama.chat.export')));
  card.append(h('div', { class: 'mr-row', style: 'align-items:flex-start' },
    h('div', {}, h('h3', { class: 'mr-util-subtitle' }, t('ollama.chat.sessions')), sessionsCol),
  ));

  if (!session) return card;

  const capabilities = ollama.modelCapabilities.get(session.model) ?? null;
  const visionSupported = capabilities?.includes('vision');

  // model + system prompt + params
  const modelSel = h('select', { 'aria-label': t('ollama.chat.model'), onchange: (e) => { session.model = e.target.value; persistSessions(); renderOllama(); } });
  for (const m of ollama.installed) modelSel.append(h('option', { value: m.name }, m.name));
  modelSel.value = session.model;
  if (!modelSel.value && ollama.installed[0]) { session.model = ollama.installed[0].name; modelSel.value = session.model; }

  const systemInput = h('textarea', {
    class: 'mr-util-system', rows: 2, 'aria-label': t('ollama.chat.systemPrompt'),
    placeholder: t('ollama.chat.systemPlaceholder'),
    onchange: (e) => { session.system = e.target.value; persistSessions(); },
  });
  systemInput.value = session.system ?? '';

  const paramsRow = h('div', { class: 'mr-util-params' });
  const paramDefs = [
    ['num_predict', t('ollama.param.numPredict'), 128, 32768, 1],
    ['temperature', t('ollama.param.temperature'), 0, 2, 0.05],
    ['top_p', t('ollama.param.topP'), 0, 1, 0.05],
    ['top_k', t('ollama.param.topK'), 1, 100, 1],
    ['repeat_penalty', t('ollama.param.repeatPenalty'), 0.5, 2, 0.05],
    ['num_ctx', t('ollama.param.numCtx'), 512, 131072, 512],
  ];
  for (const [key, label, min, max, step] of paramDefs) {
    const input = h('input', {
      type: 'number', min: String(min), max: String(max), step: String(step),
      value: session.options?.[key] ?? '', 'aria-label': label,
      onchange: (e) => {
        const v = e.target.value === '' ? null : Number(e.target.value);
        if (v !== null && (Number.isNaN(v) || v < min || v > max)) {
          e.target.setCustomValidity(`${label}: ${min}–${max}`);
          e.target.reportValidity();
          return;
        }
        e.target.setCustomValidity('');
        session.options ??= {};
        if (v === null) delete session.options[key];
        else session.options[key] = v;
        persistSessions();
      },
    });
    paramsRow.append(h('label', { class: 'mr-util-param' }, h('span', { class: 'mr-typography-label-medium' }, label), input));
  }

  card.append(
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
      h('div', { class: 'm3-select' }, h('label', {}, t('ollama.chat.model')), modelSel),
      visionSupported === false ? h('span', { class: 'mr-util-chip mr-util-chip--warn', title: t('ollama.chat.attachDisabled') }, t('ollama.chat.attachDisabled')) : null,
    ),
    h('div', { class: 'm3-textfield mr-util-systemwrap' }, systemInput, h('label', {}, t('ollama.chat.systemPrompt'))),
    h('details', { class: 'mr-util-paramdetails' }, h('summary', {}, t('ollama.chat.params')), paramsRow),
  );

  // message thread
  const thread = h('div', { class: 'mr-util-thread', 'aria-live': 'polite' });
  for (const msg of session.messages) {
    if (msg.role === 'system') continue;
    thread.append(h('div', { class: `mr-util-msg mr-util-msg--${msg.role}` },
      h('div', { class: 'mr-util-msg__who' }, msg.role === 'user' ? t('ollama.chat.you') : t('ollama.chat.assistant')),
      h('div', { class: 'mr-util-msg__text' }, msg.content || '…'),
    ));
  }
  const stream = ollama.streaming.get(session.id);
  if (stream) {
    const liveEl = h('div', { class: 'mr-util-msg__text mr-util-msg--live' }, stream.assistantMsg.content || '…');
    stream.msgEl = liveEl;
    thread.append(h('div', { class: 'mr-util-msg mr-util-msg--assistant' },
      h('div', { class: 'mr-util-msg__who' }, `${t('ollama.chat.assistant')} · ${t('ollama.chat.generating')}`),
      liveEl,
    ));
  }
  if (!session.messages.length) thread.append(h('p', { class: 'mr-palette__empty' }, t('ollama.chat.placeholder')));
  card.append(thread);

  // composer
  const input = h('textarea', {
    class: 'mr-util-composer', rows: 2, 'aria-label': t('ollama.chat.message'),
    placeholder: t('ollama.chat.placeholder'),
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = e.target.value;
        e.target.value = '';
        sendChat(text);
      }
      e.stopPropagation();
    },
  });
  const attachments = [];
  const attachBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    disabled: visionSupported ? null : true,
    'aria-label': visionSupported ? t('ollama.chat.attach') : t('ollama.chat.attachDisabled'),
    title: visionSupported ? t('ollama.chat.attach') : t('ollama.chat.attachDisabled'),
    onclick: async () => {
      const paths = await invoke('dialog:file-open', { title: t('ollama.chat.attach') });
      if (!paths?.length) return;
      for (const p of paths) {
        try {
          const buf = await invoke('utility:read-bytes', { path: p, maxBytes: 10 * 1024 * 1024 });
          attachments.push(arrayBufferToBase64(buf));
        } catch (err) {
          toast(t('ollama.chat.attach'), err.message, { kind: 'error' });
        }
      }
    },
  }, t('ollama.chat.attach'));
  card.append(h('div', { class: 'mr-util-composerrow' },
    attachBtn,
    input,
    ollama.streaming.has(session.id)
      ? h('button', { class: 'm3-btn m3-btn--danger', onclick: stopChat }, t('ollama.chat.stop'))
      : h('button', { class: 'm3-btn m3-btn--filled', onclick: () => { const text = input.value; input.value = ''; sendChat(text, attachments.splice(0)); } }, t('ollama.chat.send')),
    h('button', { class: 'm3-btn m3-btn--text', onclick: regenerateChat, disabled: ollama.streaming.has(session.id) ? true : null }, t('ollama.chat.regenerate')),
  ));
  return card;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function buildHarnessCard() {
  const card = sectionCard(t('ollama.harness.title'));
  card.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, t('ollama.harness.intro')));

  invoke('ollama:profiles-list').then(({ profiles, snapshots }) => {
    if (!card.isConnected) return;
    const list = card.querySelector('.mr-util-profilelist');
    if (!list) return;
    list.textContent = '';
    for (const p of profiles) {
      list.append(h('div', { class: 'mr-util-job' },
        h('div', { class: 'mr-util-job__main' },
          h('div', { class: 'mr-row', style: 'flex-wrap:wrap' },
            h('strong', {}, p.name),
            p.prebuilt ? h('span', { class: 'mr-util-chip' }, t('ollama.harness.prebuiltTag')) : null,
            h('code', { class: 'mr-typography-body-small' }, `${p.executable} ${p.args.join(' ')}`),
          ),
        ),
        h('div', { class: 'mr-util-job__actions' },
          h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: () => launchProfileFlow(p) }, t('ollama.harness.launch')),
          !p.prebuilt ? h('button', {
            class: 'm3-btn m3-btn--text m3-btn--sm',
            style: 'color:var(--md-sys-color-error)',
            onclick: async () => {
              const ok = await destructiveConfirm({ title: t('ollama.harness.delete'), body: p.name });
              if (!ok) return;
              await invoke('ollama:profile-delete', { id: p.id });
              renderOllama();
            },
          }, t('ollama.harness.delete')) : null,
        ),
      ));
    }
    if (!profiles.length) list.append(h('p', { class: 'mr-palette__empty' }, t('utility.adapter.none')));
    const restoreBtn = card.querySelector('.mr-util-snapbtn');
    if (restoreBtn) restoreBtn.hidden = !(snapshots.length > 0);
  }).catch(() => { /* profile list stays empty on IPC failure; status card shows the error */ });

  const list = h('div', { class: 'mr-util-profilelist' });

  // registration form (draft state survives re-renders)
  const draft = profileDraft;
  const exeLabel = h('span', { class: 'mr-typography-body-small', style: 'word-break:break-all' },
    draft.executable ? t('ollama.harness.exeChosen', { exe: draft.executable }) : '');
  const form = h('details', { class: 'mr-util-paramdetails' },
    h('summary', {}, t('ollama.harness.register')),
    h('div', { class: 'mr-util-args' },
      textField(t('ollama.harness.profileName'), 'name', draft),
      h('div', { class: 'mr-row' },
        h('button', { class: 'm3-btn m3-btn--tonal m3-btn--sm', onclick: pickExecutableForDraft }, t('ollama.harness.pickExe')),
        exeLabel,
      ),
      textField(t('ollama.harness.args'), 'args', draft, t('ollama.harness.argsHint')),
      h('div', { class: 'mr-row' },
        textField(t('ollama.harness.cwd'), 'cwd', draft),
        h('button', { class: 'm3-btn m3-btn--text m3-btn--sm', onclick: browseCwdForDraft }, t('ollama.harness.cwdBrowse')),
      ),
      textField(t('ollama.harness.envKeys'), 'envKeys', draft),
      h('button', { class: 'm3-btn m3-btn--filled', onclick: saveProfileDraft }, t('ollama.harness.save')),
    ),
  );

  card.append(
    h('div', { class: 'mr-row' },
      h('button', {
        class: 'm3-btn m3-btn--text m3-btn--sm mr-util-snapbtn',
        hidden: true,
        onclick: restoreSnapshotFlow,
      }, t('ollama.harness.restoreSnapshot')),
    ),
    list,
    form,
  );
  return card;
}

function textField(label, key, draft, hint = '') {
  const input = h('input', {
    type: 'text', class: 'm3-textfield', value: draft[key] ?? '', 'aria-label': label,
    oninput: (e) => { draft[key] = e.target.value; },
  });
  return h('div', { class: 'm3-textfield mr-util-textfield-wide' },
    input,
    h('label', {}, label),
    hint ? h('div', { class: 'm3-textfield__helper' }, hint) : null,
  );
}

// ===========================================================================
// guide
// ===========================================================================

async function renderGuide(root) {
  root.textContent = '';
  root.append(h('h1', { class: 'mr-typography-headline-small' }, t('ollama.trouble.title')));
  const mdHolder = h('div', {});
  root.append(mdHolder);
  try {
    const { doc } = await invoke('ollama:troubleshooting');
    renderInto(mdHolder, doc);
  } catch (err) {
    mdHolder.textContent = err.message;
  }
  root.append(sectionCard(t('utility.queue.title'),
    h('p', { class: 'mr-typography-body-medium' }, t('utility.queue.concurrency')),
    h('p', { class: 'mr-typography-body-medium' }, t('utility.req.pdfUnencrypted')),
  ));
}

// ===========================================================================
// tab wiring
// ===========================================================================

let subTabEls = null;

function switchSubTab(which) {
  if (!subTabEls || !subTabEls.__defs) return;
  for (const [name] of subTabEls.__defs) {
    const el = subTabEls[name];
    el.hidden = name !== which;
    el.classList.toggle('mr-active', name === which);
  }
  for (const btn of subTabEls.__buttons ?? []) {
    btn.setAttribute('aria-selected', String(btn.dataset.sub === which));
    btn.tabIndex = btn.dataset.sub === which ? 0 : -1;
  }
}

function init(panel) {
  const head = h('div', { class: 'mr-util-head' },
    h('h1', { class: 'mr-typography-headline-small' }, t('utility.tab.converter')),
  );
  panel.append(head);

  const tabBar = h('div', { class: 'm3-tabs', role: 'tablist', 'aria-label': t('utility.tab.converter') });
  const defs = [
    ['converter', t('utility.tab.converter')],
    ['ollama', t('utility.tab.ollama')],
    ['guide', t('utility.tab.guide')],
  ];
  subTabEls = {};
  subTabEls.__defs = defs;
  subTabEls.__buttons = [];
  for (const [id, label] of defs) {
    const btn = h('button', {
      class: 'm3-tab', role: 'tab', dataset: { sub: id },
      id: `mr-utility-tab-${id}`,
      'aria-controls': `mr-utility-panel-${id}`,
      'aria-selected': id === 'converter' ? 'true' : 'false',
      tabindex: id === 'converter' ? '0' : '-1',
      onclick: () => switchSubTab(id),
      onkeydown: (e) => {
        const idx = defs.findIndex(([d]) => d === id);
        // Arrow keys wrap; Home/End mirror the main strip's roving behaviour.
        const go = (nextId) => {
          switchSubTab(nextId);
          subTabEls.__buttons.find((b) => b.dataset.sub === nextId)?.focus();
        };
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          go(defs[(idx + (e.key === 'ArrowRight' ? 1 : defs.length - 1)) % defs.length][0]);
        } else if (e.key === 'Home') {
          e.preventDefault();
          go(defs[0][0]);
        } else if (e.key === 'End') {
          e.preventDefault();
          go(defs[defs.length - 1][0]);
        }
      },
    }, label);
    subTabEls.__buttons.push(btn);
    tabBar.append(btn);
  }
  panel.append(tabBar);

  const converterPane = h('div', {
    class: 'mr-util-pane', role: 'tabpanel',
    id: 'mr-utility-panel-converter', 'aria-labelledby': 'mr-utility-tab-converter',
    tabindex: '0',
  });
  const ollamaPane = h('div', {
    class: 'mr-util-pane', role: 'tabpanel',
    id: 'mr-utility-panel-ollama', 'aria-labelledby': 'mr-utility-tab-ollama',
    tabindex: '0', hidden: true,
  });
  const guidePane = h('div', {
    class: 'mr-util-pane', role: 'tabpanel',
    id: 'mr-utility-panel-guide', 'aria-labelledby': 'mr-utility-tab-guide',
    tabindex: '0', hidden: true,
  });
  // The queue card lives in its own holder so the flow re-render never wipes it.
  const queueHolder = h('div', {});
  const flowHolder = h('div', {});
  converterPane.append(queueHolder, flowHolder);
  converterEls = flowHolder;
  ollamaEls = ollamaPane;
  subTabEls.converter = converterPane;
  subTabEls.ollama = ollamaPane;
  subTabEls.guide = guidePane;
  panel.append(converterPane, ollamaPane, guidePane);

  const queueCard = h('section', { class: 'm3-card mr-util-card' });
  queueHolder.append(queueCard);
  renderQueueInto(queueCard);

  invoke('utility:registry').then((registry) => {
    converter.registry = registry;
    renderConverter();
  }).catch((err) => toast(copy('utility.err.prefix'), err.message, { kind: 'error' }));
  renderConverter();

  invoke('ollama:catalog').then((catalog) => { ollama.catalog = catalog; }).catch(() => {});
  loadSessions().then(() => { if (ollamaMounted) renderOllama(); });
  refreshStatus();
  invoke('ollama:cart-list').then((cart) => { ollama.cart = cart ?? []; if (ollamaMounted) renderOllama(); }).catch(() => {});

  renderOllama();
  renderGuide(guidePane);
  switchSubTab('converter');
  ollamaMounted = true;
}

on('utility-queue', (q) => {
  converter.queue = q;
  const firstCard = subTabEls?.converter?.querySelector('.m3-card');
  if (firstCard) renderQueueInto(firstCard);
});

registerTab({
  id: 'utility',
  label: { en: 'Toolbox', zh: '工具箱' },
  get icon() { return iconFromPath('M22 13h-8v-2h8v2Zm0-6h-8v2h8V7Zm-8 10h8v-2h-8v2Zm-2-8H2v8h10v-8ZM9 15H5v-4h4v4Z'); },
  init,
});

// ---- command palette coverage ------------------------------------------------

palette.register({
  id: 'utility.openConverter',
  title: t('utility.tab.converter'),
  section: 'Actions',
  keywords: ['converter', 'convert', 'toolbox', 'pdf', 'zip', 'wav', 'csv'],
  run: () => switchSubTab('converter'),
});
palette.register({
  id: 'utility.openOllama',
  title: t('utility.tab.ollama'),
  section: 'Actions',
  keywords: ['ollama', 'model', 'pull', 'chat', 'llm'],
  run: () => switchSubTab('ollama'),
});
palette.register({
  id: 'utility.refreshOllama',
  title: t('ollama.status.refresh'),
  section: 'Actions',
  keywords: ['ollama', 'status', 'refresh'],
  run: () => refreshStatus(),
});
palette.register({
  id: 'utility.refreshCatalog',
  title: t('ollama.store.refresh'),
  section: 'Actions',
  keywords: ['ollama', 'catalog', 'store', 'refresh'],
  run: () => refreshCatalog(),
});
palette.register({
  id: 'utility.newChat',
  title: t('ollama.chat.new'),
  section: 'Actions',
  keywords: ['ollama', 'chat', 'new'],
  run: () => { switchSubTab('ollama'); newSession(); },
});
palette.register({
  id: 'utility.troubleshooting',
  title: t('ollama.trouble.open'),
  section: 'Actions',
  keywords: ['ollama', 'troubleshooting', 'help'],
  run: () => switchSubTab('guide'),
});
