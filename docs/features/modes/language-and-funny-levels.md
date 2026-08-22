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

**Funny levels.** Two sliders, one for English copy and one for Chinese copy, each
ranging from 1 (fully serious) to 5 (maximum playfulness), shipped at 5. The level
changes the voice of messages, tooltips, and notifications — never the facts. At every
level the copy still states exactly what happened, what is affected, and what to do
next. Defaults are disclosed on first run and in settings.

**School mode.** A suppression mode intended for shared or classroom machines: when
enabled it presents English only and hides playful copy and related novelty surfaces.
The gate hook is present in the application shell; complete enforcement across every
surface is being finished by the Delight lane, and until then the mode should be
treated as partial.

## Configuration

All three controls live in settings and persist across restarts:

- Language mode: English, Chinese (Hong Kong), or bilingual.
- English funny level: 1–5, default 5.
- Chinese funny level: 1–5, default 5.
- School mode toggle (behavior completing as described above).

Preferences are local-only and never leave the machine.

## Failure modes

- A string missing from the Chinese track falls back to English instead of showing
  blank space; bilingual mode shows whichever track has the string.
- Slider values outside the valid range are clamped rather than breaking copy
  selection.
- If School mode enforcement is incomplete on a surface, that surface behaves per its
  current implementation; the gap is tracked for the Delight lane rather than hidden.

## Security considerations

Language and tone preferences carry no sensitive information and are stored locally
with other settings. Copy tone never changes factual content: error messages identify
the real failure and the real remedy at every level.

## Verification

- Switch through all three modes and spot-check navigation, dialogs, and
  notifications.
- Move each slider between 1 and 5 and confirm rendered copy changes tone while facts
  (versions, paths, error causes) stay identical.
- Restart and confirm all three settings persisted.
- With School mode enabled, confirm English presentation on completed surfaces.

## Status

**Partially shipped.** Language modes and both funny-level sliders are wired in the
application shell and styled copy is live. School mode's gate hook exists, with full
suppression behavior **in progress for the Delight lane**; see `ROADMAP.md`.
