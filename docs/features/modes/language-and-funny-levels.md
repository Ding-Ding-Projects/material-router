# Language modes and funny levels

Material Router presents its interface in three language modes and styles its copy
through two independent tone controls. Together they decide what language you read and
how playful the wording around the facts is.

## Behaviour

**Language modes.**

| Mode | Presentation |
| --- | --- |
| English | Everything in English |
| Chinese (Hong Kong) | Everything in colloquial Hong Kong Traditional Chinese (`zh-HK`) |
| Bilingual | Both, side by side, with the primary label prominent |

Both language tracks ship with the app; nothing is fetched at runtime. When a string
is missing from one track it falls back to English rather than rendering blank.
Changes apply live to every open surface: the shell chrome (title bar, tab strip,
built-in palette items) and each tab panel re-render through their own settings
change hooks, and every tab module also refreshes the command-palette titles it
registered. Nothing needs a restart.

**What a live language change preserves, per tab.** Each rebuild goes through the
tab's existing render functions; scroll positions are kept where cheap, and
uncommitted draft text is never silently destroyed:

- **API Builder** — composer state lives in the persisted draft, so nothing is
  lost; the last response body, the preset search query, and mid-typed
  stop-sequence text are carried into the rebuilt panel.
- **Providers & Keys** — provider data is re-fetched through the same reload
  path; the search query is re-adopted.
- **Server & Logs** — log buffer, level filter, pause state and search query all
  survive (the server lane's own pass).
- **Docs** — the reader re-opens the article you were on and keeps the search
  query (article bodies are English source documents).
- **Modes & Delights** — the active sub-section re-renders; an uncommitted
  Support-Ticket description/category and attention-mode pin text are restored.
- **Appearance** — controls re-adopt their persisted values; there is no
  free-text draft on this surface.
- **Toolbox** — the active sub-tab, chat composer and system-prompt drafts, and
  converter catalog query survive; harness profile fields commit on input.
- **Authenticator** — row selection, collapsed groups, peek flag and search
  query survive; entries are re-fetched.

**Honest limitation:** modal sub-surfaces that are already open when the mode
changes (add/edit/reveal dialogs, history manager) keep their current copy until
reopened; rebuilding one mid-interaction would risk its input focus for no copy
benefit.

**Funny levels.** Two sliders, one for English copy and one for Chinese copy, each
ranging from 1 (fully serious) to 5 (maximum playfulness), shipped at 5. The level
changes the voice of messages, tooltips, and notifications — never the facts. At every
level the copy still states exactly what happened, what is affected, and what to do
next. Defaults are disclosed on first run and in settings, together with the explicit
notice that the tone levels style **every** category of message, including errors,
warnings, and security notices.

**Emojis in dialogs and messages.** A persisted toggle adds one decorative emoji to
toasts, dialogs, and notifications when enabled. It is never added to buttons, field
labels, or accessible names of controls, and it is suppressed entirely while School
mode is on.

## Configuration

All three controls live in the Settings tab ("Language & tone" section) and in the
Modes & Delights tab, persist across restarts, and are recorded in local history:

- Language mode: English, Chinese (Hong Kong), or bilingual (`general.languageMode`).
- English funny level: 1–5, default 5 (`general.funnyLevelEn`).
- Chinese funny level: 1–5, default 5 (`general.funnyLevelZh`).
- Show emojis in dialogs and messages (`general.emojiInDialogs`, off by default).

While School mode is on this whole section is absent — not disabled, absent — and the
app presents English at tone level 1 until the mode is turned off again. See
[school-mode.md](school-mode.md).

## Failure modes

- A missing translation renders the English string, never a blank or a raw key in the
  user's chosen track.
- Tone flourishes are deterministic per string, so copy does not flicker between
  renders.

## Verification notes

- Switching each control updates rendered copy immediately — including every open
  tab panel's body, not only the shell chrome — and survives restart.
- Toggling School mode on re-presents every open panel in English through the same
  live pass.
- The disclosure copy names errors/warnings coverage before the user opts into higher
  levels.
