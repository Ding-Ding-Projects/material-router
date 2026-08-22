# Appearance

Material Router uses Material Design 3 throughout — color roles, typography, shape,
elevation, and motion all come from one token set applied to every surface, including
the frameless window chrome and the tab strip.

## Themes

Choose **light**, **dark**, or **system** in settings. *System* follows your operating
system's preference and switches automatically, including when your system flips
themes on a schedule. Your choice persists across restarts and applies immediately.

Both themes draw from the same Material Design 3 color roles and the same layout
metrics, so switching themes changes colors only — nothing moves, reflows, or
disappears.

## Frameless window and tabs

The window draws its own title bar and controls in the same Material style, and
content lives in a browser-style tab strip you can dock to the left, top, right, or
bottom edge. Tabs support pinning, groups, renaming, and per-tab appearance editing as
that surface matures.

## Per-element editing (in progress)

Deeper customization — editing the font, size, color, spacing, or corner radius of any
individual element from its right-click menu, plus density, accent color, and font
pickers with live preview — is being built by the Appearance lane. Until it lands, the
shipped theme settings are the reliable surface.

## Tips

- If you do not want the app following your operating system's theme changes, pin
  light or dark explicitly.
- Appearance preferences are stored locally and never leave your machine.

## Related

- [Keyboard shortcuts](keyboard-shortcuts.md) — move faster without the mouse.
- [Getting started](getting-started.md) — first-run tour.

## Customization (Appearance lane)

The Appearance tab is the deep-customization surface. Everything below persists
locally through atomic settings writes and is recorded in local history; every
setting carries an info affordance explaining what it does plus a provenance
line naming its shipped default.

### Theme, density, typography

- **Theme** light / dark / system (the shipped setting), **density**
  comfortable / compact (compact maps the spacing scale 4-64 px down to 3-48 px
  across every surface).
- **Accent seed colour** derives primary/container/secondary/tertiary roles for
  BOTH themes from one seed. The derivation approximates M3 tonal palettes in
  sRGB (not HCT) and darkens/lightens the primary until it holds at least 4.5:1
  contrast against each theme's background.
- **Interface font** from installed families (read from this machine's font
  files by the main process) plus a curated bundled-safe list that always ships;
  failures degrade honestly to the curated list.
- **Text size scale** 85%-125% scales every Material type step together,
  line heights included; **body text weight** shifts running text only.

### Colour picker

Continuous saturation/brightness field + hue strip, live HEX/RGB/HSL/alpha
entry, WCAG contrast readout against the current surface, recent colours, and
an eyedropper when the platform provides one (visibly disabled otherwise).
The **animated rainbow** stores the sentinel value `rainbow` exactly once -
never parsed as a colour, never composed into strings - and animates via ONE
global stylesheet duration derived from speed levels 1-5 in a single mapping.
Reduced motion settles on one fixed hue instead of slowing the cycle.

### Per-element editing

Every tab offers **Edit appearance…** in its right-click menu (keyboard:
ContextMenu or Shift+F10 on marked targets). The editor opens anchored beside
the element, never covering it, and covers family/size/weight/style, text and
background colour, radius, underline style/colour, overline, capitalization,
small caps, letter/word spacing, line height, super/subscript, glow blur and
opacity, and per-tab emoji icons. Each property resets to *inherit*
individually; reset-all goes through destructive confirmation. An
explicit-inheritance toggle freezes unset properties so later theme changes
stop reaching them. Unsupported options stay visible, disabled, stating why
(e.g. CSS cannot draw a double strikethrough line).

### Presets

Five built-in M3-faithful seeds ship in code. Save the current look as a named
preset, apply with one click, export/import presets as validated JSON
(schema-checked; built-ins are never overwritten by import), bulk-delete saved
presets behind destructive confirmation, and a global reset back to shipped
defaults.

### Narrator

Spoken feedback for notifications, OFF by default. English, Cantonese, or Both
(strictly serialized); per-language voice pickers read live platform voices
with *Choose automatically* as default and stable voice identities persisted;
honest status lines cover not-installed fallback (choice kept),
network-backed voices, and languages with no voice at all. A desktop screen
reader cannot be detected from inside the renderer - stated plainly; narration
ducks under the app's own announcements and pauses while hidden.

### Scheduled appearance

Rules switch a target setting (theme, density, accent, font, size scale,
rainbow speed) within optional inclusive date ranges and time windows
(midnight-crossing supported; equal start/end means all day) on selected
weekdays or every day, evaluated in the local timezone (shown in the UI).
Among matching enabled rules the later rule wins. External HTTPS/API sources
are deliberately deferred this release.

## Verification

- Colour math, scheme contrast guarantees, schedule semantics (windows,
  precedence, weekdays, date bounds) are covered by runnable pure-function
  probes; the sfnt font reader is verified against real system fonts
  including TrueType Collections.
- Interactive verification of the mounted surface lands with integration
  (see HANDOFF); this lane's worktree could not boot the stock app because of
  pre-existing foundation blockers documented there (`bridges/index.js`
  Windows ESM path, fixed here, and `__dirname` in ESM `main.js`, outside
  lane ownership).
