# Feature index

This index organizes Material Router's feature documentation by category. Every linked
article carries a status note so readers can tell what is usable today:

- **Shipped in foundation** — the feature is implemented and available in version
  0.1.0.
- **Partially shipped** — the core is available in version 0.1.0 and a named work lane
  is finishing the remainder.
- **In progress for \<lane\>** — the feature is designed and owned by a named work
  lane but is not yet usable end to end.

Reader-facing quick starts live under [docs/articles](../articles/) and are also
browsable offline inside the application.

## Routing

Everything involved in accepting a request on the local server and delivering it to
the right upstream provider.

- [Local endpoints](routing/local-endpoints.md) — Shipped in foundation.
- [Format translation](routing/format-translation.md) — Shipped in foundation.

## Builder

Tools for composing and sending requests without leaving the app.

- [API builder](builder/api-builder.md) — In progress for the Builder lane.

## Providers

Configuring upstream accounts, their credentials, and the rules that select them.

- [Provider keys and routing rules](providers/providers-keys.md) — Partially shipped:
  configuration stores and routing rules work; the full management tab is in progress
  for the Providers lane.

## Appearance

Material Design 3 theming, per-element customization, and window chrome.

- [Theme and appearance](appearance/theme-and-appearance.md) — Partially shipped: the
  M3 token set and light/dark/system themes are in; per-element editors are in
  progress for the Appearance lane.

## Modes

Presentation languages and copy tone.

- [Language modes and funny levels](modes/language-and-funny-levels.md) — Partially
  shipped: language modes and per-language funny levels are wired in the shell; full
  surface coverage is in progress for the Delight lane.

## Toolbox

Everyday utilities bundled beside the router.

- [Notifications and history](toolbox/notifications-history.md) — Shipped in
  foundation. File conversion is planned separately for the Utility lane and is not
  covered by this article yet.

## Authenticator

Local secrets and one-time codes.

- [Vault and authenticator](authenticator/vault-and-authenticator.md) — Partially
  shipped: the encrypted vault and lock hashing are in the main process; the
  authenticator screen now ships on top of them.
- [TOTP entries and pairing](authenticator/totp-entries.md) — Shipped: local
  RFC 6238/RFC 4226 entries with QR pairing, typed-code confirmation, live
  codes, bulk management, redacted/full exports and a protected mutation
  journal.

## Docs

Documentation that ships with the application.

- [Offline docs browser](docs/offline-docs.md) — Shipped in foundation.

## Platform

Packaging, distribution, and updates.

- [Packaging and updates](platform/packaging-updates.md) — Skeleton: Windows x64
  Squirrel.Windows targets are recorded and the CI release workflow is being finalized
  by the Plumbing lane.
