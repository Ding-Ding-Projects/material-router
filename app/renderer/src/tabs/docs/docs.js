// Purpose: WORKING minimal offline docs browser. Lists docs/articles/*.md from
// the build-time index, renders through the shared md.js renderer, resolves
// article-to-article links internally, and searches titles + bodies with the
// anchored regex-capable search bar. Utility lane extends this surface.
// Owned by Foundation Core lane (Utility lane extends).

import { h } from '../../core/util.js';
import { t, copy } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke } from '../../core/bridge.js';
import { renderMarkdown } from '../../core/md.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';

const cache = {
  /** @type {Array<{id,title,summary}>} */
  articles: [],
  /** id -> content */
  bodies: new Map(),
};

async function loadIndex() {
  if (cache.articles.length) return cache.articles;
  const manifest = await invoke('docs:list-articles');
  cache.articles = (manifest.articles ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    summary: a.summary ?? '',
  }));
  return cache.articles;
}

async function loadBody(id) {
  if (cache.bodies.has(id)) return cache.bodies.get(id);
  const { content } = await invoke('docs:read-article', { id });
  cache.bodies.set(id, content);
  return content;
}

function render(container) {
  const layout = h('div', { class: 'mr-docs-layout' });
  container.append(
    h('h1', { class: 'mr-typography-headline-small' }, t('tabs.docs')),
    layout,
  );

  const listCol = h('div', { class: 'mr-docs-list' });
  // mr-md carries the shared renderer typography; without it article bodies
  // fell back to UA defaults and inline code chips collided with descenders.
  const reader = h('div', { class: 'mr-docs-article mr-md', role: 'region', 'aria-label': t('docs.articleRegion') });
  layout.append(listCol, reader);

  let currentId = null;

  async function showArticle(id) {
    try {
      const content = await loadBody(id);
      currentId = id;
      reader.textContent = '';
      reader.innerHTML = renderMarkdown(content);
      for (const a of reader.querySelectorAll('a.mr-md-internal')) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const target = a.dataset.target?.replace(/\.md$/, '');
          if (target && cache.articles.some((x) => x.id === target)) showArticle(target);
        });
      }
      highlightList();
      // Preload other bodies in the background so search covers full text.
      for (const art of cache.articles) {
        if (!cache.bodies.has(art.id)) {
          loadBody(art.id).then(renderList).catch(() => {});
        }
      }
    } catch (err) {
      reader.textContent = `${copy('common.errorTitle')}: ${err.message}`;
    }
  }

  function highlightList() {
    for (const a of listEl.querySelectorAll('a')) {
      a.classList.toggle('current', a.dataset.articleId === currentId);
    }
  }

  const search = createSearchBar({
    placeholder: copy('docs.searchPlaceholder'),
    label: copy('docs.searchPlaceholder'),
    onQuery: () => renderList(),
  });

  const listEl = h('nav', { 'aria-label': t('tabs.docs') });

  function renderList() {
    const q = search.get();
    listEl.textContent = '';
    const rows = cache.articles.filter((a) =>
      matchesQuery(q, a.title)
      || matchesQuery(q, a.summary)
      || (q.mode === 'regex' ? false : matchesQuery(q, cache.bodies.get(a.id) ?? '')));
    if (rows.length === 0) {
      listEl.append(h('p', { class: 'mr-typography-body-small', style: 'padding:8px;color:var(--md-sys-color-on-surface-variant)' },
        copy('palette.noResults')));
      return;
    }
    for (const art of rows) {
      listEl.append(h('a', {
        href: `#article=${art.id}`,
        dataset: { articleId: art.id },
        onclick: (e) => { e.preventDefault(); showArticle(art.id); },
      }, art.title));
    }
    highlightList();
  }

  listCol.append(search.el, listEl);

  loadIndex().then(async () => {
    renderList();
    // Preload everything once; the corpus is small by design.
    await Promise.allSettled(cache.articles.map((a) => loadBody(a.id)));
    renderList();
    const first = cache.articles[0];
    if (first) showArticle(first.id);
  }).catch((err) => {
    listCol.append(h('p', { style: 'color:var(--md-sys-color-error)' },
      `${copy('common.errorTitle')}: ${err.message}`));
  });
}

registerTab({
  id: 'docs',
  label: { en: 'Docs', zh: '說明文件' },
  get icon() { return iconFromPath('M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2ZM6 4h5v8l-2.5-1.5L6 12V4Z'); },
  init: render,
});
