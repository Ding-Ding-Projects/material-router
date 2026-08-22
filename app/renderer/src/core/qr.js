// Purpose: dependency-free QR Code encoder (ISO/IEC 18004 subset) used to
// render otpauth:// pairing codes locally. No network, no npm packages.
//
// Scope, stated honestly:
//   - Byte mode (UTF-8) payloads, versions 1-20, error correction levels
//     L/M/Q/H with automatic fallback H -> Q -> M -> L when a payload does
//     not fit, then a typed error.
//   - Full masking with the standard four penalty rules (the encoder picks
//     the lowest-penalty mask, as scanners expect).
//   - Rendering produces a real SVG element with a 4-module quiet zone and
//     TRUE dark-on-light colors in both themes. Those two hex values are a
//     functional data encoding (a scanner contrast requirement), which is the
//     single documented exception to the tokens-only color rule; everything
//     else about this component uses tokens.
//
// Owned by the Authenticator lane.

// ---------------------------------------------------------------------------
// Galois field GF(256) arithmetic for Reed-Solomon (primitive poly 0x11D).
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** Generator-polynomial coefficients (degree = number of ECC codewords). */
function rsDivisor(degree) {
  if (degree < 1 || degree > 255) throw new Error('rs degree out of range');
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Structure tables (versions 1-20). Block entry: [numBlocks, totalCw, dataCw]
// per group; order of the four columns is L, M, Q, H.
// ---------------------------------------------------------------------------

const RS_BLOCKS = [
  // v1
  [[[1, 26, 19]], [[1, 26, 16]], [[1, 26, 13]], [[1, 26, 9]]],
  // v2
  [[[1, 44, 34]], [[1, 44, 28]], [[1, 44, 22]], [[1, 44, 16]]],
  // v3
  [[[1, 70, 55]], [[1, 70, 44]], [[2, 35, 17]], [[2, 35, 13]]],
  // v4
  [[[1, 100, 80]], [[2, 50, 32]], [[2, 50, 24]], [[4, 25, 9]]],
  // v5
  [[[1, 134, 108]], [[2, 67, 43]], [[2, 33, 15], [2, 34, 16]], [[2, 33, 11], [2, 34, 12]]],
  // v6
  [[[2, 86, 68]], [[4, 43, 27]], [[4, 43, 19]], [[4, 43, 15]]],
  // v7
  [[[2, 98, 78]], [[4, 49, 31]], [[2, 32, 14], [4, 33, 15]], [[4, 39, 13], [1, 40, 13]]],
  // v8
  [[[2, 121, 97]], [[2, 60, 38], [2, 61, 39]], [[4, 40, 18], [2, 41, 19]], [[4, 40, 14], [2, 41, 15]]],
  // v9
  [[[2, 146, 116]], [[3, 58, 36], [2, 59, 37]], [[4, 36, 16], [4, 37, 17]], [[4, 36, 12], [4, 37, 13]]],
  // v10
  [[[2, 86, 68], [2, 87, 69]], [[4, 69, 43], [1, 70, 44]], [[6, 43, 19], [2, 44, 20]], [[6, 43, 15], [2, 44, 16]]],
  // v11
  [[[4, 101, 81]], [[1, 80, 50], [4, 81, 51]], [[4, 50, 22], [4, 51, 23]], [[3, 36, 12], [8, 37, 13]]],
  // v12
  [[[2, 116, 92], [2, 117, 93]], [[6, 58, 36], [2, 59, 37]], [[4, 46, 20], [6, 47, 21]], [[7, 42, 14], [4, 43, 15]]],
  // v13
  [[[4, 133, 107]], [[8, 59, 37], [1, 60, 38]], [[8, 44, 20], [4, 45, 21]], [[12, 33, 11], [4, 34, 12]]],
  // v14
  [[[3, 145, 115], [1, 146, 116]], [[4, 64, 40], [5, 65, 41]], [[11, 36, 16], [5, 37, 17]], [[11, 36, 12], [5, 37, 13]]],
  // v15
  [[[5, 109, 87], [1, 110, 88]], [[5, 65, 41], [5, 66, 42]], [[5, 54, 24], [7, 55, 25]], [[11, 36, 12], [7, 37, 13]]],
  // v16
  [[[5, 122, 98], [1, 123, 99]], [[7, 73, 45], [3, 74, 46]], [[15, 43, 19], [2, 44, 20]], [[3, 45, 15], [13, 46, 16]]],
  // v17
  [[[1, 135, 107], [5, 136, 108]], [[10, 74, 46], [1, 75, 47]], [[1, 50, 22], [15, 51, 23]], [[2, 42, 14], [17, 43, 15]]],
  // v18
  [[[5, 150, 120], [1, 151, 121]], [[9, 69, 43], [4, 70, 44]], [[17, 50, 22], [1, 51, 23]], [[2, 42, 14], [19, 43, 15]]],
  // v19
  [[[3, 141, 113], [4, 142, 114]], [[3, 70, 44], [11, 71, 45]], [[17, 47, 21], [4, 48, 22]], [[9, 39, 13], [16, 40, 14]]],
  // v20
  [[[3, 135, 107], [5, 136, 108]], [[3, 67, 41], [13, 68, 42]], [[15, 54, 24], [5, 55, 25]], [[15, 43, 15], [10, 44, 16]]],
].map((ver) => Object.freeze(ver.map(Object.freeze)));

const ALIGNMENT = [
  [], // v1
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74],
  [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
].map(Object.freeze);

/** ISO format-info bits per EC level (L=1, M=0, Q=3, H=2). */
const ECL = Object.freeze({
  L: Object.freeze({ ordinal: 0, formatBits: 1 }),
  M: Object.freeze({ ordinal: 1, formatBits: 0 }),
  Q: Object.freeze({ ordinal: 2, formatBits: 3 }),
  H: Object.freeze({ ordinal: 3, formatBits: 2 }),
});

const MAX_VERSION = 20;

function dataCapacityBytes(version, eclKey) {
  return RS_BLOCKS[version - 1][ECL[eclKey].ordinal]
    .reduce((sum, [count, , dataCw]) => sum + count * dataCw, 0);
}

// ---------------------------------------------------------------------------
// Encoding pipeline
// ---------------------------------------------------------------------------

/**
 * Encode text into a QR matrix. Returns { size, modules } where modules is a
 * boolean[size][size] matrix WITHOUT the quiet zone (callers add margins).
 */
export function encodeQR(text, { ecl = null } = {}) {
  const bytes = new TextEncoder().encode(String(text));
  if (bytes.length === 0) throw qrError('qr-empty', 'Nothing to encode');

  const levelOrder = ecl ? [ecl] : ['H', 'Q', 'M', 'L'];
  for (const key of levelOrder) {
    if (!ECL[key]) throw qrError('qr-invalid-ecl', `Unknown error-correction level "${key}"`);
  }

  let chosen = null;
  let chosenVersion = 0;
  for (const key of levelOrder) {
    for (let ver = 1; ver <= MAX_VERSION; ver++) {
      if (bytes.length <= dataCapacityBytes(ver, key)) {
        chosen = key;
        chosenVersion = ver;
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) {
    throw qrError('qr-too-long', `Payload is ${bytes.length} bytes; the largest supported encoding holds ${dataCapacityBytes(MAX_VERSION, 'L')}`);
  }

  const codewords = buildCodewords(bytes, chosenVersion, chosen);
  const size = chosenVersion * 4 + 17;
  const modules = buildMatrix(codewords, chosenVersion, chosen);

  // Self-check: every function pattern must be intact after masking.
  verifyStructure(modules, chosenVersion);

  return { size, version: chosenVersion, ecl: chosen, modules };
}

function qrError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function buildCodewords(bytes, version, eclKey) {
  const blocks = RS_BLOCKS[version - 1][ECL[eclKey].ordinal];
  const capacity = dataCapacityBytes(version, eclKey);

  // Segment: mode 0100 (byte), char count 8 bits (v1-9) or 16 bits (v10+),
  // payload, terminator, byte alignment, alternating pad bytes.
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) appendBits(bits, b, 8);

  const maxBits = capacity * 8;
  appendBits(bits, 0, Math.min(4, maxBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0); // byte boundary
  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    dataCw.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xEC; dataCw.length < capacity; pad = pad === 0xEC ? 0x11 : 0xEC) {
    dataCw.push(pad);
  }

  // Split into blocks, compute ECC, then interleave data + ECC codewords.
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (const [count, total, data] of blocks) {
    for (let b = 0; b < count; b++) {
      dataBlocks.push(dataCw.slice(offset, offset + data));
      offset += data;
      eccBlocks.push(rsRemainder(dataCw.slice(offset - data, offset), rsDivisor(total - data)));
    }
  }
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  const maxEcc = Math.max(...eccBlocks.map((b) => b.length));
  for (let i = 0; i < maxEcc; i++) {
    for (const block of eccBlocks) if (i < block.length) out.push(block[i]);
  }
  return out;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

function buildMatrix(codewords, version, eclKey) {
  const size = version * 4 + 17;
  /** -1 unset/function placeholder, 0 light, 1 dark */
  const grid = Array.from({ length: size }, () => new Array(size).fill(-1));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  drawFinders(grid, isFunction);
  drawAlignment(grid, isFunction, version);
  drawTiming(grid, isFunction);
  // Reserve every format cell (both copies plus the always-dark module) so
  // data placement skips them; values are redrawn per candidate mask later.
  drawFormatBits(grid, isFunction, 'M', 0);
  if (version >= 7) drawVersionInfo(grid, isFunction, version);

  drawCodewords(grid, isFunction, codewords);

  // Try all eight masks, score penalties, keep the best-scoring result.
  // Masks toggle, so each candidate is reverted before the next trial and
  // every snapshot always matches its own declared mask exactly.
  let best = null;
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, isFunction, mask);
    drawFormatBits(grid, isFunction, eclKey, mask);
    const penalty = penaltyScore(grid);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = grid.map((row) => [...row]);
      bestMask = mask;
    }
    applyMask(grid, isFunction, mask); // revert (XOR toggling is involutive)
  }
  void bestMask; // retained in case callers ever need to know which mask won
  return best;
}

