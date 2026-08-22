# Theme and appearance

Material Router follows Material Design 3 throughout: color roles, typography scale,
shape, elevation, and motion come from a token set applied to every surface, including
the frameless window chrome, the tab strip, the command palette, and notifications.

## Behaviour

Shipped today:

- **Light, dark, and system themes.** Choose a fixed theme or follow the operating
  system's preference. The choice persists across restarts and applies immediately.
- **M3 token foundation.** All shipped surfaces draw from the same token set, so theme
  switches are consistent everywhere at once.

Planned, owned by the Appearance lane:

- **Per-element appearance editing.** Any rendered element — a tab, a group, a menu, a
  dialog — will offer an *Edit appearance* action from its context menu (with a
  keyboard equivalent) opening a non-modal editor anchored beside it. Editors will
  cover fonts, sizes, weights, colors, spacing, corner radii, icons, and states, with
  per-property, per-element, and global resets.
- **Extended controls.** Density, accent or seed color, and font selection with live
  preview, plus named presets and import/export of customized themes.
- **Contrast guidance.** Accessible-contrast readouts in color controls so custom
  choices remain legible in both themes.

## Configuration

Theme selection lives in the app's settings and persists locally. Appearance
preferences are per-user, local-only, and never synchronized.

## Failure modes

- An unreadable or corrupted preference falls back to the shipped default theme rather
  than leaving surfaces unstyled.
- Custom values that would harm legibility are flagged by contrast readouts once those
  controls ship; until then, defaults remain the safest path.
- Following the system theme means the app changes appearance when the operating
  system does; pin a fixed theme if that movement is unwanted.

## Security considerations

Appearance preferences contain no sensitive data and are stored with the rest of the
app's local settings. Nothing about them leaves the machine.

## Verification

- Switch between light, dark, and system and confirm every visible surface — window
  chrome, tabs, palette, notifications — updates together.
- Restart the app and confirm the chosen theme persisted.
- Flip the operating system between light and dark while set to *system* and confirm
  the app follows.

Per-element editors will be verified once shipped: editing a property, observing the
live change, resetting it per property and globally, and confirming persistence across
restart.

## Status

**Partially shipped.** The M3 token set and light/dark/system themes are in the
foundation build. Per-element appearance editors, extended typography and color
controls, and presets are **in progress for the Appearance lane**; see `ROADMAP.md`.

## Shipped by the Appearance lane

The planned items above are now implemented on top of the token set
(tokens.css is never edited; the lane writes one runtime override style
element):

- **Extended controls.** Density (comfortable/compact), accent seed colour with
  a derived M3-style role set for both themes, interface font picker over
  installed + curated-safe families, text size scale 85-125%, and body-text
  weight.
- **Per-element appearance editing.** Anchored, non-modal editors open beside
  the triggering tab or any marked target (`data-mr-appearance-target`) from
  the context menu or the ContextMenu / Shift+F10 keys, with per-property and
  reset-all resets, an explicit-inheritance toggle, and unsupported options
  visible-but-disabled stating why.
- **Infinite colour picker** with continuous SV field, HEX/RGB/HSL/alpha
  entry, contrast readout vs surface, recent colours, honest eyedropper
  availability, and the animated-rainbow sentinel mode (one global duration,
  reduced motion settles one hue).
- **Named presets:** five built-in M3-faithful schemes plus save-current,
  schema-checked JSON export/import, bulk delete behind destructive
  confirmation, and global reset.
- **Narrator settings section:** enable (off by default), narrated language,
  per-language voice pickers over live platform voices, rate/pitch, honest
  status lines.
- **Scheduled appearance rules:** local timezone evaluation, inclusive dates,
  midnight-crossing time windows, weekday sets, later-enabled-rule-wins
  precedence; external HTTPS/API sources deferred this release.

Every setting row carries progressive-disclosure explanation plus a truthful
default-provenance line; every persisted write goes through atomic settings
storage and records a local-history entry; searchable pickers in this surface
all embed the shared anchored regex-capable builder.

See `docs/articles/appearance.md` for behaviour, failure modes and
verification detail.
