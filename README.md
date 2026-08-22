<p align="center">
  <img src="build/icons/social-preview.png" alt="Material Router - your keys, your models, one local endpoint" width="640" />
</p>

<h1 align="center">Material Router</h1>

<p align="center">
  <a href="#-features">Features</a> ·
  <a href="#-quickstart">Quickstart</a> ·
  <a href="#-security-model">Security</a> ·
  <a href="#-development">Development</a> ·
  <a href="#-documentation">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/Ding-Ding-Projects/material-router/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Ding-Ding-Projects/material-router?include_prereleases&logo=github"></a>
  <a href="#"><img alt="Platform" src="https://img.shields.io/badge/platform-Windows-blue?logo=windows95"></a>
  <a href="LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <a href="#"><img alt="Made with hand-written code" src="https://img.shields.io/badge/runtime%20deps-zero-brightgreen"></a>
</p>

---

**Material Router** is a bring-your-own-key AI router that runs on your own machine.
Point any OpenAI-compatible or Anthropic-compatible client at a local endpoint,
and route every request to whichever provider you choose - with full wire-format
translation between the two ecosystems, streaming included. No account, no proxy
service, no telemetry: your API keys never leave your machine.

## ✨ Features

**Routing core**
- 🔀 **Local endpoints** - `POST /v1/chat/completions` (OpenAI) and `POST /v1/messages` (Anthropic) on `127.0.0.1`, port configurable; loopback-only by default.
- 🌐 **Format translation** - requests, responses and SSE streams translate OpenAI ↔ Anthropic in both directions: system prompts, tool calls, images, stop sequences, usage, finish reasons.
- 📋 **Routing rules** - prefix / exact / catchall model-name matching with deterministic priority resolution.
- 🛡️ **Guard rails** - 10 MB body limit, rejecting request deadlines (default 120 s), upstream abort on client disconnect, optional bearer auth, optional CORS.
- 🪵 **Redacted structured logs** - ring buffer of 2 000 events; never a key, never a full body.

<details>
<summary><strong>The rest of the app</strong></summary>

- 🏗️ **Fully GUI-driven API builder** - compose, inspect and send requests without touching JSON *(Builder lane)*
- 🔑 **Providers & keys** - OS-encrypted key storage via Electron safeStorage; per-provider base URLs and default models *(Providers lane)*
- 🎨 **Material Design 3 expressive UI** - light/dark/system themes from one token sheet; per-element appearance editors *(Appearance lane)*
- 🗂️ **Browser-style tabs** - dock left/right/top/bottom, pinning, named collapsible groups, drag reorder, rename, close guards
- ⌨️ **Command palette** - `Ctrl+Shift+F`, fuzzy search, rich inline controls, teleport-to-element
- 🔍 **Regex builder everywhere** - anchored to every search bar, step-budgeted matching, live capture groups
- 🔔 **Notification center** - non-blocking toasts, searchable history, bulk actions, JSON/Markdown export
- 🕘 **Local history journal** - filterable by date, action type, and text
- 🌍 **Language modes** - English / Traditional Chinese (Hong Kong) / bilingual, plus per-language humor levels 1–5 that style voice without changing facts
- 🔒 **Element locks & unlock ladder**, School mode, super confirmation *(Delight lane)*
- 🔐 **Built-in authenticator** - TOTP entries with QR pairing *(Authenticator lane)*
- 🧰 **Toolbox** - local file converter *(Utility lane)*
- 📖 **Offline docs browser** - bundled articles, internal links, regex-capable search
- 🔄 **Auto-updates** - background checks every six hours, staged installs behind a ready banner, unsigned feed disclosed everywhere

</details>

## 🚀 Quickstart

**Option A - download the installer**

