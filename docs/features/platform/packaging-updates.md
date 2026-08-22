# Packaging and releases

> **Status: shipped** for everything on this page except where a sentence
> names what still needs a real release run to prove it.

## Windows x64 installer

Releases ship a Squirrel.Windows installer targeting 64-bit Windows. The
same artifact comes from three routes that cannot drift apart:

- `npm run dist` - direct electron-builder invocation into
  `dist/squirrel-windows/`.
- `build-installer.bat` - release-shaped local build that verifies what it
  produced before claiming success (see below).
- `.github/workflows/release.yml` - the pipeline every push to `main`, every
  `v*` tag push, and every manual dispatch runs.

## Unsigned installers: please read

Material Router's installers are **not code-signed**. This is deliberate,
permanent project policy, and it has one visible consequence:

- On first run, Microsoft Windows SmartScreen may show *"Windows protected
  your PC"*. Choose **More info**, then **Run anyway**, to continue installing.
- Your browser may warn before downloading an unsigned executable.

Because there is no signature chain, every release attaches
`SHA256SUMS.txt` listing the SHA-256 digest of each artifact. Compare your
download against it before running anything. If a digest does not match,
the file is not the released artifact: delete it and re-download.

## What every release carries

The workflow publishes exactly one new, uniquely tagged, non-draft GitHub
release whose notes contain, in order:

1. **Version heading** and a `Code name:` line resolving a dish from the
   public [`dim-sum-photos`](https://github.com/Ding-Ding-Projects/dim-sum-photos)
   catalog - English name dot Traditional Chinese name - only ever picking a
   dish whose photograph is actually published under that repository's
   `catalog-v1*` release assets (confirmed with a HEAD request before
   selection) and never used by this project before. If no such dish can be
   resolved, the release ships with its version alone and the notes say so.
2. **What's changed**: one line per commit since the previous tag.
3. **Line count**: the markdown table from `npm run count -- --markdown`
   (see `scripts/count-lines.mjs`) including agent/human attribution of
   surviving lines by git blame.
4. **Workflow timing**: runner-reported job start and the publication moment
   as UTC ISO timestamps plus an `HH:mm:ss` duration.
5. **Verification statement**: no local test suites ran for the build, and
   workflows run no test or lint gates by standing project policy.
6. **Unsigned disclosure** and the exact commit SHA.

Assets: `*-Setup.exe`, `RELEASES`, the full `.nupkg`, the delta `.nupkg`
when produced, `SHA256SUMS.txt`, and the dim-sum photo itself.

## Tag uniqueness

Tags are monotonic and never recycled. Before building, the workflow lists
every existing tag *and* release name across the repository, takes the
highest `vX.Y.Z`, bumps the minor level with patch reset (`v1.2.9` ->
`v1.3.0`), then re-checks the candidate against remote git refs. A
collision fails the job loudly instead of overwriting history. With no prior
version at all, the first release uses the app's own `package.json` version.
The build-time copy of `package.json` is synced to the tag so the shipped
artifact's version advances - nothing is committed back.

## Artifact verification gate

Before staging, the workflow asserts each installer artifact exists, is
non-zero bytes, and that `Get-AuthenticodeSignature` reports exactly
`NotSigned`. Signing is permanently out of scope, so a signed output fails
the job rather than shipping.

After publishing (or any time later), anyone can re-verify a release from a
checkout:

```bat
node scripts/verify-release-assets.mjs --tag v0.2.0 --sha <commit-sha>
```

Options: `--repo owner/name` (defaults to this project) and repeatable
`--asset <glob>` (defaults to `*-Setup.exe`, `RELEASES`, `*.full.nupkg`).
The script exits non-zero if the release is missing or still a draft, any
expected asset is absent / empty / lacks an https download URL, or the tag
does not resolve to the given commit SHA.

## One-click local builds

All three scripts accept `/s` (also `--silent`, or a `SILENT=1` environment
variable): no prompt, no pause, non-zero exit on first failure. Every phase
prints what it is doing, what it found already present, what it installed
and where, and how long it took.

| Script | Does |
| --- | --- |
| `download-dependencies.bat` | Installs the pinned Node toolchain and project dependencies into `%LOCALAPPDATA%\material-router-toolchain` and `node_modules`, verifying every downloaded binary against `scripts/dependency-manifest.json` SHA-256 digests before extraction. A mismatch deletes the download and refuses to continue. |
| `build.bat` | Everything above, then brand icons, then offers to launch. Interactive runs pre-elevate up front; silent mode continues unelevated because every install is user-scoped anyway. |
| `build-installer.bat` | Everything above, then packages the Squirrel installer and verifies `Setup.exe`, `RELEASES`, and the full `.nupkg` exist non-zero and report `NotSigned`, printing the Setup.exe SHA-256. Never tags, pushes, or publishes. |

Dependency versions are pinned in two places that agree: Node in
`scripts/dependency-manifest.json` (with the portable zip's SHA-256 taken
from nodejs.org's published SHASUMS256 at authoring time), and every npm
package via `package-lock.json`, which `npm ci` enforces through registry
integrity hashes.

## Security considerations

- Update and release transport is HTTPS throughout.
- No signing certificate exists anywhere in this project's toolchain, by
  policy; the packaging path clears signing inputs and verifies the result
  came out unsigned rather than trusting a default.
- The dependency fetcher installs user-scoped, never machine-wide, and never
  requests elevation; it refuses URLs that are not recorded in the committed
  manifest.

## Verification

Verified during the lane that built this pipeline:

- `actionlint` structural pass over the workflow (shellcheck integration
  disabled; see repository notes on the Windows actionlint hang), YAML parse
  clean, and all eleven embedded PowerShell blocks pass the PowerShell
  language parser.
- `node scripts/count-lines.mjs` and `npm run count -- --markdown` both run
  clean with their internal bucket-versus-blame consistency assertions
  passing.
- `verify-release-assets.mjs` exercised against the live repository for the
  missing-release case: five failures reported, exit code 1.
- Manifest parsing, phase timing, and Node-version gating in the bat helpers
  executed directly.

Still needing the first real release run to prove end to end: the workflow's
own green run producing the artifacts it describes, and an installed update
applying on restart. Those land with the first push that triggers it.

## See also

- [Auto-updates](auto-update.md) - how the installed app checks, stages, and
  applies these releases.
