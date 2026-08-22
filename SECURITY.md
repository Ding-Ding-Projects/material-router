# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes (active development line) |

Older releases receive no patches; please update to the newest release.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/Ding-Ding-Projects/material-router/security/advisories/new)
or contact the maintainers through the repository's listed contact channel. Please include
a description, reproduction steps, and affected versions. Do not open a public issue for
an unpatched vulnerability.

We aim to acknowledge reports within 7 days and will publish advisories alongside fixes.

## Scope notes for this project

- The local router binds loopback by default; reports involving the default
  configuration are highest priority.
- API keys are protected with OS-level credential encryption (Electron safeStorage /
  DPAPI on Windows). Anything that leaks key material from `vault.dat`, logs, or IPC is
  in scope.
- Installers are intentionally unsigned (project policy). SmartScreen warnings alone are
  not vulnerabilities, but anything that lets an attacker substitute a different binary
  for the published artifact would be.
- Auto-update integrity (feed metadata + package hashes over HTTPS) is in scope once the
  updater ships; unsigned-transport claims must match reality.
