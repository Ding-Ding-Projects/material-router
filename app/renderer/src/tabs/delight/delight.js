// Purpose: Modes & Delights tab - the Delight lane's home surface. Hosts
// language modes completion, personal vocabulary, School mode, toy locks,
// Support Tickets, attention modes and the unlock ladder entry points as
// browser-style sub tabs; registers searchable Settings sections; adds
// command-palette coverage; boots the global effects (locks enforcement,
// ADHD modes, dim sum surprise).
// Owned by Delight lane - keep the registerTab call and the exported tab id
// ('delight') stable.

import { h } from '../../core/util.js';
import { t, addBundle } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { registerSettingsSection } from '../../core/settings-ui.js';
import * as settings from '../../core/settings.js';
import * as palette from '../../core/palette.js';

import { en } from './i18n/delight.en.js';
import { zh } from './i18n/delight.zh.js';
addBundle('delight', { en, zh });

import { renderModesSection, registerModesSettingsSection } from './modes.js';
import { renderVocabSection } from './vocab.js';
import { renderSchoolSection } from './school.js';
import { bootLocks, renderLocksSection } from './locks.js';
import { renderTicketsSection } from './tickets.js';
import { renderAdhdSection, bootAdhd } from './adhd.js';
import { bootDimSumSurprise } from './dimsum.js';
import { whenReady, dc } from './common.js';

const SECTIONS = [
  { id: 'modes', labelKey: 'dl.common.sectionModes' },
  { id: 'vocab', labelKey: 'dl.common.sectionVocab' },
  { id: 'school', labelKey: 'dl.common.sectionSchool' },
  { id: 'locks', labelKey: 'dl.locks.section' },
  { id: 'adhd', labelKey: 'dl.adhd.section' },
  { id: 'tickets', labelKey: 'dl.tickets.section' },
];

let activeSection = 'modes';
let sectionHostRef = null;

function render(container) {
  container.replaceChildren();
  container.append(h('h1', { class: 'mr-typography-headline-small' }, t('tabs.delight')));

  const tabBar = h('div', { class: 'm3-tabs', role: 'tablist', 'aria-label': t('tabs.delight') });
  const host = h('div', { class: 'mr-col', style: 'gap:16px;margin-top:12px;overflow-y:auto;min-height:0' });
  sectionHostRef = host;

  for (const s of SECTIONS) {
    const btn = h('button', {
      class: 'm3-tab',
      role: 'tab',
      id: `mr-delight-tab-${s.id}`,
      'aria-selected': String(activeSection === s.id),
      'aria-controls': `mr-delight-panel-${s.id}`,
      onclick: () => showSection(s.id),
    }, t(s.labelKey));
    tabBar.append(btn);
  }

  const panel = h('div', { role: 'tabpanel', id: `mr-delight-panel-${activeSection}`, 'aria-labelledby': `mr-delight-tab-${activeSection}` });
  container.append(tabBar, panel);
  panel.append(host);

  showSection(activeSection);
  ensureLanguagePass();
}

/**
 * Live retranslate: rebuild the tab's own chrome (title, sub-tab labels) and
 * re-invoke the active section's existing render function. Sub-sections with
 * their own settings subscriptions (modes, school) re-render through those
 * too; this pass keeps them consistent on School-mode flips as well.
 * Draft safety: the ticket form and the attention-mode pin hold uncommitted
 * text, so both are captured before the rebuild and restored afterwards (the
 * ticket description re-fires its input listener so Submit re-enables).
 */
