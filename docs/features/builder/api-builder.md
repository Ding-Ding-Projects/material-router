# API builder

The API builder is the in-app, fully graphical way to compose, save, and send requests
through Material Router without touching `curl` or another external client. Every
configuration value is picked from a real control — endpoint, provider, model,
sampling parameters, tool definitions — so a complete request can be assembled
without typing anything. Free-text entry exists only where prose genuinely belongs:
message content and the optional system prompt.

## Behaviour

- **Endpoint picker.** A segmented control chooses the wire format: OpenAI
  `chat.completions` or Anthropic `messages`. The choice decides which local path the
  test request posts to and how the preview renders.
- **Provider and model pickers.** Both are populated live over IPC. The provider list
  comes from `providers:list` (enabled providers only); the model list is the cached
  `providers:get-models` result for the chosen provider, with a refresh button that
  calls `providers:refresh-models`. When no provider is configured yet the card shows
  an honest empty state with a shortcut into Providers & Keys; when a refresh returns
  nothing, the card says so instead of leaving a silent dropdown.
- **Parameter controls.** Temperature slider (0–2, step 0.05), `top_p` slider (0–1),
  max-output-tokens stepper clamped to 1–200000, a stop-sequence chip editor with
  one-tap suggestions (up to 8; Anthropic keeps only the first 4, as its format
  requires), and a stream toggle.
- **System prompt presets.** None / Concise / Coder / Translator fill the editable
  textarea. A provenance line under the field states whether the current text came
  from a preset or was written by hand, and when no system prompt will be sent.
- **Tool use.** Toggling tool use exposes a mini-form with no free typing at all: the
  tool name is a suggestion select, the description auto-fills per name and stays
  editable, and the JSON schema is picked from named templates with a live preview.
- **Messages composer.** Each row has a role picker (`user`/`assistant`; `system`
  appears for the OpenAI endpoint, where the wire format allows it in the message
  list — on the Anthropic side system rows fold into the `system` field, which the
  composer states inline). Rows reorder up/down, duplicate, and delete through the
  destructive-confirmation dialog; an add button appends rows.
- **Live request preview.** The exact JSON body updates as controls change. The
  format switch renders it *as OpenAI* (the canonical composition) or *as Anthropic*
  through `builder:translate-preview`, which runs `translator.openaiToAnthropicRequest`
  in the main process — the same pure function the router itself uses — and lists its
  translation notes verbatim. One click copies the displayed body.
- **Send test request.** Dispatch goes through `builder:test-send`, which mirrors the
  server's pipeline exactly: route resolution via `providersStore.resolveRoute`,
  wire-format translation when the provider speaks the other format, credentials
  attached from the encrypted vault inside the main process, the configured rejecting
  deadline, and response translation back into the chosen inbound format. Progress,
  translation notes, errors, cancellation and streamed deltas arrive as
  `builder-stream` events keyed by request id.
- **Response viewer.** HTTP status, round-trip time and routed wire format; a token
  usage table (prompt / completion / total, shown as "—" when the upstream did not
  report); pretty/raw toggle; streamed responses render progressively in a live region
  with the raw SSE transcript available under Raw. A cancel button aborts an in-flight
  request; Clear empties the panel.
- **Presets.** The current composition saves under a name (a suggested default makes
  Enter alone work); saving over an existing name asks first. Presets load, delete
  behind destructive confirmation, export as JSON honoring the active filter, and open
  in VS Code — falling back to the platform default app, with the fallback stated in
  the toast either way. A filter search over presets ships the shared regex-capable
  search bar (plain text default, anchored builder per field).
- **Client snippets.** cURL, JavaScript `fetch()`, Python `requests`, the Anthropic
  SDK and the OpenAI SDK, each targeting the local router URL. Snippets reference
  environment variables only — real keys never leave the vault, so no generated code
  contains one.

## Configuration

- Compositions autosave to the renderer draft store (`mr.builder.draft`) and are
  restored on next launch, announced by a toast.
- Presets persist in `userData/builder-presets.json` through the atomic `JSONStore`
  (unique temp name + rename + bounded retry), capped at 100 entries of ≤200 KB each.
- Editor handoff writes under `userData/builder-exports/` through `atomicWriteFile`.

## Failure modes

- Sending is blocked while validation fails; the reasons are listed beside the send
  button ("pick a model", "pick a provider", "at least one message needs content").
- No matching route surfaces the same message an external client would receive.
- Upstream failures arrive as structured events (status, type, truncated redacted
  message) and render in the response panel plus an error toast; deadlines reject as
  timeouts; cancelling reports the abort honestly.
- Streamed transcripts cap at ~400 KB and say so when truncated.

## Security considerations

- Provider keys are read from the vault only inside the main process and attached to
  the upstream call there; nothing sent to the renderer contains secret material.
- Snippets embed no credentials — bearer tokens appear as environment-variable
  references, and the SDK samples note that upstream keys stay in the vault.
- Saved request bodies can hold conversation content you consider sensitive, so treat
  the preset store like any local document store.

## Verification

Verified during this lane's task: all six renderer modules pass Node syntax checks;
the pure modules were exercised end-to-end (bundle key parity across en/zh-HK,
canonical-body assembly including system-preset folding, junk-input normalization and
clamping, snippet generation against both wire paths with auth on/off, usage
extraction for both formats); the bridge passes syntax checks and registers only
within the allowlisted `builder` domain. Interactive send/stream verification against
a live provider remains a manual step for the integrator, since lanes run no captures;
the pipeline the send path drives is the shipped router described in
[Local endpoints](../routing/local-endpoints.md) and
[Format translation](../routing/format-translation.md).

## Status

**Shipped for the Builder lane.** The composer, preview, send path, response viewer,
presets and snippets are usable in the application. Live-provider interaction checks
and any built-artifact capture evidence are owned by the integration pass tracked in
`ROADMAP.md`.
