# Format translation

Material Router accepts requests in either the OpenAI Chat Completions format or the
Anthropic Messages format and translates in both directions, so an OpenAI-speaking
client can reach an Anthropic-format provider and the reverse. Translation covers
requests, non-streaming responses, and streaming chunks. See
[Local endpoints](local-endpoints.md) for the server itself.

## Behaviour

Translation is automatic and depends only on which endpoint received the request and
which provider the routing rules selected. The mapping between concepts:

| Concept | OpenAI form | Anthropic form |
| --- | --- | --- |
| System prompt | A message with `"role": "system"` | The top-level `system` field |
| Assistant tool call | `tool_calls` on an assistant message | A `tool_use` content block |
| Tool result | A message with `"role": "tool"` | A `tool_result` block inside a user message |
| Image input | An `image_url` part carrying a base64 data URL | An `image` block with a base64 `source` |
| Stop conditions | The `stop` array | The `stop_sequences` array |
| Output cap | `max_tokens`, optional | `max_tokens`, required |

Details worth knowing:

- **System prompts.** OpenAI-style system messages are collected and moved into the
  Anthropic `system` field; an Anthropic `system` value becomes leading system messages
  when targeting an OpenAI provider.
- **Tools.** Tool definitions, assistant tool calls, and tool results convert cleanly
  in both directions, preserving names, arguments, and identifiers.
- **Images.** Base64-encoded images map between OpenAI data-URL parts and Anthropic
  base64 source blocks.
- **Streaming.** Anthropic's event sequence (`message_start`, content block deltas,
  `message_delta`, `message_stop`) converts to OpenAI `chat.completion.chunk` deltas,
  and OpenAI deltas convert to the Anthropic sequence, so streamed output renders
  correctly for either client type.
- **Usage.** Token accounting maps `prompt_tokens`, `completion_tokens`, and
  `total_tokens` onto `input_tokens` and `output_tokens`; totals are recomputed as the
  sum when converting toward the OpenAI shape.

Finish and stop reasons translate as follows:

| OpenAI `finish_reason` | Anthropic `stop_reason` | Notes |
| --- | --- | --- |
| `stop` | `end_turn` | Natural completion |
| `length` | `max_tokens` | Output cap reached |
| `tool_calls` | `tool_use` | Model requested a tool |
| `stop` (mapped from) | `stop_sequence` | OpenAI has no distinct value, so a fired stop sequence reports as `stop` toward OpenAI clients |

**`max_tokens` defaulting.** The Anthropic format requires `max_tokens`; the OpenAI
format treats it as optional. When an incoming request omits it and the destination
needs it, the translator fills in `4096` and writes a note to the redacted log so the
substitution is visible rather than silent.

## Configuration

None. Translation engages automatically per request based on the receiving endpoint and
the selected provider's format. There are no toggles to misconfigure.

## Failure modes

- Structurally invalid payloads are rejected with a descriptive error identifying the
  field that could not be interpreted.
- Content shapes outside the table above (for example unusual part types) produce an
  explicit unsupported-field error instead of being dropped quietly.
- Unrecognized finish or stop reasons are carried through best-effort rather than
  crashing the stream.
- Because `max_tokens` may be defaulted to 4096, very long requested outputs can
  truncate earlier than expected; the log note identifies when this happened.

## Security considerations

- Translation runs entirely in process. Request and response bodies are not persisted;
  only redacted, structural log entries are kept.
- Provider credentials are attached after translation, when the outbound request is
  assembled, and never appear in translated payloads stored in logs.

## Verification

Useful checks, all against the running app:

- Send the same conversation to `/v1/chat/completions` routed to an Anthropic-format
  provider and confirm the reply parses as normal OpenAI output.
- Repeat in reverse through `/v1/messages` toward an OpenAI-format provider.
- Exercise streaming in both directions and compare chunk ordering.
- Send a tool-using conversation and confirm the call-and-result pair survives the
  round trip.
- Omit `max_tokens` on a request destined for an Anthropic-format provider and confirm
  the response still succeeds and a defaulting note appears in the log.

## Status

**Shipped in foundation (v0.1.0)** for both directions, including streaming conversion,
tools, images, stop sequences, finish-reason mapping, usage mapping, and the documented
`max_tokens` default.
