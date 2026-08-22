# Provider keys and routing rules

Material Router is bring-your-own-key: you configure the upstream AI providers you
already have accounts with, attach each provider's API key, and write routing rules
that decide which provider handles a given request. This article covers the
management surface, the configuration model, where keys live, and how routing
decisions are made.

## Behaviour

A **provider** records a display name, a type (`openai`, `anthropic`, or
`openai-compatible`), a base URL, a reference to a stored API key, an enabled flag,
and an optional default model. **Routing rules** match the model name requested by
the client:

| Matcher | Meaning |
| --- | --- |
| Exact | Matches one specific model name |
| Prefix | Matches any model name starting with the given text |
| Catch-all | Matches anything; labelled **Fallback** in the editor |

Rules are evaluated top to bottom — the displayed order is the priority order, and
the first match wins — so specific rules belong above broad ones. Equal priorities
break ties by specificity (exact beats prefix beats catch-all), then by position.
A request whose model matches no rule falls back to the first enabled provider that
has a default model; if none qualifies, the request is rejected with an explanatory
error.

**Key storage.** API keys are stored once in the encrypted vault (Electron
`safeStorage`, backed by DPAPI on Windows) under a stable per-provider vault id, and
provider records hold only that opaque id. At request time the main process resolves
the reference, attaches the credential to the outbound call, and discards it.
Plaintext keys never appear in provider records, configuration files, exports, logs,
or on screen after entry.

## Management tab

The Providers & Keys tab is the graphical management surface:

- **Provider cards** show the type badge, an enabled switch wired to the same store,
  a connection-status dot carrying the last test result beside plain words (never
  colour alone), and Edit / Test / Delete actions. Deleting a provider names it and
  its stored key reference in a two-step destructive confirmation, states that its
  routing rules are removed too, and deletes the referenced vault entry.
- **Add / Edit form** suggests a display name per type, offers a segmented type
  picker, prefills the base URL per type (`https://api.openai.com/v1`,
  `https://api.anthropic.com/v1`, or custom for OpenAI-compatible endpoints, each
  with a restore-default control), takes the API key through a masked field stored
  via the vault (presence shown afterwards as an id only, never the value), and
  fills the default-model picker from the last successful connection test while
  keeping free-text entry available.
- **Test action** sends a minimal models-list request through the `providers:test`
  bridge with a rejecting deadline (15 s default, clamped 1–30 s). The result is
  announced as a non-blocking toast, kept as the card's status dot, and cached so
  the local `/v1/models` listing reflects it.
- **Routing-rules editor** lists rules in priority order. Each row has a match-type
  picker, a pattern field with suggestion chips of common model prefixes
  (`gpt-4o`, `claude-*`, …), a target-provider picker populated from real providers,
  an enable toggle, move up/down, and delete behind destructive confirmation.
  Catch-all rows disable the pattern field, explain why, and carry the Fallback
  badge. Pattern/target edits apply explicitly per row; structural changes (add,
  reorder, enable, delete) persist immediately and rewrite priorities so the list
  order always equals resolution order.

Inline validation speaks in plain words ("Base URL must start with https://
(http:// is allowed only for localhost)"), disabled controls name their unmet
condition ("Add a provider first"), and every string exists in English and Hong
Kong-style Traditional Chinese.

## Failure modes

- **Dangling key reference.** A provider whose key reference no longer resolves
  fails its requests with an explicit credential error rather than silently omitting
  the header. Removing a key from the form is applied only on save and can be undone
  until then.
- **No matching rule.** The request is rejected with a message naming the unmatched
  model so the fix is obvious; the deterministic-resolution note above the rule list
  documents the fallback behaviour.
- **Overlapping rules.** Only the highest-priority match fires; lower duplicates are
  inert, and the ordered editor makes that visible.
- **Wrong base URL.** Connection tests surface upstream failures as typed results
  (status plus redacted reason) without storing them anywhere beyond the local UI;
  routed requests fail after their deadline, consistent with
  [Local endpoints](../routing/local-endpoints.md).
- **Encryption unavailable.** When OS-level encryption is unavailable for a session,
  the vault falls back to weak local obfuscation and the form discloses that in a
  toast at save time.

## Security considerations

- Keys are encrypted at the operating-system level and referenced indirectly, so a
  leaked configuration export contains identifiers, never secrets.
- The test bridge accepts a freshly typed key only inside one IPC call frame; it is
  never logged, echoed back, or persisted, and upstream error text is redacted and
  truncated before it reaches the UI.
- Deleting a provider deletes its vault entry; if that deletion fails, a persistent
  warning names the orphaned vault id instead of staying silent.
- Status dots and timestamps live in renderer-local storage and contain no secret
  material.

## Verification

Manual checks against the running app:

- Store a key through the form, then inspect the persisted provider record and
  confirm it contains only the vault id reference and no readable key material.
- Run Test on a card and confirm the toast, the status dot wording, and the
  default-model suggestions all update; repeat against an unreachable URL and
  confirm an honest failure result rather than a hang.
- Define an exact rule, a prefix rule, and a catch-all, send requests whose model
  names distinguish them, and confirm the displayed order decides correctly; move a
  rule and confirm requests follow the new order.
- Delete a rule and confirm requests that depended on it now report the
  unmatched-model error (or fall back exactly as documented).

## Status

**Shipped.** Provider records, key storage via vault references, priority-ordered
routing rules, and the Providers & Keys management tab (cards, add/edit form,
connection testing, rules editor) are implemented. No automated tests exist for this
surface by project policy (CI runs none); verification is the manual checklist
above. See `ROADMAP.md` for the current breakdown.
