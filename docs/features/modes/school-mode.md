# School mode

One universal, user-renamable suppression switch. While it is on, Material Router
presents English only and hides every playful or distracting surface. The record lives
in one dedicated store (`delight-school.json` inside the application-data folder) that
every surface reads, and changes propagate live to open windows.

## Behaviour

While the mode is on:

- Presentation is forced to English on every surface, at tone level 1 (fully serious).
- Cantonese, bilingual mode, both funny-level sliders, the emoji toggle, the
  personal-vocabulary upload, and the dim sum surprise are **absent** — not disabled
  with a message, absent. No message names what is hidden.
- The mode's name is whatever the user set. Every surface, including accessible names,
  uses only the chosen name; the shipped label appears nowhere once renamed.

Turning the mode **off** requires the unlock credential. Turning it **on** requires
creating that credential first if none exists, so the gate can never be on without a
way back that the user controls.

## Configuration

- Modes & Delights tab → School mode, or Settings → School mode.
- Rename: type a new name (up to 60 characters) and save; recorded in local history.
- Credential: set or change from the same card. Stored as a scrypt hash and salt in
  the OS-encrypted vault — never plaintext, never exported.

## Failure modes

- Wrong credential: honest feedback, and from the third consecutive failure a growing
  wait (30 s doubling, capped at 15 minutes). The unlock ladder may replace the wait
  while its hourly budget lasts — see [unlock-ladder.md](unlock-ladder.md). Winning a
  round clears that wait only; the real credential is still required and the
  escalation schedule is untouched.
- Forgotten credential: the supported recovery is to close the app and delete the
  application-data folder in the OS file manager. The folder's exact path is shown in
  the mode card, in every unlock prompt, and by Support Tickets. The app states
  plainly that this mode is a user-experience choice, not a security boundary.

## Privacy and security

- The credential is a scrypt hash (N=16384) plus random salt inside the encrypted
  vault. No plaintext ever persists, logs, or exports.
- The mode is a self-imposed speed bump. It is not encryption and must never be
  described as protection.

## Verification notes

- Toggling the mode updates every open surface live (English enforcement included).
- Turning it off without the credential fails closed, with and without a credential
  present.
