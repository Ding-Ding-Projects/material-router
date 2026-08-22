// Purpose: pure-core tests for app/main/vault.js.
//
// vault.js does `import { safeStorage } from 'electron'`. Under plain Node the
// electron package either does not resolve (no node_modules) or exports the
// binary path string, which fails the named import. The suite therefore
// provisions a minimal local electron stub under node_modules/ (gitignored)
// when no usable electron module exists, which links the import and makes
// `encryptionAvailable` false — exercising the documented obfuscation fallback.
// Real safeStorage encryption paths need Electron itself and are covered by the
// app's runtime smoke pass, not here; that boundary is recorded in HANDOFF.md.
//
// The scrypt hash/verify helpers are pure Node crypto and need no stub at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { makeTempDir, makeTempCleanup } from './helpers.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmpRoot = makeTempDir('vault');
test.after(makeTempCleanup(tmpRoot));

/**
 * Ensure `import { safeStorage } from 'electron'` can link under plain Node.
 * Returns true when a usable module (stub or otherwise) is in place.
 */
function ensureElectronImportable() {
  const pkgDir = path.join(REPO_ROOT, 'node_modules', 'electron');
  const marker = path.join(pkgDir, '.material-router-test-stub');
  if (fs.existsSync(marker)) return true;

  // Probe an existing real install: if it already provides an object with
  // safeStorage we can import it directly; otherwise write the stub.
  if (fs.existsSync(path.join(pkgDir, 'package.json'))) {
    try {
      const require = createRequire(pathToFileURL(path.join(REPO_ROOT, 'package.json')));
      const mod = require('electron');
      if (mod && typeof mod === 'object' && 'safeStorage' in mod) return true;
    } catch { /* fall through to stub */ }
  }

  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'electron', version: '0.0.0-test-stub', main: 'index.js',
  }));
  fs.writeFileSync(path.join(pkgDir, 'index.js'), [
    '// Test-only stub provisioned by test/vault.test.mjs.',
    '// Plain Node cannot link the real electron module; this stub makes',
    "// `safeStorage` present-but-unavailable so the obfuscation fallback runs.",
    'module.exports = { safeStorage: null };',
    '',
  ].join('\n'));
  fs.writeFileSync(marker, 'provisioned by test/vault.test.mjs; safeStorage unavailable by design\n');
  return true;
}

const vaultUrl = pathToFileURL(path.join(REPO_ROOT, 'app', 'main', 'vault.js')).href;

// Import once at module scope so every test below shares the module record.
const electronReady = ensureElectronImportable();
const vaultModule = electronReady ? await import(vaultUrl) : null;

// ---------------------------------------------------------------------------
// hashSecret / verifySecret — pure Node crypto, no Electron anywhere
// ---------------------------------------------------------------------------

test('hashSecret/verifySecret round trip with generated salt', () => {
  const { hashSecret, verifySecret } = vaultModule;
  const { hashB64, saltB64 } = hashSecret('correct horse battery staple');
  assert.ok(saltB64.length > 0);
  assert.equal(Buffer.from(saltB64, 'base64').length, 16, 'fresh salt is 16 random bytes');
  assert.equal(Buffer.from(hashB64, 'base64').length, 64, 'scrypt output is 64 bytes');

  assert.equal(verifySecret('correct horse battery staple', saltB64, hashB64), true);
  assert.equal(verifySecret('wrong password', saltB64, hashB64), false);
  assert.equal(verifySecret('', saltB64, hashB64), false, 'empty password rejected');
  assert.equal(verifySecret('correct horse battery staple', saltB64, Buffer.from('junk').toString('base64')), false,
    'mismatched hash lengths fail closed via timingSafeEqual guard');
});

test('hashSecret is deterministic for a fixed salt (verification depends on it)', () => {
  const { hashSecret } = vaultModule;
  const saltB64 = Buffer.from('0123456789abcdef').toString('base64');
  const a = hashSecret('same input', saltB64);
  const b = hashSecret('same input', saltB64);
  assert.equal(a.hashB64, b.hashB64);
  assert.equal(a.saltB64, saltB64);
  const different = hashSecret('same input?', saltB64);
  assert.notEqual(different.hashB64, a.hashB64);
});

test('hashSecret rejects empty/non-string passwords', () => {
  const { hashSecret } = vaultModule;
  assert.throws(() => hashSecret(''), /password required/);
  assert.throws(() => hashSecret(null), /password required/);
});

