/* Focus aids: interface accommodations, off by default, never medical.
   Low stimulation quiets decoration; time awareness shows how long this
   session has been open; one next action persists across pages. */

import { el, storage } from './util.js';
import { getSettings, updateSettings } from './store.js';
import { t } from './i18n.js';

export function registerAdhdBundle(addBundle) {
  addBundle('adhd', {
    en: {
      'ad.title': 'Focus aids',
      'ad.lead': 'Interface accommodations, each off by default and each independent. These are interface options, not medical features, and nothing about them says anything about any person.',
      'ad.low': 'Low stimulation (quieter colour, no non-essential motion)',
      'ad.time': 'Show how long this visit has been open',
      'ad.next': 'One next action (stays until you change it)',
      'ad.nextPlaceholder': 'e.g. Read the routing article',
      'ad.elapsed': 'Open for',
      'ad.fact': 'Nothing here has changed for a while is a fact, not a nudge.',
    },
    zh: {
      'ad.title': '專注幫手',
      'ad.lead': '介面調節，每個都預設關閉、各自獨立。呢啲係介面選項，唔係醫療功能，亦都唔代表用唔用嘅人係點。',
      'ad.low': '低刺激（色調收斂、無多餘動畫）',
      'ad.time': '顯示今次瀏覽開咗幾耐',
      'ad.next': '下一步（留到你改為止）',
      'ad.nextPlaceholder': '例如：睇路由嗰篇文',
      'ad.elapsed': '已開咗',
      'ad.fact': '好耐無嘢變過係一個事實，唔係催促。',
    },
  });
}

export function initFocusAids() {
  const s = getSettings();
  document.documentElement.classList.toggle('low-stimulation', s.lowStimulation === true);

  if (s.showSessionTime) mountSessionChip();
  if (s.nextAction) mountNextAction();
}

function mountSessionChip() {
  if (document.getElementById('session-chip')) return;
  if (!storage.get('session-start', null)) {
    storage.set('session-start', Date.now());
  }
  const chip = el('div', { class: 'session-chip mono', id: 'session-chip', role: 'timer' });
  const tick = () => {
    const start = storage.get('session-start', Date.now());
    const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
    chip.textContent = `${t('ad.elapsed')} ${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 1000);
  document.body.append(chip);
}

function mountNextAction() {
  if (document.getElementById('next-action')) return;
  const s = getSettings();
  const wrap = el('div', { class: 'next-action', id: 'next-action' });
  const cb = el('input', { type: 'checkbox', id: 'next-action-done' });
  const label = el('label', { for: 'next-action-done', text: s.nextAction || '' });
  cb.checked = !!storage.get('next-action-done', false);
  cb.addEventListener('change', () => storage.set('next-action-done', cb.checked));
  const clearBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: '✕', 'aria-label': t('dlg.cancel') });
  clearBtn.addEventListener('click', () => {
    updateSettings({ nextAction: '' });
    wrap.remove();
  });
  if (cb.checked) label.style.textDecoration = 'line-through';
  cb.addEventListener('change', () => {
    label.style.textDecoration = cb.checked ? 'line-through' : '';
  });
  wrap.append(cb, label, clearBtn);
  document.body.append(wrap);
}

export function buildFocusAidsEditor(mount) {
  const s = getSettings();
  mount.append(
    el('h3', { class: 'modal-title', text: t('ad.title') }),
    el('p', { class: 'setting-desc', text: t('ad.lead') }),
  );

  const lowCb = el('input', { type: 'checkbox', id: 'ad-low' });
  lowCb.checked = s.lowStimulation;
  lowCb.addEventListener('change', () => {
    updateSettings({ lowStimulation: lowCb.checked });
    document.documentElement.classList.toggle('low-stimulation', lowCb.checked);
  });

  const timeCb = el('input', { type: 'checkbox', id: 'ad-time' });
  timeCb.checked = s.showSessionTime;
  timeCb.addEventListener('change', () => {
    updateSettings({ showSessionTime: timeCb.checked });
    if (timeCb.checked) { mountSessionChip(); }
    else { const chip = document.getElementById('session-chip'); if (chip) chip.remove(); }
  });

  const nextIn = el('input', { type: 'text', class: 'mr-input', id: 'ad-next', maxlength: '120', value: s.nextAction || '', placeholder: t('ad.nextPlaceholder') });
  nextIn.addEventListener('change', () => {
    updateSettings({ nextAction: nextIn.value.trim().slice(0, 120) });
    const existing = document.getElementById('next-action');
    if (existing) existing.remove();
    if (nextIn.value.trim()) mountNextAction();
  });

  const row = (labelText, ctrl) => el('label', { class: 'setting-label' }, [document.createTextNode(labelText), ctrl]);
  mount.append(
    row(t('ad.low'), lowCb),
    row(t('ad.time'), timeCb),
    row(t('ad.next'), nextIn),
    el('p', { class: 'setting-desc', text: t('ad.fact') }),
  );
}
