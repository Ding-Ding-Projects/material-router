/* Settings page controller: a tabbed settings surface with its own search,
   every section searchable through the anchored regex builder. Sections:
   Appearance, Language & tone, Tabs, Tab locks, Scheduled, Focus aids,
   History, Your data. */

import { el, downloadBlob, storage, fmtDateTime } from './util.js';
import { t, copy, applyDom } from './i18n.js';
import { getSettings, updateSettings, replaceSettings, onSettings } from './store.js';
import { createSearchBar } from './searchbar.js';
import { buildAppearanceEditor } from './appearance.js';
import { buildDockSwitcher, buildGroupManager } from './tabs.js';
import { buildLockManager } from './locks.js';
import { buildScheduleEditor } from './schedule.js';
import { buildHistoryPanel } from './history.js';
import { buildFocusAidsEditor } from './adhd.js';
import { destructiveConfirm } from './dialogs.js';
import { notify } from './toasts.js';

export function initSettingsPage() {
  const root = document.getElementById('settings-root');
  if (!root) return;

  // search first: filters every section's rows
  const searchMount = el('div', {});
  root.append(searchMount);
  const state = { mode: 'plain', pattern: '', flags: 'i' };
  createSearchBar(searchMount, {
    ariaLabel: t('set.search'),
    placeholder: t('set.searchPlaceholder'),
    onQuery(next) {
      Object.assign(state, next);
      filterSections();
    },
  });
  const noMatch = el('p', { class: 'empty-state', hidden: '', text: t('set.noMatch') });
  root.append(noMatch);

  const sections = [];
  let tablist = null;
  let panelsWrap = null;

  function addSection(id, titleKey, build) {
    const host = el('section', { class: 'settings-section', id: `sec-${id}`, role: 'tabpanel', 'aria-labelledby': `tab-${id}`, tabindex: '-1', dataset: { sectionId: id } });
    host.append(el('h2', { text: t(titleKey) }));
    build(host);
    sections.push({ id, titleKey, host });
  }

  addSection('appearance', 'set.appearance', (host) => {
    buildAppearanceEditor(host);
    host.append(el('p', { class: 'setting-desc provenance', text: t('set.provenance') }));
  });

  addSection('language', 'set.tone', (host) => {
    const s = getSettings();
    const langSel = el('select', { class: 'mr-select', id: 'lang-sel' },
      ['en', 'zh', 'bi'].map((v) => el('option', { value: v, selected: s.language === v ? '' : null, text: t(`set.lang.${v}`) })));
    langSel.addEventListener('change', () => updateSettings({ language: langSel.value }));

    const funnyEn = el('input', { type: 'range', min: '1', max: '5', step: '1', value: String(s.funnyEn), id: 'funny-en' });
    const funnyZh = el('input', { type: 'range', min: '1', max: '5', step: '1', value: String(s.funnyZh), id: 'funny-zh' });
    const enOut = el('output', { class: 'mono', for: 'funny-en', text: String(s.funnyEn) });
    const zhOut = el('output', { class: 'mono', for: 'funny-zh', text: String(s.funnyZh) });
    funnyEn.addEventListener('input', () => { enOut.textContent = funnyEn.value; updateSettings({ funnyEn: Number(funnyEn.value) }); });
    funnyZh.addEventListener('input', () => { zhOut.textContent = funnyZh.value; updateSettings({ funnyZh: Number(funnyZh.value) }); });

    const emojiCb = el('input', { type: 'checkbox', id: 'emoji-cb' });
    emojiCb.checked = s.emojiOn;
    emojiCb.addEventListener('change', () => updateSettings({ emojiOn: emojiCb.checked }));

    const schoolCb = el('input', { type: 'checkbox', id: 'school-cb' });
    schoolCb.checked = s.schoolMode;
    schoolCb.addEventListener('change', () => updateSettings({ schoolMode: schoolCb.checked }));

    const row = (labelText, ctrl) => el('label', { class: 'setting-label' }, [document.createTextNode(labelText), ctrl]);
    host.append(
      row(t('set.language'), langSel),
      el('div', { class: 'setting-row sliderline' }, [
        el('label', { class: 'setting-label', for: 'funny-en' }, [document.createTextNode(t('set.funnyEn'))]),
        funnyEn, enOut,
      ]),
      el('div', { class: 'setting-row sliderline' }, [
        el('label', { class: 'setting-label', for: 'funny-zh' }, [document.createTextNode(t('set.funnyZh'))]),
        funnyZh, zhOut,
      ]),
      el('label', { class: 'setting-label checkline' }, [emojiCb, document.createTextNode(` ${t('set.emoji')}`)]),
      el('label', { class: 'setting-label checkline' }, [schoolCb, document.createTextNode(` ${t('set.school')}`)]),
      el('p', { class: 'setting-desc', text: t('set.disclosure') }),
    );
  });

  addSection('tabs', 'set.tabs', (host) => {
    const dockMount = el('div', {});
    const groupsMount = el('div', {});
    host.append(
      el('div', { class: 'setting-row' }, [el('span', { class: 'setting-label', text: t('tb.dock') }), dockMount]),
      el('h3', { class: 'field-label', text: t('tb.groups') }),
      groupsMount,
    );
    buildDockSwitcher(dockMount);
    buildGroupManager(groupsMount);
  });

  addSection('locks', 'set.locks', (host) => {
    const lockMount = el('div', {});
    host.append(lockMount);
    buildLockManager(lockMount);
  });

  addSection('schedule', 'set.schedule', (host) => {
    const schedMount = el('div', {});
    host.append(schedMount);
    buildScheduleEditor(schedMount);
  });

  addSection('focus', 'ad.title', (host) => {
    buildFocusAidsEditor(host);
  });

  addSection('history', 'set.history', (host) => {
    const histMount = el('div', {});
    host.append(histMount);
    buildHistoryPanel(histMount);
  });

  addSection('data', 'set.data', (host) => {
    const exportBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--filled', id: 'btn-export-settings', text: t('set.export') });
    exportBtn.addEventListener('click', () => {
      const payload = JSON.stringify({
        exportedBy: 'material-router documentation site',
        exportedAt: new Date().toISOString(),
        note: 'Contains this browser\'s site preferences only. No credentials exist on the static site.',
        settings: getSettings(),
        schedule: storage.get('schedule', {}),
        tabs: storage.get('tabstate', {}),
      }, null, 2);
      downloadBlob('material-router-site-settings.json', payload, 'application/json');
      recordExported();
      notify({ title: t('set.exported'), kind: 'success' });
    });

    const resetBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--danger', text: t('set.resetAll') });
    resetBtn.addEventListener('click', async () => {
      const keys = storage.keys().length;
      const ok = await destructiveConfirm({
        detail: t('set.resetConfirm'),
        affectedItems: `${keys} ×`,
      });
      if (!ok) return;
      for (const k of storage.keys()) storage.remove(k);
      location.reload();
    });

    host.append(exportBtn, resetBtn);
  });

  async function recordExported() {
    const { recordHistory } = await import('./history.js');
    recordHistory({ action: 'exported', label: t('set.export'), at: fmtDateTime(Date.now()) });
  }

  /* tabbed presentation of the sections */
  function renderTabs() {
    if (tablist) tablist.remove();
    if (panelsWrap) panelsWrap.remove();
    tablist = el('div', { class: 'settings-tabstrip', role: 'tablist', 'aria-label': t('set.title') });
    panelsWrap = el('div', { class: 'settings-panels' });
    for (const sec of sections) {
      const btn = el('button', {
        type: 'button', class: 'settings-tab', role: 'tab', id: `tab-${sec.id}`,
        'aria-selected': 'false', 'aria-controls': `sec-${sec.id}`, tabindex: '-1',
        text: t(sec.titleKey),
      });
      btn.addEventListener('click', () => activate(sec.id));
      btn.addEventListener('keydown', (e) => {
        const idx = sections.findIndex((s2) => s2.id === sec.id);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          activate(sections[(idx + 1) % sections.length].id);
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          activate(sections[(idx - 1 + sections.length) % sections.length].id);
        }
      });
      tablist.append(btn);
      panelsWrap.append(sec.host);
    }
    searchMount.after(tablist, panelsWrap);
    activate(location.hash ? `sec-${location.hash.slice(1)}` : sections[0].id, { fromHash: true });
  }

  function activate(id, { fromHash = false } = {}) {
    const target = sections.find((s2) => s2.id === id.replace(/^sec-/, '')) || sections[0];
    for (const sec of sections) {
      const on = sec.id === target.id;
      sec.host.hidden = !on;
      sec.host.classList.toggle('is-active', on);
      const btn = tablist.querySelector(`#tab-${sec.id}`);
      if (btn) {
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
      }
    }
    const activeBtn = tablist.querySelector(`#tab-${target.id}`);
    if (activeBtn && !fromHash) activeBtn.focus();
    if (activeBtn) activeBtn.scrollIntoView({ block: 'nearest' });
  }

  function filterSections() {
    const q = state.pattern.trim().toLowerCase();
    let anyVisible = false;
    for (const sec of sections) {
      if (!q) {
        sec.host.style.display = sec.host.classList.contains('is-active') ? '' : 'none';
        anyVisible = true;
        continue;
      }
      const hay = sec.host.textContent.toLowerCase();
      let hit;
      if (state.mode === 'regex') {
        try { hit = new RegExp(state.pattern, state.flags.replace('g', '') || undefined).test(hay); }
        catch { hit = true; }
      } else {
        hit = hay.includes(q);
      }
      sec.host.style.display = hit ? '' : 'none';
      if (hit) anyVisible = true;
    }
    noMatch.hidden = anyVisible || !q;
    if (q) {
      tablist.style.display = 'none';
    } else {
      tablist.style.display = '';
      // restore normal tab behaviour
      for (const sec of sections) {
        sec.host.style.display = sec.host.classList.contains('is-active') ? '' : 'none';
      }
    }
  }

  renderTabs();
  applyDom();

  // reflect live changes into controls that show values
  onSettings(() => {
    const s = getSettings();
    const langSel = document.getElementById('lang-sel');
    if (langSel && langSel.value !== s.language) langSel.value = s.language;
  });
}

/* init: either main.js's mr-settings-ready event, or a direct load */
let booted = false;
function bootOnce() {
  if (booted) return;
  booted = true;
  initSettingsPage();
}
window.addEventListener('mr-settings-ready', bootOnce);
if (document.readyState !== 'loading' && document.getElementById('settings-root')) {
  bootOnce();
}
