#!/usr/bin/env node
// Purpose: generate every brand asset with ZERO dependencies - a hand-written
// PNG encoder (zlib deflate + CRC32), an analytic-SDF rasterizer, and a
// compact monoline stroke font for the social card wordmark.
//
// Outputs:
//   build/icons/icon.png            512x512 app icon
//   build/icons/icon@2x.png         1024x1024
//   build/icons/icon.ico            16..256 wrapped PNG-in-ICO
//   build/icons/social-preview.png  1280x640 repository embed card
//   site/assets/social-preview.png  byte-identical copy of the above
//
// Run: npm run icons
// Owned by Foundation Core lane.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const OUT_DIR = join(ROOT, 'build', 'icons');
const SITE_OUT = join(ROOT, 'site', 'assets');

// ---------------------------------------------------------------------------
// M3 palette (mirrors tokens.css baseline light scheme)
// ---------------------------------------------------------------------------

const C = {
  primary: [103, 80, 164],
  onPrimaryContainer: [33, 0, 93],
  primaryContainer: [234, 221, 255],
  surface: [254, 247, 255],
  onSurface: [29, 27, 32],
  onSurfaceVariant: [73, 69, 79],
};

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, 8-bit)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
      : Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas + analytic-SDF drawing (1px antialiasing via signed distances)
// ---------------------------------------------------------------------------

class Canvas {
  constructor(width, height, fill = null) {
    this.w = width;
    this.h = height;
    this.px = new Float64Array(width * height * 4);
    if (fill) this.fillAll(fill);
  }

  fillAll([r, g, b]) {
    for (let i = 0; i < this.w * this.h; i++) {
      this.px[i * 4] = r; this.px[i * 4 + 1] = g; this.px[i * 4 + 2] = b; this.px[i * 4 + 3] = 255;
    }
  }

  /** Blend a colored shape given a coverage function d(x,y)->signed distance. */
  paint(sdf, [r, g, b], alphaScale = 1) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        let a = Math.min(1, Math.max(0, 0.5 - d)) * alphaScale;
        if (a <= 0) continue;
        const i = (y * this.w + x) * 4;
        const da = this.px[i + 3] / 255;
        const outA = a + da * (1 - a);
        if (outA === 0) continue;
        this.px[i] = (r * a + this.px[i] * da * (1 - a)) / outA;
        this.px[i + 1] = (g * a + this.px[i + 1] * da * (1 - a)) / outA;
        this.px[i + 2] = (b * a + this.px[i + 2] * da * (1 - a)) / outA;
        this.px[i + 3] = outA * 255;
      }
    }
  }

  roundRect(x, y, w, h, radius, color) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const hw = w / 2;
    const hh = h / 2;
    const r = Math.min(radius, hw, hh);
    this.paint((px, py) => {
      const qx = Math.abs(px - cx) - (hw - r);
      const qy = Math.abs(py - cy) - (hh - r);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
    }, color);
  }

  capsule(ax, ay, bx, by, thickness, color) {
    const r = thickness / 2;
    const bax = bx - ax;
    const bay = by - ay;
    const lenSq = bax * bax + bay * bay || 1e-9;
    this.paint((px, py) => {
      const pax = px - ax;
      const pay = py - ay;
      const t = Math.min(1, Math.max(0, (pax * bax + pay * bay) / lenSq));
      const dx = pax - bax * t;
      const dy = pay - bay * t;
      return Math.sqrt(dx * dx + dy * dy) - r;
    }, color);
  }

  disc(cx, cy, radius, color) {
    this.paint((px, py) => Math.hypot(px - cx, py - cy) - radius, color);
  }

  toPNG() {
    const buf = Buffer.alloc(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      buf[i * 4] = Math.round(this.px[i * 4]);
      buf[i * 4 + 1] = Math.round(this.px[i * 4 + 1]);
      buf[i * 4 + 2] = Math.round(this.px[i * 4 + 2]);
      buf[i * 4 + 3] = Math.round(this.px[i * 4 + 3]);
    }
    return encodePNG(this.w, this.h, buf);
  }
}

/** The route glyph: three nodes joined by a path, drawn inside a unit square. */
function drawRouteGlyph(canvas, ox, oy, size) {
  const s = size;
  const nodes = [
    [ox + 0.30 * s, oy + 0.66 * s],
    [ox + 0.52 * s, oy + 0.34 * s],
    [ox + 0.74 * s, oy + 0.62 * s],
  ];
  const lineW = Math.max(2, 0.055 * s);
  for (let i = 0; i < nodes.length - 1; i++) {
    canvas.capsule(nodes[i][0], nodes[i][1], nodes[i + 1][0], nodes[i + 1][1], lineW, C.onPrimaryContainer);
  }
  const outer = 0.115 * s;
  const inner = 0.048 * s;
  for (const [nx, ny] of nodes) {
    canvas.disc(nx, ny, outer, C.onPrimaryContainer);
    canvas.disc(nx, ny, inner, C.primaryContainer);
  }
}

