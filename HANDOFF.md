# Handoff - Material Router

## 2026-09-18 repository closeout refresh

The primary checkout is `C:\Users\cntow\Documents\GitHub\material-router` on `main` at
`626d154db1e8e4c1cf1a3efdafc8ae25b1ca49eb`, and it matches `origin/main`. A fresh
read-only process check found no running Git process, no lock file, and no linked checkout
admin metadata. The current inventory contains one checkout, one local branch, one remote
head, the historical tags listed by `git show-ref`, no stash entries, no conflict index
entries, 218 tracked paths, and no nonignored untracked paths.

The 13 linked feature branches named in the earlier closeout inventory are already
integrated into `main` through ordinary two-parent merge commits and are no longer present
as local or remote heads. Their previous preservation refs and ancestry proofs remain
documented below. No new linked checkout or branch was created or removed in this refresh.

Preservation refs were verified with `git ls-remote` before cleanup. The preserved branch
heads are:

| Branch | Verified tip |
| --- | --- |
| `feat/readme-captures` | `b0c1fae0909aa2a2def7a6b9ef0b98864971d9bc` |
| `feat/readme-captures-2` | `768a02bbf826c9b05b405c428bbcc7ece704ed28` |
| `feat/fix-minors-toolbox` | `1431f5e5c06dcf083bbaa93d8a8e88f3460f0651` |
| `feat/fix-minors-ui` | `1368d7751b572a5be75136ffc31d4d15c9643dd3` |
| `feat/gap-close` | `4e1310f7492682bd83121fa877e8ea62136839d4` |
| `feat/lang-live-panels` | `01bd5a5e4ea15ce4e440757012ad94f8ac80a31f` |
| `feat/local-tests` | `c3636b9efb3411e2bd0ad17227cdd98736fcddbc` |
| `feat/releases-bom` | `22d222085cc98cb0524cc80b8f60220ace472804` |
| `feat/smoke-fix-0` | `7da4fcb49a630616abffb69ce9598ffafb7378ee` |
| `feat/smoke-fix-1` | `6a0a5eb1d86cf2c9a69bf6d2719afae6be3f9837` |
| `feat/smoke-fix-2` | `a3c8a5a0b68af3b3aa46f06f2c74b12d49cc16db` |
| `feat/smoke-fix-3` | `c6c5a008e5c5a388c27246bbac8e090ad7be88f4` |
| `feat/tabs-destroy` | `c6f081e3863803a843fbdd84bf014a7ad141bd75` |

Each preservation tip is an ancestor of the final `main` tip. The linked checkout paths
are task-owned closeout candidates because they were explicitly placed in scope together.
No separate user-owned, active, load-bearing, unmerged, unpublished, or ownership-uncertain
work was found in the named set. The external archive was created and read back before
any linked checkout or branch was removed:

- Path: `C:\Users\cntow\OneDrive\OakKayBackups\material-router\zips\material-router-20260918T174104Z.7z`
- Size: `3,320,548` bytes
- Listed entries: `3,324`
- Git administration listed: yes
- All 14 primary and linked Git metadata paths listed: yes
- Excluded by Git ignore rules: ignored files and directories only

The archive is the deletion backstop for this closeout and is not part of the repository.

Fresh archive receipt for this refresh:

- Path: `C:\Users\cntow\OneDrive\OakKayBackups\material-router\zips\material-router-20260918T183755Z.7z`
- Size: `6,296,195` bytes
- Listed entries: `867`
- Git administration entries: `436`
- Source paths included: `218` tracked, `0` nonignored untracked
- Read-back checks: 7-Zip test exit `0`, listing exit `0`, `HANDOFF.md` and `ROADMAP.md` present
- Scope: this repository only; ignored files and directories were excluded

Cleanup result from the earlier closeout: all 13 named linked checkout directories and
their local and remote feature branches were removed after the proofs above. The current
refresh found no removable candidate. The only remaining checkout and branch are the
primary `main` checkout and the remote `origin/main`, both at `626d154`.

