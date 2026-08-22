/* Changelog page: client-rendered from the GitHub releases API.
   The fetch is the one explicitly-marked live call on this page; offline it
   degrades to an honest empty state with a retry. Date filter + text search
   (regex opt-in via its own builder) compose, and export honors both. */

import { el, fmtDate, downloadBlob } from './util.js';
import { renderMarkdown } from './md.js';
import { createSearchBar } from './searchbar.js';
import { t } from './i18n.js';
import { recordHistory } from './history.js';

const RELEASES_API = 'https://api.github.com/repos/Ding-Ding-Projects/material-router/releases?per_page=30';
const REPO_RELEASES_URL = 'https://github.com/Ding-Ding-Projects/material-router/releases';

export function registerChangelogBundle(addBundle) {
  addBundle('changelog', {
    en: {
      'cl.title': 'Changelog',
      'cl.lead': 'Every release, newest first, straight from GitHub. Each entry links the exact commit and assets of that release.',
      'cl.empty': 'No releases have been published yet. When v0.1.0 ships, every release lands here automatically.',
      'cl.noMatch': 'No release matches the current search or date filter.',
      'cl.error': 'Could not reach GitHub. You may be offline — nothing else on this page needs the network.',
      'cl.retry': 'Try again',
      'cl.date': 'Published',
      'cl.from': 'From', 'cl.to': 'To',
      'cl.presets.all': 'All time', 'cl.presets.30': 'Last 30 days', 'cl.presets.90': 'Last 90 days',
      'cl.exportMd': 'Export Markdown', 'cl.exportTxt': 'Export plain text',
      'cl.assets': 'Assets',
      'cl.commit': 'Commit',
      'cl.viewOnGithub': 'View on GitHub',
      'cl.liveNote': 'This list is fetched live from api.github.com when the page loads; everything else on this site works offline.',
    },
    zh: {
      'cl.title': '更新日誌',
      'cl.lead': '所有版本由新到舊，直接讀取GitHub。每條紀錄都連住嗰次release嘅確切commit同埋附件。',
      'cl.empty': '仲未有任何正式發佈。v0.1.0 出街之後，每次release都會自動出現喺呢度。',
      'cl.noMatch': '無版本符合而家嘅搜尋或者日期篩選。',
      'cl.error': '連唔上GitHub。可能你離咗線 —— 呢一頁其他嘢都唔使網絡。',
      'cl.retry': '再試一次',
      'cl.date': '發佈日期',
      'cl.from': '由', 'cl.to': '至',
      'cl.presets.all': '全部時間', 'cl.presets.30': '最近 30 日', 'cl.presets.90': '最近 90 日',
      'cl.exportMd': '匯出Markdown', 'cl.exportTxt': '匯出純文字',
      'cl.assets': '附件',
      'cl.commit': 'Commit',
      'cl.viewOnGithub': '去GitHub睇',
      'cl.liveNote': '呢個列表係載入頁面嗰陣即時從api.github.com攞；本網站其餘部分離線都照用得。',
    },
  });
}

