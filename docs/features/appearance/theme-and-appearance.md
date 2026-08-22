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