The final closeout refresh commit will be recorded below after the documents are
committed and the remote ref is verified.

State: ALL NINE FEATURE LANES MERGED to this branch and syntax-gated (87 app modules
clean). The gap-close pass (2026-08-22) landed on top of the integration commit: the
authenticator offline article joined `docs/articles/` with its manifest regenerated,
the Providers lane's journal actions gained real `history.onRestore` implementations
(`app/renderer/src/tabs/providers/restore.js`), README lane annotations were removed,
and ROADMAP Phase 2 now records verification state. Integration edits made by the
integrator earlier: updater-banner import wired in app/renderer/src/app.js, docs
manifest regenerated, ROADMAP Phase 1 ticks applied, platform index section
corrected. The two foundation repairs from the utility lane (ESM loader
pathToFileURL, MAIN_DIR for createWindow) are present.

## How to build / run

```text
npm install          # already done on this checkout; dev deps only
npm start            # launch the Electron app
npm test             # zero-dependency pure-core suite (node --test, 98 tests)
npm run dist         # unsigned Squirrel installer -> dist/squirrel-windows/
npm run icons        # regenerate brand assets (deterministic)
npm run docs-index   # rebuild docs/articles/index.json
npm run count        # committed line-count table
build.bat            # fresh-machine one-click (installs toolchain itself)
build-installer.bat  # release-shaped unsigned Setup.exe
```

Verified on this machine: `npm install` exit 0 (Electron 33.4.11 binary present),
`node scripts/generate-icons.mjs` produces all five assets with byte-identical social
previews, all 26 renderer ES modules pass a Node import check, `package.json` parses.
Local test suite exists and is green (see "Local test suite" below); CI still runs no
test or lint jobs by policy.

## Local test suite

`npm test` runs `node --test` over `test/*.test.mjs` — node:test + node:assert only,
zero new dependencies. Current verdict: **98 pass / 0 fail** on Windows, Node v24.19.0,
four consecutive runs at the commit noted in git history. Coverage and boundaries:

- `translator.js` — full-featured request translation both directions, OpenAI →
  Anthropic → OpenAI round trip (system, roles, text, base64 image parts, tool_calls,
  tools defs, stop sequences, max_tokens defaulting/precedence), non-streaming response
  mapping both directions, both streaming converters (role-first chunk, text deltas,
  tool-call argument accumulation, usage placement, error-event close, converter-pair
  round trip), plus `upstreamHeaders`/`upstreamPath`/`errorBody`. Known limitation
  asserted rather than hidden: prompt tokens arriving in late OpenAI usage chunks have
  no home in an already-emitted Anthropic `message_start`, so they read as 0 there.
- `store.js` — atomic write validity, unique temp names under concurrent saves, no
  `.tmp` residue, retry behaviour via an in-process `fs.promises.rename`/
  `fs.renameSync` patch seam (EPERM retried then succeeds, ENOENT never retried,
  bounded 8-attempt exhaustion with `cause` preserved); JSONStore persistence/reload,
  deep-merged defaults, dotted paths, subscribers, debounced saves, corrupt-file
  quarantine, clone-safety, `flushSync`. Simulating a real open-handle rename failure
  on Windows was deliberately not attempted (Node opens files FILE_SHARE_DELETE, so it
  is platform-flaky); the injected-seam tests cover the same codes deterministically.
- `providers-store.js` — CRUD normalization invariants, rule normalization, route
  resolution order (priority > specificity exact/prefix/catchall > insertion order),
  disabled provider/rule fall-through, fallback-to-default-model, blank-model handling,
  TTL model cache expiry/invalidation, `refreshModels` against a local fixture server.