test('verifySecret never throws — hostile inputs become false', () => {
  const { verifySecret } = vaultModule;
  const { hashB64, saltB64 } = vaultModule.hashSecret('pw');
  assert.equal(verifySecret('pw', '!!!not-base64!!!', hashB64), false);
  assert.equal(verifySecret('pw', saltB64, '!!!not-base64!!!'), false);
});

// ---------------------------------------------------------------------------
// Vault class — obfuscation fallback (safeStorage unavailable under plain Node)
// ---------------------------------------------------------------------------

test('Vault: obfuscation fallback persists secrets across instances and never exposes values in lists', () => {
  const { Vault } = vaultModule;
  assert.ok(vaultModule.defaultVaultPath('C:/tmp').includes('vault.dat'));

  const file = path.join(tmpRoot, `vault-${Date.now()}.dat`);
  const v1 = new Vault(file);
  assert.equal(v1.encryptionAvailable, false, 'plain Node has no OS keychain: fallback documented');

  const stored = v1.setSecret('provider:main', 'sk-super-secret-value');
  assert.equal(stored, false, 'returns false when obfuscation was used (UI must warn once)');
  assert.equal(v1.obfuscationWarned, true);
  assert.equal(v1.getSecret('provider:main'), 'sk-super-secret-value');
  assert.deepEqual(v1.listIds(), ['provider:main'], 'ids only — values never exposed through lists');

  // On-disk bytes must not contain the plaintext.
  const raw = fs.readFileSync(file);
  assert.ok(!raw.includes('sk-super-secret-value'), 'plaintext never reaches vault.dat');
  assert.ok(raw.subarray(0, 8).toString('utf8') === 'MRVLT01\n', 'magic header present');

  // A second instance reloads from disk and deobfuscates.
  const v2 = new Vault(file);
  assert.equal(v2.getSecret('provider:main'), 'sk-super-secret-value');
  assert.equal(v2.has('provider:main'), true);

  // Delete persists too.
  assert.equal(v2.deleteSecret('provider:main'), true);
  assert.equal(v2.deleteSecret('provider:main'), false);
  const v3 = new Vault(file);
  assert.equal(v3.getSecret('provider:main'), null);
  assert.equal(v3.has('provider:main'), false);
});

test('Vault: setSecret validates its inputs', () => {
  const { Vault } = vaultModule;
  const v = new Vault(path.join(tmpRoot, `vault-validate-${Date.now()}.dat`));
  assert.throws(() => v.setSecret('', 'x'), /id required/);
  assert.throws(() => v.setSecret(null, 'x'), /id required/);
  assert.throws(() => v.setSecret('id', 42), /must be a string/);
  assert.throws(() => v.setSecret('id', { nested: 'object' }), /must be a string/);
});

test('Vault: missing file loads empty; corrupt file is quarantined and vault stays usable', () => {
  const { Vault } = vaultModule;
  const dir = path.join(tmpRoot, `vault-corrupt-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  const missing = new Vault(path.join(dir, 'nope.dat'));
  assert.equal(missing.listIds().length, 0);

  const file = path.join(dir, 'broken.dat');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('MRVLT01\n', 'utf8'), Buffer.from([1, 2, 99])]));
  // Length prefix 0x00000102 claims far more bytes than exist -> load stops.
  const v = new Vault(file);
  assert.equal(v.listIds().length, 0, 'truncated record skipped, not crashed on');
  // The vault remains writable after a bad load.
  v.setSecret('after-corruption', 'still works');
  assert.equal(v.getSecret('after-corruption'), 'still works');

  const wrongMagic = path.join(dir, 'wrongmagic.dat');
  fs.writeFileSync(wrongMagic, 'not a vault at all');
  const v2 = new Vault(wrongMagic);
  assert.equal(v2.listIds().length, 0);
});

test('Vault: malformed JSON records inside a well-formed container are skipped', () => {
  const { Vault } = vaultModule;
  const dir = path.join(tmpRoot, `vault-skip-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mixed.dat');

  const rec = (id, data) => {
    const payload = Buffer.from(JSON.stringify({ id, data }), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
  };
  const garbage = (() => {
    const payload = Buffer.from('not json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
  })();

  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('MRVLT01\n', 'utf8'),
    garbage,
    rec('good', Buffer.from('plain').toString('base64')),
  ]));

  const v = new Vault(file);
  assert.deepEqual(v.listIds(), ['good'], 'malformed record skipped; valid record loaded');
});
