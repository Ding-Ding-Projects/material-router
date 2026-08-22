# API builder

The API builder is the in-app, fully graphical way to compose, save, and send requests
through Material Router without touching `curl` or another external client. It lets
you build a request visually, pick which local endpoint it targets, keep named
requests for reuse, and dispatch them through the same routing pipeline external
clients use.

## Behaviour (intended)

When complete, the builder will provide:

- **Visual request composer.** Edit the model, system prompt, message list, sampling
  settings, and tool definitions in structured form fields instead of hand-written
  JSON.
- **Endpoint picker.** Choose between the OpenAI-format endpoint
  (`/v1/chat/completions`) and the Anthropic-format endpoint (`/v1/messages`) so the
  same conversation can be exercised against either wire format.
- **Named requests.** Save a composed request under a name, reload it later, duplicate
  and modify it, and delete ones you no longer need.
- **Send through the router.** Dispatching a request sends it to the local server, so
  format translation, routing rules, credential resolution, deadlines, and redacted
  logging behave exactly as they do for external clients.

Responses render inline with timing and token usage, and streamed replies render
progressively as chunks arrive.

## Configuration

Saved requests are stored locally alongside the rest of the app's data. No network
access is involved until you press send, at which point traffic flows only to
`127.0.0.1:<port>` and onward to the provider your routing rules select.

## Failure modes

- Composing an incomplete request (missing model, empty message list) is caught by
  validation before anything is sent.
- Sending a payload whose format does not match the chosen endpoint surfaces the same
  structured errors described in [Format translation](../routing/format-translation.md).
- A request that exceeds the server's guard rails (body size, deadline) fails exactly
  as it would from an external client.

## Security considerations

- Saved requests reference providers by name; API keys are never copied into a saved
  request. Credentials are attached at send time from the encrypted vault.
- Saved request bodies can contain conversation content you consider sensitive, so
  treat the saved-request store as you would any local document store.

## Verification

Verification steps will accompany the finished surface: composing and sending a
request through each endpoint, saving and reloading a named request, confirming
streamed output renders progressively, and confirming a failed route produces the same
redacted error an external client would see. These checks are pending until the
surface lands.

## Status

**In progress for the Builder lane.** The builder is designed and scoped but not yet
usable in the application; the routing pipeline it will drive is fully shipped, as
described in [Local endpoints](../routing/local-endpoints.md). Progress is tracked in
`ROADMAP.md`.
