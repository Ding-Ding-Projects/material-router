// Purpose: the infinite colour picker - a continuous hue strip plus a
// saturation/brightness 2D field, live HEX / RGB / HSL / alpha entry, WCAG
// contrast readout against the current surface colour, recent colours,
// eyedropper when the platform offers one (honestly disabled otherwise), and
// the animated-rainbow SENTINEL mode.
//
// The rainbow mode stores the literal sentinel string ('rainbow'). It is
// never appended to, never parsed as a colour, and never joined into a
// palette array - call sites that need a real colour must check it first
// (colors.isSentinel). The animation itself is stylesheet-driven with ONE
// global duration variable; reduced motion settles on one fixed hue.
// Owned by Appearance lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import {
  parseColor, rgbToHex, rgbToHexA, rgbToHsl, hslToRgb,
  contrast, RAINBOW, isSentinel,
} from './colors.js';

let openPopover = null;

function hsvToRgb(h, s, v) {
  // s,v in [0,1]
  const c = v * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rp = 0; let gp = 0; let bp = 0;
  if (hp < 1) [rp, gp, bp] = [c, x, 0];
  else if (hp < 2) [rp, gp, bp] = [x, c, 0];
  else if (hp < 3) [rp, gp, bp] = [0, c, x];
  else if (hp < 4) [rp, gp, bp] = [0, x, c];
  else if (hp < 5) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  const m = v - c;
  return { r: Math.round((rp + m) * 255), g: Math.round((gp + m) * 255), b: Math.round((bp + m) * 255) };
}

function rgbToHsv({ r, g, b }) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = (((gn - bn) / d) % 6 + 6) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * createColorPicker({ label, value, onChange, allowRainbow=true,
 *                     getRecents=()=>[], addRecent=()=>{} })
 * Renders an inline swatch button that opens the anchored editor popover.
 * Returns { el, setValue(v) }.
 */
