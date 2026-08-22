# TOTP entries and pairing

The Authenticator tab is a complete local authenticator: it stores standard
RFC 6238 time-based (and RFC 4226 counter-based HOTP) one-time-password
entries, shows their rotating codes, and confirms every new entry by asking
for one current code before the entry is trusted. Everything runs inside the
app; there is no network access anywhere in this feature.

## Behaviour

**Entry list.** Entries are named by service (issuer) and account, with an
optional emoji icon and an optional group name. The list is searchable through
the tab's search bar (plain text by default, regex via its anchored builder),
reorderable by dragging or with Alt+Arrow keys, and supports multi-select with
select-all-shown, invert, clear, bulk delete, and bulk move-to-group.

**Codes.** Armed TOTP entries show the current code in large grouped digits.
The code itself is a copy button. A text countdown ("12 s left") always states
the seconds remaining - never colour or motion alone - and a next-code peek
can be toggled per row or from the row menu. Screen readers get one
announcement per refresh wave when codes rotate, not per-second chatter.
HOTP entries show their counter instead of a countdown and offer an explicit
"Advance counter" action; copying never advances it automatically.

**Pairing gate.** A new entry is only saved after you type one current code
from your device, verified against the submitted parameters (with the standard
±1 step window for TOTP). A wrong code saves nothing. Bulk imports create
entries in an unconfirmed state; each one is armed individually through the
same typed-code check. Changing an entry's algorithm, digit count or period
drops it back to unconfirmed for the same reason.

**Registration QR.** The pairing panel renders the entry's `otpauth://` URI as
a locally generated QR code - no network request, no third-party renderer. The
QR keeps true dark-on-light contrast in both themes so scanners accept it, and
the grouped base32 key sits behind an explicit reveal action next to the exact
algorithm, digit count and period.

## Storage

Entry metadata lives in `authenticator.json` inside the app's data directory,
written atomically. Each entry's secret lives separately in the encrypted
vault under a stable random id, so restoring or reordering entries can never
orphan a secret. If the operating system's encryption facility is unavailable,
the vault falls back to obfuscation and the tab says so plainly in its header.

## Mutation journal

Every add, edit, rename, parameter change, removal, import, reorder, grouping
and restore is appended to a dedicated append-only journal file. The journal
never contains secrets or codes - only metadata and change summaries. Retention
keeps at most 2000 records or 400 days, whichever trims first, and a Prune
action runs the same policy on demand.

The journal is readable through the **Mutation history** surface, which is
protected by its own password (scrypt-hashed, independent from everything
else unless deliberately reused). It offers text search (plain or regex),
date-range filters, per-action chips with counts, a change-detail view, export
of the filtered set to Markdown stating plainly that keys and codes are never
recorded, and restore for metadata edits and order changes. Deleted entries are
honestly not restorable: their secret was deleted with them, and the journal
cannot bring it back.

## Exports

Two exports exist and they are different on purpose:

- **Metadata only** carries issuer, account, icon, group, algorithm, digits,
  period, timestamps and ids. It states in the file itself that secrets are
  omitted. This is the ordinary export.
- **Keys included** writes every secret in plain text together with ready-to-
  scan `otpauth://` URIs. It is gated behind a destructive-action confirmation
  that names the risk in plain words, and its filename marks it SECRETS.

Both are JSON with a kind marker and an export timestamp.

## Configuration

No settings are required; the feature works immediately. Relevant facts:

- Default parameters follow the ecosystem standard: SHA-1, 6 digits, 30-second
  period. Every parameter can be chosen explicitly per entry (SHA-256/SHA-512,
  6-8 digits, any period up to one day).
- Secrets shorter than 80 bits are rejected; 128 bits or more is the
  recommendation echoed in the form.

## Failure modes

- A wrong pairing code blocks the save and says so; nothing partial persists.
- A missing vault record (secret deleted outside the app) surfaces as "the
  secret for this entry is missing" rather than a blank code.
- If the journal write fails after a successful mutation, the mutation stands
  and a persistent error notice reports the journal failure verbatim.
- QR payloads beyond version 20 capacity cannot be encoded; the UI shows the
  encoder's error instead of a degraded image.

## Security considerations

- Codes and secrets are never logged. Error strings are truncated at the log
  boundary like everywhere else in the app.
- The history password is stored as a scrypt verifier (salt + hash), never in
  reversible form, and repeated failed unlocks add a small bounded delay.
- The QR's fixed black/white colours are a scanner-contrast requirement, the
  single documented exception to the token-only colour rule.

## Verification

Verified against the published RFC 4226 HOTP test vectors (all ten counters)
and the full RFC 6238 Appendix B tables for SHA-1, SHA-256 and SHA-512 at all
six documented time steps, plus ±1-step window behaviour, base32 round-trips,
otpauth parsing rules and end-to-end handler flows over real atomic store
files. The QR encoder was verified by decoding its own matrices back: format
information checked against the BCH generator, both copies agreeing, codewords
recovered along the placement path, Reed-Solomon syndromes evaluated with an
independent GF(256) implementation (all zero), and the byte-mode payload
reconstructed to match the input exactly across versions including the 16-bit
count field. No test files ship with the repository, per project policy.
