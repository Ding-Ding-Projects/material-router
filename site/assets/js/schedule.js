/* Scheduled settings: local-timezone rules that switch theme, language and
   other site values at chosen times. Values come from local fixed settings
   (a validated HTTPS API or Home-Assistant entity is the desktop app's
   route; a static page has neither, stated here). Later matching rule wins;
   edits are recorded in the history journal. */

import { el, uid, fmtDate, localTimezoneLabel, storage } from './util.js';
import { getSettings, updateSettings } from './store.js';
import { t } from './i18n.js';

const SCHEMA_VERSION = 1;

export function registerScheduleBundle(addBundle) {
  addBundle('schedule', {
    en: {
      'sc.title': 'Scheduled settings',
      'sc.lead': 'Rules apply appearance values at set times in your own timezone. When two rules match, the later one wins; when none matches your base choices return.',
      'sc.add': 'Add rule',
      'sc.label': 'Rule name',
      'sc.days': 'Days',
      'sc.everyday': 'Every day',
      'sc.time': 'Start – end',
      'sc.value': 'Applies',
      'sc.enabled': 'Enabled',
      'sc.empty': 'No rules yet. Add one to switch themes automatically.',
      'sc.tz': 'Interpreted in your device timezone:',
      'sc.crossMidnight': 'A rule may cross midnight; it then covers both listed days.',
      'sc.theme.light': 'Light theme', 'sc.theme.dark': 'Dark theme',
      'sc.lang.en': 'English', 'sc.lang.zh': 'Chinese (HK)', 'sc.lang.bi': 'Bilingual',
      'sc.invalid': 'Give the rule a name and valid times first.',
    },
    zh: {
      'sc.title': '定時設定',
      'sc.lead': '規則會喺你指定嘅時間、用你部機自己時區套用外觀設定。兩條規則撞時間，後面嗰條贏；無規則生效時就返你原本揀嘅值。',
      'sc.add': '加規則',
      'sc.label': '規則名',
      'sc.days': '星期',
      'sc.everyday': '每日',
      'sc.time': '開始 – 結束',
      'sc.value': '套用',
      'sc.enabled': '啟用',
      'sc.empty': '仲未有規則。加一條，主題就可以自動轉。',
      'sc.tz': '以下按你裝置時區解讀：',
      'sc.crossMidnight': '規則可以過午夜；咁就會橫跨前後兩日。',
      'sc.theme.light': '淺色主題', 'sc.theme.dark': '深色主題',
      'sc.lang.en': '英文', 'sc.lang.zh': '中文（香港）', 'sc.lang.bi': '雙語',
      'sc.invalid': '請先填名同比埋正確時間。',
    },
  });
}

function load() {
  const saved = storage.get('schedule', null);
  if (!saved || saved.schemaVersion !== SCHEMA_VERSION) return { schemaVersion: SCHEMA_VERSION, rules: [] };
  return saved;
}
function save(data) {
  storage.set('schedule', data);
  evaluate(true);
  document.dispatchEvent(new CustomEvent('site-history-record', {
    detail: { action: 'schedule-changed', label: t('sc.title') },
  }));
}

/* minutes since local midnight; handles windows crossing midnight */
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function dayIndexMondayFirst() {
  return (new Date().getDay() + 6) % 7;
}

function ruleMatches(rule) {
  if (!rule || rule.enabled === false) return false;
  const [sh, sm] = String(rule.start).split(':').map(Number);
  const [eh, em] = String(rule.end).split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return false;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const cur = nowMinutes();
  const today = dayIndexMondayFirst();
  let days = Array.isArray(rule.days) && rule.days.length ? rule.days : [0, 1, 2, 3, 4, 5, 6];
  const crossesMidnight = end <= start;
  const inWindow = crossesMidnight ? cur >= start || cur < end : cur >= start && cur < end;
  if (!inWindow) return false;
  if (crossesMidnight && cur < end) {
    // early-morning half: the previous day must be selected too
    const yesterday = (today + 6) % 7;
    return days.includes(today) || days.includes(yesterday);
  }
  return days.includes(today);
}

let lastApplied = null;
export function evaluate(force = false) {
  const s = getSettings();
  if (!s.scheduleEnabled && !force) return null;
  const data = load();
  const active = [...data.rules].reverse().find(ruleMatches); // later rule wins
  if (!active) {
    if (lastApplied && !force) {
      // base settings already restored by the user's own store values
      lastApplied = null;
    }
    return null;
  }
  lastApplied = active.id;
  if (active.value && active.value.startsWith('theme:')) {
    updateSettings({ appearance: { theme: active.value.split(':')[1] } });
  } else if (active.value && active.value.startsWith('lang:')) {
    updateSettings({ language: active.value.split(':')[1] });
  }
  return active;
}

