# Built-in authenticator

Material Router ships a complete local authenticator: standard one-time-password
entries (TOTP and counter-based HOTP), their rotating codes, QR pairing, and an
encrypted store that never leaves your machine. Open the **Authenticator** tab
to use it — there is no network access anywhere in this feature.

## Entries

Every entry is named by service (issuer) and account, with an optional emoji
icon and group. The list is searchable (plain text by default, regex through
the search bar's anchored builder), reorderable by dragging or with Alt+Arrow,
and supports multi-select with bulk delete and bulk move-to-group.

Armed TOTP entries show the current code in large grouped digits — the code is
itself a copy button. A text countdown always states the seconds remaining, and
a next-code peek can be toggled per row. HOTP entries show their counter with
an explicit advance action; copying never advances it.

## Pairing

A new entry is only saved after you type one current code from your device,
verified against the parameters you entered. A wrong code saves nothing. The
pairing panel renders the `otpauth://` URI as a locally generated QR code — no
third-party renderer, no network request — with the grouped base32 key behind
an explicit reveal beside the exact algorithm, digit count and period.

Defaults follow the ecosystem standard: SHA-1, 6 digits, 30-second period.
Every parameter can be chosen per entry (SHA-256/SHA-512, 6–8 digits, any
period up to one day); secrets shorter than 80 bits are rejected.

## Storage and history

Entry metadata lives in an atomically written JSON file inside the app's data
directory; each secret lives separately in the encrypted vault under a stable
random id, so reordering or restoring entries can never orphan it. If the
operating system's encryption facility is unavailable, the tab says so plainly
in its header before anything weaker is used.

Every mutation is appended to a dedicated journal file that never contains
secrets or codes. The **Mutation history** surface opens it behind its own
password, offering text search, date-range filters, per-action chips, Markdown
export of the filtered set, and restore for metadata edits and order changes.
Deleted entries are honestly not restorable: the secret was deleted with them.

## Exports

Two exports exist and they are different on purpose:

- **Metadata only** carries issuer, account, icon, group, algorithm, digits,
  period, timestamps and ids, and states in the file itself that secrets are
  omitted. This is the ordinary export.
- **Keys included** writes every secret in plain text with ready-to-scan
  `otpauth://` URIs. It sits behind a confirmation naming the risk in plain
  words, and its filename marks it SECRETS.

## Current status

Shipped: entry list with codes and countdowns, QR pairing gate, parameter
choice per entry, encrypted storage, the password-protected mutation journal,
and both exports. The project ships no automated tests by policy; behaviour was
verified against the published RFC 4226 and RFC 6238 test vectors, and the full
manual checklist lives in `docs/features/authenticator/totp-entries.md`.

## Related

- [Providers and keys](providers-keys.md) — the same encrypted vault protects provider API keys.
- [Keyboard shortcuts](keyboard-shortcuts.md) — moving around the shell.
- [Appearance](appearance.md) — themes and light/dark contrast for the QR panel.