function setFunctionModule(grid, isFunction, x, y, dark) {
  grid[y][x] = dark ? 1 : 0;
  isFunction[y][x] = true;
}

function drawFinders(grid, isFunction) {
  const size = grid.length;
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        setFunctionModule(grid, isFunction, x, y, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignment(grid, isFunction, version) {
  const pos = ALIGNMENT[version - 1];
  for (const cy of pos) {
    for (const cx of pos) {
      // Skip the three corners occupied by finder patterns.
      if ((cx <= 8 && cy <= 8) || (cx >= grid.length - 8 && cy <= 8) || (cx <= 8 && cy >= grid.length - 8)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunctionModule(grid, isFunction, cx + dx, cy + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
}

function drawTiming(grid, isFunction) {
  const size = grid.length;
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (!isFunction[6][i]) setFunctionModule(grid, isFunction, i, 6, dark);
    if (!isFunction[i][6]) setFunctionModule(grid, isFunction, 6, i, dark);
  }
}

function drawFormatBits(grid, isFunction, eclKey, mask) {
  const size = grid.length;
  const data = ECL[eclKey].formatBits << 3 | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bitAt = (i) => ((bits >>> i) & 1) === 1;
  // Coordinates follow the standard's (column, row) convention; setFunction-
  // Module takes (x, y) and marks the cell as reserved.
  // First copy
  for (let i = 0; i <= 5; i++) setFunctionModule(grid, isFunction, 8, i, bitAt(i));
  setFunctionModule(grid, isFunction, 8, 7, bitAt(6));
  setFunctionModule(grid, isFunction, 8, 8, bitAt(7));
  setFunctionModule(grid, isFunction, 7, 8, bitAt(8));
  for (let i = 9; i < 15; i++) setFunctionModule(grid, isFunction, 14 - i, 8, bitAt(i));
  // Second copy
  for (let i = 0; i < 8; i++) setFunctionModule(grid, isFunction, size - 1 - i, 8, bitAt(i));
  for (let i = 8; i < 15; i++) setFunctionModule(grid, isFunction, 8, size - 15 + i, bitAt(i));
  // The always-dark module sits at (x=8, y=size-8), beside the vertical
  // second copy, and is re-asserted on every format redraw.
  setFunctionModule(grid, isFunction, 8, size - 8, true);
}

function drawVersionInfo(grid, isFunction, version) {
  const size = grid.length;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(grid, isFunction, a, b, bit);
    setFunctionModule(grid, isFunction, b, a, bit);
  }
}

function drawCodewords(grid, isFunction, codewords) {
  const size = grid.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // vertical timing column is skipped
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x]) continue;
        grid[y][x] = i < codewords.length * 8
          ? ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1)
          : 0; // remainder bits (versions with them) are light
        i += 1;
      }
    }
  }
  // Every codeword bit must have been placed; leftover modules (the version's
  // remainder bits) were filled light above.
  if (i < codewords.length * 8) throw qrError('qr-internal', 'Codeword placement ran out of modules');
}

