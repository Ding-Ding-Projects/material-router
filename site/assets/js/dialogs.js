/* Modal dialog infrastructure + destructive-action super confirmation
   (two independent keys, then a full-range slider, with an emergency exit).
   Reduced motion respected; focus returned to the opener on close. */

import { el, reducedMotionPreferred } from './util.js';
import { t } from './i18n.js';

let openLayer = null;

export function registerDialogBundle(addBundle) {
  addBundle('dialogs', {
    en: {
      'dlg.cancel': 'Cancel',
      'dlg.confirm': 'Confirm',
      'dlg.super.title': 'Are you sure? This cannot be undone.',
      'dlg.super.lead': 'This action will permanently:',
      'dlg.super.key1': 'Key 1: I understand what will be deleted',
      'dlg.super.key2': 'Key 2: I have no unsaved work that depends on it',
      'dlg.super.slider': 'Slide fully to the right to confirm',
      'dlg.super.emergency': 'Emergency exit — cancel',
      'dlg.super.hold': 'Hold both keys, then drag the slider all the way across.',
    },
    zh: {
      'dlg.cancel': '取消',
      'dlg.confirm': '確認',
      'dlg.super.title': '真係肯定？做咗就返唔到轉頭。',
      'dlg.super.lead': '呢個動作會永久：',
      'dlg.super.key1': '第一把鎖：我明白將會刪除啲乜',
      'dlg.super.key2': '第二把鎖：我無未儲存嘅嘢會受影響',
      'dlg.super.slider': '推到最右手先算確認',
      'dlg.super.emergency': '緊急出口 —— 取消',
      'dlg.super.hold': '兩把鎖都開咗，再將滑桿由頭推到尾。',
    },
  });
}

function baseModal({ labelledBy }) {
  if (openLayer) openLayer.remove();
  const scrim = el('div', { class: 'modal-scrim' });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  if (labelledBy) box.setAttribute('aria-labelledby', labelledBy);
  scrim.append(box);
  const prevFocus = document.activeElement;
  document.body.append(scrim);
  openLayer = scrim;
  const close = () => {
    scrim.remove();
    if (openLayer === scrim) openLayer = null;
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      // rudimentary focus trap
      const focusables = box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  return { box, scrim, close };
}

/* destructiveConfirm({title, detail, confirmLabel}) -> Promise<boolean> */
export function destructiveConfirm({ title, detail, affectedItems = null, confirmLabel = null } = {}) {
  return new Promise((resolve) => {
    const id = `super-${Math.random().toString(36).slice(2)}`;
    const { box, close } = baseModal({ labelledBy: id });

    const heading = el('h2', { id, class: 'modal-title', text: title || t('dlg.super.title') });
    const lead = el('p', { class: 'modal-lead' }, [
      document.createTextNode(t('dlg.super.lead')),
      ' ',
      el('strong', { text: detail || '' }),
    ]);
    if (affectedItems != null) {
      lead.append(el('div', { class: 'modal-count', text: affectedItems }));
    }

    let key1 = false;
    let key2 = false;

    const mk = (labelText) => {
      const cb = el('input', { type: 'checkbox' });
      const label = el('label', { class: 'super-key' }, [cb, document.createTextNode(` ${labelText}`)]);
      return { cb, label };
    };
    const k1 = mk(t('dlg.super.key1'));
    const k2 = mk(t('dlg.super.key2'));
    const hint = el('p', { class: 'modal-hint', text: t('dlg.super.hold') });

    const sliderWrap = el('div', { class: 'super-slider-wrap' });
    const slider = el('input', {
      type: 'range', min: '0', max: '100', value: '0', step: '1',
      'aria-label': t('dlg.super.slider'),
    });
    const fill = el('div', { class: 'super-fill' });
    sliderWrap.append(fill, slider);

    const actions = el('div', { class: 'modal-actions' });
    const emergency = el('button', { type: 'button', class: 'mr-btn mr-btn--text super-emergency', text: t('dlg.super.emergency') });
    const go = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: confirmLabel || t('dlg.confirm'), disabled: '' });
    actions.append(emergency, go);

    function refresh() {
      slider.disabled = !(key1 && key2);
      go.disabled = !(key1 && key2 && Number(slider.value) >= 100);
      fill.style.width = `${slider.value}%`;
    }
    k1.cb.addEventListener('change', () => { key1 = k1.cb.checked; refresh(); });
    k2.cb.addEventListener('change', () => { key2 = k2.cb.checked; refresh(); });
    slider.addEventListener('input', () => {
      if (!(key1 && key2)) { slider.value = 0; }
      fill.classList.toggle('charging', Number(slider.value) > 0 && !reducedMotionPreferred());
      refresh();
    });

    const finish = (ok) => { close(); resolve(ok); };
    go.addEventListener('click', () => finish(true));
    emergency.addEventListener('click', () => finish(false));

    box.append(heading, lead, k1.label, k2.label, hint, sliderWrap, actions);
    k1.cb.focus();
  });
}