Grab the latest `Setup.exe` from [Releases](https://github.com/Ding-Ding-Projects/material-router/releases).
Installers are built with Squirrel.Windows and ship **unsigned**: Windows will show an
unknown-publisher / SmartScreen warning on first run. That warning is expected for this
project's current no-signing policy - verify what you downloaded against the SHA-256 in
the release notes before proceeding.

**Option B - run from source**

```bat
git clone https://github.com/Ding-Ding-Projects/material-router.git
cd material-router
build.bat
```

`build.bat` installs everything it needs itself (Node runtime included, user-scoped),
then offers to launch the app. Silent variant: `build.bat /s`.

Then point a client at:

```
http://127.0.0.1:8787/v1          # OpenAI-compatible
http://127.0.0.1:8787/v1          # Anthropic-compatible (/v1/messages)
```

## 🔐 Security model

- **Keys stay local.** Provider API keys are encrypted with the operating system's
  credential protection (Electron safeStorage / DPAPI on Windows) inside your profile's
  application-data directory. They are never logged, never exported, never sent anywhere
  except the provider you configured.
- **Loopback only.** The router binds `127.0.0.1` by default. Exposing it beyond your
  machine requires deliberately changing the bind host in settings, and bearer-token
  authentication can be switched on independently.
- **Unsigned installers, stated plainly.** This project permanently does not sign code.
  The SmartScreen warning you will meet at install time is the honest cost of that policy.
- **No network calls of its own.** The app talks only to the providers you configure;
  there is no analytics, no crash reporting, no phone-home.

## 🛠️ Development

```text
npm install        # dev dependencies only: electron, electron-builder (+ squirrel plugin)
npm start          # run the app
npm run dist       # build the Squirrel installer into dist/squirrel-windows/
npm run icons      # regenerate brand assets (deterministic, zero-dep)
npm run docs-index # rebuild docs/articles/index.json for the in-app browser
npm run count      # print the line-count table (-- --markdown for the notes-ready form)
```

| Script | Purpose |
| --- | --- |
| `build.bat` | fresh machine → running app, installing everything itself (`/s`, `--silent` or `SILENT=1` for unattended) |
| `build-installer.bat` | same bootstrap, then verifies the release-shaped unsigned `Setup.exe`, `RELEASES`, `.nupkg` and prints their SHA-256 - never tags, pushes, or publishes |
| `download-dependencies.bat` | pinned toolchain + project deps only, digest-verified against [`scripts/dependency-manifest.json`](scripts/dependency-manifest.json) before anything extracts |

Every phase of every script reports what it found, what it installed, where,
and how long it took. A downloaded toolchain binary whose SHA-256 disagrees
with the manifest is deleted and the script stops - nothing unverified is
ever extracted.

### Releases

Every push to `main` (and every manual dispatch) publishes one uniquely
tagged, non-draft GitHub Release built by
[`.github/workflows/release.yml`](.github/workflows/release.yml): unsigned
Squirrel installer plus `RELEASES`, full and delta `.nupkg`,
`SHA256SUMS.txt`, a dim-sum photo resolved from the public catalog, a
line-count table with agent/human attribution, workflow timing evidence,
and an explicit statement that no test or lint gates ran - standing project
policy. Tags are monotonic and never recycled; a collision fails loudly.
Details: [packaging docs](docs/features/platform/packaging-updates.md).

Verify a published release from any checkout:

```bat
node scripts/verify-release-assets.mjs --tag v0.2.0 --sha <commit-sha>
```

Exits non-zero unless the release exists, is non-draft, carries every
expected asset non-empty with download URLs, and its tag resolves to exactly
that commit.

### Auto-updates

The installed app checks GitHub releases on startup and every six hours,
stages the newer installer in the background, and shows a persistent
non-blocking ready banner - **Restart to install** runs your unsaved-work
guards before quitting into the Squirrel update; **Later** snoozes that
version. The feed is unsigned and every surface offering it says so. One
import wires the surface into the shell:
`import './core/updater-banner.js';` in `app/renderer/src/app.js`.
Details: [auto-update docs](docs/features/platform/auto-update.md).

### Line counts

Source of truth: `npm run count`; refreshed by CI into every release's
notes. Attribution counts surviving lines by git blame - agent lines are
those whose introducing commit carries the `Co-Authored-By: Claude Fable 5`
trailer or whose author is the automation identity:

<!-- COUNTS:START -->
<!-- refreshed by CI on each release; table below captured at this lane's tip -->

| Bucket | Files | Lines | Non-blank | Agent | Human | Uncommitted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tests | 0 | 0 | 0 | 0 | 0 | 0 |
| workflows | 1 | 368 | 332 | 368 | 0 | 0 |
| styles | 10 | 925 | 856 | 925 | 0 | 0 |
| docs | 25 | 1,764 | 1,345 | 1,764 | 0 | 0 |
| site | 0 | 0 | 0 | 0 | 0 | 0 |
| app-source | 45 | 8,527 | 7,692 | 8,527 | 0 | 0 |
| scripts | 8 | 710 | 644 | 710 | 0 | 0 |
| (unmatched) | 0 | 0 | 0 | 0 | 0 | 0 |
| **TOTAL** | 89 | 12,294 | 10,869 | 12,294 | 0 | 0 |

Generated lines within counted files: 0. Excluded entirely: node_modules, dist and build output, binary icon assets, package-lock.json (lockfile), docs/articles/index.json (generated docs index), .vscode/.idea scratch.

**Hand-build time estimate (not a measurement):** roughly **75–110 hours** of focused solo work — about two to three calendar weeks. Method: 10,869 non-blank counted lines at an assumed 100–150 effective lines/hour for hand-written Electron/JS/CSS/Markdown, no difficulty multiplier applied. Disagree with the rate and the estimate moves with it.

<!-- COUNTS:END -->

## 📚 Documentation

- Feature index: [`docs/features/index.md`](docs/features/index.md)
- In-app offline articles: [`docs/articles/`](docs/articles/)
- Architecture handoff for contributors: [`HANDOFF.md`](HANDOFF.md)

## 📄 License

[MIT](LICENSE) © Ding-Ding-Projects contributors
