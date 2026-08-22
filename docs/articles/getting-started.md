# Getting started

Material Router is an open-source desktop app for Windows that acts as a local,
bring-your-own-key AI router: point your existing AI tools at it, configure the
providers you already have accounts with, and let it forward and translate traffic on
`127.0.0.1`.

This page gets you from install to a working setup.

## 1. Install

Download the latest Windows x64 installer from the project's releases page and run it.

> The installer is unsigned, so Windows SmartScreen may show *"Windows protected your
> PC"*. Choose **More info**, then **Run anyway**, to continue. Verify the download
> before running it — for example by comparing a SHA-256 digest against the one
> published with the release, when one is provided.

## 2. Look around

The app opens into a tabbed, Material Design 3 interface:

- A browser-style tab strip (dockable to the left, top, right, or bottom) holds your
  open surfaces.
- Press `Ctrl+Shift+F` anywhere to open the command palette and jump straight to any
  feature, setting, or article.
- The built-in docs browser mirrors everything in `docs/articles/`, offline.

## 3. Understand the endpoints

The router serves four routes on the loopback interface, port 8787 by default:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible completions |
| `POST /v1/messages` | Anthropic-compatible messages |
| `GET /v1/models` | Available model identifiers |
| `GET /health` | Liveness check |

Any client that speaks either wire format can point at `http://127.0.0.1:8787` and
work without changes. Details: [Endpoints](endpoints.md).

## 4. Configure a provider

Add the provider you want requests to reach, attach its API key, and write a routing
rule that sends model names to it. Keys are stored OS-encrypted and referenced by
identifier — never in plaintext. The management interface is being polished; the model
is described in [Providers and keys](providers-keys.md).

## 5. Read further, offline

Everything here — and more — ships inside the app's docs browser, so help works with
no internet connection. Useful next stops:

- [Endpoints](endpoints.md) — request shapes, guard rails, and examples.
- [API builder](api-builder.md) — composing requests in-app.
- [Keyboard shortcuts](keyboard-shortcuts.md) — moving fast without the mouse.

## Where to go with problems

If a request fails, the notification center keeps the error and the history journal
records what happened; both are searchable. Start with [Endpoints](endpoints.md) for
the guard rails (body size, timeouts, authentication), then check your routing rules.
