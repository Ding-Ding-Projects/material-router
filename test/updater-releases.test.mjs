// Purpose: pure-core tests for app/main/updater.js RELEASES manifest parsing.
//
// The v0.1.0 feed shipped with a UTF-8 BOM (EF BB BF) ahead of the first
// SHA1 and had to be repaired out of band; a client comparing a BOM-prefixed
// token against the real digest can never match and fails closed forever.
// These tests pin the parser's tolerance contract: BOM stripped before
// parsing, CRLF and LF line endings, trailing whitespace per line, and
// garbage lines skipped without poisoning the entries around them.
//
// Honest nuance: ECMAScript's WhiteSpace table currently includes U+FEFF, so
// String.prototype.trim() happens to absorb a decoded BOM today - meaning a
// trim()-only implementation can pass these tests too. They are a behavioural
// contract pin (BOM/CRLF/whitespace tolerance must survive any refactor),
// not a proof that only the explicit strip passes.
//
// updater.js does `import { app } from 'electron'`. Under plain Node the
// electron package either does not resolve (no node_modules) or exports the
// binary path string, which fails the named import. The suite therefore
// provisions a minimal local electron stub under node_modules/ (gitignored)
// when no usable module object exists - the same seam test/vault.test.mjs
// uses, with an app-shaped export so both files can share one stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** U+FEFF via explicit escape: never a literal invisible byte in this source. */
const UTF8_BOM = '\uFEFF';
assert.equal(UTF8_BOM, Buffer.from([0xef, 0xbb, 0xbf]).toString('utf8'),
  'sanity: the escape matches what a BOM decodes to');

/**
 * Write the minimal electron stub. The export MUST stay on one line shaped
 * like `module.exports = { safeStorage: null, app };`: Node's cjs-module-lexer
 * only recognises simple literal shapes when linking CJS named exports for
 * `import { app } from 'electron'`, and a multi-line object with function
 * values lexes to nothing (the import fails with "Named export 'app' not
 * found"). safeStorage is included so test/vault.test.mjs can share this stub.
 */
function writeElectronStub() {
  const pkgDir = path.join(REPO_ROOT, 'node_modules', 'electron');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'electron', version: '0.0.0-test-stub', main: 'index.js',
  }));
  fs.writeFileSync(path.join(pkgDir, 'index.js'), [
    '// Test-only stub provisioned by test/updater-releases.test.mjs.',
    "// Plain Node cannot link the real electron module; keep the export line",
    '// below exactly as it is so named-import linking can see it.',
    "const app = { getPath: () => process.cwd(), getVersion: () => '0.0.0-test', quit: () => {} };",
    'module.exports = { safeStorage: null, app };',
    '',
  ].join('\n'));
}

/** True when the resolvable electron module exposes the `app` updater.js needs. */
function electronHasApp() {
  const pkgDir = path.join(REPO_ROOT, 'node_modules', 'electron');
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) return false;
  try {
    const require = createRequire(pathToFileURL(path.join(REPO_ROOT, 'package.json')));
    const mod = require('electron');
    return Boolean(mod && typeof mod === 'object' && 'app' in mod);
  } catch {
    return false;
  }
}

if (!electronHasApp()) writeElectronStub();

const updaterUrl = pathToFileURL(path.join(REPO_ROOT, 'app', 'main', 'updater.js')).href;
let updaterModule;
try {
  updaterModule = await import(updaterUrl);
} catch (err) {
  // A sibling test file's provisioning may have replaced the stub between our
  // probe and this import (node --test runs files in parallel processes).
  // Rewrite ours - it is a superset of what both files need - and retry once.
  if (!String(err?.message ?? '').includes("Named export")) throw err;
  writeElectronStub();
  updaterModule = await import(updaterUrl);
}
const { parseReleasesManifest } = updaterModule;

const shaA = crypto.randomBytes(20).toString('hex'); // realistic SHA1 shape
const shaB = crypto.randomBytes(20).toString('hex');

// ---------------------------------------------------------------------------
// BOM-prefixed manifests parse cleanly
// ---------------------------------------------------------------------------

test('parseReleasesManifest strips a leading UTF-8 BOM and parses the entry', () => {
  const installerSha = crypto.createHash('sha1').update(Buffer.from('fake installer payload')).digest('hex');
  const entries = parseReleasesManifest(`${UTF8_BOM}${installerSha} MaterialRouter-1.2.3-full.nupkg 54321\n`);

  assert.equal(entries.size, 1, 'exactly one entry parsed');
  assert.deepEqual(entries.get('materialrouter-1.2.3-full.nupkg'), {
    hash: installerSha,
    size: 54321,
  });
});

