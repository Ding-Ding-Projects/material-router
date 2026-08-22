# Server and logs

The **Server & Logs** tab is the control surface for Material Router's loopback
HTTP listener and the viewer for its redacted request log. The server itself
lives in the main process — this tab starts, stops, configures, and observes it.
See [Local endpoints](local-endpoints.md) for the wire surface being controlled,
and [Format translation](format-translation.md) for how requests are bridged
between the OpenAI and Anthropic shapes.

## Status card

The top card reports the live state of the listener:

| Field | Source |
| --- | --- |
| Running / stopped | actual listener state |
| Port · bind address | values the running listener was started with |
| Uptime | time since the current listen started |
| Requests served | cumulative counter kept by the server process |
| Providers ready / routing rules | counts from the providers store |

**Start** and **Stop** act immediately; while a lifecycle call is in flight
both buttons are disabled so nothing can be double-invoked. Failures (a busy
port, for example) surface as an error notification carrying the real message.

### Configuration controls

Four persisted settings are editable directly on the card:

- **Port** — a stepper (type it, use ±, or arrow keys). Valid range 1024–65535;
  out-of-range input shows an inline explanation and is not persisted.
- **Loopback only** — on, the listener binds `127.0.0.1`; off, it binds
  `0.0.0.0` so other devices on the network can reach it. Turning it off shows
  a warning recommending bearer auth.
- **Require bearer token** — callers must send `Authorization: Bearer <token>`
  on `/v1` routes.
- **Allow CORS** — answers cross-origin preflights and adds CORS headers.

Every change is written through the atomic settings store and recorded in local
history. They do not all take effect at the same speed, and the tab says so:

| Setting | Takes effect |
| --- | --- |
| Port, bind address | on restart only |
| Bearer requirement, CORS | on the next request, no restart needed |

When the port or bind address has been changed while the server is running, a
restart-required banner appears naming exactly which fields changed, with a
one-click **Restart now** action. The banner compares against a snapshot of the
values actually bound at listen time, not the desired ones, so drift cannot
hide. If a restart fails (the new port is taken), the listener stays stopped
and the error says why.

## Local access token

The token card manages the bearer credential used when *Require bearer token*
is on. Tokens are generated in the main process from `crypto.randomBytes`,
stored in the OS-encrypted vault under the id the router already reads, and
**shown once** at generation: copy it, press Done, and no surface can display
it again. Regenerating — gated behind the destructive confirmation, because it
invalidates the old value immediately — hands out a fresh token; clients still
sending the old one receive HTTP 401 until they are updated. If OS-level
encryption is unavailable on the machine, the stored-at-rest warning says so
plainly instead of pretending the vault encrypted it.

Token values never appear in logs, exports, history entries, or any IPC read:
only generation returns one, and only presence is queryable afterwards.

## Live log

The log card streams every structured event the router emits, already redacted
at the source: no API keys, tokens, or request bodies are ever recorded, and
error text arrives truncated to 200 characters.

- **Columns:** time, direction (`in`/`out`), model, provider, status, ms,
  bytes. Error rows carry a subtle error tint and red status numbers.
- **Render window:** the last 300 matching rows render; the buffer behind them
  holds up to 2,000 entries (mirroring the main-process ring). When the ring
  discards older entries, a line above the table says how many were dropped.
- **Pause / resume:** pause freezes the view while events keep buffering;
  resume reports how many arrived (`Resume (12 new)`). Auto-scroll only sticks
  when you are already near the bottom, so reading back is never fought.
- **Row detail:** click, Enter, or Space opens a drawer with every field of the
  entry plus a copy-as-JSON action and the redaction note.
- **Filter row:** a plain-text filter across all fields by default, with the
  anchored regex builder (`.*/abc` toggle) for pattern users — each field owns
  its own state.
- **Level chips:** All, or Errors (entries whose kind or status marks them as
  failures).

Empty states are honest: "No requests routed yet" before any traffic, and a
distinct "no entries match the current filters" once a filter is active.

### Export and clear

The filtered view (search + level chip, not just the rendered window) exports
to JSON, CSV, or Markdown through the standard download path. CSV quoting is
spreadsheet-safe and cells that could parse as formulas are neutralized. Clear
log removes everything after the destructive confirmation names the exact count.

## Health endpoint explainer

The bottom card explains `GET /health` — which always answers without a token —
and renders four copyable `curl` examples built from the currently configured
port: health check, model list, and a minimal completion in each wire format.
While bearer auth is on, the examples grow the matching `Authorization` header
and a note spells that out. Examples target `127.0.0.1` and note the address
the listener actually binds.

## Failure modes

| Condition | Result |
| --- | --- |
| Start while a port is busy | error notification with the OS reason; server stays stopped |
| Restart after changing to a busy port | same, stated plainly ("the listener is stopped") |
| Invalid port typed | inline "enter a port between 1024 and 65535", nothing persisted |
| Regenerate token with live clients | old token rejected 401 until clients update |
| Vault unavailable for encryption | stored token is obfuscated only; the tab says so |
| Log cleared by accident | not recoverable — the confirmation states this before you confirm |

## Security considerations

- Loopback binding is the default and the recommended state; turning it off
  warns and pairs with bearer auth guidance.
- The access token lives in the OS credential store, is reveal-once, and is
  excluded from every export and log path.
- Log entries are redacted upstream of this UI; the viewer adds nothing that
  could re-widen them.
- Clearing the log is destructive and confirmed twice; exports honor active
  filters so a careless "select all" cannot silently widen what leaves the app.

## Verification

With the app running: toggle each setting and watch the restart banner track
exactly the port/host changes; start and stop from both the card and the
command palette; generate a token and confirm it never re-displays; point a
client (or one of the copied curl lines) at the router and watch entries land
live; pause mid-stream and resume to see the new-count; filter with plain text
then a regex; export each format; clear and confirm the empty state. Keyboard
only: every control above is reachable and operable without a pointer, and the
table opens detail drawers with Enter or Space.

## Suggested articles

- [Local endpoints](local-endpoints.md) — the routes this tab controls
- [Format translation](format-translation.md) — what happens between the two wire formats
- [Provider keys and routing rules](../providers/providers-keys.md) — where requests go next
- [Notifications and history](../toolbox/notifications-history.md) — where the tab's records land

## Status

**Shipped in the Server lane (v0.1.0).** Controls, token management, live
redacted log with filtering/pause/export, drift-aware restart notice, and the
health explainer are implemented on the foundation seams. Delight-lane upgrades
(super-confirmation gate replacing the two-step dialog) apply here automatically
once they land.
