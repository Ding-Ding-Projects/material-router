#!/usr/bin/env node
// Generates docs/articles/index.json for the in-app offline docs browser.
// Run: npm run docs-index   (also run automatically before packaging)

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIR = join(ROOT, 'docs', 'articles');
const OUT = join(DIR, 'index.json');

if (!existsSync(DIR)) {
  console.error(`docs/articles not found at ${DIR}`);
  process.exit(1);
}

const articles = [];
for (const name of readdirSync(DIR).sort()) {
  if (!name.toLowerCase().endsWith('.md')) continue;
  const abs = join(DIR, name);
  if (!statSync(abs).isFile()) continue;
  const text = readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  let title = null;
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) { title = m[1].trim(); break; }
  }
  if (!title) title = basename(name, '.md');
  // Summary: first non-heading, non-empty paragraph line.
  let summary = '';
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('```')) {
      if (summary) break;
      continue;
    }
    summary += (summary ? ' ' : '') + t.replace(/[*_`[\]()]/g, '');
    if (summary.length >= 160) break;
  }
  if (summary.length > 180) summary = summary.slice(0, 177) + '...';
  articles.push({
    id: basename(name, '.md'),
    file: name,
    title,
    summary,
  });
}

const index = {
  generatedAt: new Date().toISOString(),
  count: articles.length,
  articles,
};

writeFileSync(OUT, JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log(`docs/articles/index.json written: ${articles.length} article(s)`);
