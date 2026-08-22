#!/usr/bin/env node
// Committed line counter for Material Router.
// Prints the exact table releases publish. Run: npm run count
// Exclusions (stated, not silent): node_modules, dist, out, .git,
// package-lock.json (generated), generated icon binaries, generated
// docs index.json. Everything counted is hand-written source.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToRoot } from './lib-root.mjs';

const ROOT = fileURLToRoot(import.meta.url);

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'out', '.git', 'build', '.vscode', '.idea']);
const EXCLUDE_FILES = new Set(['package-lock.json']);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry)) yield* walk(p);
    } else {
      if (!EXCLUDE_FILES.has(entry)) yield p;
    }
  }
}

const BUCKETS = [
  { key: 'main-process', test: (r) => r.startsWith(`app${sep}main`) },
  { key: 'preload', test: (r) => r.startsWith(`app${sep}preload`) },
  { key: 'renderer-js', test: (r) => r.startsWith(`app${sep}renderer`) && /\.(js|mjs|cjs)$/.test(r) },
  { key: 'renderer-css', test: (r) => r.startsWith(`app${sep}renderer`) && /\.css$/.test(r) },
  { key: 'renderer-html', test: (r) => r.startsWith(`app${sep}renderer`) && /\.html$/.test(r) },
  { key: 'scripts', test: (r) => r.startsWith(`scripts${sep}`) },
  { key: 'docs-md', test: (r) => r.startsWith(`docs${sep}`) && !r.endsWith('index.json') },
  { key: 'root-md', test: (r) => /^[^\\/]+\.md$/i.test(r) },
  { key: 'config-ci', test: (r) => /\.(yml|yaml|json|bat|toml)$/i.test(r) || r.startsWith(`.github${sep}`) },
];

const rows = new Map(BUCKETS.map((b) => [b.key, { files: 0, lines: 0, nonBlank: 0 }]));
let unmatched = { files: 0, lines: 0, nonBlank: 0 };

for (const abs of walk(ROOT)) {
  const rel = relative(ROOT, abs);
  if (rel.endsWith('index.json') && rel.includes(`docs${sep}articles`)) continue; // generated
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  const lines = text.split(/\r\n|\n|\r/);
  // Drop a phantom trailing line caused only by a final newline.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const nonBlank = lines.filter((l) => l.trim() !== '').length;
  const bucket = BUCKETS.find((b) => b.test(rel));
  const target = bucket ? rows.get(bucket.key) : unmatched;
  target.files += 1;
  target.lines += lines.length;
  target.nonBlank += nonBlank;
}

const order = [...rows.entries(), ['(unmatched)', unmatched]];
const w = Math.max(...order.map(([k]) => k.length));
console.log('Material Router line count');
console.log('');
console.log(`${'bucket'.padEnd(w)}  files      lines   non-blank`);
console.log('-'.repeat(w + 34));
let tf = 0, tl = 0, tn = 0;
for (const [key, v] of order) {
  console.log(`${key.padEnd(w)}  ${String(v.files).padStart(5)}  ${String(v.lines).padStart(8)}  ${String(v.nonBlank).padStart(9)}`);
  tf += v.files; tl += v.lines; tn += v.nonBlank;
}
console.log('-'.repeat(w + 34));
console.log(`${'TOTAL'.padEnd(w)}  ${String(tf).padStart(5)}  ${String(tl).padStart(8)}  ${String(tn).padStart(9)}`);
console.log('');
console.log('Excluded: node_modules, dist, out, .git, build icons (binaries), package-lock.json, docs/articles/index.json (generated).');
