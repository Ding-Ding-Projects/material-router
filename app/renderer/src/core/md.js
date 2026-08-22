// Purpose: the one shared markdown renderer for provider-authored text and
// the offline docs. Escapes HTML first, then applies a conservative Markdown
// transform. Never receives or produces executable content.
// Owned by Foundation Core lane.

const EMOJI = new Map(Object.entries({
  smile: '😄', grin: '😁', wink: '😉', joy: '😂', sob: '😭',
  thinking: '🤔', ok_hand: '👌', thumbsup: '👍', thumbsdown: '👎',
  warning: '⚠️', rocket: '🚀', sparkles: '✨', bulb: '💡',
  lock: '🔒', key: '🔑', gear: '⚙️', book: '📖', teacup_without_handle: '🍵',
}));

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`:([a-z0-9_+-]+):`/gi, (_, name) => EMOJI.get(name.toLowerCase()) ?? _); // `:name:` literal form
  out = out.replace(/:([a-z0-9_+-]+):/gi, (m, name) => EMOJI.get(name.toLowerCase()) ?? m);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => renderLink(label, href));
  return out;
}

function renderLink(label, href) {
  if (/^https?:\/\//i.test(href)) {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  // Internal links (relative .md files or #article ids) are handled by the
  // docs browser via data attributes; they never navigate the window itself.
  const safeHref = escapeHtml(href);
  return `<a href="#" class="mr-md-internal" data-target="${safeHref}">${label}</a>`;
}

function resolveInternal(href, baseUrl) {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).pathname.split('/').pop().replace(/\.md$/, '');
  } catch {
    return href;
  }
}

/**
 * Render markdown text to a sanitized HTML string.
 * opts: {baseUrl} - when given, relative .md links resolve to article ids
 * rooted at that directory.
 */
export function renderMarkdown(text, { baseUrl = null } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  /** @type {string[]} */
  let paraBuf = [];

  function flushPara() {
    if (paraBuf.length) {
      html.push(`<p>${inline(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^```/.test(line)) {
        html.push(`<pre><code${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''}>${codeBuf.join('\n')}</code></pre>`);
        inCode = false;
        codeBuf = [];
        codeLang = '';
      } else {
        codeBuf.push(line);
      }
      i += 1;
      continue;
    }

    const fence = /^```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      inCode = true;
      codeLang = fence[1] || '';
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      html.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      html.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      html.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flushPara();
      const header = splitTableRow(lines[i]);
      i += 2;
      /** @type {string[][]} */
      const rows = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      html.push('<table><thead><tr>'
        + header.map((cell) => `<th>${inline(cell)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>');
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      i += 1;
      continue;
    }

    paraBuf.push(line.trim());
    i += 1;
  }
  if (inCode && codeBuf.length) {
    html.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
  }
  flushPara();

  let out = html.join('\n');
  if (baseUrl) {
    out = out.replace(/data-target="([^"]+)"/g, (m, href) =>
      `data-target="${escapeHtml(resolveInternal(href, baseUrl))}"`);
  }
  return out;
}

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/** Render into an element with the accessible region label attached. */
export function renderInto(el, text, { baseUrl } = {}) {
  el.classList.add('mr-md');
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'rendered document');
  el.innerHTML = renderMarkdown(text, { baseUrl });
}
