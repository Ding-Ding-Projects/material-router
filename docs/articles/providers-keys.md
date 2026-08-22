# Providers and keys

Material Router is bring-your-own-key: it never bundles accounts or credits. You
connect the providers you already use, attach their API keys, and tell the router
which models go where.

## Providers

A provider entry records a name, the upstream base URL, a reference to the stored API
key, and the models it serves. You can add as many as you like — different vendors, or
several accounts at the same vendor.

## Keys

API keys are stored in an encrypted vault backed by the operating system (DPAPI on
Windows). Provider records never contain the key itself — only an opaque identifier
that the app resolves at request time. Concretely:

- Keys never appear in plaintext in configuration files, exports, or logs.
- Deleting a provider removes its reference; the vault entry can be cleaned
  separately.
- The app's lock gates access to key-managing surfaces.

See `docs/features/authenticator/` in the repository for the underlying vault
mechanism.

## Routing rules

Routing rules decide which provider handles each request by matching the requested
model name:

| Matcher | Use it for |
| --- | --- |
| Exact | Pinning one specific model name |
| Prefix | Covering a family, such as everything starting with a shared prefix |
| Catch-all | A final fallback so nothing is unmatched |

Rules are checked in priority order and the first match wins, so put specific rules
above broad ones. A request that matches nothing is rejected with an error naming the
model, which usually means you need another rule or a catch-all.

## Current status

The provider, key-reference, and routing-rule machinery is implemented and actively
used by the router. The dedicated management screen is being finished by the Providers
lane; until it lands, configuration is managed through the underlying stores. Track
progress in the repository's `ROADMAP.md`.

## Related

- [Endpoints](endpoints.md) — where requests enter the router.
- [Getting started](getting-started.md) — the overall setup flow.
