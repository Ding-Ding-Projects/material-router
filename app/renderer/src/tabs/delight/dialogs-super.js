// Purpose: the upgraded destructive-action gate ("super confirmation"): two
// independently operated press-and-hold keys, then a full-range confirmation
// slider, with a progress animation while it moves and a distinct completion
// animation once authorised. An Emergency exit control stays available the
// whole time, Escape cancels, and focus returns to the invoking control.
// Facts (what will be destroyed) are rendered plainly at every funny level;
// only the surrounding chrome carries any voice.
// Owned by Delight lane. Integration note for sibling lanes: import
// { destructiveConfirmSuper } from here and call it where you currently call
// dialogs.destructiveConfirm; the signature matches.

import { h } from '../../core/util.js';
import { copy, t } from '../../core/i18n.js';
import { openModal } from '../../core/dialogs.js';
import { announce } from '../../core/toasts.js';

const HOLD_MS = 1200;

/**
 * @param {{title:string, body:string, confirmLabel?:string}} spec
 * @returns {Promise<boolean>} true only after both keys AND the full-range slider
 */
export function destructiveConfirmSuper({ title, body, confirmLabel } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const keyDone = [false, false];
    let sliderDone = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(result);
    };

    // -- key-hold button factory -------------------------------------------------
    function makeKeyHold(index, label) {
      const fill = h('span', {
        class: 'mr-super-key__fill',
        role: 'progressbar',
        'aria-label': label,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
        'aria-hidden': 'true',
      });
      const status = h('span', { class: 'mr-super-key__status' }, '');
      const btn = h('button', {
        type: 'button',
        class: 'mr-super-key',
        'aria-pressed': 'false',
        'aria-label': `${label}. ${t('dl.super.holdHint')}`,
      }, fill, h('span', { class: 'mr-super-key__label' }, label), status);

      let raf = 0;
      let startTs = 0;
      let holding = false;

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      function frame(now) {
        if (!holding) return;
        const pct = Math.min(100, ((now - startTs) / HOLD_MS) * 100);
        fill.style.width = `${pct}%`;
        fill.setAttribute('aria-valuenow', String(Math.round(pct)));
        if (pct >= 100) {
          complete();
          return;
        }
        raf = requestAnimationFrame(frame);
      }

      function begin() {
        if (keyDone[index] || holding || settled) return;
        holding = true;
        startTs = performance.now();
        btn.classList.add('holding');
        btn.setAttribute('aria-pressed', 'true');
        if (reducedMotion) {
          // No animated sweep; the hold itself is still required in full.
          raf = setTimeout(complete, HOLD_MS);
        } else {
          raf = requestAnimationFrame(frame);
        }
      }
      function cancel() {
        if (keyDone[index] || !holding) return;
        holding = false;
        btn.classList.remove('holding');
        btn.setAttribute('aria-pressed', 'false');
        cancelAnimationFrame(raf);
        clearTimeout(raf);
        fill.style.width = '0%';
        fill.setAttribute('aria-valuenow', '0');
      }
      function complete() {
        holding = false;
        cancelAnimationFrame(raf);
        clearTimeout(raf);
        keyDone[index] = true;
        btn.classList.remove('holding');
        btn.classList.add('done');
        btn.disabled = true;
        fill.style.width = '100%';
        fill.setAttribute('aria-valuenow', '100');
        status.textContent = t('dl.super.keyDone');
        announce(`${label}: ${t('dl.super.keyDone')}`);
        updateGate();
      }

      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); begin(); });
      btn.addEventListener('pointerup', cancel);
      btn.addEventListener('pointerleave', cancel);
      btn.addEventListener('pointercancel', cancel);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      btn.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          begin();
        }
      });
      btn.addEventListener('keyup', (e) => {
        if (e.key === 'Enter' || e.key === ' ') cancel();
      });
      return btn;
    }

    // -- slider -------------------------------------------------------------------
    const slider = h('input', {
      type: 'range',
      class: 'mr-super-slider',
      min: '0',
      max: '100',
      step: '1',
      value: '0',
      disabled: true,
      'aria-label': t('dl.super.slider'),
    });

    function onSlide() {
      if (sliderDone || settled) return;
      const v = Number(slider.value);
      if (v >= 100) authorize();
    }
    slider.addEventListener('input', onSlide);
    slider.addEventListener('change', onSlide);

    function updateGate() {
      if (keyDone[0] && keyDone[1]) slider.disabled = false;
    }

    // -- completion -----------------------------------------------------------------
    function authorize() {
      sliderDone = true;
      slider.disabled = true;
      const badge = h('div', { class: 'mr-super-complete', role: 'status' }, t('dl.super.authorised'));
      actionsEl.replaceChildren(badge);
      announce(t('dl.super.authorised'));
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => finish(true), reducedMotion ? 150 : 650);
    }

    // -- assembly ----------------------------------------------------------------------
    const keysRow = h('div', { class: 'mr-col' },
      makeKeyHold(0, t('dl.super.key1')),
      makeKeyHold(1, t('dl.super.key2')),
      h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:0' },
        t('dl.super.holdHint')),
    );

    const emergencyBtn = h('button', {
      type: 'button',
      class: 'm3-btn m3-btn--tonal mr-super-exit',
      onclick: () => finish(false),
    }, t('dl.super.emergencyExit'));

    const actionsEl = h('div', { class: 'mr-col', style: 'gap:8px' },
      h('div', { class: 'mr-row', style: 'flex-wrap:wrap' }, slider, emergencyBtn),
    );

    const bodyWrap = h('div', { class: 'mr-col', style: 'gap:12px' },
      h('p', {
        class: 'mr-typography-body-medium',
        style: 'color:var(--md-sys-color-on-surface);margin:0;white-space:pre-line;font-weight:500',
      }, String(body ?? '')),
      keysRow,
      actionsEl,
    );

    const dlg = openModal({
      title,
      body: bodyWrap,
      onClose: () => finish(false),
      actions: [],
    });
    void confirmLabel; // authorisation is the slider reaching its end, not another button
  });
}

/** Convenience alias matching dialogs.confirm's naming style. */
export const superConfirm = destructiveConfirmSuper;
