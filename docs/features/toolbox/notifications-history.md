# Notifications and history

Material Router keeps you informed without interrupting you. Transient events appear
as non-blocking toasts, durable notices collect in a searchable notification center,
and a local history journal records what the app did so you can look back after the
fact.

## Behaviour

**Toasts.** Informational and success messages appear as non-blocking toasts anchored
in the bottom-right corner of the window. They stack without overlapping and
auto-dismiss on a sensible timeout. Errors and warnings persist until dismissed so
they cannot scroll away unnoticed. Toasts never steal focus and never block the
interface.

**Notification center.** A reviewable center lists recent notifications so dismissed
items stay findable. It provides:

- Search across notification titles and bodies, supporting both plain text and regular
  expressions.
- Bulk dismissal, so clearing many notices takes one action.
- Export of the current view to a portable file.

**History journal.** Notable application events — requests served, configuration
changes, errors — are recorded in a local journal. The journal offers filtering by
date and by action type, so "what changed yesterday" or "which requests failed" are
each one filter away. Entries are structured and redacted.

## Configuration

Neither feature requires setup. Notification and history data are stored locally with
the rest of the app's data; export writes whatever the current view holds, honoring
any active search or filters.

## Failure modes

- Many rapid notifications stack rather than overlapping or dropping silently.
- Dismissed errors remain recoverable in the center, so an accidental dismissal loses
  nothing permanent.
- A failed export reports the failure rather than writing a truncated file quietly.
- Journal filters compose: combining a date range with an action filter narrows
  results rather than letting one override the other.

## Security considerations

- Notifications and history entries are redacted: provider keys, bearer tokens, and
  raw request bodies never appear in either surface.
- Exports carry the same redaction as the on-screen views.
- All data stays on the machine; neither feature makes network requests.

## Verification

- Trigger a success (serve a request) and confirm a toast appears bottom-right and
  auto-dismisses.
- Trigger a failure (request an unmatched model) and confirm the toast persists until
  dismissed.
- Open the center, search with a plain term and with a regular expression,
  bulk-dismiss a selection, and export the remaining view.
- Filter the journal by date and by action and confirm results narrow as expected.

## Status

**Shipped in foundation (v0.1.0)** for toasts, the notification center, and the
history journal, including search with regex support, bulk actions, export, and
journal filters. The broader toolbox — file conversion among other utilities — is
planned separately for the **Utility lane** and is not covered by this article yet.
