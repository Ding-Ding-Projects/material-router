/* Minimal, safe Markdown renderer for provider-authored text
   (GitHub release notes). Escape first, then format. Links are restricted
   to http(s) and anchored #targets; everything else renders as text.
   Zero dependencies; mirrors the app's "rendered, not printed" rule. */

import { escapeHtml } from './util.js';

function safeHref(href) {
  const h = String(href || '').trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('#')) return h;
  return null;
}

function inline(text) {
  let s = escapeHtml(text);
  // images -> link text (no remote image loading inside release notes)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, href) => {
    const u = safeHref(href);
    return u ? `<a href="${u}" rel="noopener noreferrer" target="_blank">${alt || 'link'}</a>` : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const u = safeHref(href);
    return u ? `<a href="${u}" rel="noopener noreferrer" target="_blank">${label}</a>` : label;
  });
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // autolink bare issue refs to this repository's issues
  s = s.replace(/(^|\s)#(\d{1,6})\b/g, '$1<a href="https://github.com/Ding-Ding-Projects/material-router/issues/$2" rel="noopener noreferrer" target="_blank">#$2</a>');
  return s;
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listType = null; // 'ul' | 'ol'
  let paraBuf = [];

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  const closePara = () => {
    if (paraBuf.length) { out.push(`<p>${inline(paraBuf.join(' '))}</p>`); paraBuf = []; }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) {
      closePara(); closeList();
      if (inCode) { out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`); codeBuf = []; inCode = false; }
      else { inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (!line.trim()) { closePara(); closeList(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closePara(); closeList();
      const level = Math.min(h[1].length + 1, 6); // shift down: page owns h1
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*])\s+/.test(line)) {
      closePara();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      closePara();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closePara(); closeList();
      out.push(`<blockquote><p>${inline(line.replace(/^\s*>\s?/, ''))}</p></blockquote>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closePara(); closeList();
      out.push('<hr>');
      continue;
    }
    paraBuf.push(line.trim());
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  closePara(); closeList();
  return out.join('\n');
}
