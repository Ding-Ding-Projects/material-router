/* Support Tickets: the recovery route for a forgotten lock credential,
   dressed as a service desk. The joke is the point — and one plain line
   says nothing is sent anywhere. The "resolution" shows exactly which
   browser storage to clear; clearing it is the user's own action behind a
   destructive confirmation. */

import { el, uid, fmtDateTime } from './util.js';
import { destructiveConfirm } from './dialogs.js';
import { t } from './i18n.js';

export function registerSupportBundle(addBundle) {
  addBundle('support', {
    en: {
      'sp.title': 'Support Tickets',
      'sp.forgot': 'Forgotten your password?',
      'sp.category': 'Category',
      'sp.cat.lock': 'I locked myself out',
      'sp.cat.other': 'Something else (nobody will read this)',
      'sp.desc': 'Describe the problem',
      'sp.submit': 'Submit ticket',
      'sp.list': 'Your tickets',
      'sp.empty': 'No tickets yet. Long may it last.',
      'sp.created': 'Ticket created',
      'sp.status.new': 'New',
      'sp.status.triage': 'Triaged (by nobody)',
      'sp.status.resolved': 'Resolved',
      'sp.resolve': 'View resolution',
      'sp.resolutionTitle': 'Resolution',
      'sp.resolutionBody': 'The only fix that works: clear this site\'s storage in your browser. That resets every tab lock, every setting and this ticket list in one go.',
      'sp.openSettings': 'Open "Clear site data"…',
      'sp.plain': 'Nothing here is sent anywhere. No network request is made, no ticket exists outside this browser, no data is collected, and no person is reading this.',
      'sp.severity': 'Severity',
      'sp.sev.critical': 'Critical (decorative)',
      'sp.firstResponse': 'First response',
    },
    zh: {
      'sp.title': '客戶支援服務枱',
      'sp.forgot': '唔記得咗密碼？',
      'sp.category': '類別',
      'sp.cat.lock': '我鎖死咗自己入唔返去',
      'sp.cat.other': '其他（反正冇人會睇）',
      'sp.desc': '描述下個問題',
      'sp.submit': '提交工單',
      'sp.list': '你嘅工單',
      'sp.empty': '仲未有任何工單。繼續保持。',
      'sp.created': '已開單',
      'sp.status.new': '新單',
      'sp.status.triage': '已分類（分俾邊個？冇人）',
      'sp.status.resolved': '已解決',
      'sp.resolve': '睇解決方法',
      'sp.resolutionTitle': '解決方法',
      'sp.resolutionBody': '唯一有效嘅方法：喺瀏覽器度清除呢個網站嘅儲存。一次過重置所有分頁鎖、所有設定、埋呢張工單清單。',
      'sp.openSettings': '開「清除網站資料」……',
      'sp.plain': '呢度任何嘢都唔會送出去。無網絡請求、張單只存在於你部瀏覽器、無收集任何資料、亦都冇人會睇。',
      'sp.severity': '嚴重程度',
      'sp.sev.critical': '極危急（裝飾用）',
      'sp.firstResponse': '首次回覆',
    },
  });
}

function tickets() {
  try { return JSON.parse(localStorage.getItem('mr-site:support-tickets') || '[]'); }
  catch { return []; }
}
function saveTickets(list) {
  localStorage.setItem('mr-site:support-tickets', JSON.stringify(list.slice(-50)));
}

export function openSupportTickets() {
  const scrim = el('div', { class: 'modal-scrim' });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sp-title' });

  box.append(
    el('h2', { id: 'sp-title', class: 'modal-title', text: t('sp.title') }),
    // the one unmissable plain line, styled plainly regardless of funny level
    el('p', { class: 'support-plain-line', text: t('sp.plain') }),
  );

  const catSel = el('select', { class: 'mr-select', id: 'sp-cat' },
    [t('sp.cat.lock'), t('sp.cat.other')].map((l) => el('option', { value: l, text: l })));
  const sevSel = el('select', { class: 'mr-select', id: 'sp-sev' },
    [t('sp.sev.critical'), 'High', 'Medium', 'Low'].map((l) => el('option', { value: l, text: l })));
  const descIn = el('textarea', { class: 'mr-input', rows: '3', maxlength: '500', id: 'sp-desc', placeholder: t('sp.desc') });

  const formRow = el('div', { class: 'schedule-form' }, [
    el('label', { class: 'setting-label' }, [document.createTextNode(t('sp.category')), catSel]),
    el('label', { class: 'setting-label' }, [document.createTextNode(t('sp.severity')), sevSel]),
    descIn,
  ]);
  box.append(formRow);

  const submitBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--filled', text: t('sp.submit') });
  const numberSpan = el('span', { class: 'centre-count' });
  submitBtn.addEventListener('click', () => {
    const list = tickets();
    const number = `MR-${String(1000 + Math.floor(Math.random() * 9000))}`;
    list.push({
      id: uid('tk'), number,
      category: catSel.value, severity: sevSel.value,
      description: descIn.value.slice(0, 500),
      createdAt: new Date().toISOString(),
      status: t('sp.status.triage'),
    });
    saveTickets(list);
    numberSpan.textContent = `${t('sp.created')} · ${number}`;
    renderList();
  });

  const listWrap = el('div', { class: 'centre-list' });
  function renderList() {
    listWrap.textContent = '';
    const list = tickets();
    if (!list.length) {
      listWrap.append(el('p', { class: 'empty-state', text: t('sp.empty') }));
      return;
    }
    for (const tk of [...list].reverse()) {
      const resolveBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('sp.resolve') });
      resolveBtn.addEventListener('click', async () => {
        // advance status then show the resolution
        const all = tickets();
        const rec = all.find((x) => x.id === tk.id);
        if (rec) rec.status = t('sp.status.resolved');
        saveTickets(all);
        renderList();
        await showResolution();
      });
      listWrap.append(el('div', { class: 'centre-row' }, [
        el('div', { class: 'centre-row-main' }, [
          el('div', { class: 'centre-row-title mono', text: `${tk.number} · ${tk.status}` }),
          el('div', { class: 'centre-row-body', text: `${tk.category} · ${fmtDateTime(tk.createdAt)}` }),
        ]),
        resolveBtn,
      ]));
    }
  }

  async function showResolution() {
    const ok = await destructiveConfirm({
      title: t('sp.resolutionTitle'),
      detail: t('sp.resolutionBody'),
      confirmLabel: t('sp.openSettings'),
    });
    if (!ok) return;
    // The app never deletes anything itself: hand the user to the browser's
    // own surface for this origin.
    try {
      if (document.hasStorageAccess === undefined || true) {
        window.open('chrome://settings/siteData', '_blank', 'noopener');
      }
    } catch { /* browser refused; the instructions above still stand */ }
    scrim.remove();
  }

  const actions = el('div', { class: 'modal-actions' }, [submitBtn, numberSpan]);
  box.append(actions, el('h3', { class: 'field-label', text: t('sp.list') }), listWrap);

  const closeBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: '✕', 'aria-label': t('dlg.cancel') });
  closeBtn.addEventListener('click', () => scrim.remove());
  actions.prepend(closeBtn);

  scrim.append(box);
  document.body.append(scrim);
  renderList();
  const escHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); scrim.remove(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
}
