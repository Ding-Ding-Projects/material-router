# The unlock ladder

After three failed credential attempts, instead of making a person watch a countdown,
the app offers a small game. Falling down the ladder leaves the person exactly where
they started, so it can only ever improve a locked-out wait.

## Rungs

1. **Dim sum** — one dish, four choices (photos from the local cache of the public
   dim-sum catalog; offline the rung is skipped honestly and the ladder starts at the
   sums).
2. **Ten easy sums** — single- and double-digit addition; every one must be right.
3. **Whack-a-mole** — after a wrong sum: hit enough moles inside a timed round.
4. **The clock** — after a lost round or an exhausted budget: serve the wait.

Under School mode rung 1 is absent entirely — the ladder starts at the sums, because a
message naming the hidden dim-sum rung would break School mode's own rule.

## Safety properties (all enforced in the main process)

- **Winning clears the WAITING, never the credential.** No session is minted; the
  person returns to the normal sign-in state and must still give the real credential.
- **It never refunds attempts.** Serving the clock and clearing the ladder return
  exactly the same thing: the end of the current wait. The consecutive-failure
  escalation (30 s doubling from the third failure, capped at 15 minutes) is untouched.
- **It is budgeted:** at most three ladder skips per rolling hour, persisted. After
  that, only the clock runs for everyone.
- **Single-use nonce:** challenges are generated and graded main-side against a nonce
  consumed on first answer; challenges expire after 90 seconds.
- **A timed game cannot be won faster than it lasts:** mole-round submissions that
  arrive before the round's duration has actually elapsed are rejected, and each mole
  can be graded once, only while genuinely visible in its cell.

## Verification notes

- Wrong dish five times → sums; wrong sums → moles; lost moles → clock.
- Budget exhaustion switches every offer to the clock for the rest of the hour.
- Answers of the wrong kind, expired challenges, and replayed nonces all fail closed.
