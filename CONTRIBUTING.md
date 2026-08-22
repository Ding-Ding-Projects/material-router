# Contributing

Thanks for looking at Material Router.

## Getting started

```bat
git clone https://github.com/Ding-Ding-Projects/material-router.git
cd material-router
build.bat        :: or: npm install && npm start
```

`build.bat` installs the toolchain itself (user-scoped, no admin required) and offers to
launch the app. Silent mode for scripts/CI: `build.bat /s`.

## Ground rules

- **Zero runtime dependencies.** If a change needs a new runtime package, the change is
  wrong for this repository. devDependencies need a strong justification.
- **Keep the seams.** See `AGENTS.md` and `HANDOFF.md` for the architecture contract:
  IPC domain allowlist, atomic writes, rejecting deadlines, token-only CSS, `t()` for all
  copy with English + Traditional Chinese (Hong Kong) keys.
- **Small commits, honest messages.** Bilingual commit messages are welcome (English
  subject, optional playful Cantonese body). Every commit carries
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Docs travel with code.** A behavior change updates its feature article, the offline
  docs (`npm run docs-index`), and the roadmap tick in the same change.
- **No signing, no CI gates.** The project does not sign code and its workflows run no
  test/lint jobs; run checks locally in the change that touches the code.

## Pull requests

1. Branch from `main`; keep one logical change per PR.
2. Describe what changed and how you verified it (commands + results, honestly stated).
3. Update `ROADMAP.md` ticks and `HANDOFF.md` if the seam map moved.
4. Regenerate brand assets only via `npm run icons` (never by hand).
