# Vault and authenticator

Material Router keeps secrets in a local encrypted vault and protects the app with a
lock derived through memory-hard hashing. A built-in time-based one-time-password
(TOTP) authenticator shares this foundation.

## Behaviour

**Encrypted vault.** The main process owns a vault for sensitive values such as
provider API keys. Encryption uses Electron's `safeStorage`, which on Windows is
backed by the operating system's DPAPI, so ciphertext is bound to the current user
profile. Stored values are addressed by opaque identifiers (`keyRef`s); consumers such
as provider records hold references, never contents. See
[Provider keys and routing rules](../providers/providers-keys.md) for the consumer
side.

**App lock.** The application lock derives a verifier from your lock secret using
scrypt, a memory-hard key derivation function, so the stored verifier is not
reversible into the secret. Unlocking the app gates access to the vault-backed
surfaces.

**TOTP authenticator (planned surface).** The authenticator screen will let you
register standard RFC 6238 time-based one-time-password entries and read their
rotating codes inside the app, with codes computed locally and secrets held in the
same protected storage as everything else.

## Configuration

- Setting or changing the app lock happens in settings; the verifier is stored, never
  the secret itself.
- Vault entries are created implicitly when a feature stores a secret (for example,
  when a provider key is saved) and removed when their owner deletes them.
- The authenticator's registration and entry management arrives with its screen.

## Failure modes

- If the operating-system encryption facility is unavailable, writing a secret fails
  with an explicit error rather than storing anything unprotected; the feature that
  triggered the write reports the failure.
- A forgotten lock secret cannot be recovered from the stored verifier by design.
- A dangling `keyRef` (owner deleted, vault entry kept) fails closed with a credential
  error at use time and can be cleaned from the vault.

## Security considerations

- Secrets are encrypted at rest with an OS-bound mechanism and never written to plain
  configuration files, exports, logs, or history entries.
- scrypt's memory hardness makes brute-forcing a stolen verifier expensive.
- Redaction applies everywhere: log ring buffers, notifications, and journal entries
  record that a credential was used, not the credential.
- Treat profile-level protection as the boundary: DPAPI ties decryption to your
  Windows user account, so protect that account accordingly.

## Verification

- Save a provider key and confirm the provider record holds a `keyRef` while the
  vault holds ciphertext, and that requests succeed end to end.
- Set an app lock, restart, and confirm the lock gates the expected surfaces.
- Inspect logs and exports after exercising the above and confirm no secret material
  appears.
- Authenticator checks (registration, rotation windows, standard test vectors) will be
  documented with the finished surface.

## Status

**Partially shipped.** The encrypted vault and scrypt-based lock hashing are
implemented in the main process and in active use. The TOTP authenticator screen is
**in progress for the Authenticator lane**; see `ROADMAP.md`.

**TOTP authenticator (shipped).** The authenticator screen is now a complete
local implementation: RFC 6238 TOTP and RFC 4226 HOTP entries with SHA-1,
SHA-256 and SHA-512, 6 to 8 digits, arbitrary periods, QR pairing with a
typed-code confirmation gate before anything is armed, live codes with a text
countdown and next-code peek, bulk management, redacted and explicit-gated
full exports, and a password-protected append-only mutation journal. See
[TOTP entries and pairing](totp-entries.md) for the full behaviour.