- `upstream.js` — exercised against a real loopback `node:http` fixture server because
  `callUpstream` uses global fetch with no injection seam: JSON success + byte count,
  SSE parsing across chunk boundaries (multi-line data fields, `[DONE]` pass-through,
  comment-only events skipped), upstream error normalization incl. credential redaction,
  deadline rejection (`DeadlineError`, 504) on POST and GET paths, client-disconnect 499,
  connection-refused mapping, `normalizeUpstreamError` unit cases.
- `vault.js` — scrypt `hashSecret`/`verifySecret` round trip, wrong-password rejection,
  fixed-salt determinism, hostile-input fail-closed; Vault persistence across instances
  via the obfuscation fallback. Real `safeStorage` encryption paths need Electron and are
  covered by runtime smoke passes, not here: under plain Node the suite provisions a
  gitignored `node_modules/electron` stub (marker file `.material-router-test-stub`)
  when no usable electron module exists, so `import { safeStorage } from 'electron'`
  links and the documented unavailable-encryption path runs.

Two product bugs were found by this suite and fixed in the same change:
1. `vault.js` `_isObfuscated` compared against `0x4f424631` ("OBF1") while `_obfuscate`
   writes header `'OFB1'` (`0x4f464231`) — every obfuscated secret was stored once and
   then permanently unreadable through `getSecret()` on machines without OS keychain
   encryption.
2. `store.js` `deletePath` returned `true` for absent keys (`delete obj.missing` is
   truthy in JS), so `JSONStore.delete()` reported success for keys that did not exist;
  it now requires an own property before deleting and reports honestly.

## Architecture in one paragraph

Electron ESM main process (`app/main/`) owns persistence (`store.js` atomic JSONStore),
secrets (`vault.js` safeStorage + scrypt), the loopback HTTP router (`server.js` on
`node:http`), wire-format translation (`translator.js`, pure functions + two streaming
converter classes), upstream calls with rejecting deadlines (`upstream.js`), and provider/
rule persistence with deterministic route resolution (`providers-store.js`). The renderer
(`app/renderer/`) is plain ES modules, no bundler: one M3 token sheet, a component layer,
and shell modules (tabs, palette, search bars + regex builder, toasts + notification
center, history, settings shell, dialogs, markdown renderer). The sandboxed renderer talks
to main exclusively through one IPC channel (`mr:invoke`) whose domains are allowlisted in
`ipc.js`. Preload is CommonJS (`preload.cjs`) because sandboxed preloads cannot be ESM.

## Seam map (lane -> owned paths; all nine landed)

| Lane | Owned paths | Existing seams it builds on |
| --- | --- | --- |
| Foundation Core | `app/main/*`, `app/preload/preload.cjs`, renderer shell (`core/history.js`, `core/tabs.js`, `core/palette.js`, `core/searchbar.js`, `docs` tab) | owns every seam below; lanes extend, never rename |
| Builder | `app/renderer/src/tabs/builder/*` (landed) | IPC `builder:*` domain; `translator.js` for translate-preview |
| Providers | `app/renderer/src/tabs/providers/*` incl. `restore.js` for journal restore hooks (landed) | IPC `providers:*` + `vault:*`; `providers-store.js` CRUD/rules/modelsCache |
| Server | `app/renderer/src/tabs/server/*` (landed) | IPC `server:get-status/start/stop`; `logs:query`; `mr:event` `log` + `server-status` channels |
| Appearance | `app/renderer/src/tabs/appearance/*` (landed) | `core/tokens.css` (extend via presets, never raw colors); `mr:tab-edit-appearance` event from tab context menu |
| Delight | `app/renderer/src/tabs/delight/*` (landed) | implements the `i18n.schoolModeActive()` / `emojiToggleOn()` hooks, upgraded `destructiveConfirm`, `mr:tab-lock-element` event, `vault.hashSecret/verifySecret` |
| Utility | `app/renderer/src/tabs/utility/*` (landed) | `core/md.js`, `core/searchbar.js`, `util.fileOpen/saveText/saveBlob`; extended the docs browser |
| Authenticator | `app/renderer/src/tabs/authenticator/*` + its own main-side journal bridge (landed) | `vault.js` (encrypted records, scrypt), IPC `vault:*` incl. auth-journal routes |
| Plumbing/site | `.github/workflows/release.yml` + `pages.yml`, `*.bat`, `site/`, `scripts/count-lines.mjs`, `scripts/dependency-manifest.json`, `core/updater-banner.js` wiring in `app.js` (landed) | release workflow publishes real tagged releases; count table refreshed by CI |

