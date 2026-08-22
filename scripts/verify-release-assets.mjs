#!/usr/bin/env node
// Release verification for Material Router.
//
// Given a tag, asserts - via the gh CLI, never a hand-rolled REST client -
// that:
//   1. the release exists and is NOT a draft,
//   2. every expected asset is attached, non-zero size, with a download URL,
//   3. the tag resolves to the exact intended commit SHA.
// Any failed assertion exits non-zero after listing everything it checked,
// so one run reports the whole truth rather than stopping at the first miss.
//
// Usage:
//   node scripts/verify-release-assets.mjs --tag v0.2.0 --sha <commit-sha> \
//        [--repo Ding-Ding-Projects/material-router] \
//        [--asset '*-Setup.exe' --asset RELEASES --asset '*.full.nupkg']
//
// Asset expectations are glob patterns matched against actual asset names
// because Squirrel asset names embed the app version. Defaults cover the
// required trio; *.delta.nupkg is optional by design and not asserted.

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`verify-release-assets: ${flag} requires a value`);
    process.exit(2);
  }
  return v;
}
function argValues(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) {
        console.error(`verify-release-assets: ${flag} requires a value`);
        process.exit(2);
      }
      out.push(v);
    }
  }
  return out;
}

const TAG = argValue('--tag');
const SHA = argValue('--sha');
const REPO = argValue('--repo') ?? 'Ding-Ding-Projects/material-router';
const ASSET_PATTERNS = argValues('--asset');

if (!TAG || !SHA) {
  console.error('Usage: node scripts/verify-release-assets.mjs --tag vX.Y.Z --sha <commit-sha> [--repo owner/name] [--asset <glob>]...');
  process.exit(2);
}

const DEFAULT_PATTERNS = ['*-Setup.exe', 'RELEASES', '*.full.nupkg'];
const patterns = ASSET_PATTERNS.length > 0 ? ASSET_PATTERNS : DEFAULT_PATTERNS;

function gh(endpoint, ...flags) {
  // stderr is captured rather than inherited: an expected 404 ("no such
  // release") must not read as a crash, while real failures still surface
  // through the thrown error below.
  return execFileSync('gh', ['api', endpoint, ...flags], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Minimal glob: * matches any run of characters. Anchored on the whole name. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const failures = [];
const checks = [];

// 1. Release exists and is published (not a draft).
let release = null;
try {
  release = JSON.parse(gh(`repos/${REPO}/releases/tags/${TAG}`));
  checks.push(`release ${TAG} exists`);
} catch {
  failures.push(`no published release found for tag ${TAG} under ${REPO}`);
}

if (release?.draft) {
  failures.push(`release ${TAG} is a draft - drafts are not shipped releases`);
} else if (release) {
  checks.push(`release ${TAG} is non-draft`);
}

if (release && release.tag_name !== TAG) {
  failures.push(`release tag_name "${release.tag_name}" does not match requested "${TAG}"`);
} else if (release) {
  checks.push(`release tag_name matches ${TAG}`);
}

// 2. Every expected asset attached, non-zero, with a download URL.
const assets = Array.isArray(release?.assets) ? release.assets : [];
for (const pattern of patterns) {
  const rx = globToRegExp(pattern);
  const match = assets.find((a) => rx.test(a.name));
  if (!match) {
    failures.push(`expected asset matching "${pattern}" is not attached (attached: ${assets.map((a) => a.name).join(', ') || 'none'})`);
    continue;
  }
  checks.push(`asset "${match.name}" present`);
  if (!(Number(match.size) > 0)) failures.push(`asset "${match.name}" has zero size`);
  else checks.push(`asset "${match.name}" size ${match.size} bytes`);
  if (!/^https:\/\//.test(String(match.browser_download_url ?? ''))) {
    failures.push(`asset "${match.name}" has no https download URL`);
  } else {
    checks.push(`asset "${match.name}" download URL ${match.browser_download_url}`);
  }
}

// 3. The tag resolves to exactly the intended commit. Annotated tags are
// peeled through ^{} so the check compares against the commit, not the tag
// object itself.
try {
  const refs = JSON.parse(gh(`repos/${REPO}/git/refs/tags/${TAG}`));
  const list = Array.isArray(refs) ? refs : [refs];
  const shas = new Set(list.map((r) => r.object?.sha).filter(Boolean));
  // Follow an annotated tag object to its commit when needed.
  for (const r of list) {
    if (r.object?.type === 'tag') {
      const obj = JSON.parse(gh(`repos/${REPO}/git/tags/${r.object.sha}`));
      if (obj.object?.sha) shas.add(obj.object.sha);
    }
  }
  if (shas.has(SHA)) {
    checks.push(`tag ${TAG} resolves to intended commit ${SHA}`);
  } else {
    failures.push(`tag ${TAG} does not resolve to ${SHA} (resolves to: ${[...shas].join(', ') || 'nothing'})`);
  }
} catch {
  failures.push(`could not resolve tag ${TAG} in ${REPO} - the release exists but its git ref could not be read`);
}

console.log(`Verifying ${REPO} @ ${TAG} (expected commit ${SHA})`);
for (const c of checks) console.log(`  ok    : ${c}`);
for (const f of failures) console.error(`  FAIL  : ${f}`);
console.log(`${checks.length} passed, ${failures.length} failed`);

if (failures.length > 0) process.exit(1);
