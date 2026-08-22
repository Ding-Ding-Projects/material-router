# Local Ollama suite manager

The Toolbox tab's Ollama half manages a local Ollama installation end to end:
service diagnosis, installed models, the official model library, batch
downloads, local chat with saved conversations, and a harness launcher for
running other local programs against a chosen model.

The manager talks **only** to Ollama's documented local HTTP API on
`http://127.0.0.1:11434` (loopback enforced in the bridge: any non-loopback or
non-http endpoint is refused). The official catalog at `registry.ollama.ai` is
fetched only when you press **Refresh catalog now**. All requests are made by
the main process with rejecting deadlines and bounded payload sizes — the
sandboxed renderer never opens a socket.

## Service status and diagnosis

The status card distinguishes the states that need different actions:

- **Reachable** — shows the reported version.
- **Nothing is listening** — connection refused; the suggested action is to
  install or start Ollama, then refresh.
- **Unhealthy** — the port answered too slowly within its deadline; deadlines
  always reject rather than hang, so the panel always comes back.
- **Catalog stale / never fetched** — the Model Store shows the age of the
  last verified copy and offers refresh.
- **Low disk** — free space beside the models folder is measured and surfaced.

A bundled offline troubleshooting document (rendered in-panel) carries these
states plus recovery steps, and is available with no network at all.

## Installed models

Lists every locally installed tag with size, family, parameter size,
quantization level and running state (`/api/ps`). Search supports plain text
and regex through the shared anchored builder; running-only filter and name/size
sorting compose with it. Per-model actions:

- **Details** — capabilities as reported by `/api/show`, plus a modelfile
  excerpt.
- **Chat** — opens a conversation bound to that model.
- **Delete** — goes through the destructive confirmation naming the exact
  model and its size before calling `/api/delete`.

## Model Store

The store keeps the last verified copy of the official library
(`registry.ollama.ai/library`). Offline you can browse, search and read the
stored copy; only refreshing needs network. Each library entry expands on
demand into its published variant tags with their download sizes.

### Hardware fit verdicts

Every variant gets one of four verdicts computed from measured numbers only —
never inferred from the model's name:

| Verdict | Rule |
| --- | --- |
| Runs well | download size ≤ 50 % of total RAM and fits on disk |
| Runs with limits | ≤ 85 % of total RAM and fits on disk |
| Unlikely | bigger than 85 % of RAM or than free disk |
| Unknown | a measurement was missing |

Each verdict carries an expandable evidence list: probe timestamp, total and
free RAM, disk free where the models folder lives, already-installed bytes for
that family, and the variant's own download size. Verdicts are recomputed from
live probes whenever they are displayed.

## Cart and downloads

Adding a variant schedules a **local pull only** — there is no payment or
entitlement anywhere in this flow. Before starting, the cart shows the count,
total download size, the disk reservation (about 1.2× the download) and states
plainly that the transfer happens over your network now.

Downloads run with bounded parallelism of 2, per-item byte progress when
Ollama reports it, and cancel/retry. Outcomes are kept per item — done,
failed, cancelled — and a failed item never turns the batch green nor touches
already-finished models.

## Local chat

- Multiple named conversations with rename, delete (destructive confirm) and
  redacted JSON export; sessions persist across restarts.
- Editable system prompt, documented generation parameters (`num_predict`
  default 2048, temperature, top_p, top_k, repeat_penalty, num_ctx) with range
  validation.
- Streamed answers with **Stop**, plus **Regenerate** from the last user turn.
- Image attachments appear only when the selected model reports vision
  capability; otherwise the control stays visible but disabled with that exact
  reason.

## Harness launcher

Launches another local program against a chosen model:

- two prebuilt example profiles ship by default;
- new profiles are registered through a real executable file picker, and every
  field passes a strict schema: absolute executable path (or built-in
  `ollama`), argument tokens limited to flags/literals/`{model}`, absolute
  optional working directory, environment variable *names* only (values come
  from the environment and are never shown or stored);
- launching first shows a **preflight review** — the exact executable,
  resolved arguments, working directory, redacted environment keys, chosen
  model and any blockers;
- the profile store is snapshotted before registration, deletion and launch;
  if the launched process exits within the health window the snapshot is
  rolled back automatically and the failure is reported honestly;
- snapshots can also be restored manually from the panel.

## Privacy

Everything except the explicit catalog refresh is loopback-local. Chat
conversations stay in the app's local store; exports carry what you typed and
state that no secrets exist in them. No telemetry, no analytics, no third-party
calls.
