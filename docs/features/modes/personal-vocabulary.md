# Personal vocabulary

A local, private word-replacement list the user supplies as a JSON file. The control
is always visible in Settings and in the Modes & Delights tab — before any file
exists — and every surface renders its original shipped wording until a valid file is
loaded.

## Behaviour

- **Choose vocabulary file…** opens the native file picker. Replacing an existing file
  is one action; clearing is another.
- States are explicit: no-file, loaded (with count), invalid (with reason), replaced,
  cleared. A rejected file never partially applies.
- Clearing purges the cache immediately; original wording returns everywhere at once.

## Accepted contract (generic, bounded)

```json
{ "schemaVersion": 1, "entries": { "exact text": "replacement" } }
```

| Bound | Value |
| --- | --- |
| File size | 256 KB |
| Entries | 5 000 |
| Nesting depth | 4 levels |
| Entry shape | string → string only |
| Unsafe keys (`__proto__`, `constructor`, `prototype`) | rejected |

Validation happens wholesale in the main process before anything is stored; the reason
for any rejection is shown to the user and recorded locally.

## Privacy

Everything stays on this computer. No network request is made by this feature; the
source file name is deliberately not persisted, and contents are never logged,
exported, or synced. Exports of other data do not include the vocabulary cache.

## Honest scope note

Replacements apply at this lane's own surfaces today via its text-transform helper.
Global application to every surface lands when the shared translation hook accepts a
transform; until then the UI states that remaining surfaces keep their shipped
wording. No silent partial behaviour is presented as full coverage.

## Failure modes

- Malformed JSON, wrong schema version, oversized files, or non-string entries: whole
  file refused with the specific reason; previous cache (if any) stays active only if
  the user has not explicitly cleared it.
- Cache corruption on disk: the store keeps defaults and preserves the corrupt file
  beside itself for inspection rather than half-loading it.