export function buildScheduleEditor(mount) {
  mount.textContent = '';
  const data = load();

  mount.append(
    el('h3', { class: 'modal-title', text: t('sc.title') }),
    el('p', { class: 'setting-desc', text: t('sc.lead') }),
    el('p', { class: 'setting-desc mono', text: `${t('sc.tz')} ${localTimezoneLabel()} · ${t('sc.crossMidnight')}` }),
  );

  const listWrap = el('div', {});
  mount.append(listWrap);

  function renderList() {
    listWrap.textContent = '';
    if (!data.rules.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('sc.empty') }));
      return;
    }
    for (const rule of data.rules) {
      const enabledCb = el('input', { type: 'checkbox' });
      enabledCb.checked = rule.enabled !== false;
      enabledCb.setAttribute('aria-label', `${t('sc.enabled')}: ${rule.label}`);
      enabledCb.addEventListener('change', () => { rule.enabled = enabledCb.checked; save(data); });

      const rmBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('tb.close') });
      rmBtn.setAttribute('aria-label', `${t('tb.close')} ${rule.label}`);
      rmBtn.addEventListener('click', () => {
        data.rules = data.rules.filter((r) => r !== rule);
        save(data); renderList();
      });

      const valueSel = el('select', { class: 'mr-select', 'aria-label': `${t('sc.value')}: ${rule.label}` },
        [
          ['theme:light', t('sc.theme.light')],
          ['theme:dark', t('sc.theme.dark')],
          ['lang:en', t('sc.lang.en')],
          ['lang:zh', t('sc.lang.zh')],
          ['lang:bi', t('sc.lang.bi')],
        ].map(([v, l]) => el('option', { value: v, selected: rule.value === v ? '' : null, text: l })));
      valueSel.addEventListener('change', () => { rule.value = valueSel.value; save(data); renderList(); });

      listWrap.append(el('div', { class: 'centre-row schedule-row' }, [
        enabledCb,
        el('div', { class: 'centre-row-main' }, [
          el('div', { class: 'centre-row-title', text: rule.label }),
          el('div', { class: 'centre-row-body', text: `${daysLabel(rule)} · ${rule.start}–${rule.end} · ${fmtDate(Date.now())}` }),
        ]),
        valueSel,
        rmBtn,
      ]));
    }
  }

  function daysLabel(rule) {
    if (!rule.days || rule.days.length === 7) return t('sc.everyday');
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return rule.days.map((d) => names[d]).join(' ');
  }

  // create form: native date/time inputs, keyboard accessible
  const labelIn = el('input', { type: 'text', class: 'mr-input', placeholder: t('sc.label'), 'aria-label': t('sc.label') });
  const startIn = el('input', { type: 'time', class: 'mr-input', value: '22:00', 'aria-label': t('sc.time') });
  const endIn = el('input', { type: 'time', class: 'mr-input', value: '07:00', 'aria-label': t('sc.time') });
  const everydayCb = el('input', { type: 'checkbox', id: 'sched-everyday' });
  everydayCb.checked = true;
  const weekdayWrap = el('div', { class: 'weekday-wrap', role: 'group', 'aria-label': t('sc.days') });
  const dayBoxes = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name, idx) => {
    const cb = el('input', { type: 'checkbox', id: `sched-day-${idx}`, disabled: '' });
    cb.checked = true;
    cb.dataset.day = String(idx);
    cb.addEventListener('change', () => { everydayCb.checked = false; });
    const lbl = el('label', { class: 'flag-chip', for: `sched-day-${idx}` }, [cb, document.createTextNode(` ${name}`)]);
    weekdayWrap.append(lbl);
    return cb;
  });
  everydayCb.addEventListener('change', () => {
    for (const cb of dayBoxes) { cb.checked = true; cb.disabled = everydayCb.checked; }
  });
  const valueSel = el('select', { class: 'mr-select' },
    [
      ['theme:dark', t('sc.theme.dark')],
      ['theme:light', t('sc.theme.light')],
      ['lang:zh', t('sc.lang.zh')],
      ['lang:en', t('sc.lang.en')],
      ['lang:bi', t('sc.lang.bi')],
    ].map(([v, l]) => el('option', { value: v, text: l })));

  const err = el('p', { class: 'form-error', hidden: '', role: 'alert', text: t('sc.invalid') });
  const addBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--filled', text: t('sc.add') });
  addBtn.addEventListener('click', () => {
    const label = labelIn.value.trim().slice(0, 60);
    const timeOk = /^\d{2}:\d{2}$/.test(startIn.value) && /^\d{2}:\d{2}$/.test(endIn.value);
    if (!label || !timeOk) { err.hidden = false; return; }
    err.hidden = true;
    const days = everydayCb.checked ? [0, 1, 2, 3, 4, 5, 6] : dayBoxes.filter((cb) => cb.checked).map((cb) => Number(cb.dataset.day));
    data.rules.push({
      id: uid('rule'), schemaVersion: SCHEMA_VERSION, label,
      start: startIn.value, end: endIn.value, days,
      value: valueSel.value, enabled: true,
    });
    save(data); renderList();
    labelIn.value = '';
  });

  const form = el('div', { class: 'schedule-form' }, [
    el('label', { class: 'setting-label' }, [document.createTextNode(t('sc.label')), labelIn]),
    el('label', { class: 'setting-label' }, [document.createTextNode(t('sc.time')), el('span', { class: 'pair' }, [startIn, endIn])]),
    el('label', { class: 'setting-label checkline' }, [everydayCb, document.createTextNode(` ${t('sc.everyday')}`)]),
    weekdayWrap,
    el('label', { class: 'setting-label' }, [document.createTextNode(t('sc.value')), valueSel]),
    addBtn, err,
  ]);
  mount.append(form);
  renderList();
}
