# Packaging and updates

> **Status: skeleton.** This article records the packaging and distribution targets
> for Material Router. The implementation is being finalized by the Plumbing lane;
> treat the specifics below as the committed plan rather than shipped behavior until
> this notice is removed.

## Behaviour (target)

- **Windows x64 installer.** Releases ship a Squirrel.Windows-based installer
  targeting 64-bit Windows, produced by the repository's build scripts.
- **Auto-updates.** The app checks an HTTPS-hosted update feed and stages new versions
  for installation on restart, following the Squirrel.Windows update model.

## Unsigned installers: please read

Material Router's installers are **not code-signed**. This is a deliberate project
decision, and it has one visible consequence you should expect:

- On first run, Microsoft Windows SmartScreen may show *"Windows protected your PC"*.
  Choose **More info**, then **Run anyway**, to continue installing.
- Your browser may warn before downloading an unsigned executable. Keep the file and
  verify it rather than trusting the warning either way.

Because there is no signature, verify downloads independently before running them —
for example by comparing a SHA-256 digest, when the release publishes one, against
your downloaded file. If a digest is published and does not match, the file is not the
released artifact: delete it and re-download.

## Configuration

Nothing to configure yet. Once the updater ships, it will expose a manual *Check for
updates* action, show update availability and readiness without interrupting your
work, and install staged updates only when you choose to restart.

## Failure modes (planned handling)

- **Feed unreachable.** Update checks fail quietly and non-blockingly; the app keeps
  working and retries later.
- **Corrupt or tampered download.** Digest validation rejects the package and nothing
  is staged.
- **Failed install.** Squirrel.Windows rolls back, leaving the previous version
  intact.

## Security considerations

- Update transport is HTTPS, so the feed and its artifacts travel encrypted.
- There is no signature chain to rely on, so independent verification of downloads is
  the user's safeguard and is disclosed here rather than implied away.
- No signing certificate exists in this project's toolchain, by policy.

## Verification

To be completed with the shipping release pipeline:

- Installer installs, launches, and uninstalls cleanly on Windows x64.
- Any published digests match the attached artifacts byte for byte.
- The update feed serves valid metadata and a staged update installs on restart.

## Status

**Skeleton.** Windows x64 Squirrel.Windows packaging is the committed target, unsigned
distribution with independent download verification is the committed policy, and the
CI release workflow that produces and publishes these artifacts is being finalized by
the **Plumbing lane**. This article will be rewritten as shipped behavior once that
lands.
