# Handoff - Foundation

State: foundation skeleton complete on `feat/foundation`. Every architectural seam the
feature lanes depend on exists, runs, and is named. Lane surfaces are working placeholder
cards except the docs browser, which is functional.

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
