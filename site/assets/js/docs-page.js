/* Docs hub controller: article index with its own filter search
   (regex builder anchored, plain text default). */

import { el } from './util.js';
import { t } from './i18n.js';
import { createSearchBar } from './searchbar.js';
import { PAGES } from './pages-data.js';

const ARTICLES = PAGES.filter((p) => p.href.startsWith('articles/'));

const BLURBS = {
  routing: {
    en: 'Local endpoints on 127.0.0.1 and the OpenAI ↔ Anthropic translator: requests, responses and streams.',
    zh: '喺127.0.0.1開本地端點，同OpenAI ↔ Anthropic翻譯器：請求、回應、串流全部搞掂。',
  },
  builder: {
    en: 'Compose, save and send requests through the router without touching JSON.',
    zh: '唔使掂JSON，都可以砌好、儲存同發送經路由器嘅請求。',
  },
  providers: {
    en: 'Bring your own keys: encrypted storage, provider records, priority-ordered rules.',
    zh: '自帶金鑰：加密儲存、供應商紀錄、有優先次序嘅規則。',
  },
  modes: {
    en: 'English / Hong Kong Chinese / bilingual, two funny-level sliders, School mode.',
    zh: '英文／香港中文／雙語，兩條搞笑程度滑桿，仲有返學模式。',
  },
  appearance: {
    en: 'Material Design 3 themes today; per-element editors, presets and export as they land.',
    zh: '而家有Material Design 3主題；逐元素編輯、預設集、匯出會陸續有來。',
  },
  toolbox: {
    en: 'Notification centre and history journal today; file conversion planned by the Utility lane.',
    zh: '而家有通知中心同歷史日誌；檔案轉換由Utility lane計緊。',
  },
  authenticator: {
    en: 'Encrypted vault, scrypt app lock, and a local TOTP authenticator surface in progress.',
    zh: '加密保險庫、scrypt程式鎖，本地TOTP驗證器介面趕工中。',
  },
  platform: {
    en: 'Windows x64 Squirrel installer, unsigned by policy, auto-updates over HTTPS.',
    zh: 'Windows x64 Squirrel安裝程式，按政策唔簽名，自動更新行HTTPS。',
  },
};

let booted = false;
export function bootDocsPage() {
  if (booted) return;
  booted = true;
  const root = document.getElementById('docs-root');
  if (!root) return;

  root.append(
    el('h2', { id: 'docs-hub', text: t('docs.h1') }),
    el('p', { class: 'page-lead', text: t('docs.lead') }),
  );

  const searchMount = el('div', {});
  root.append(searchMount);
  const list = el('ul', { class: 'docs-list', id: 'article-list' });
  root.append(list);

  const state = { mode: 'plain', pattern: '', flags: 'i' };
  createSearchBar(searchMount, {
    ariaLabel: t('docs.filter'),
    placeholder: t('docs.filter'),
    onQuery(next) { Object.assign(state, next); render(); },
  });

  function render() {
    list.textContent = '';
    const q = state.pattern.trim().toLowerCase();
    let shown = 0;
    for (const art of ARTICLES) {
      const blurb = BLURBS[art.id] || { en: '', zh: '' };
      const hay = `${t(art.labelKey)} ${art.labelZh} ${blurb.en} ${blurb.zh}`.toLowerCase();
      let hit = !q;
      if (q) {
        if (state.mode === 'regex') {
          try { hit = new RegExp(state.pattern, state.flags.replace('g', '') || undefined).test(hay); }
          catch { hit = true; }
        } else {
          hit = hay.includes(q);
        }
      }
      if (!hit) continue;
      shown += 1;
      const li = el('li', { class: 'docs-item' });
      li.append(el('a', { class: 'docs-link', href: art.href }, [
        el('span', { class: 'docs-title', text: t(art.labelKey) }),
        getSettingsLanguage() !== 'en' ? el('span', { class: 'docs-sub', text: art.labelZh }) : null,
      ]));
      const lang = getSettingsLanguage();
      li.append(el('p', { class: 'docs-blurb', text: lang === 'zh' ? blurb.zh : blurb.en }));
      list.append(li);
    }
    if (!shown && q) {
      list.append(el('li', { class: 'empty-state', text: t('docs.noMatch') }));
    }
  }

  function getSettingsLanguage() {
    try {
      return JSON.parse(localStorage.getItem('mr-site:settings') || '{}').language || 'en';
    } catch { return 'en'; }
  }

  render();
}

window.addEventListener('mr-docs-ready', bootDocsPage);
if (document.readyState !== 'loading' && document.getElementById('docs-root')) {
  bootDocsPage();
}
