# API builder

The API builder will let you compose, save, and send AI requests entirely inside
Material Router — no separate terminal client, no hand-edited JSON files.

> **In progress.** The builder is being built by the Builder lane and is not yet
> usable in the app. This page describes the intended workflow so you know what is
> coming; the routing pipeline beneath it is fully shipped today.

## The idea

- **Compose visually.** Fill in the model, messages, system prompt, sampling settings,
  and tool definitions in structured fields instead of writing JSON by hand.
- **Pick the endpoint.** Choose the OpenAI format (`/v1/chat/completions`) or the
  Anthropic format (`/v1/messages`), so one conversation can be exercised against
  either wire format.
- **Save and reuse.** Store a composed request under a name, reload or duplicate it
  later, and delete the ones you no longer need.
- **Send through the router.** The send button posts to the local server, so format
  translation, routing rules, credential handling, timeouts, and logging behave
  exactly as they do for external clients such as curl.
- **Tweak and resend.** Reload a saved request, change one field, and send again
  without rebuilding the rest of it.

## Why it matters

Sending through the router means what you test is what your tools will run. A request
that works in the builder works from any client pointed at the same endpoint, and a
failure surfaces the same redacted diagnostics you would see anywhere else.

## Today's alternative

Until the builder ships, exercise the router directly with any HTTP client — see
[Endpoints](endpoints.md) for the routes, guard rails, and copy-paste examples.

## Related

- [Endpoints](endpoints.md) — the local server surface.
- [Providers and keys](providers-keys.md) — where requests go and how keys attach.
- [Getting started](getting-started.md) — the overall setup flow.
