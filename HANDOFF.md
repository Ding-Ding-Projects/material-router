# Handoff - Material Router

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
No test suites were run (none exist yet; CI runs none by policy).

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
