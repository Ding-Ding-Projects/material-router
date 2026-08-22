# Contributor & Agent Guidance

A sanitized mirror of this project's working rules. Nothing here is machine-specific;
follow the repository's own architecture first, these rules second, and global agent
policy wherever it is stricter.

## Architecture seams (do not drift)

- Follow the existing seams exactly: IPC domains in `app/main/ipc.js`, store APIs in
  `store.js` / `providers-store.js`, translator function names, tab registry ids, event
  names (`log`, `toast`, `server-status`, `update-status`). Renames break sibling lanes.
- Zero runtime npm dependencies. devDependencies only: `electron`, `electron-builder`,
  `electron-builder-squirrel-windows`. Everything else is hand-written.
- No bundler. Plain ES modules in main + renderer; the preload stays CommonJS
  (`preload.cjs`) because sandboxed preloads cannot be ES modules.

## Code patterns that are required, not preferred

- **Atomic writes** for every persistent state file: unique temp name, rename, bounded
  retry on `EPERM`/`EACCES`/`EBUSY`. Use `JSONStore` / `atomicWriteFile` in `store.js`.
- **Deadlines that reject.** Any request over a socket, pipe, or IPC channel gets a timer
  that aborts and surfaces an error; a promise that can pend forever is a defect.
- **Honest error propagation.** Every async fs op try/catch with real rethrow or a typed
  normalized error. Never swallow with an empty catch and a success return.
- **Redaction at the log boundary.** Never log API keys, tokens, or full request bodies.
  Error strings are truncated to 200 characters at the server's log emitter.

## Interface rules

- All user-facing copy goes through `t()` / `copy()` with real `en` and `zh-HK` keys.
  Machine-literal translations are defects.
- Accessibility baseline: every control has an accessible name, is keyboard reachable,
  shows visible focus, and respects reduced motion.
- CSS uses the tokens in `app/renderer/src/core/tokens.css` exclusively. Raw colors
  outside that file are not allowed (functional data encodings excepted, stated inline).
- Every new search field ships with the anchored regex-capable builder from
  `core/searchbar.js` - plain text default, regex opt-in.
- Destructive actions go through `dialogs.destructiveConfirm` (or its future upgraded
  replacement) with the affected data named in plain words.

## Process rules

- Commit messages: concise factual English subject; body may add a playful Traditional
  Chinese line; every commit ends with the trailer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No test or lint jobs in GitHub Actions workflows, ever - workflows build, package, and
  publish releases only. Local checks run in the task that changes the code.
- Windows-first: guard platform-specific behavior with `process.platform` checks.
- Code signing is permanently out of scope: never request, generate, or restore signing
  material, and keep `forceCodeSigning: false`.
- Documentation updates (`README.md`, `docs/features/**`, `docs/articles/**` +
  `npm run docs-index`, `ROADMAP.md`, `HANDOFF.md`) land in the same task as the change
  they describe. Roadmap items are ticked only when actually finished.
- Never commit secrets, credentials, `node_modules`, or build output. `.gitignore` covers
  the usual suspects; think before `git add -A`.