export async function initChangelog(mount) {
  mount.append(
    el('h2', { text: t('cl.title') }),
    el('p', { class: 'page-lead', text: t('cl.lead') }),
    el('p', { class: 'setting-desc', text: t('cl.liveNote') }),
  );

  const toolbar = el('div', { class: 'centre-toolbar' });
  const searchMount = el('div', {});
  const fromIn = el('input', { type: 'date', class: 'mr-input', 'aria-label': t('cl.from') });
  const toIn = el('input', { type: 'date', class: 'mr-input', 'aria-label': t('cl.to') });
  const presetSel = el('select', { class: 'mr-select', 'aria-label': t('cl.date') },
    [['all', t('cl.presets.all')], ['30', t('cl.presets.30')], ['90', t('cl.presets.90')]]
      .map(([v, l]) => el('option', { value: v, text: l })));
  toolbar.append(searchMount, fromIn, toIn, presetSel);
  mount.append(toolbar);

  const state = { mode: 'plain', pattern: '', flags: 'i' };
  createSearchBar(searchMount, {
    ariaLabel: t('cl.title'),
    onQuery(next) { Object.assign(state, next); render(); },
  });

  const status = el('p', { class: 'empty-state', role: 'status' });
  const list = el('div', { class: 'changelog-list' });
  mount.append(status, list);

  let releases = null; // null = not loaded yet

  async function load() {
    status.textContent = '⏳ …';
    try {
      const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('unexpected payload');
      releases = data;
    } catch {
      releases = [];
      releasesFailed = true;
    }
    render();
  }
  let releasesFailed = false;

  function visibleReleases() {
    if (!releases) return [];
    const from = fromIn.value ? new Date(`${fromIn.value}T00:00:00`).getTime() : (presetSel.value === 'all' ? 0 : Date.now() - Number(presetSel.value) * 86400000);
    const to = toIn.value ? new Date(`${toIn.value}T23:59:59`).getTime() : Infinity;
    return releases.filter((r) => {
      const at = new Date(r.published_at || r.created_at).getTime();
      if (at < from || at > to) return false;
      const q = state.pattern.trim();
      if (!q) return true;
      const hay = `${r.name || ''}\n${r.tag_name}\n${r.body || ''}`;
      if (state.mode === 'regex') {
        try { return new RegExp(state.pattern, state.flags.replace('g', '') || undefined).test(hay); }
        catch { return true; }
      }
      return hay.toLowerCase().includes(q.toLowerCase());
    });
  }

  function render() {
    list.textContent = '';
    if (!releases) return;
    if (releasesFailed && !releases.length) {
      status.textContent = '';
      status.append(el('div', { class: 'empty-state' }, [
        document.createTextNode(t('cl.error')),
        ' ',
        el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('cl.retry'), onclick: load }),
      ]));
      return;
    }
    const rows = visibleReleases();
    if (!rows.length) {
      status.textContent = releases.length ? t('cl.noMatch') : t('cl.empty');
      return;
    }
    status.textContent = '';
    for (const r of rows) {
      const art = el('article', { class: 'changelog-entry' });
      const head = el('div', { class: 'changelog-head' }, [
        el('h3', {}, [
          el('a', { href: r.html_url, rel: 'noopener noreferrer', target: '_blank', text: r.name || r.tag_name }),
          ' ',
          el('code', { class: 'mono changelog-tag', text: r.tag_name }),
        ]),
        el('time', { datetime: r.published_at || '', text: `${t('cl.date')}: ${fmtDate(r.published_at || r.created_at)}` }),
      ]);
      art.append(head);
      if (r.body) {
        const body = el('div', { class: 'md-body' });
        body.innerHTML = renderMarkdown(r.body);
        art.append(body);
      }
      const assets = Array.isArray(r.assets) ? r.assets : [];
      if (assets.length) {
        const ul = el('ul', { class: 'asset-list' });
        for (const a of assets.slice(0, 12)) {
          ul.append(el('li', {}, [
            el('a', { href: a.browser_download_url, rel: 'noopener noreferrer', target: '_blank', text: a.name }),
            document.createTextNode(` · ${(a.size / 1048576).toFixed(1)} MB`),
          ]));
        }
        art.append(el('details', {}, [el('summary', { text: `${t('cl.assets')} (${assets.length})` }), ul]));
      }
      list.append(art);
    }
  }

  // exports honor the active filters
  const buildFilteredText = () => visibleReleases().map((r) => (
    `## ${r.name || r.tag_name} (${r.tag_name})\n${fmtDate(r.published_at || r.created_at)}\n${(r.body || '').trim()}\n`
  )).join('\n---\n\n');
  const mdBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('cl.exportMd') });
  mdBtn.addEventListener('click', () => {
    downloadBlob('material-router-changelog.md',
      `# Material Router ${t('cl.title')}\n\n(from: ${fromIn.value || '—'} to: ${toIn.value || '—'})\n\n${buildFilteredText()}`,
      'text/markdown;charset=utf-8');
    recordHistory({ action: 'exported', label: t('cl.exportMd') });
  });
  const txtBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--tonal', text: t('cl.exportTxt') });
  txtBtn.addEventListener('click', () => {
    downloadBlob('material-router-changelog.txt',
      `Material Router changelog\n(${fromIn.value || '—'} → ${toIn.value || '—'})\n\n${buildFilteredText().replace(/[#*`>]/g, '')}`,
      'text/plain;charset=utf-8');
    recordHistory({ action: 'exported', label: t('cl.exportTxt') });
  });
  mount.append(el('div', { class: 'builder-actions' }, [mdBtn, txtBtn,
    el('a', { class: 'mr-btn mr-btn--text', href: REPO_RELEASES_URL, target: '_blank', rel: 'noopener noreferrer', text: t('cl.viewOnGithub') })]));

  fromIn.addEventListener('change', () => { presetSel.value = 'all'; render(); });
  toIn.addEventListener('change', render);
  presetSel.addEventListener('change', () => { fromIn.value = ''; toIn.value = ''; render(); });

  await load();
}
