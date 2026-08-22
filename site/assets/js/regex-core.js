/* Regex engine wrapper shared by every site search field and the builder.
   Plain text is the default; regex is an explicit opt-in. Matching is
   step-budgeted so a pathological pattern cannot hang the page: the budget
   bounds match attempts, not the engine's internal backtracking per attempt,
   and the builder says so honestly. Zero-width matches advance by one. */

export const STEP_BUDGET = 20000;

export function parseFlags(flags) {
  const set = new Set(String(flags || '').split(''));
  let out = '';
  if (set.has('i')) out += 'i';
  if (set.has('m')) out += 'm';
  if (set.has('s')) out += 's';
  if (set.has('u')) out += 'u';
  return out; // 'g' is managed internally by safeMatch
}

export function compileRegex(pattern, flags) {
  return new RegExp(pattern, parseFlags(flags));
}

/* Plain-text mode: literal substring search, case-insensitive by default. */
export function plainMatch(text, query, { caseInsensitive = true } = {}) {
  const hay = String(text || '');
  const needle = String(query || '');
  if (!needle) return { matches: [], error: null, truncated: false };
  const hayC = caseInsensitive ? hay.toLowerCase() : hay;
  const needleC = caseInsensitive ? needle.toLowerCase() : needle;
  const matches = [];
  let idx = hayC.indexOf(needleC);
  while (idx !== -1) {
    matches.push({ index: idx, length: needle.length, groups: [hay.slice(idx, idx + needle.length)] });
    if (matches.length >= STEP_BUDGET) return { matches, error: null, truncated: true };
    idx = hayC.indexOf(needleC, idx + Math.max(needle.length, 1));
  }
  return { matches, error: null, truncated: false };
}

export function regexMatch(text, pattern, flags) {
  const hay = String(text || '');
  if (!pattern) return { matches: [], error: null, truncated: false };
  let re;
  try {
    re = new RegExp(pattern, parseFlags(flags) + 'g');
  } catch (err) {
    return { matches: [], error: err.message, truncated: false };
  }
  const matches = [];
  let steps = 0;
  let m;
  const anchoredGlobal = re;
  while ((m = anchoredGlobal.exec(hay)) !== null) {
    steps += 1;
    if (steps > STEP_BUDGET) return { matches, error: null, truncated: true };
    matches.push({
      index: m.index,
      length: m[0].length,
      groups: Array.from(m),
      named: m.groups || null,
    });
    if (m[0].length === 0) anchoredGlobal.lastIndex += 1; // zero-width safety
    if (anchoredGlobal.lastIndex > hay.length) break;
  }
  return { matches, error: null, truncated: false };
}

export function matchText(text, { mode = 'plain', pattern = '', flags = '' } = {}) {
  if (mode === 'regex') return regexMatch(text, pattern, flags);
  return plainMatch(text, pattern);
}

export function highlightInto(element, text, result) {
  element.textContent = '';
  if (!result || !result.matches.length) {
    element.textContent = text;
    return;
  }
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const m of result.matches) {
    if (m.index > cursor) frag.append(text.slice(cursor, m.index));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(m.index, m.index + m.length);
    frag.append(mark);
    cursor = m.index + Math.max(m.length, 0);
    if (m.length === 0) {
      frag.append(text[cursor] || '');
      cursor += 1;
    }
  }
  if (cursor < text.length) frag.append(text.slice(cursor));
  element.append(frag);
}