test('BOM-prefixed hash token equals the real digest (the v0.1.0 failure mode)', () => {
  const digest = shaA;
  const entries = parseReleasesManifest(`${UTF8_BOM}${digest} Setup.exe 100\n`);
  const entry = entries.get('setup.exe');
  assert.ok(entry, 'entry found despite the BOM');
  assert.equal(entry.hash, digest, 'hash carries no BOM residue, so the digest comparison can match');
});

// ---------------------------------------------------------------------------
// Plain manifests are unchanged
// ---------------------------------------------------------------------------

test('plain LF manifest parses exactly as before', () => {
  const entries = parseReleasesManifest(`${shaA} MaterialRouter-1.2.3-full.nupkg 54321\n${shaB} delta.nupkg 7\n`);
  assert.equal(entries.size, 2);
  assert.deepEqual(entries.get('materialrouter-1.2.3-full.nupkg'), { hash: shaA, size: 54321 });
  assert.deepEqual(entries.get('delta.nupkg'), { hash: shaB, size: 7 });
});

test('no-trailing-newline manifest still yields its single entry', () => {
  const entries = parseReleasesManifest(`${shaA} setup.exe 12345`);
  assert.deepEqual(entries.get('setup.exe'), { hash: shaA, size: 12345 });
});

// ---------------------------------------------------------------------------
// CRLF and trailing whitespace tolerance
// ---------------------------------------------------------------------------

test('CRLF line endings are tolerated across every entry', () => {
  const crlf = `${shaA} full.nupkg 111\r\n${shaB} delta.nupkg 222\r\n`;
  const entries = parseReleasesManifest(crlf);
  assert.equal(entries.size, 2);
  assert.deepEqual(entries.get('full.nupkg'), { hash: shaA, size: 111 });
  assert.deepEqual(entries.get('delta.nupkg'), { hash: shaB, size: 222 });
});

test('trailing whitespace on a line does not corrupt the size field', () => {
  const entries = parseReleasesManifest(`${shaA} full.nupkg 333   \t\r\n`);
  const entry = entries.get('full.nupkg');
  assert.deepEqual(entry, { hash: shaA, size: 333 });
  assert.equal(typeof entry.size, 'number', 'size stays numeric, never a whitespace-carrying string');
});

test('BOM plus CRLF plus trailing spaces together still parse', () => {
  const text = `${UTF8_BOM}${shaA} full.nupkg 444\r\n${shaB} delta.nupkg 555 \r\n`;
  const entries = parseReleasesManifest(text);
  assert.equal(entries.size, 2);
  assert.deepEqual(entries.get('full.nupkg'), { hash: shaA, size: 444 });
  assert.deepEqual(entries.get('delta.nupkg'), { hash: shaB, size: 555 });
});

// ---------------------------------------------------------------------------
// Garbage lines are skipped, valid lines survive
// ---------------------------------------------------------------------------

test('garbage lines are skipped and the rest of the manifest still parses', () => {
  // Skippable per the parser's contract: blank, comment, whitespace-only,
  // and single-field lines. Anything else with two or more fields parses as
  // an entry (pinned separately below).
  const mixed = [
    '# a comment line',
    '',
    'onlyonefield',
    '\t   ',
    `${shaA} good.nupkg 777`,
    `${shaB} also-good.nupkg 888`,
  ].join('\n');
  const entries = parseReleasesManifest(mixed);
  assert.equal(entries.size, 2, 'only the two well-formed lines became entries');
  assert.deepEqual(entries.get('good.nupkg'), { hash: shaA, size: 777 });
  assert.deepEqual(entries.get('also-good.nupkg'), { hash: shaB, size: 888 });
});

test('a multi-token junk line becomes an inert entry rather than breaking parsing', () => {
  // Documented behaviour, pinned deliberately: any line with two or more
  // fields parses as "<hash> <filename> ...". Such an entry can never be
  // selected by the updater (it looks up the exact Setup.exe filename), so
  // this is tolerance, not corruption - tightening the format later must be
  // a conscious change that updates this test, never a silent one.
  const entries = parseReleasesManifest('this line is junk\n');
  assert.equal(entries.size, 1);
  const entry = entries.get('line');
  assert.ok(entry, 'junk parsed under its second token as filename');
  assert.equal(entry.hash, 'this');
  assert.ok(Number.isNaN(entry.size), 'missing size field stays NaN, not 0');
});

test('degenerate inputs produce an empty map instead of throwing', () => {
  assert.equal(parseReleasesManifest('').size, 0);
  assert.equal(parseReleasesManifest(null).size, 0);
  assert.equal(parseReleasesManifest(undefined).size, 0);
  assert.equal(parseReleasesManifest(UTF8_BOM).size, 0,
    'a bare BOM with no content is not an entry');
});
