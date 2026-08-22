# API builder

The API builder lets you compose, save, and send AI requests entirely inside
Material Router — no separate terminal client, no hand-edited JSON files, and no
typing configuration: every setting is a picker, slider or toggle.

## The idea

- **Compose visually.** Pick the provider and model from live lists, set temperature,
  `top_p`, output limit and stop sequences with real controls, and add messages in
  reorderable rows. Free text is only for what you are actually saying.
- **Pick the endpoint.** Choose the OpenAI format (`/v1/chat/completions`) or the
  Anthropic format (`/v1/messages`), so one conversation can be exercised against
  either wire format.
- **Preview before sending.** A live panel shows the exact JSON body, switchable
  between "as OpenAI" and "as Anthropic". The Anthropic view comes from the same
  translator the router runs in production, and its notes (merged messages, defaulted
  `max_tokens`, dropped parameters) appear right under the preview.
- **Send through the router.** The send button posts via the main process using the
  identical pipeline external clients hit — routing rules, translation, vault-backed
  credentials, deadlines. What works here works from curl.
- **Watch it stream.** With streaming on, output renders progressively, with token
  usage and timing alongside; cancel any in-flight request with one click.
- **Save and reuse.** Store the composition under a name, reload it later, export it
  as JSON, or hand it to VS Code (falling back to your default editor when VS Code is
  not installed).
- **Copy a client snippet.** Generate ready-to-run cURL, JavaScript `fetch()`, Python
  `requests`, Anthropic SDK or OpenAI SDK code pointed at your local router.

## Why it matters

Sending through the router means what you test is what your tools will run. A request
that works in the builder works from any client pointed at the same endpoint, and a
failure surfaces the same redacted diagnostics you would see anywhere else. Because
every snippet references environment variables instead of keys, nothing you copy ever
carries a credential — those stay encrypted in the vault.

## Try it

1. Add a provider and key in [Providers and keys](providers-keys.md).
2. Open **API Builder**, pick the endpoint, provider and model.
3. Write a first user message, watch the preview update, press **Send test request**.
4. Save the composition as a preset when it behaves.

## Related

- [Endpoints](endpoints.md) — the local server surface snippets target.
- [Providers and keys](providers-keys.md) — where requests go and how keys attach.
- [Getting started](getting-started.md) — the overall setup flow.
