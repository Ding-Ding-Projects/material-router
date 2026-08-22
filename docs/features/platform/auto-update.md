# Auto-updates

> **Status: shipped.** The updater, its IPC surface, and its renderer banner
> are implemented; the one integration line that imports the banner module is
> recorded at the bottom of this article.

## Behaviour

Material Router checks for updates the Chrome-style way: quietly, in the
background, and never interrupting anything.

- **Check schedule.** A first check runs about eight seconds after launch so
  the window exists to receive its results, then every six hours afterwards.
  You can also run a check yourself any time through the command palette
  (`Ctrl+Shift+F` -> *Check for updates*).
- **Version comparison.** The feed's latest release tag is compared against
  your running version numerically (`v0.10.0` beats `v0.9.5`), not as text.
  Equal or older versions change nothing.
- **Staging.** When a newer version exists, its `Setup.exe` downloads into a
  staging folder inside your application-data directory with progress
  broadcast on the app's `update-status` event channel. The download happens
  in the background; you keep working.
- **Ready banner.** Once staged, a persistent non-blocking banner appears
  carrying the new version number, a link to the release notes, the
  unsigned-feed warning (below), and two buttons:
  - **Restart to install update** - runs your unsaved-work guards first, then
    spawns the staged installer detached and quits the app so Squirrel.Windows
    can apply the update and relaunch it.
  - **Later** - dismisses the banner for that version. It stays dismissed
    until a different version becomes ready.
- **Cancel.** *Cancel update download* in the palette stops an in-flight
  download; partial files are deleted and nothing is staged.

## The feed is unsigned

This project permanently does not sign code, and every surface that offers
an installer says so in the same breath. What protects the staged update is:

- HTTPS transport for the feed query and the installer download;
- the Squirrel `RELEASES` manifest entry for the exact installer file,
  validated before and after download - if the downloaded package's digest
  disagrees with the manifest, everything staged is deleted and the failure
  is reported rather than offered;
- release assets additionally published with `SHA256SUMS.txt` you can check
  by hand.

No signature verification is claimed anywhere, because none exists.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `updates.enabled` | `true` | Master switch for automatic checks. When off, a manual check reports honestly that updates are switched off rather than pretending to run. |
| `updates.checkIntervalMs` | `21600000` | Milliseconds between background checks (six hours). |

## Failure modes

Every failure lands as an honest localized toast naming what actually went
wrong, and leaves your installation untouched:

- **Offline / feed unreachable** - the request deadline rejects, the state
  broadcasts as an error, and the next scheduled check tries again.
- **No published release yet** - reported as "nothing to update to", not as
  a crash.
- **Release without a Setup.exe asset** or a `RELEASES` manifest that does
  not list it - treated as invalid metadata; nothing downloads.
- **Digest mismatch after download** - the partial result is deleted,
  nothing is staged, and the toast says exactly that.
- **Cancelled download** - partials deleted, state returns to idle.
- **Failed install** - Squirrel.Windows applies updates transactionally on
  restart; a failed run leaves the previous version intact and running.

## Security considerations

- Only loopback-free HTTPS endpoints are contacted: the GitHub API and
  release asset hosts. No telemetry, no analytics, no other calls.
- The updater holds no secrets and logs none; error strings are truncated at
  the log boundary.
- Installation requires an explicit user action that passes registered
  unsaved-work guards; there is no silent apply path.

## Verification

- Module-level behaviour exercised headlessly: semver comparison ordering,
  `RELEASES` manifest parsing shape, and renderer-module import with its
  DOM guards.
- End-to-end staging against a real newer release needs the first tagged
  release to exist; until then the updater honestly reports that there is
  nothing to update to. This is the same boundary named in
  [Packaging and releases](packaging-updates.md).

## Integration note

The banner self-initializes when imported, so wiring it into the shell is a
single line in `app/renderer/src/app.js`:

```js
import './core/updater-banner.js';
```

Until that import lands during lane integration, the main-process updater
still checks, stages, and broadcasts; only the visible surface waits.

## See also

- [Packaging and releases](packaging-updates.md) - how releases and their
  artifacts are produced and verified upstream of this feature.
