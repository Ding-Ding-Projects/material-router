# Support Tickets

The application's own fictional service desk, played completely straight. Reachable
from the Forgotten-password link in every unlock prompt, from Help, and from the
command palette.

## The honesty line

Rendered unmissably at the top of the desk, in plain wording the tone levels do not
restyle:

> Nothing here is sent anywhere. No ticket exists outside this machine, no network
> request is made, no data is collected, and nobody is reading it. The desk cannot
> delete anything for you either.

## Behaviour

- Ticket form: category (including "Locked out of a lock"), description, a generated
  local number (`MR-TS-000001` and up), and a severity nobody honours.
- A canned first response arrives on the ticket immediately — the desk has read the
  manual once.
- Status advances locally: open → first response → being looked at → resolved. All of
  it is theatre; only one resolution exists.
- **Resolution:** shows the exact application-data folder path with a copy button and
  an Open-folder action that asks the OS file manager to open it. The user deletes the
  folder themselves; the app never deletes anything through this surface.

## Storage and export

Tickets live in `delight-tickets.json` inside the application-data folder, are
searchable (plain text by default, anchored regex builder available), and exportable
to JSON honouring the current filter. Deleting one ticket goes through the two-key +
slider destructive gate.

## Failure modes

- If the OS refuses to open the folder, the exact error is surfaced as a non-blocking
  notification; the path remains copyable.
- The desk makes no network calls under any circumstance; there is nothing to fail
  offline except the file-manager handoff above.