Tab close lifecycle seam: a tab def may declare an optional
`destroy(container, api)` (`api = { id, reason: 'close' }`), which `closeTab`
calls once per mount, BEFORE removing the panel node, with double-destroy
guarded by the strip (`destroyedSinceMount`, cleared on the next `init`). It is
where a tab module unsubscribes events (`bridge.onAll` gives one combined
unsubscribe), clears timers and aborts streams; a later remount re-runs
`init()`, which re-registers everything released. Implemented by Server
(pollers + uptime ticker + language sub + port timer), Builder (stream sub +
debounces + in-flight abort), Authenticator (code ticker), and the Appearance
tab's narrator feed per its documented "call once at tab init" teardown.
Import-time app-global subscriptions (dim-sum surprise, locks, School mode,
ADHD momentum ticker, utility conversion engine, updater banner) are once-only
by design and intentionally survive their tab.

## Stability contract for lanes

- Keep IPC channel names (`domain:name`), event names (`log`, `toast`, `server-status`,
  `update-status`), settings keys, and tab ids stable; the registry validates them.
- Replace stub file contents freely; do not rename a stub module's registered tab id.
- All user-visible copy goes through `t()`/`copy()` with both `en` and `zh` keys.
- Persistent writes go through `JSONStore` (atomic) - never bare `fs.writeFile` on state.
- Deadlines must reject, not dangle; every async fs op propagates errors honestly.
- CSS uses tokens from `tokens.css` only.

## Known gaps (current truth after the gap-close pass)

Resolved since the foundation handoff:

1. ~~Placeholder feature tabs~~ - all nine lanes landed real surfaces; no placeholder cards remain.
2. ~~School mode, toy locks, unlock ladder, super confirmation, narrator/TTS, dim-sum surprise, ADHD modes~~ - implemented by the Delight lane against the existing hooks (`schoolModeActive`, `emojiToggleOn`, `destructiveConfirm`, `mr:tab-lock-element`).
3. ~~Auto-updater~~ - shipped by the Plumbing lane (`core/updater-banner.js`, imported in `app.js`); unsigned-feed disclosure everywhere.
4. ~~`build.bat` toolchain bootstrap hardening + digest manifest~~ - `download-dependencies.bat` verifies pinned versions + SHA-256 against `scripts/dependency-manifest.json`.
5. ~~Release workflow skeleton~~ - `release.yml` publishes uniquely tagged non-draft releases with the line-count table, dim-sum asset, SHA256SUMS and timing evidence; live tags v0.62-v0.67 prove the pipeline.
6. ~~`/v1/models` empty until config UI~~ - the Providers tab ships provider/key/rule configuration; cached model lists populate from connection tests.

Still open:

7. **Regex step budget** bounds match attempts, not the engine's internal backtracking per attempt; the builder UI states this honestly. A hard backtracking bound would need a custom matcher.
8. **History restore coverage is partial**: the Providers-lane journal actions (`providers.add/update/delete`, `rule.add/update/delete`, `rules.reorder`) have working `history.onRestore` implementations in `app/renderer/src/tabs/providers/restore.js`, appending compensating entries. Other recorded actions (appearance, presets, utility, authenticator.*) still have no renderer-journal restore hooks; the Authenticator tab restores through its own main-side journal instead.
9. **Tab labels** re-render on language change only after a strip rebuild; live per-label refresh is still pending.
10. **README captures** - real built-artifact captures of every surface are not yet embedded in the README (tracked unticked in ROADMAP Phase 2 for the captures pass).
