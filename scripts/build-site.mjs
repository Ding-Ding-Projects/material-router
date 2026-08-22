/* Documentation-site build/validation script. Zero dependencies.
   The pages are hand-authored static files; this script
   1. validates every page's social/embed metadata (og:*, twitter:*, theme-color),
   2. validates that every local stylesheet, module and internal link resolves,
   3. stamps site/build-info.json consumed by the About page.
   Exits non-zero listing every problem found — a green run is only meaningful
   because failures are loud. */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    if (p.endsWith('.html')) return [p];
    return [];
  });
}

const pages = walk(site);
if (!pages.length) {
  console.error('build-site: no HTML pages found under site/');
  process.exit(1);
}

const REQUIRED_META = [
  'og:title', 'og:description', 'og:url', 'og:type', 'og:site_name',
  'og:image', 'og:image:width', 'og:image:height', 'og:image:alt',
];
const problems = [];

for (const page of pages) {
  const rel = page.slice(site.length + 1).replace(/\\/g, '/');
  const html = readFileSync(page, 'utf8');
  const depth = rel.includes('/') ? 1 : 0;

  for (const prop of REQUIRED_META) {
    if (!html.includes(`property="og:${prop}"`) && !html.includes(`property="${prop}"`)) {
      problems.push(`${rel}: missing og meta ${prop}`);
    }
  }
  // og:image must be an absolute https URL
  const img = /property="og:image" content="([^"]+)"/.exec(html);
  if (!img || !img[1].startsWith('https://')) problems.push(`${rel}: og:image is not absolute https`);
  if (!/name="twitter:card" content="summary_large_image"/.test(html)) {
    problems.push(`${rel}: missing twitter:card summary_large_image`);
  }
  if (!/name="theme-color"/.test(html)) problems.push(`${rel}: missing theme-color`);

  // local asset references resolve (relative to the page)
  for (const m of html.matchAll(/(?:href|src)="(assets\/[^"]+)"/g)) {
    try {
      statSync(resolve(dirname(page), m[1]));
    } catch {
      problems.push(`${rel}: broken local reference ${m[1]}`);
    }
  }
  // internal .html links resolve relative to the page
  for (const m of html.matchAll(/href="(\.\.?\/[^"]*\.html|[^"#][^":]*\.html)"/g)) {
    if (/https?:/.test(m[1])) continue;
    try {
      statSync(resolve(dirname(page), decodeURIComponent(m[1])));
    } catch {
      problems.push(`${rel}: broken internal link ${m[1]}`);
    }
  }
}

// stamp build info consumed by the About page
const info = {
  generatedAt: new Date().toISOString(),
  pages: pages.map((p) => p.slice(site.length + 1).replace(/\\/g, '/')).sort(),
};
writeFileSync(join(site, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);

if (problems.length) {
  console.error(`build-site: ${problems.length} problem(s):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`build-site: ${pages.length} pages validated; site/build-info.json stamped.`);
