/* Site appearance engine: theme, accent (infinite picker + rainbow sentinel),
   density, typography, motion. Everything applies to the live chrome and
   persists through the settings store. Accent presets derive M3 roles from
   the chosen seed with plain HSL maths. */

import { el, storage, reducedMotionPreferred } from './util.js';
import { getSettings, updateSettings, onSettings, RAINBOW_LEVEL_SECONDS } from './store.js';
import { RAINBOW, hexToRgb, rgbToHsl, attachColourPicker } from './color-picker.js';
import { t } from './i18n.js';

export const FONT_STACKS = [
  { id: '', en: 'Default (Segoe UI / system)', zh: '預設（Segoe UI／系統）', css: '' },
  { id: 'system-ui', en: 'System UI', zh: '系統介面', css: 'system-ui, sans-serif' },
  { id: 'serif', en: 'Serif', zh: '襯線', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', en: 'Monospace', zh: '等寬', css: 'Consolas, "Cascadia Mono", "Courier New", monospace' },
  { id: 'rounded', en: 'Rounded', zh: '圓體', css: '"Segoe UI Variable Display", "Comfortaa", "Segoe UI", sans-serif' },
];

/* Derive a small role set from one seed colour. Values land in CSS vars that
   the stylesheet consumes; the shipped token sheet stays the fallback. */
function rolesFromSeed(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [h, s, l] = rgbToHsl(rgb);
  const mix = (base, over, alpha) => {
    const p = (x) => parseInt(x, 16);
    const ch = (a, b) => Math.round(a * (1 - alpha) + b * alpha);
    return `#${[0, 2, 4].map((i) => ch(p(base.slice(1 + i, 3 + i)), p(over.slice(1 + i, 3 + i))).toString(16).padStart(2, '0')).join('')}`;
  };
  const primaryLight = hslHex(h, Math.min(s, 0.55), Math.max(0.32, Math.min(l, 0.45)));
  const primaryDark = hslHex(h, Math.min(s + 0.1, 0.7), Math.max(0.68, Math.min(l + 0.2, 0.85)));
  return {
    light: {
      primary: primaryLight,
      'primary-container': mix('#eaddff', primaryLight, 0.25),
      'on-primary-container': hslHex(h, 0.6, 0.16),
    },
    dark: {
      primary: primaryDark,
      'primary-container': hslHex(h, 0.45, 0.3),
      'on-primary-container': hslHex(h, 0.7, 0.9),
    },
  };
}
function hslHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return `#${[r, g, b].map((q) => Math.round((q + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function applyAppearance() {
  const s = getSettings();
  const a = s.appearance;
  const root = document.documentElement;

  // theme
  const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = a.theme === 'system' ? (sysDark ? 'dark' : 'light') : a.theme;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;

  // accent: default | seed colour | rainbow sentinel (animated in CSS only)
  root.classList.toggle('rainbow-accent', a.accent === RAINBOW);
  const roles = a.accent && a.accent.startsWith('#') ? rolesFromSeed(a.accent) : null;
  if (roles) {
    root.style.setProperty('--site-accent-light', roles.light.primary);
    root.style.setProperty('--site-accent-light-container', roles.light['primary-container']);
    root.style.setProperty('--site-accent-light-on-container', roles.light['on-primary-container']);
    root.style.setProperty('--site-accent-dark', roles.dark.primary);
    root.style.setProperty('--site-accent-dark-container', roles.dark['primary-container']);
    root.style.setProperty('--site-accent-dark-on-container', roles.dark['on-primary-container']);
  } else {
    ['light', 'light-container', 'light-on-container', 'dark', 'dark-container', 'dark-on-container']
      .forEach((k) => root.style.removeProperty(`--site-accent-${k}`));
  }
  const secs = RAINBOW_LEVEL_SECONDS[a.rainbowSecondsLevel] || 15;
  root.style.setProperty('--rainbow-duration', `${secs}s`);

  // typography + density
  const stack = FONT_STACKS.find((f) => f.id === a.fontFamily);
  if (stack && stack.css) root.style.setProperty('--site-font-family', stack.css);
  else root.style.removeProperty('--site-font-family');
  root.style.setProperty('--site-font-scale', String(a.fontScale / 100));
  root.style.setProperty('--site-font-weight', String(a.fontWeight));
  root.style.setProperty('--site-letter-spacing', `${a.letterSpacing / 100}em`);
  root.style.setProperty('--site-line-height', String(a.lineHeight / 100));
  root.setAttribute('data-density', String(a.density));

  // motion + stimulation
  root.classList.toggle('reduce-motion', reducedMotionPreferred());
  root.classList.toggle('low-stimulation', s.lowStimulation === true);
}

export function initAppearance() {
  applyAppearance();
  onSettings(() => applyAppearance());
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance());
  }
}

/* Presets: named, exportable, importable. Derived from real settings only. */
export const PRESETS = {
  default: { theme: 'system', accent: '', rainbowSecondsLevel: 2, density: 0, fontFamily: '', fontScale: 100, fontWeight: 400, letterSpacing: 0, lineHeight: 150, reduceMotion: false },
  midnight: { theme: 'dark', accent: '#3f51b5', rainbowSecondsLevel: 2, density: 0, fontFamily: '', fontScale: 100, fontWeight: 400, letterSpacing: 0, lineHeight: 150, reduceMotion: false },
  paper: { theme: 'light', accent: '#795548', rainbowSecondsLevel: 2, density: 1, fontFamily: 'serif', fontScale: 105, fontWeight: 400, letterSpacing: 0, lineHeight: 165, reduceMotion: false },
  carnival: { theme: 'dark', accent: 'rainbow', rainbowSecondsLevel: 4, density: 0, fontFamily: 'rounded', fontScale: 100, fontWeight: 500, letterSpacing: 0, lineHeight: 150, reduceMotion: false },
};

export function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return false;
  updateSettings({ appearance: { ...preset } });
  return true;
}

/* Settings-page editor panel (also embedded by the tab appearance editor's
   shared colour control). Renders controls bound to the store. */
export function buildAppearanceEditor(mount) {
  const s = getSettings();
  const a = s.appearance;

  const themeSel = el('select', { class: 'mr-select', id: 'ap-theme' },
    ['system', 'light', 'dark'].map((v) => el('option', { value: v, selected: a.theme === v ? '' : null, text: t(`ap.theme.${v}`) })));
  themeSel.addEventListener('change', () => updateSettings({ appearance: { theme: themeSel.value } }));

  const accentBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal accent-btn', 'aria-haspopup': 'dialog' });
  const accentPreview = el('span', { class: 'swatch', 'aria-hidden': 'true' });
  accentBtn.append(accentPreview, document.createTextNode(t('ap.accent.pick')));
  const paintPreview = () => {
    const cur = getSettings().appearance.accent;
    if (cur === RAINBOW) { accentPreview.className = 'swatch swatch--rainbow'; }
    else { accentPreview.className = 'swatch'; accentPreview.style.background = cur || 'var(--md-sys-color-primary)'; }
  };
  paintPreview();
  attachColourPicker(accentBtn, {
    get: () => getSettings().appearance.accent,
    set: (v) => { updateSettings({ appearance: { accent: v } }); paintPreview(); },
  });

  const rainbowLvl = el('input', { type: 'range', min: '1', max: '5', step: '1', value: String(a.rainbowSecondsLevel), 'aria-label': t('ap.rainbow.speed') });
  rainbowLvl.addEventListener('input', () => updateSettings({ appearance: { rainbowSecondsLevel: Number(rainbowLvl.value) } }));

  const densitySel = el('select', { class: 'mr-select', id: 'ap-density' },
    [['-1', t('ap.density.compact')], ['0', t('ap.density.default')], ['1', t('ap.density.roomy')]]
      .map(([v, l]) => el('option', { value: v, selected: String(a.density) === v ? '' : null, text: l })));
  densitySel.addEventListener('change', () => updateSettings({ appearance: { density: Number(densitySel.value) } }));

  const fontSel = el('select', { class: 'mr-select', id: 'ap-font' },
    FONT_STACKS.map((f) => el('option', { value: f.id, selected: a.fontFamily === f.id ? '' : null, text: t('lang') === 'zh' && f.zh ? f.zh : f.en })));
  fontSel.addEventListener('change', () => updateSettings({ appearance: { fontFamily: fontSel.value } }));

  const scaleNum = el('input', { type: 'number', min: '75', max: '200', step: '5', value: String(a.fontScale), class: 'mr-input', id: 'ap-scale' });
  const scaleRange = el('input', { type: 'range', min: '75', max: '200', step: '5', value: String(a.fontScale), 'aria-label': t('ap.font.scale') });
  const scaleSync = (v) => {
    const n = Math.max(75, Math.min(200, Number(v) || 100));
    updateSettings({ appearance: { fontScale: n } });
    scaleNum.value = String(n); scaleRange.value = String(n);
  };
  scaleNum.addEventListener('change', () => scaleSync(scaleNum.value));
  scaleRange.addEventListener('input', () => scaleSync(scaleRange.value));

  const weightSel = el('select', { class: 'mr-select', id: 'ap-weight' },
    [300, 400, 500, 600, 700].map((w) => el('option', { value: String(w), selected: a.fontWeight === w ? '' : null, text: String(w) })));
  weightSel.addEventListener('change', () => updateSettings({ appearance: { fontWeight: Number(weightSel.value) } }));

  const spacing = el('input', { type: 'range', min: '-2', max: '10', step: '1', value: String(a.letterSpacing), 'aria-label': t('ap.font.spacing') });
  spacing.addEventListener('input', () => updateSettings({ appearance: { letterSpacing: Number(spacing.value) } }));
  const lineH = el('input', { type: 'range', min: '110', max: '220', step: '5', value: String(a.lineHeight), 'aria-label': t('ap.font.lineheight') });
  lineH.addEventListener('input', () => updateSettings({ appearance: { lineHeight: Number(lineH.value) } }));

  const motion = el('input', { type: 'checkbox' });
  motion.checked = a.reduceMotion;
  motion.addEventListener('change', () => updateSettings({ appearance: { reduceMotion: motion.checked } }));

  const row = (labelText, control) => el('div', { class: 'setting-row' }, [
    el('label', { class: 'setting-label' }, [document.createTextNode(labelText), control]),
  ]);

  mount.append(
    row(t('ap.theme'), themeSel),
    row(t('ap.accent'), accentBtn),
    row(t('ap.rainbow'), rainbowLvl),
    row(t('ap.density'), densitySel),
    row(t('ap.font.family'), fontSel),
    row(t('ap.font.scale'), el('div', { class: 'pair' }, [scaleRange, scaleNum])),
    row(t('ap.font.weight'), weightSel),
    row(t('ap.font.spacing'), spacing),
    row(t('ap.font.lineheight'), lineH),
    row(t('ap.motion'), motion),
  );

  // presets
  const presetRow = el('div', { class: 'setting-row preset-row' });
  for (const name of Object.keys(PRESETS)) {
    const b = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t(`ap.preset.${name}`) });
    b.addEventListener('click', () => applyPreset(name));
    presetRow.append(b);
  }
  const exportBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('ap.preset.export') });
  exportBtn.addEventListener('click', () => {
    const payload = JSON.stringify({ exportedBy: 'material-router site', kind: 'appearance-preset', values: getSettings().appearance }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = el('a', { href: url, download: 'site-appearance-preset.json' });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
  const importBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('ap.preset.import') });
  const fileIn = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden' });
  const fileBtn = importBtn;
  fileBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      if (text.length > 100000) throw new Error('too large');
      const parsed = JSON.parse(text);
      const values = parsed && parsed.values ? parsed.values : parsed;
      if (values && typeof values === 'object') updateSettings({ appearance: values });
    } catch { /* invalid file: leave settings untouched */ }
    fileIn.value = '';
  });
  presetRow.append(exportBtn, fileBtn, fileIn);
  mount.append(el('div', { class: 'field-label' }, [t('ap.presets')]), presetRow);

  // reset
  const resetBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('ap.reset') });
  resetBtn.addEventListener('click', () => { updateSettings({ appearance: { ...PRESETS.default } }); storage.set('recent-colors', []); });
  mount.append(resetBtn);
}