const MASK_FORMULAS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function applyMask(grid, isFunction, mask) {
  const size = grid.length;
  const formula = MASK_FORMULAS[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      grid[y][x] = formula(y, x) ? (grid[y][x] === 1 ? 0 : 1) : grid[y][x];
    }
  }
}

function penaltyScore(grid) {
  const size = grid.length;
  let penalty = 0;

  // Rule 1: runs of 5+ same-colored modules in rows and columns.
  for (let y = 0; y < size; y++) {
    penalty += lineRuns(grid[y]);
  }
  for (let x = 0; x < size; x++) {
    const col = new Array(size);
    for (let y = 0; y < size; y++) col[y] = grid[y][x];
    penalty += lineRuns(col);
  }

  // Rule 2: 2x2 blocks of the same color.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = grid[y][x];
      if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) penalty += 3;
    }
  }

  // Rule 3: the two finder-like patterns (1011101 with 0000 on either side).
  const FINDER = [true, false, true, true, true, false, true];
  const matchesPattern = (get, len) => {
    let count = 0;
    outer:
    for (let start = 0; start < len - 6; start++) {
      for (let k = 0; k < 7; k++) {
        if (get(start + k) !== FINDER[k]) continue outer;
      }
      // Light run of 4 on either side
      const before = start >= 4 && !get(start - 1) && !get(start - 2) && !get(start - 3) && !get(start - 4);
      const after = start + 10 < len && !get(start + 7) && !get(start + 8) && !get(start + 9) && !get(start + 10);
      if (before || after) count += 40;
    }
    return count;
  };
  for (let y = 0; y < size; y++) {
    penalty += matchesPattern((i) => grid[y][i] === 1, size);
    penalty += matchesPattern((i) => grid[i][y] === 1, size);
  }

  // Rule 4: deviation from 50% dark.
  let dark = 0;
  for (const row of grid) for (const c of row) if (c === 1) dark += 1;
  const total = size * size;
  const percent = (dark * 100) / total;
  const prev5 = Math.floor(percent / 5);
  const next5 = Math.ceil(percent / 5);
  penalty += Math.min(Math.abs(prev5 * 5 - 50) / 5, Math.abs(next5 * 5 - 50) / 5) * 10;

  return penalty;
}

