/* Infinite colour picker: continuous saturation/lightness field plus a hue
   rail, numeric entry in HEX / RGB / HSL, live accessible-contrast readout,
   recent colours, and an animated rainbow sentinel. The sentinel is a token,
   never a colour string, and never joins the swatch palette. */

import { el, clamp } from './util.js';
import { t } from './i18n.js';

export const RAINBOW = 'rainbow'; // the sentinel value stored as the accent

/* ---- colour space conversions (HSV is the working space) ---- */
export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((x) => Math.round(clamp(x, 0, 1) * 255));
}
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
const hex2 = (n) => n.toString(16).padStart(2, '0');
export function rgbToHex([r, g, b]) { return `#${hex2(r)}${hex2(g)}${hex2(b)}`.toLowerCase(); }
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}
function luminance([r, g, b]) {
  const a = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
export function contrastRatio(rgbA, rgbB) {
  const l1 = luminance(rgbA); const l2 = luminance(rgbB);
  const hi = Math.max(l1, l2); const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

let openPicker = null;

/* attachColourPicker(anchorButton, { get, set }) — get()/set(value) where
   value is '#rrggbb', '' for default, or the RAINBOW sentinel. */
export function attachColourPicker(btn, { get, set }) {
  let pop = null;

  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null;
    btn.setAttribute('aria-expanded', 'false');
    if (openPicker === api) openPicker = null;
    btn.focus();
  };
  const api = { close };

  let hsv = [262, 0.6, 0.64];
  const initial = get();
  if (initial && initial.startsWith('#')) {
    const rgb = hexToRgb(initial);
    if (rgb) hsv = rgbToHsv(...rgb);
  }

  function render() {
    pop.textContent = '';
    const [h] = hsv;

    const fieldWrap = el('div', { class: 'cp-field' });
    const cursor = el('div', { class: 'cp-cursor' });
    const field = el('div', {
      class: 'cp-sv',
      style: `background:
        linear-gradient(to top, #000, transparent),
        linear-gradient(to right, #fff, hsl(${h}, 100%, 50%));`,
      role: 'application',
      'aria-label': t('cp.field'),
      tabindex: '0',
    }, [cursor]);
    const posCursor = () => {
      cursor.style.left = `${hsv[1] * 100}%`;
      cursor.style.top = `${(1 - hsv[2]) * 100}%`;
      cursor.style.background = rgbToHex(hsvToRgb(...hsv));
    };
    posCursor();
    const pickFromEvent = (e) => {
      const r = field.getBoundingClientRect();
      const x = clamp((e.clientX - r.left) / r.width, 0, 1);
      const y = clamp((e.clientY - r.top) / r.height, 0, 1);
      hsv[1] = x; hsv[2] = 1 - y;
      posCursor(); commit();
    };
    field.addEventListener('pointerdown', (e) => {
      field.setPointerCapture(e.pointerId);
      pickFromEvent(e);
      const move = (ev) => pickFromEvent(ev);
      const up = () => {
        field.removeEventListener('pointermove', move);
        field.removeEventListener('pointerup', up);
      };
      field.addEventListener('pointermove', move);
      field.addEventListener('pointerup', up);
    });
    field.addEventListener('keydown', (e) => {
      const stepMap = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] };
      if (!stepMap[e.key]) return;
      e.preventDefault();
      hsv[1] = clamp(hsv[1] + stepMap[e.key][0], 0, 1);
      hsv[2] = clamp(hsv[2] + stepMap[e.key][1], 0, 1);
      posCursor(); commit();
    });
    fieldWrap.append(field);

    const hueRail = el('input', {
      type: 'range', min: '0', max: '360', value: String(Math.round(h)),
      class: 'cp-hue', 'aria-label': t('cp.hue'),
    });
    hueRail.addEventListener('input', () => { hsv[0] = Number(hueRail.value); posCursor(); commit(); });
    fieldWrap.append(hueRail);
    pop.append(fieldWrap);

    // numeric entry: HEX / RGB / HSL with live translation
    const inputsRow = el('div', { class: 'cp-inputs' });
    const hexIn = el('input', { type: 'text', class: 'mr-input mono', 'aria-label': t('cp.hex'), spellcheck: 'false' });
    const rgbIn = el('input', { type: 'text', class: 'mr-input mono', 'aria-label': 'RGB' });
    const hslIn = el('input', { type: 'text', class: 'mr-input mono', 'aria-label': 'HSL' });
    const syncInputs = () => {
      const rgb = hsvToRgb(...hsv);
      hexIn.value = rgbToHex(rgb);
      rgbIn.value = rgb.join(', ');
      const hsl = rgbToHsl(rgb);
      hslIn.value = hsl.join(', ');
    };
    const parseAndCommit = (txt, parser) => {
      const parsed = parser(txt);
      if (!parsed) return false;
      hsv = parsed; posCursor(); syncInputs(); commit();
      return true;
    };
    hexIn.addEventListener('change', () => parseAndCommit(hexIn.value, (v) => {
      const rgb = hexToRgb(v); return rgb ? rgbToHsv(...rgb) : null;
    }));
    rgbIn.addEventListener('change', () => parseAndCommit(rgbIn.value, (v) => {
      const parts = v.split(',').map((x) => parseInt(x.trim(), 10));
      if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return null;
      return rgbToHsv(...parts.map((p) => clamp(p, 0, 255)));
    }));
    hslIn.addEventListener('change', () => parseAndCommit(hslIn.value, (v) => {
      const parts = v.split(',').map((x) => parseFloat(x.trim()));
      if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return null;
      const [hh, ss, ll] = [clamp(parts[0], 0, 360), clamp(parts[1], 0, 100) / 100, clamp(parts[2], 0, 100)];
      const c = (1 - Math.abs(2 * ll - 1)) * ss;
      const hp = hh / 60; const x = c * (1 - Math.abs((hp % 2) - 1));
      let rr = 0, gg = 0, bb = 0;
      if (hp < 1) [rr, gg, bb] = [c, x, 0];
      else if (hp < 2) [rr, gg, bb] = [x, c, 0];
      else if (hp < 3) [rr, gg, bb] = [0, c, x];
      else if (hp < 4) [rr, gg, bb] = [0, x, c];
      else if (hp < 5) [rr, gg, bb] = [x, 0, c];
      else [rr, gg, bb] = [c, 0, x];
      const m = ll - c / 2;
      const rgb = [rr, gg, bb].map((q) => Math.round((q + m) * 255));
      return rgbToHsv(...rgb);
    }));
    syncInputs();
    inputsRow.append(hexIn, rgbIn, hslIn);
    pop.append(inputsRow);

    // contrast readout against both site backgrounds
    const rgb = hsvToRgb(...hsv);
    const bgWhite = contrastRatio(rgb, [255, 255, 255]).toFixed(2);
    const bgDark = contrastRatio(rgb, [29, 27, 32]).toFixed(2);
    pop.append(el('p', { class: 'cp-contrast', text: `${t('cp.contrast')} ${bgWhite} : 1 (${t('cp.light')}) · ${bgDark} : 1 (${t('cp.dark')})` }));

    // rainbow sentinel + reset + recents
    const row = el('div', { class: 'cp-actions' });
    const rbBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal cp-rainbow' }, [
      el('span', { class: 'swatch swatch--rainbow', 'aria-hidden': 'true' }),
      document.createTextNode(` ${t('cp.rainbow')}`),
    ]);
    rbBtn.classList.toggle('is-on', get() === RAINBOW);
    rbBtn.addEventListener('click', () => { close(); set(RAINBOW); });
    const defBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('cp.default') });
    defBtn.addEventListener('click', () => { close(); set(''); });
    row.append(rbBtn, defBtn);

    const recents = JSON.parse(localStorage.getItem('mr-site:recent-colors') || '[]').slice(0, 8);
    if (recents.length) {
      const rw = el('div', { class: 'cp-recents', role: 'group', 'aria-label': t('cp.recent') });
      for (const hx of recents) {
        const sw = el('button', { type: 'button', class: 'swatch', style: `background:${hx}`, 'aria-label': hx, title: hx });
        sw.addEventListener('click', () => {
          const rgbv = hexToRgb(hx);
          if (rgbv) { hsv = rgbToHsv(...rgbv); posCursor(); syncInputs(); commit(); }
        });
        rw.append(sw);
      }
      row.append(rw);
    }
    pop.append(row);
  }

  function commit() {
    const value = rgbToHex(hsvToRgb(...hsv));
    try {
      const recents = JSON.parse(localStorage.getItem('mr-site:recent-colors') || '[]')
        .filter((x) => x !== value);
      recents.unshift(value);
      localStorage.setItem('mr-site:recent-colors', JSON.stringify(recents.slice(0, 8)));
    } catch { /* ignore */ }
    set(value);
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (pop) { close(); return; }
    if (openPicker) openPicker.close();
    openPicker = api;
    pop = el('div', { class: 'builder-pop cp-pop', role: 'dialog', 'aria-label': t('cp.title') });
    render();
    btn.setAttribute('aria-expanded', 'true');
    const rect = btn.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 320)}px`;
    pop.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`;
    document.body.append(pop);
    setTimeout(() => {
      const onDoc = (ev) => {
        if (!pop.contains(ev.target) && ev.target !== btn) { close(); document.removeEventListener('pointerdown', onDoc); }
      };
      document.addEventListener('pointerdown', onDoc);
    });
    const onEsc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    pop.addEventListener('keydown', onEsc);
  });

  return api;
}

export function registerColorBundle(addBundle) {
  addBundle('color-picker', {
    en: {
      'cp.title': 'Colour picker',
      'cp.field': 'Saturation and brightness field',
      'cp.hue': 'Hue',
      'cp.hex': 'HEX value',
      'cp.rainbow': 'Rainbow',
      'cp.default': 'Use default',
      'cp.recent': 'Recent colours',
      'cp.contrast': 'Contrast:',
      'cp.light': 'light theme',
      'cp.dark': 'dark theme',
    },
    zh: {
      'cp.title': '顏色揀選器',
      'cp.field': '飽和度同明度範圍',
      'cp.hue': '色相',
      'cp.hex': 'HEX 值',
      'cp.rainbow': '彩虹',
      'cp.default': '用返預設',
      'cp.recent': '最近用過嘅色',
      'cp.contrast': '對比度：',
      'cp.light': '淺色主題',
      'cp.dark': '深色主題',
    },
  });
}
