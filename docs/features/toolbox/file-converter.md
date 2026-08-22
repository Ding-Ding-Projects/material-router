# File converter

The Toolbox tab carries a local file converter. Everything runs on this
machine: detection, inspection, conversion and output validation. There are no
network calls, no bundled third-party binaries, and no runtime npm
dependencies — every adapter is implemented against Node built-ins or the
app's own canvas engine.

## How a conversion flows

1. **Pick a source.** Choose file, or drop one onto the drop zone. Dropped
   files are staged into the app's private temp folder first (the sandboxed
   renderer has no file paths), bounded at 64 MB; larger files use
   **Choose file**.
2. **Byte-signature detection.** The first (and for containers, the last) kilo
   bytes are inspected for magic numbers — RIFF families, PNG/JPEG/GIF/BMP
   headers, `%PDF-`, ZIP/7z/gzip, EBML, ISO-BMFF brands and text heuristics.
   The detection card states the format, its confidence and the exact reasons.
3. **Adapter catalog.** Every adapter is listed by category, searchable with
   the anchored regex-capable builder. Adapters the detected format cannot
   feed stay visible and marked; adapters with no bundled engine stay visible
   and **disabled with their exact missing-dependency reason** — capability
   gaps are never hidden.
4. **Disclosure before execution.** The selected adapter states what it does,
   what it changes (lossiness notes), and what must be true before it runs
   (for example the PDF requirements below).
5. **Destination.** Save-as dialog (or folder picker for extraction), with the
   ordinary overwrite protection: replacing an existing file goes through the
   destructive confirmation, which names the exact file.
6. **Sandboxed execution.** Worker conversions run in a plain Node child
   process with exactly one allowlisted argv entry (a temp job file). There is
   no shell, no user strings on a command line, and no network access in the
   worker. A wall-clock deadline kills the child if it overruns.
7. **Validation, then atomic write.** Output is validated by signature or
   parse round-trip (PDF page objects, ZIP end-of-central-directory, RIFF/WAVE
   header, ICO directory, JSON parse, non-empty for text) before it is written
   with the app's atomic temp-and-rename writer. A failed or cancelled
   conversion therefore never leaves a partial file at the destination.

## Adapter catalog

| Category | Bundled adapters | Unavailable (visible, disabled) |
| --- | --- | --- |
| Documents / PDF | split, merge, reorder, rotate | DOCX → PDF (no bundled layout engine) |
| Images | PNG/JPEG/BMP/WebP/GIF → PNG/JPEG/WebP/BMP with scaling; PNG → ICO | TIFF, HEIC (no bundled codec) |
| Audio | WAV convert (rate/width/channels), WAV → raw PCM, raw PCM → WAV | MP3/OGG/FLAC/AAC decode/encode (no bundled codec) |
| Video | container header inspection | all transcoding (no bundled video codecs) |
| Archives | ZIP extract, ZIP create | 7z, RAR (no bundled engines) |
| Structured data | JSON↔YAML subset, JSON↔TOML subset, JSON→CSV/TSV, CSV/TSV→JSON | — |
| Code / Text | UTF-8/UTF-16LE/BE/Latin-1 with BOM control, CRLF/LF/CR normalisation | — |
| Binary encodings | Base64 and hexadecimal encode/decode (streaming encode) | — |

## PDF capability limits (stated before execution)

The bundled PDF engine is a scan-based structural rewriter for *simple,
classic* PDFs. Before anything runs it detects and refuses:

- encrypted files (`/Encrypt` present), and
- PDF 1.5+ compressed object streams (`/ObjStm`).

Split, merge, reorder and rotate rebuild the page tree with renumbered
objects, copy content streams byte-for-byte, rewrite page parents, inherit
missing page attributes from the source page tree, and emit a fresh
cross-reference table. The detection card shows the page count and whether the
rewrite is available for the specific file.

## Resource bounds

- In-memory adapters are capped at 64 MB input and say so in the error.
- Base64/hex encoding streams in chunks, so large files are fine; decoding
  holds the result in memory and is capped.
- Every job has a deadline (20 s detection, 30 s inspection, 10 minutes
  conversion) after which the child is killed and the failure is reported.
- The queue admits at most 2 concurrent jobs and refuses single enqueue calls
  above 5000 items.

## Batch queue

Conversions land in a persistent queue (atomic JSON store) that survives app
restarts:

- per-item state machine: waiting → converting → done / skipped / failed /
  cancelled / interrupted;
- **pause / resume** the whole queue, cancel or retry single items, remove
  finished rows, clear all finished;
- **free-space preflight** before each job (reserves at least 64 MB or twice
  the source size) and an honest failure when the disk cannot hold it;
- destinations that already exist are skipped unless the overwrite was
  explicitly confirmed;
- **crash recovery**: a job that was mid-flight when the app closed is marked
  *interrupted by shutdown* — nothing partial was written — and can be retried
  with one click.

## Privacy

Conversion never touches the network. Dropped files are staged only inside the
app's own data directory and are read by the local worker process. Nothing
from a conversion is logged, exported or transmitted.
