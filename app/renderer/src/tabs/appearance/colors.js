// Purpose: pure colour math for the Appearance lane - parsing, formatting,
// RGB<->HSL, WCAG contrast, mixing, and deriving an M3-style role scheme from
// one seed colour. No DOM here so every function stays unit-testable.
//
// The scheme derivation is an sRGB approximation of Material Design 3 tonal
// palettes (mixing toward white/black at fixed ratios), NOT Google's HCT math.
// That approximation is stated in the docs and in the UI explanation.
// Owned by Appearance lane.

/** The one sentinel value the whole app recognises for the animated rainbow. */
export const RAINBOW = 'rainbow';

export function isSentinel(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === RAINBOW;
}

/** Parse #rgb, #rrggbb, #rrggbbaa -> {r,g,b,a} (a default 1). Null when invalid. */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const m = /^#([0-9a-f]{3,8})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((c) => c + c).join('');
  }
  if (hex.length !== 6 && hex.length !== 8) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b, a };
}

export function rgbToHex({ r, g, b }) {
  const part = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHexA({ r, g, b, a = 1 }) {
  const base = rgbToHex({ r, g, b });
  if (a >= 0.999) return base;
  const aa = Math.max(0, Math.min(255, Math.round(a * 255))).toString(16).padStart(2, '0');
  return `${base}${aa}`;
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hn < 60) [rp, gp, bp] = [c, x, 0];
  else if (hn < 120) [rp, gp, bp] = [x, c, 0];
  else if (hn < 180) [rp, gp, bp] = [0, c, x];
  else if (hn < 240) [rp, gp, bp] = [0, x, c];
  else if (hn < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

export function hexToHsl(input) {
  const rgb = parseColor(input);
  return rgb ? rgbToHsl(rgb) : null;
}

export function hslToHex(h, s, l) {
  return rgbToHex(hslToRgb({ h, s, l }));
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }) {
  const lin = (v) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (>= 1, <= 21). */
export function contrast(a, b) {
  const la = luminance(parseColor(a) ?? { r: 0, g: 0, b: 0 });
  const lb = luminance(parseColor(b) ?? { r: 255, g: 255, b: 255 });
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear mix of two parseable colours; t=0 -> a, t=1 -> b. Alpha ignored. */
export function mix(colorA, colorB, t) {
  const a = parseColor(colorA);
  const b = parseColor(colorB);
  if (!a || !b) return null;
  const f = Math.max(0, Math.min(1, t));
  return rgbToHex({
    r: a.r + (b.r - a.r) * f,
    g: a.g + (b.g - a.g) * f,
    b: a.b + (b.b - a.b) * f,
  });
}

function darkenUntilReadable(color, against, minRatio) {
  let current = color;
  for (let i = 0; i < 24; i++) {
    if (contrast(current, against) >= minRatio) return current;
    const darker = mix(current, '#000000', 0.08);
    if (!darker || darker === current) break;
    current = darker;
  }
  return current;
}

function lightenUntilReadable(color, against, minRatio) {
  let current = color;
  for (let i = 0; i < 24; i++) {
    if (contrast(current, against) >= minRatio) return current;
    const lighter = mix(current, '#ffffff', 0.08);
    if (!lighter || lighter === current) break;
    current = lighter;
  }
  return current;
}

/**
 * Derive the M3-style colour roles from one seed for BOTH themes.
 * Returns { light: {...}, dark: {...} } keyed by token suffix
 * (primary, onPrimary, primaryContainer, ...). Approximation of M3 tonal
 * palettes using sRGB mixes - documented as such everywhere it is surfaced.
 */
export function deriveScheme(seedHex) {
  const seed = parseColor(seedHex) ? seedHex : '#6750a4';
  const hsl = hexToHsl(seed);

  const tinted = (t) => mix(seed, '#ffffff', t);
  const shaded = (t) => mix(seed, '#000000', t);
  const desat = (amount) => hslToHex(hsl.h, Math.max(8, hsl.s * amount), hsl.l);
  const tertiaryHsl = { h: hsl.h - 52, s: Math.max(24, hsl.s * 0.82), l: hsl.l };
  const tertiary = hslToHex(tertiaryHsl.h, tertiaryHsl.s, tertiaryHsl.l);
  const tertiaryTint = (t) => mix(tertiary, '#ffffff', t);
  const tertiaryShade = (t) => mix(tertiary, '#000000', t);

  const lightBg = '#fef7ff';
  const darkBg = '#141218';

  const lightPrimary = darkenUntilReadable(seed, lightBg, 4.5);
  const darkPrimary = lightenUntilReadable(seed, darkBg, 4.5);

  return {
    light: {
      primary: lightPrimary,
      onPrimary: contrast(lightPrimary, '#ffffff') >= 4.5 ? '#ffffff' : '#1d1b20',
      primaryContainer: tinted(0.86),
      onPrimaryContainer: shaded(0.62),
      secondary: darkenUntilReadable(desat(0.38), lightBg, 4.5),
      secondaryContainer: mix(desat(0.38), '#ffffff', 0.88),
      onSecondaryContainer: mix(desat(0.38), '#000000', 0.66),
      tertiary: darkenUntilReadable(tertiary, lightBg, 4.5),
      tertiaryContainer: tertiaryTint(0.86),
      onTertiaryContainer: tertiaryShade(0.62),
      inversePrimary: darkPrimary,
    },
    dark: {
      primary: darkPrimary,
      onPrimary: contrast(darkPrimary, '#1d1b20') >= 4.5 ? '#1d1b20' : '#381e72',
      primaryContainer: shaded(0.55),
      onPrimaryContainer: tinted(0.9),
      secondary: lightenUntilReadable(desat(0.38), darkBg, 4.5),
      secondaryContainer: mix(desat(0.38), '#000000', 0.55),
      onSecondaryContainer: mix(desat(0.38), '#ffffff', 0.9),
      tertiary: lightenUntilReadable(tertiary, darkBg, 4.5),
      tertiaryContainer: tertiaryShade(0.55),
      onTertiaryContainer: tertiaryTint(0.9),
      inversePrimary: lightPrimary,
    },
  };
}

/** Format helpers for the picker's numeric readouts. */
export function toRgbString(rgb) {
  return `rgb(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)})`;
}

export function toHslString(rgb) {
  const { h, s, l } = rgbToHsl(rgb);
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}