function lineRuns(line) {
  let penalty = 0;
  let runColor = line[0];
  let runLen = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === runColor) {
      runLen += 1;
    } else {
      if (runLen >= 5) penalty += runLen - 2;
      runColor = line[i];
      runLen = 1;
    }
  }
  if (runLen >= 5) penalty += runLen - 2;
  return penalty;
}

/** Cheap structural self-check: finders/timing/dark module must be intact. */
function verifyStructure(grid, version) {
  const size = grid.length;
  if (size !== version * 4 + 17) throw qrError('qr-internal', 'Bad matrix size');
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const expected = dist !== 2;
        const actual = grid[cy + dy][cx + dx] === 1;
        if (expected !== actual) throw qrError('qr-internal', 'Finder pattern corrupted');
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    const expected = i % 2 === 0;
    if ((grid[6][i] === 1) !== expected || (grid[i][6] === 1) !== expected) {
      throw qrError('qr-internal', 'Timing pattern corrupted');
    }
  }
  if (grid[size - 8][8] !== 1) throw qrError('qr-internal', 'Dark module missing');
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

/**
 * Render `text` as a crisp SVG QR element. Fixed near-black/near-white are a
 * functional scanner-contrast requirement and apply in both themes (see file
 * header). Returns { el, matrix, size }.
 */
export function qrSvgElement(text, { modulePx = 4, quietModules = 4, label = 'QR code' } = {}) {
  const { size, modules, version, ecl } = encodeQR(text);
  const total = (size + quietModules * 2) * modulePx;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(total));
  svg.setAttribute('height', String(total));
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.classList.add('mr-auth-qr');

  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.setAttribute('fill', '#ffffff');
  svg.append(bg);

  // One path per dark run keeps the node count tiny even for v20 matrices.
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', '#000000');
  let d = '';
  for (let y = 0; y < size; y++) {
    let runStart = -1;
    for (let x = 0; x <= size; x++) {
      const dark = x < size && modules[y][x];
      if (dark && runStart === -1) runStart = x;
      if (!dark && runStart !== -1) {
        d += `M${(runStart + quietModules) * modulePx} ${(y + quietModules) * modulePx}`
          + `h${(x - runStart) * modulePx}v${modulePx}h-${(x - runStart) * modulePx}Z`;
        runStart = -1;
      }
    }
  }
  path.setAttribute('d', d);
  svg.append(path);

  return { el: svg, size: total, modules, version, ecl };
}
