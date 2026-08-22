# Attention modes (ADHD modes)

Five independent, persisted interface accommodations for scattered days. They are
settings, not health advice: no diagnosis, no assessment, no claims of clinical
benefit, and no gamification. Every mode is OFF by default, and they are named by what
they do.

| Mode | What it does |
| --- | --- |
| Focus | Dims everything except the panel being worked in; one always-visible button restores it. |
| Low stimulation | Suppresses non-essential motion and animation, in union with the system reduced-motion setting. |
| Time awareness | Shows session elapsed time and time since anything last changed near the tab strip. |
| One thing at a time | A user-chosen next-action pin, persisted, visible after any context switch. |
| Gentle momentum nudge | After a quiet stretch you choose, one dismissible note states plainly how long nothing has changed. |

## Tone rules

Copy is plain and factual ("Nothing has changed here for 40 minutes"), never scolding,
never a productivity score, never streaks or rankings. Facts stay exact at every funny
level.

## Configuration

Settings → Attention modes, or Modes & Delights → Attention modes:

- Each mode has its own switch (`adhd.focus`, `adhd.lowStimulation`,
  `adhd.timeAwareness`, `adhd.oneThing`, `adhd.momentum`).
- Momentum's quiet threshold is configurable (`adhd.idleMinutes`, default 20).
- Snoozing the nudge is respected for exactly as long as it says; dismissing removes
  it until the next quiet stretch.
- All changes are recorded in local history.

## Failure modes

- The strip and chips remove themselves when their settings turn off.
- Reduced motion and Low stimulation compose: either alone suppresses non-essential
  animation.