export function createColorPicker({
  label,
  value = '#6750a4',
  onChange = () => {},
  allowRainbow = true,
  getRecents = () => [],
  addRecent = () => {},
}) {
  let current = typeof value === 'string' ? value : '';

  const swatchFill = h('span', { class: 'mr-cp__fill', 'aria-hidden': 'true' });
  const swatch = h('button', {
    type: 'button',
    class: 'mr-cp',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onclick: () => (openPopover ? openPopover.close() : open()),
  }, swatchFill, h('span', { class: 'mr-cp__text' }));

  function syncSwatch() {
    swatch.classList.toggle('mr-cp--rainbow', isSentinel(current));
    if (isSentinel(current)) {
      swatch.style.background = '';
      swatchFill.textContent = '';
      swatch.querySelector('.mr-cp__text').textContent = t('appearance.color.rainbowActive');
    } else {
      swatch.style.background = current || 'transparent';
      swatch.querySelector('.mr-cp__text').textContent = current || t('appearance.color.unset');
    }
    void swatchFill;
  }

  function setValue(v) {
    current = String(v ?? '');
    syncSwatch();
  }

  function close() {
    if (openPopover) openPopover.close();
  }

  function open() {
    if (openPopover) openPopover.close();
    openPopover = buildEditor();
  }

  function buildEditor() {
    const startRgb = parseColor(current) ?? { r: 103, g: 80, b: 164, a: 1 };
    const startHsv = rgbToHsv(startRgb);
    const state = {
      h: startHsv.h,
      s: startHsv.s,
      v: startHsv.v,
      a: startRgb.a ?? 1,
      rainbow: isSentinel(current),
    };

    const svCanvas = h('canvas', { class: 'mr-cp__field', width: '232', height: '148', role: 'application', 'aria-label': t('appearance.color.fieldLabel'), tabindex: '0' });
    const hueSlider = h('input', { type: 'range', min: '0', max: '360', step: '1', class: 'mr-cp__hue', 'aria-label': t('appearance.color.hueLabel') });
    const alphaSlider = h('input', { type: 'range', min: '0', max: '100', step: '1', class: 'mr-cp__alpha', 'aria-label': t('appearance.color.alphaLabel') });

    const hexInput = h('input', { type: 'text', spellcheck: 'false', 'aria-label': t('appearance.color.hexLabel'), class: 'mr-cp__num' });
    const rInput = numberInput(t('appearance.color.rLabel'));
    const gInput = numberInput(t('appearance.color.gLabel'));
    const bInput = numberInput(t('appearance.color.bLabel'));
    const aInput = numberInput(t('appearance.color.alphaShort'));
    const hInput = numberInput(t('appearance.color.hLabel'));
    const sInput = numberInput(t('appearance.color.sLabel'));
    const lInput = numberInput(t('appearance.color.lLabel'));

    const previewEl = h('span', { class: 'mr-cp__preview', 'aria-hidden': 'true' });
    const contrastEl = h('span', { class: 'mr-typography-body-small mr-grow' });
    const copyBtn = h('button', { type: 'button', class: 'm3-btn m3-btn--text m3-btn--sm' }, t('common.copy'));
    const errEl = h('span', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-error)' });

    const rainbowToggleWrap = h('div', {});
    const recentsRow = h('div', { class: 'mr-row mr-cp__recents' });

    let eyedropperBtn = null;
    if (typeof window.EyeDropper !== 'function') {
      eyedropperBtn = h('button', {
        type: 'button', class: 'm3-btn m3-btn--text m3-btn--sm', disabled: true,
        title: t('appearance.color.eyedropperUnavailable'),
        'aria-label': `${t('appearance.color.eyedropper')} (${t('appearance.color.eyedropperUnavailable')})`,
      }, t('appearance.color.eyedropper'));
    } else {
      eyedropperBtn = h('button', {
        type: 'button', class: 'm3-btn m3-btn--text m3-btn--sm', 'aria-label': t('appearance.color.eyedropper'),
        onclick: async () => {
          try {
            const result = await new window.EyeDropper().open();
            applyParsed(parseColor(result?.sRGBHex));
          } catch { /* user cancelled the eyedropper - not an error */ }
        },
      }, t('appearance.color.eyedropper'));
    }

    function numberInput(aria) {
      return h('input', { type: 'number', class: 'mr-cp__num mr-cp__num--small', 'aria-label': aria, min: '-999', max: '999', step: '1' });
    }

    function drawField() {
      const ctx = svCanvas.getContext('2d');
      const w = svCanvas.width;
      const hgt = svCanvas.height;
      const base = hsvToRgb(state.h, 1, 1);
      const gradH = ctx.createLinearGradient(0, 0, w, 0);
      gradH.addColorStop(0, '#ffffff');
      gradH.addColorStop(1, `rgb(${base.r},${base.g},${base.b})`);
      ctx.fillStyle = gradH;
      ctx.fillRect(0, 0, w, hgt);
      const gradV = ctx.createLinearGradient(0, 0, 0, hgt);
      gradV.addColorStop(0, 'rgba(0,0,0,0)');
      gradV.addColorStop(1, '#000000');
      ctx.fillStyle = gradV;
      ctx.fillRect(0, 0, w, hgt);
      cursorEl.style.left = `${state.s * 100}%`;
      cursorEl.style.top = `${(1 - state.v) * 100}%`;
    }

    const cursorEl = h('span', { class: 'mr-cp__cursor', 'aria-hidden': 'true' });
    const fieldWrap = h('div', { class: 'mr-cp__fieldwrap' }, svCanvas, cursorEl);

    function emit(commit) {
      const rgb = hsvToRgb(state.h, state.s, state.v);
      const hexA = rgbToHexA({ ...rgb, a: state.a });
      current = hexA;
      onChange(hexA);
      syncSwatch();
      refreshReadouts(rgb);
      if (commit) addRecent(rgbToHex(rgb));
    }

    function applyParsed(parsed) {
      if (!parsed) return;
      const hsv = rgbToHsv(parsed);
      state.h = hsv.h; state.s = hsv.s; state.v = hsv.v; state.a = parsed.a ?? 1;
      state.rainbow = false;
      syncControls();
      emit(false);
    }

    function syncControls() {
      hueSlider.value = String(Math.round(state.h));
      alphaSlider.value = String(Math.round(state.a * 100));
      drawField();
      const rgb = hsvToRgb(state.h, state.s, state.v);
      const hsl = rgbToHsl(rgb);
      hexInput.value = rgbToHexA({ ...rgb, a: state.a });
      rInput.value = String(rgb.r); gInput.value = String(rgb.g); bInput.value = String(rgb.b);
      aInput.value = String(Math.round(state.a * 100));
      hInput.value = String(Math.round(hsl.h)); sInput.value = String(Math.round(hsl.s)); lInput.value = String(Math.round(hsl.l));
      refreshReadouts(rgb);
    }

    function refreshReadouts(rgb) {
      previewEl.style.background = rgbToHexA({ ...rgb, a: state.a });
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--md-sys-color-surface').trim() || '#fef7ff';
      const opaque = rgbToHex(rgb);
      let ratio;
      try { ratio = contrast(opaque, bg); } catch { ratio = null; }
      if (ratio == null || !Number.isFinite(ratio)) {
        contrastEl.textContent = t('appearance.color.contrastUnknown');
      } else {
        const ok = ratio >= 4.5;
        contrastEl.textContent = `${t('appearance.color.contrastLabel')} ${ratio.toFixed(2)}:1 · ${ok ? t('appearance.color.contrastOk') : t('appearance.color.contrastLow')}`;
        contrastEl.style.color = ok ? 'var(--md-sys-color-success)' : 'var(--md-sys-color-on-surface-variant)';
      }
      errEl.textContent = '';
    }

    svCanvas.addEventListener('pointerdown', (e) => {
      svCanvas.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const rect = svCanvas.getBoundingClientRect();
        state.s = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        state.v = Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
        state.rainbow = false;
        emit(false);
      };
      move(e);
      const up = () => {
        svCanvas.removeEventListener('pointermove', move);
        svCanvas.removeEventListener('pointerup', up);
        addCurrentToRecents();
      };
      svCanvas.addEventListener('pointermove', move);
      svCanvas.addEventListener('pointerup', up);
    });

    hueSlider.addEventListener('input', () => {
      state.h = Number(hueSlider.value);
      state.rainbow = false;
      emit(false);
    });
    alphaSlider.addEventListener('input', () => {
      state.a = Number(alphaSlider.value) / 100;
      state.rainbow = false;
      emit(true);
    });

    hexInput.addEventListener('change', () => {
      const parsed = parseColor(hexInput.value.trim());
      if (!parsed) {
        errEl.textContent = t('appearance.color.invalidHex');
        syncControls();
        return;
      }
      applyParsed(parsed);
      emit(true);
    });

    const bindChannel = (input, channel, scale = 1) => {
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (!Number.isFinite(n)) { syncControls(); return; }
        const rgb = hsvToRgb(state.h, state.s, state.v);
        rgb[channel] = Math.max(0, Math.min(255, n));
        applyParsed({ ...rgb, a: state.a });
        emit(true);
        void scale;
      });
    };
    bindChannel(rInput, 'r'); bindChannel(gInput, 'g'); bindChannel(bInput, 'b');

    aInput.addEventListener('change', () => {
      state.a = Math.max(0, Math.min(100, Number(aInput.value) || 0)) / 100;
      emit(true);
    });
    hInput.addEventListener('change', () => {
      state.h = ((Number(hInput.value) || 0) % 360 + 360) % 360;
      emit(false);
    });
    sInput.addEventListener('change', () => {
      const rgb = hslToRgb(Number(hInput.value) || 0, Number(sInput.value) || 0, Number(lInput.value) || 0);
      applyParsed(rgb);
      emit(false);
    });
    lInput.addEventListener('change', () => {
      const rgb = hslToRgb(Number(hInput.value) || 0, Number(sInput.value) || 0, Number(lInput.value) || 0);
      applyParsed(rgb);
      emit(false);
    });

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(hexInput.value).catch(() => {});
      copyBtn.textContent = t('common.copied');
      setTimeout(() => { copyBtn.textContent = t('common.copy'); }, 1200);
    });

    function addCurrentToRecents() {
      const rgb = hsvToRgb(state.h, state.s, state.v);
      addRecent(rgbToHex(rgb));
    }

    function renderRainbowToggle(host) {
      host.textContent = '';
      if (!allowRainbow) return;
      const cb = h('input', {
        type: 'checkbox',
        checked: state.rainbow ? true : null,
        'aria-label': t('appearance.color.rainbowToggle'),
        onchange: () => {
          state.rainbow = cb.checked;
          if (state.rainbow) {
            current = RAINBOW; // stored exactly once, never composed
            onChange(RAINBOW);
            syncSwatch();
          } else {
            emit(false);
          }
          lockFields(state.rainbow);
        },
      });
      host.append(h('label', { class: 'm3-checkbox' }, cb,
        h('span', {}, t('appearance.color.rainbowToggle'))),
      h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:4px 0 0' },
        t('appearance.color.rainbowNote')));
    }

    function lockFields(locked) {
      for (const el of [hexInput, rInput, gInput, bInput, aInput, hInput, sInput, lInput, hueSlider, alphaSlider, svCanvas]) {
        el.disabled = locked;
      }
      fieldWrap.classList.toggle('mr-cp__fieldwrap--locked', locked);
      if (locked) errEl.textContent = '';
    }

    function renderRecents() {
      recentsRow.textContent = '';
      const recents = getRecents().slice(0, 12);
      recentsRow.append(h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('appearance.color.recentLabel')));
      if (recents.length === 0) {
        recentsRow.append(h('span', { class: 'mr-typography-body-small' }, t('appearance.color.recentEmpty')));
      }
      for (const hex of recents) {
        recentsRow.append(h('button', {
          type: 'button',
          class: 'mr-cp__recent',
          style: `background:${hex}`,
          'aria-label': `${t('appearance.color.useRecent')} ${hex}`,
          title: hex,
          onclick: () => { applyParsed(parseColor(hex)); emit(true); },
        }));
      }
    }

    // -- popover scaffolding -------------------------------------------------
    const bodyEl = h('div', { class: 'mr-col', style: 'gap:10px;min-width:280px' },
      fieldWrap,
      hueSlider,
      alphaSlider,
      h('div', { class: 'mr-row mr-wrap' },
        hexInput,
        rInput, gInput, bInput, aInput,
        hInput, sInput, lInput,
      ),
      errEl,
      h('div', { class: 'mr-row' }, previewEl, contrastEl, copyBtn, eyedropperBtn),
      rainbowToggleWrap,
      recentsRow,
    );

    const anchorRect = swatch.getBoundingClientRect();

    function reposition() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const measured = pop.getBoundingClientRect();
      let left = Math.min(Math.max(8, anchorRect.left), Math.max(8, vw - measured.width - 8));
      let top = anchorRect.bottom + 4;
      if (top + measured.height > vh - 8) top = Math.max(8, anchorRect.top - measured.height - 4);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      }
    }

    function onPointerDown(e) {
      if (!pop.contains(e.target) && e.target !== swatch && !swatch.contains(e.target)) cleanup();
    }

    function cleanup() {
      pop.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', cleanup);
      window.removeEventListener('scroll', reposition, true);
      swatch.setAttribute('aria-expanded', 'false');
      if (openPopover?.close === cleanup) openPopover = null;
      swatch.focus();
    }

    const pop = h('div', {
      class: 'mr-cp__popover',
      role: 'dialog',
      'aria-label': label || t('appearance.color.pickerTitle'),
    }, h('div', { class: 'mr-typography-title-medium', style: 'margin-bottom:6px' }, label ?? ''), bodyEl);

    document.body.append(pop);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', cleanup);
    window.addEventListener('scroll', reposition, true);
    swatch.setAttribute('aria-expanded', 'true');

    renderRainbowToggle(rainbowToggleWrap);
    renderRecents();
    syncControls();
    lockFields(state.rainbow);
    reposition();

    return { close: cleanup };
  }

  syncSwatch();
  return { el: swatch, setValue };
}
