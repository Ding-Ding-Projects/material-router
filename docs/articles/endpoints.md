# Endpoints

Material Router listens on the loopback interface at `http://127.0.0.1:8787` by
default. Four routes are available.

## Routes

| Route | Method | Wire format |
| --- | --- | --- |
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/models` | GET | Plain JSON list of available model identifiers |
| `/health` | GET | Small JSON status document for liveness checks |

Point any OpenAI- or Anthropic-speaking client at the matching route; the router
translates between formats as needed and forwards to the provider your routing rules
select.

## Quick checks

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

A minimal OpenAI-format request:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}'
```

The same conversation in Anthropic format hits `/v1/messages` with that format's
fields (`model`, `messages`, `max_tokens`). Add `"stream": true` to either request to
receive a streamed response.

## Guard rails

- **Body size:** request bodies are limited to 10 MB; larger ones get HTTP 413.
- **Timeout:** upstream calls have a 120-second deadline; expiry aborts the upstream
  request and returns an error to you.
- **Disconnect:** closing your connection early aborts the upstream call.
- **Authentication:** optionally, enable bearer token auth in settings and send
  `Authorization: Bearer <token>`; mismatches get HTTP 401.
- **CORS:** off unless you enable it for browser-based tools.

## Errors you might see

| Situation | Likely cause |
| --- | --- |
| 400 with a field name | Malformed or unsupported payload structure |
| No-route error naming your model | The model name matched no routing rule |
| 401 | Bearer token auth is on and the header is missing or wrong |
| 413 | Body exceeded 10 MB |
| Gateway error after a pause | Upstream unreachable or the 120-second deadline expired |

## More detail

The full feature documentation covers configuration (host, port, CORS, authentication),
translation behavior, logging, and security notes: see `docs/features/routing/` in the
repository, or browse those pages offline inside the app's docs browser.