/** The complete app icon at any size: container square + route glyph. */
function drawIcon(size) {
  const canvas = new Canvas(size, size);
  const margin = 0.094 * size; // 48px at 512
  const box = size - margin * 2;
  canvas.roundRect(margin, margin, box, box, 0.1875 * size, C.primaryContainer);
  drawRouteGlyph(canvas, margin, margin, box);
  return canvas.toPNG();
}

// ---------------------------------------------------------------------------
// Monoline stroke font (uppercase, digits, basic punctuation)
// Glyph grid: 4 wide x 6 tall, y grows downward. Poly-line point lists.
// ---------------------------------------------------------------------------

const GLYPHS = {
  A: [[[0, 6], [2, 0], [4, 6]], [[0.9, 3.8], [3.1, 3.8]]],
  B: [[[0, 0], [0, 6]], [[0, 0], [2.6, 0], [3.6, 1], [3.6, 2], [2.6, 3], [0, 3]], [[0, 3], [2.8, 3], [3.8, 3.9], [3.8, 5], [2.8, 6], [0, 6]]],
  C: [[[3.6, 1.2], [2.6, 0], [1.2, 0], [0, 1.2], [0, 4.8], [1.2, 6], [2.6, 6], [3.6, 4.8]]],
  D: [[[0, 0], [0, 6], [2.4, 6], [3.9, 4.5], [3.9, 1.5], [2.4, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [2.8, 3]]],
  G: [[[3.6, 1.2], [2.6, 0], [1.2, 0], [0, 1.2], [0, 4.8], [1.2, 6], [2.6, 6], [3.6, 4.8], [3.6, 3.4], [2.1, 3.4]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[2, 0], [2, 6]], [[0.7, 0], [3.3, 0]], [[0.7, 6], [3.3, 6]]],
  J: [[[3.2, 0], [3.2, 4.6], [2.2, 6], [0.8, 6], [0.2, 4.8]]],
  K: [[[0, 0], [0, 6]], [[3.6, 0], [0.3, 3.2]], [[1.4, 2.3], [3.8, 6]]],
  L: [[[0, 0], [0, 6], [3.8, 6]]],
  M: [[[0, 6], [0, 0], [2, 3.2], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [[[1.3, 0], [2.7, 0], [4, 1.3], [4, 4.7], [2.7, 6], [1.3, 6], [0, 4.7], [0, 1.3], [1.3, 0]]],
  P: [[[0, 6], [0, 0], [2.6, 0], [3.8, 1], [3.8, 2.4], [2.6, 3.4], [0, 3.4]]],
  Q: [[[1.3, 0], [2.7, 0], [4, 1.3], [4, 4.7], [2.7, 6], [1.3, 6], [0, 4.7], [0, 1.3], [1.3, 0]], [[2.7, 4.4], [4, 5.9]]],
  R: [[[0, 6], [0, 0], [2.6, 0], [3.8, 1], [3.8, 2.4], [2.6, 3.4], [0, 3.4]], [[1.8, 3.4], [3.9, 6]]],
  S: [[[3.7, 1], [2.7, 0], [1.2, 0], [0.2, 0.9], [0.2, 2.1], [1.2, 3], [2.8, 3], [3.8, 3.9], [3.8, 5.1], [2.8, 6], [1.2, 6], [0.3, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 4.7], [1.2, 6], [2.8, 6], [4, 4.7], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 2.6], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 2.9], [4, 0]], [[2, 2.9], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  0: [[[1.3, 0], [2.7, 0], [4, 1.3], [4, 4.7], [2.7, 6], [1.3, 6], [0, 4.7], [0, 1.3], [1.3, 0]], [[0.8, 1.5], [3.2, 4.5]]],
  1: [[[0.9, 1.2], [2.1, 0], [2.1, 6]], [[0.7, 6], [3.5, 6]]],
  2: [[[0.5, 1.2], [1.4, 0], [2.8, 0], [3.7, 1], [3.7, 2.3], [0.5, 6], [3.9, 6]]],
  3: [[[0.5, 0.9], [1.4, 0], [2.8, 0], [3.7, 0.9], [3.7, 2.1], [2.8, 3], [1.5, 3]], [[2.8, 3], [3.8, 3.9], [3.8, 5.1], [2.8, 6], [1.4, 6], [0.5, 5.2]]],
  4: [[[3.1, 6], [3.1, 0], [0, 4.2], [4, 4.2]]],
  5: [[[3.7, 0], [0.5, 0], [0.5, 2.8], [2.7, 2.8], [3.8, 3.8], [3.8, 5], [2.8, 6], [0.7, 6], [0, 5.4]]],
  6: [[[3.4, 1], [2.5, 0], [1.2, 0], [0.2, 1], [0.2, 5], [1.2, 6], [2.8, 6], [3.8, 5], [3.8, 3.9], [2.8, 3], [1.2, 3], [0.2, 3.9]]],
  7: [[[0, 0], [4, 0], [1.4, 6]]],
  8: [[[1.2, 0], [2.8, 0], [3.7, 0.9], [3.7, 2.1], [2.8, 3], [1.2, 3], [0.3, 2.1], [0.3, 0.9], [1.2, 0]], [[1.2, 3], [2.9, 3], [3.8, 3.9], [3.8, 5.1], [2.9, 6], [1.1, 6], [0.2, 5.1], [0.2, 3.9], [1.2, 3]]],
  9: [[[0.6, 5], [1.5, 6], [2.8, 6], [3.8, 5], [3.8, 1], [2.8, 0], [1.2, 0], [0.2, 1], [0.2, 2.1], [1.2, 3], [2.8, 3], [3.8, 2.1]]],
  '.': [[[2, 5.55], [2.02, 5.57]]],
  ':': [[[2, 1.8], [2.02, 1.82]], [[2, 4.6], [2.02, 4.62]]],
  '-': [[[0.8, 3], [3.2, 3]]],
  '/': [[[0.6, 6], [3.4, 0]]],
};

const ADVANCE_OVERRIDES = { ' ': 3.0, '.': 1.8, ':': 1.8, '-': 4.2, '/': 4.6, I: 3.4, 1: 3.4 };
const DEFAULT_ADVANCE = 5.4;

/** Draw uppercase text. Returns the x cursor after the string. */
function drawText(canvas, text, ox, oy, capHeightPx, color, letterSpacingUnits = 0) {
  const scale = capHeightPx / 6;
  const stroke = Math.max(2, capHeightPx * 0.155);
  let x = ox;
  for (const ch of String(text).toUpperCase()) {
    if (ch === ' ') {
      x += ADVANCE_OVERRIDES[' '] * scale;
      continue;
    }
    const glyph = GLYPHS[ch];
    if (!glyph) { x += DEFAULT_ADVANCE * scale; continue; }
    for (const polyline of glyph) {
      for (let i = 0; i < polyline.length - 1; i++) {
        const [x1, y1] = polyline[i];
        const [x2, y2] = polyline[i + 1];
        canvas.capsule(
          x + x1 * scale, oy + y1 * scale,
          x + x2 * scale, oy + y2 * scale,
          stroke, color,
        );
      }
    }
    x += ((ADVANCE_OVERRIDES[ch] ?? DEFAULT_ADVANCE) + letterSpacingUnits) * scale;
  }
  return x;
}

/** The 1280x640 repository embed card. */
function drawSocialPreview() {
  const W = 1280;
  const H = 640;
  const canvas = new Canvas(W, H, C.surface);

  // Left: large app mark.
  const markSize = 320;
  const mx = 120;
  const my = (H - markSize) / 2;
  canvas.roundRect(mx, my, markSize, markSize, markSize * 0.19, C.primaryContainer);
  drawRouteGlyph(canvas, mx, my, markSize);

  // Right: accent bar + stacked wordmark + tagline.
  const tx = 530;
  canvas.roundRect(tx, 148, 104, 16, 8, C.primary);
  drawText(canvas, 'MATERIAL', tx, 196, 92, C.onSurface);
  drawText(canvas, 'ROUTER', tx, 306, 92, C.onSurface);
  drawText(canvas, 'YOUR KEYS. YOUR MODELS.', tx, 452, 26, C.onSurfaceVariant);
  drawText(canvas, 'ONE LOCAL ENDPOINT.', tx, 496, 26, C.onSurfaceVariant);
  return canvas.toPNG();
}

// ---------------------------------------------------------------------------
// ICO assembly (PNG-in-ICO entries, valid for Vista+)
// ---------------------------------------------------------------------------

function buildICO(pngsBySize) {
  const sizes = Object.keys(pngsBySize).map(Number).sort((a, b) => a - b);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  const entries = [];
  let offset = 6 + sizes.length * 16;
  const blobs = [];
  for (const size of sizes) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(pngsBySize[size].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngsBySize[size].length;
    entries.push(entry);
    blobs.push(pngsBySize[size]);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SITE_OUT, { recursive: true });

const outputs = new Map([
  ['build/icons/icon.png', drawIcon(512)],
  ['build/icons/icon@2x.png', drawIcon(1024)],
  ['build/icons/icon.ico', buildICO({
    16: drawIcon(16),
    24: drawIcon(24),
    32: drawIcon(32),
    48: drawIcon(48),
    64: drawIcon(64),
    128: drawIcon(128),
    256: drawIcon(256),
  })],
]);

const socialPng = drawSocialPreview();
outputs.set('build/icons/social-preview.png', socialPng);
outputs.set('site/assets/social-preview.png', socialPng);

for (const [rel, data] of outputs) {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

// Prove the two social copies are byte-identical on disk, not just in memory.
const rootCopy = readFileSync(join(ROOT, 'build', 'icons', 'social-preview.png'));
const siteCopy = readFileSync(join(ROOT, 'site', 'assets', 'social-preview.png'));
if (!rootCopy.equals(siteCopy)) {
  console.error('FATAL: social-preview copies differ on disk');
  process.exit(1);
}

for (const [rel, data] of outputs) {
  console.log(`${rel}  ${(data.length / 1024).toFixed(1)} KB`);
}
console.log('icons OK: social previews are byte-identical.');
