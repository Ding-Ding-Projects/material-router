# Toy locks (element locks)

A playful, self-imposed speed bump on any element whose context menu offers
"Lock this element…". Shipped today for tab buttons; the same wizard serves any
element that dispatches the `mr:tab-lock-element` event.

## Behaviour

- **Lock this element…** opens an anchored, non-modal wizard beside the target. It
  names the exact target and returns focus to it on close.
- Each lock carries its own credential: a password or a standard TOTP secret
  (base32 or an `otpauth://` URI). Pairing is confirmed with one current code before
  the lock arms.
- Unlock duration is chosen at creation: this surface only (relocks when you leave the
  tab), a set number of minutes, or until the app closes.
- Locked elements show a lock affordance and an accessible "(locked)" name. Activating
  one opens an anchored unlock prompt instead of the element's normal action.
- Wrong attempts get honest feedback and are rate-limited in the main process from the
  third consecutive failure onward. The Forgotten-password link routes to Support
  Tickets.

## The disclosure, everywhere it matters

This is a toy lock: a self-imposed speed bump. It is not encryption, not a security
boundary, and not fit to guard anything that matters. Recovery is self-service:
delete the application-data folder (the exact path is shown in the wizard and every
prompt) and every lock resets.

## Storage

- Lock metadata: `delight-locks.json` in the application-data folder.
- Credentials: scrypt hash + salt, or the TOTP secret, inside the OS-encrypted vault.
  TOTP secrets share the authenticator lane's `lock:<elementId>` id convention — one
  secret per element, no implicit reuse between locks.

## Verification notes

- A locked tab cannot be activated by mouse or keyboard until unlocked.
- Removing a lock goes through the two-key + slider destructive gate and deletes that
  lock's credential with it.
- Locks are enumerable and searchable in Modes & Delights → Toy locks.
