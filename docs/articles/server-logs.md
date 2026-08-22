# Server and logs

The Server & Logs tab controls the loopback router and shows its redacted
request log.

## Controls

Start and stop the listener, set the port (1024–65535), toggle loopback-only
binding, bearer-token enforcement, and CORS. Port and bind address apply on
restart — when they change while running, a banner names the changed fields
and offers Restart now. The bearer requirement and CORS take effect on the next
request without a restart.

## Access token

Generate a strong token from the tab; it is stored in the OS-encrypted vault
and shown exactly once. Regenerating (confirm twice) invalidates the old value
immediately, so update any client that still sends it. Tokens never appear in
logs or exports.

## Live log

Requests stream in as structured rows: time, direction, model, provider,
status, duration, bytes. Filter with plain text or the built-in regex builder,
narrow to errors with the level chip, pause the view while events keep
buffering, and click a row for full details. Entries are redacted before they
are ever recorded — no keys, tokens, or request bodies. The last 2,000 entries
are kept; exports of the filtered view come as JSON, CSV, or Markdown, and
clearing the log is confirmed twice because it cannot be undone.

## Health check

`GET /health` answers without a token and reports service, version, and
uptime. The tab builds copyable curl examples for it plus both completion
formats from your current port, adding the Authorization header automatically
while bearer auth is on.