let languageUnsub = null;
function ensureLanguagePass() {
  if (languageUnsub) return;
  languageUnsub = settings.onChange((key) => {
    if (key !== 'general.languageMode' && key !== 'school.active') return;
    const panelEl = document.getElementById('mr-tab-panel-delight');
    if (!panelEl?.isConnected || !sectionHostRef) return;
    const panelScroll = panelEl.scrollTop;
    const hostScroll = sectionHostRef.scrollTop;
    const drafts = {
      ticketDesc: document.getElementById('mr-ticket-desc')?.value ?? '',
      ticketCat: document.getElementById('mr-ticket-cat')?.value ?? null,
      adhdPin: document.getElementById('mr-adhd-pin')?.value ?? null,
    };
    render(panelEl);
    sectionHostRef.scrollTop = hostScroll;
    panelEl.scrollTop = panelScroll;
    const restoreDrafts = () => {
      const descEl = document.getElementById('mr-ticket-desc');
      if (descEl && drafts.ticketDesc && !descEl.value) {
        descEl.value = drafts.ticketDesc;
        // Re-fires the form's input listener so Submit re-enables honestly.
        descEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const catEl = document.getElementById('mr-ticket-cat');
      if (catEl && drafts.ticketCat && !catEl.dataset.mrRestored) {
        catEl.value = drafts.ticketCat;
        catEl.dataset.mrRestored = '1';
      }
      const pinEl = document.getElementById('mr-adhd-pin');
      if (pinEl && drafts.adhdPin != null && !pinEl.value) pinEl.value = drafts.adhdPin;
    };
    restoreDrafts();
    // The tickets section renders asynchronously (it awaits its reload), so
    // when it was the active section the form does not exist yet; retry
    // briefly and only while the form was missing at the first attempt.
    if (drafts.ticketDesc && !document.getElementById('mr-ticket-desc')) {
      setTimeout(restoreDrafts, 60);
      setTimeout(restoreDrafts, 250);
    }
    registerDelightPaletteItems();
  });
}

function showSection(id) {
  activeSection = id;
  const container = sectionHostRef?.parentElement;
  if (!container || !sectionHostRef) return;
  for (const btn of document.querySelectorAll('#mr-delight-tabs [role=tab], .m3-tabs [role=tab]')) {
    if (btn.id?.startsWith('mr-delight-tab-')) {
      btn.setAttribute('aria-selected', String(btn.id === `mr-delight-tab-${id}`));
    }
  }
  sectionHostRef.replaceChildren();
  const def = SECTIONS.find((s) => s.id === id);
  const panel = sectionHostRef.parentElement;
  panel.id = `mr-delight-panel-${id}`;
  panel.setAttribute('aria-labelledby', `mr-delight-tab-${id}`);

  switch (def?.id) {
    case 'modes': return renderModesSection(sectionHostRef);
    case 'vocab': return renderVocabSection(sectionHostRef);
    case 'school': return renderSchoolSection(sectionHostRef);
    case 'locks': return renderLocksSection(sectionHostRef);
    case 'adhd': return renderAdhdSection(sectionHostRef);
    case 'tickets': return renderTicketsSection(sectionHostRef).catch(() => {});
    default: return undefined;
  }
}

function openSupportDesk(topic = null) {
  // Teleport into this tab's tickets section from anywhere.
  import('../../core/tabs.js').then(({ activate }) => activate('delight')).catch(() => {});
  activeSection = 'tickets';
  setTimeout(() => {
    if (!sectionHostRef) return;
    showSection('tickets');
    if (topic === 'lockout') {
      const cat = document.getElementById('mr-ticket-cat');
      if (cat) cat.value = 'lockout';
    }
  }, 120);
}

if (typeof window !== 'undefined') {
  window.addEventListener('mr:open-support-tickets', () => openSupportDesk('lockout'));
}

registerTab({
  id: 'delight',
  label: { en: 'Modes & Delights', zh: '模式與趣味' },
  get icon() {
    return iconFromPath('M12 2l1.9 5.7L19.6 9.6l-5.7 1.9L12 17.2l-1.9-5.7L4.4 9.6l5.7-1.9L12 2Zm6 13 .95 2.85 2.85.95-2.85.95L18 22.6l-.95-2.85-2.85-.95 2.85-.95L18 15Z');
  },
  init: render,
});

// -- searchable Settings sections ------------------------------------------------

registerModesSettingsSection(registerSettingsSection);

registerSettingsSection({
  id: 'delight-school',
  label: { en: 'School mode', zh: '學校模式' },
  render(container) { renderSchoolSection(container); },
  entries: [
    { label: { en: 'School mode switch', zh: '學校模式開關' }, keywords: ['school', 'mode', 'english only'], resolve: () => null },
    { label: { en: 'Rename School mode', zh: '為學校模式改名' }, keywords: ['rename', 'school'], resolve: () => document.getElementById('mr-school-name') },
  ],
});

registerSettingsSection({
  id: 'delight-vocabulary',
  label: { en: 'Personal vocabulary', zh: '個人詞彙表' },
  render(container) { renderVocabSection(container); },
  entries: [
    { label: { en: 'Personal vocabulary upload', zh: '個人詞彙表上載' }, keywords: ['vocabulary', 'json', 'replace words'], resolve: () => document.getElementById('mr-vocab-file') },
  ],
});

registerSettingsSection({
  id: 'delight-adhd',
  label: { en: 'Attention modes', zh: '專注模式' },
  render(container) { renderAdhdSection(container); },
  entries: [
    { label: { en: 'Attention modes (Focus, low stimulation, time awareness)', zh: '專注模式（聚焦、低刺激、時間感知）' }, keywords: ['adhd', 'focus', 'attention', 'momentum', 'stimulation'], resolve: () => null },
    { label: { en: 'Momentum idle minutes', zh: '提示前嘅安靜分鐘數' }, keywords: ['idle', 'minutes', 'momentum'], resolve: () => document.getElementById('mr-adhd-idle') },
    { label: { en: 'Next-action pin', zh: '下一步釘選' }, keywords: ['one thing', 'pin', 'next action'], resolve: () => document.getElementById('mr-adhd-pin') },
  ],
});

// -- command palette coverage ------------------------------------------------------
// Wrapped so the language-change pass can re-register localized titles
// (palette.register replaces entries by id).

function registerDelightPaletteItems() {
  palette.register({
    id: 'delight.open',
    title: t('tabs.delight'),
    section: 'Tabs',
    run: () => { import('../../core/tabs.js').then(({ activate }) => activate('delight')); },
  });
  palette.register({
    id: 'delight.support',
    title: t('dl.tickets.title'),
    section: 'Actions',
    keywords: ['support', 'ticket', 'locked out', 'forgot password'],
    run: () => openSupportDesk(null),
  });
  palette.register({
    id: 'delight.school',
    title: t('dl.common.sectionSchool'),
    section: 'Settings',
    keywords: ['school', 'english only'],
    run: () => { import('../../core/tabs.js').then(({ activate }) => activate('delight')).then(() => showSection('school')); },
  });
  palette.register({
    id: 'delight.adhd.focus',
    title: t('dl.adhd.focus'),
    section: 'Settings',
    keywords: ['focus', 'dim'],
    control(holder) {
      const input = h('input', {
        type: 'checkbox',
        'aria-label': t('dl.adhd.focus'),
        onchange: async (e) => {
          const { set } = await import('../../core/settings.js');
          await set('adhd.focus', Boolean(e.target.checked));
        },
      });
      whenReady(() => {
        import('../../core/settings.js').then(({ get }) => { input.checked = Boolean(get('adhd.focus', false)); });
      });
      holder.append(h('label', { class: 'm3-switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'thumb' }))));
    },
    run() {
      import('../../core/settings.js').then(async ({ get, set }) => {
        await set('adhd.focus', !get('adhd.focus', false));
      });
    },
  });
  palette.register({
    id: 'delight.adhd.lowStim',
    title: t('dl.adhd.lowStim'),
    section: 'Settings',
    keywords: ['low stimulation', 'motion'],
    run() {
      import('../../core/settings.js').then(async ({ get, set }) => {
        await set('adhd.lowStimulation', !get('adhd.lowStimulation', false));
      });
    },
  });
}

registerDelightPaletteItems();

// -- boot global effects -------------------------------------------------------------

whenReady(() => {
  bootLocks();
  bootAdhd();
  bootDimSumSurprise();
});

void dc;
