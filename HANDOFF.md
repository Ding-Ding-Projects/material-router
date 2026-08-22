# Handoff - Foundation

State: ALL NINE FEATURE LANES MERGED to this branch and syntax-gated (86 app modules clean). Integration edits made by the integrator: updater-banner import wired in app/renderer/src/app.js, docs manifest regenerated, ROADMAP Phase 1 ticks applied, platform index section corrected. The two foundation repairs from the utility lane (ESM loader pathToFileURL, MAIN_DIR for createWindow) are present.
feature lanes depend on exists, runs, and is named. Lane surfaces are working placeholder
cards except the docs browser, which is functional.

## How to build / run

```text
npm install          # already done on this checkout; dev deps only
npm start            # launch the Electron app
npm test             # zero-dependency pure-core suite (node --test, 88 tests)
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
zero new dependencies. Current verdict: **88 pass / 0 fail** on Windows, Node v24.19.0,
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

## Seam map (lane -> owned paths)

| Lane | Owned paths | Existing seams it builds on |
| --- | --- | --- |
| Builder | `app/renderer/src/tabs/builder/*` | IPC `builder:*` domain; `translator.js` for translate-preview |
| Providers | `app/renderer/src/tabs/providers/*` | IPC `providers:*` + `vault:*`; `providers-store.js` CRUD/rules/modelsCache |
| Server | `app/renderer/src/tabs/server/*` | IPC `server:get-status/start/stop`; `logs:query`; `mr:event` `log` + `server-status` channels |
| Appearance | `app/renderer/src/tabs/appearance/*` | `core/tokens.css` (extend via presets, never raw colors); `mr:tab-edit-appearance` event from tab context menu |
| Delight | `app/renderer/src/tabs/delight/*` | `i18n.schoolModeActive()` hook, `emojiToggleOn()` gate, `dialogs.destructiveConfirm` (upgrade in place), `mr:tab-lock-element` event, `vault.hashSecret/verifySecret` |
| Utility | `app/renderer/src/tabs/utility/*` | `core/md.js`, `core/searchbar.js`, `util.fileOpen/saveText/saveBlob` |
| Authenticator | `app/renderer/src/tabs/authenticator/*` | `vault.js` (encrypted records, scrypt), IPC `vault:*` |
| Plumbing/site | `.github/`, `*.bat`, `site/`, README count block | release workflow TODO markers; `scripts/count-lines.mjs` table |

## Stability contract for lanes

- Keep IPC channel names (`domain:name`), event names (`log`, `toast`, `server-status`,
  `update-status`), settings keys, and tab ids stable; the registry validates them.
- Replace stub file contents freely; do not rename a stub module's registered tab id.
- All user-visible copy goes through `t()`/`copy()` with both `en` and `zh` keys.
- Persistent writes go through `JSONStore` (atomic) - never bare `fs.writeFile` on state.
- Deadlines must reject, not dangle; every async fs op propagates errors honestly.
- CSS uses tokens from `tokens.css` only.

## Known gaps (handed to lanes)

1. **Builder/Providers/Server/Appearance/Delight/Utility/Authenticator tabs** are placeholder cards (by design).
2. **School mode, toy locks, unlock ladder, super confirmation, narrator, dim-sum surprise, ADHD modes** - hooks exist (`schoolModeActive`, `emojiToggleOn`, `destructiveConfirm`, `mr:tab-lock-element`), implementations pending (Delight lane).
3. **Auto-updater** - feed config + UI pending (Plumbing lane); Squirrel target already configured.
4. **`build.bat` toolchain bootstrap** is functional but basic (winget/portable fallback untested on a truly bare machine) - Plumbing lane hardens + adds digest manifest.
5. **Release workflow** is a skeleton: tag uniqueness, line-count table, dim-sum asset, timing evidence are TODO-marked (Plumbing lane).
6. **`/v1/models`** serves cached entries and refreshes stale providers in the background; first-run with zero providers returns an empty list until Providers lane adds config UI.
7. **Regex step budget** bounds match attempts, not the engine's internal backtracking per attempt; the builder UI states this honestly.
8. **History restore** is a registered-hook stub; lanes register real restore actions via `history.onRestore(action, fn)`.
9. **Tab labels** re-render on language change only after a strip rebuild; live per-label refresh lands with Appearance lane's re-render pass.
