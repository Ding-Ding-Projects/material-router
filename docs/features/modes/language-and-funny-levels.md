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
Changes apply live to open surfaces through the settings change hooks; nothing needs a
restart.

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

- Switching each control updates rendered copy immediately and survives restart.
- The disclosure copy names errors/warnings coverage before the user opts into higher
  levels.
