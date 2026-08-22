# Local endpoints

Material Router exposes a small HTTP surface on the local machine. AI clients that
speak the OpenAI or Anthropic wire formats point at this surface, and the router
forwards each request to a configured upstream provider according to its routing
rules. See [Format translation](format-translation.md) for how the two formats are
bridged and [Provider keys and routing rules](../providers/providers-keys.md) for how
destinations are chosen.

## Behaviour

The server listens on the loopback interface (`127.0.0.1`) by default on port `8787`.
Four routes are served:

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/chat/completions` | POST | OpenAI Chat Completions wire format |
| `/v1/messages` | POST | Anthropic Messages wire format |
| `/v1/models` | GET | Model identifiers available through configured providers |
| `/health` | GET | Liveness and basic status for tooling and monitors |

Requests are matched against routing rules by model name, in priority order, and the
first matching rule decides which provider receives the call. Both completion routes
support streaming responses; chunks are translated between formats as they pass
through.

Guard rails that apply to every request:

- **Body limit:** request bodies larger than 10 MB are rejected with HTTP 413.
- **Upstream deadline:** each upstream request gets a default 120-second deadline.
  When the deadline expires the upstream connection is aborted and the client receives
  an error response instead of hanging.
- **Client disconnect:** if the caller closes the connection early, the in-flight
  upstream request is aborted rather than left running to completion.
- **Structured logs:** requests are recorded in a redacted, structured log ring buffer
  capped at 2000 entries. Bodies and credentials are never written verbatim.

## Configuration

Server settings live in the app's settings store and take effect when the listener
restarts:

- **Host** — the bind address. It stays on loopback unless changed deliberately.
- **Port** — defaults to `8787`; any free port can be used.
- **CORS** — a toggle. When disabled, browser-originated cross-site requests are
  refused; enable it only for local web tools that need to call the router directly.
- **Bearer token authentication** — a toggle. When enabled, callers must send
  `Authorization: Bearer <token>`; requests with a missing or mismatched header are
  rejected with HTTP 401.

The 10 MB body limit and the 120-second deadline are fixed values in the foundation
release; making them configurable is tracked as future work.

## Failure modes

| Condition | Result |
| --- | --- |
| Port already in use | Listener fails to start and the app raises a notification; pick another port |
| Malformed JSON body | Rejected with HTTP 400 and a descriptive message |
| Body over 10 MB | Rejected with HTTP 413 |
| Missing or wrong bearer token | Rejected with HTTP 401 when the toggle is on |
| No routing rule matches the model | Rejected with an explanatory error naming the unmatched model |
| Upstream unreachable or slow | Request aborts at the 120-second deadline and the client receives an error |
| Client hangs up mid-stream | Upstream request is aborted promptly |

Errors returned to clients are structured and redacted: they describe what went wrong
without echoing provider credentials or raw upstream payloads.

## Security considerations

- The server binds to loopback only by default. Changing the host to a shared
  interface exposes the proxy to your network; if you do that, enable bearer token
  authentication.
- Enable bearer token auth whenever other people or untrusted processes share the
  machine, since any local process could otherwise reach the proxy.
- Credentials are resolved from the encrypted vault at request time and are never
  placed in URLs, headers sent to clients, or log entries.
- Log entries are redacted before storage and the ring buffer discards the oldest
  entries past 2000, so the log cannot grow without bound.

## Verification

With the app running, the quickest checks are:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

Then send a minimal completion against whichever format your client uses, first with
streaming disabled and then with `"stream": true`, and confirm chunks arrive
incrementally. Finally, open the log viewer and confirm entries appear redacted, and
send an oversized or malformed body to confirm the guard rails answer with 413 or 400.

## Status

**Shipped in foundation (v0.1.0).** The loopback server, both wire formats, model
listing, health reporting, the guard rails above, and redacted logging are all
implemented. Future adjustments — configurable limits, richer health detail — are
tracked in `ROADMAP.md`.
