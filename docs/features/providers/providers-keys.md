# Provider keys and routing rules

Material Router is bring-your-own-key: you configure the upstream AI providers you
already have accounts with, attach each provider's API key, and write routing rules
that decide which provider handles a given request. This article covers the
configuration model, where keys live, and how routing decisions are made.

## Behaviour

A **provider** records a display name, a base URL, a reference to a stored API key, and
the model identifiers it serves. **Routing rules** match the model name requested by
the client:

| Matcher | Meaning |
| --- | --- |
| Exact | Matches one specific model name |
| Prefix | Matches any model name starting with the given text |
| Catch-all | Matches anything, typically used as the final fallback |

Rules are evaluated in priority order and the first match wins, so specific rules
belong above broad ones. A request whose model matches no rule is rejected with an
explanatory error; defining a catch-all rule is the usual way to guarantee every
request finds a home.

**Key storage.** API keys are stored once in the encrypted vault (Electron
`safeStorage`, backed by DPAPI on Windows) and provider records hold only an opaque
`keyRef` identifier. At request time the main process resolves the reference, attaches
the credential to the outbound call, and discards it. Plaintext keys never appear in
provider records, configuration files, exports, or logs.

## Configuration

Provider and rule records are created, updated, and deleted through the main process
configuration stores, which persist locally. The full graphical management tab —
browsing providers, editing keys through the vault, and reordering rules — is being
built by the Providers lane. Until it lands, configuration changes go through the
underlying stores rather than a dedicated settings screen.

## Failure modes

- **Dangling key reference.** A provider whose `keyRef` no longer resolves fails its
  requests with an explicit credential error rather than silently omitting the header.
- **No matching rule.** The request is rejected with a message naming the unmatched
  model so the fix is obvious.
- **Overlapping rules.** Only the highest-priority match fires; if two rules both
  match, the lower one is inert, which the eventual rule editor will visualize.
- **Wrong base URL.** Upstream failures surface as gateway errors after the request
  deadline, consistent with [Local endpoints](../routing/local-endpoints.md).

## Security considerations

- Keys are encrypted at the operating-system level and referenced indirectly, so a
  leaked configuration export contains identifiers, never secrets.
- Log entries record that a credential was attached, not the credential itself.
- Removing a provider removes its reference; orphaned vault entries can be removed
  without exposing their contents.

## Verification

- Store a key, then inspect the persisted provider record and confirm it contains a
  `keyRef` identifier and no readable key material.
- Export the configuration and confirm the export carries references only.
- Define an exact rule, a prefix rule, and a catch-all, then send requests whose model
  names distinguish them and confirm the priority order decides correctly.
- Delete a rule and confirm requests that depended on it now report the
  unmatched-model error.

## Status

**Partially shipped.** Provider records, key storage via vault references, and
priority-ordered routing rules are implemented in the main process and in active use by
the routing pipeline. The dedicated management GUI is **in progress for the Providers
lane**; see `ROADMAP.md` for the current breakdown.
