/* Home-page installer section: reads the GitHub releases API client-side,
   shows the newest Setup.exe with its version, and states plainly that
   installers are unsigned. Until v0.1.0 exists it shows an honest empty
   state instead of a guessed link. Marked live fetch; degrades offline. */

import { el } from './util.js';
import { t } from './i18n.js';

const API = 'https://api.github.com/repos/Ding-Ding-Projects/material-router/releases/latest';

export function registerDownloadsBundle(addBundle) {
  addBundle('downloads', {
    en: {
      'dl.title': 'Download the installer',
      'dl.platform': 'Windows x64 · Squirrel.Windows · unsigned',
      'dl.unsigned': 'This project permanently does not code-sign. Windows SmartScreen will warn on first run — choose “More info”, then “Run anyway”. Verify what you downloaded against the SHA-256 in the release notes before running it.',
      'dl.empty': 'No release has been published yet (v0.1.0 is on its way). The button will appear here the moment the first installer ships — never before, and never pointing at a guess.',
      'dl.viewAll': 'All releases on GitHub',
      'dl.error': 'Could not reach GitHub right now. Try again later, or open the releases page directly.',
      'dl.download': 'Download',
      'dl.version': 'Version',
      'dl.size': 'Size',
      'dl.fromSource': 'Prefer source? Run build.bat from a clone.',
      'dl.shaNote': 'Compare the SHA-256 published beside each asset before running anything.',
    },
    zh: {
      'dl.title': '下載安裝程式',
      'dl.platform': 'Windows x64 · Squirrel.Windows · 無簽名',
      'dl.unsigned': '本項目永遠唔會做代碼簽名。第一次行嗰陣Windows SmartScreen一定會彈警告 —— 撳「更多資訊」再「仍要執行」。行之前，攞release note度嘅SHA-256核對你下載咗嘅檔案。',
      'dl.empty': '仲未有正式發佈（v0.1.0 趕緊製作中）。第一個安裝程式出街嗰一刻，個掣就會喺呢度出現 —— 唔會早到，亦都唔會亂指一個地址俾你。',
      'dl.viewAll': '去GitHub睇所有版本',
      'dl.error': '而家連唔上GitHub。遲啲再試，或者直接開releases頁。',
      'dl.download': '下載',
      'dl.version': '版本',
      'dl.size': '大小',
      'dl.fromSource': '想用源碼？Clone之後行 build.bat 就得。',
      'dl.shaNote': '行任何嘢之前，先對埋asset旁邊公佈嘅SHA-256。',
    },
  });
}

export async function initDownloads(mount) {
  mount.append(
    el('h2', { id: 'download', text: t('dl.title') }),
    el('p', { class: 'page-lead mono', text: t('dl.platform') }),
  );
  const body = el('div', { class: 'dl-body' }, [el('p', { class: 'empty-state', text: '⏳ …' })]);
  const unsignedNote = el('p', { class: 'unsigned-note' }, [
    el('strong', { text: t('dl.unsigned') }),
  ]);
  mount.append(body, unsignedNote, el('p', { class: 'setting-desc', text: t('dl.shaNote') }));

  try {
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(String(res.status));
    const rel = await res.json();
    const setup = (rel.assets || []).find((a) => /^setup.*\.exe$/i.test(a.name) || /setup/i.test(a.name) && a.name.toLowerCase().endsWith('.exe'));
    body.textContent = '';
    if (!setup) {
      emptyState();
      return;
    }
    const btn = el('a', {
      class: 'mr-btn mr-btn--filled dl-btn',
      href: setup.browser_download_url,
      rel: 'noopener noreferrer',
    }, [
      document.createTextNode(`${t('dl.download')} ${setup.name}`),
    ]);
    btn.setAttribute('aria-label', `${t('dl.download')} ${setup.name} (${rel.tag_name})`);
    body.append(
      btn,
      el('p', { class: 'setting-desc mono' }, [
        `${t('dl.version')}: ${rel.tag_name}`,
        setup.size ? ` · ${t('dl.size')}: ${(setup.size / 1048576).toFixed(1)} MB` : '',
      ]),
    );
  } catch {
    body.textContent = '';
    body.append(el('div', { class: 'empty-state' }, [
      document.createTextNode(t('dl.empty')),
      ' ',
      el('a', { class: 'mr-btn mr-btn--tonal', href: 'https://github.com/Ding-Ding-Projects/material-router/releases', target: '_blank', rel: 'noopener noreferrer', text: t('dl.viewAll') }),
      el('p', { class: 'setting-desc', text: t('dl.fromSource') }),
    ]));
  }

  function emptyState() {
    body.append(el('div', { class: 'empty-state' }, [
      document.createTextNode(t('dl.empty')),
      ' ',
      el('a', { class: 'mr-btn mr-btn--tonal', href: 'https://github.com/Ding-Ding-Projects/material-router/releases', target: '_blank', rel: 'noopener noreferrer', text: t('dl.viewAll') }),
    ]));
  }
}
