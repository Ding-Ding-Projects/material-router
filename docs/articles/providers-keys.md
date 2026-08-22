# Providers and keys

Material Router is bring-your-own-key: it never bundles accounts or credits. You
connect the providers you already use, attach their API keys, and tell the router
which models go where — all from the **Providers & Keys** tab.

## Providers

A provider entry records a name, the upstream base URL, a reference to the stored
API key, and an optional default model. You can add as many as you like — different
vendors, or several accounts at the same vendor. The form suggests a starting name,
prefills the base URL for OpenAI and Anthropic (custom URLs work for any
OpenAI-compatible endpoint, including local runtimes on `http://localhost`), and
lets you test the connection before relying on it.

Each provider card shows whether it is enabled, whether its last connection test
succeeded, and quick actions to edit, re-test, or delete it. Deleting a provider
asks twice, names the stored key it will remove, and cleans up routing rules that
pointed at it.

## Keys

API keys are stored in an encrypted vault backed by the operating system (DPAPI on
Windows). Provider records never contain the key itself — only a vault id such as
`mrkey_prov_x123`. Concretely:

- Keys never appear in plaintext in configuration files, exports, or logs.
- After saving, the form shows only that the key exists and under which id.
- Replacing a key overwrites the same vault id; removing one is confirmed twice and
  applied when you save.
- If the operating system's encryption is unavailable, the app tells you before it
  stores anything with weaker local protection.

## Routing rules

Routing rules decide which provider handles each request by matching the requested
model name:

| Matcher | Use it for |
| --- | --- |
| Exact | Pinning one specific model name |
| Prefix | Covering a family, such as everything starting with `claude-` |
| Catch-all (labelled Fallback) | A final safety net so nothing is unmatched |

The rule list is ordered: top of the list is tried first, and the first match wins,
so keep specific rules above broad ones. Each row has a match type, a pattern field
with suggestion chips (`gpt-4o`, `gpt-4*`, `claude-*`, …), the target provider, an
on/off toggle, and move up/down controls. A request that matches nothing falls back
to the first enabled provider with a default model, or is rejected with an error
naming the model.

## Current status

Shipped: the Providers & Keys tab covers provider cards, add/edit with guided
validation, connection testing with a hard timeout, key management through the
vault, and the ordered routing-rules editor. The project ships no automated tests
by policy, so behaviour is verified with the manual checklist in
`docs/features/providers/providers-keys.md`.

## Related

- [Endpoints](endpoints.md) — where requests enter the router.
- [Getting started](getting-started.md) — the overall setup flow.
