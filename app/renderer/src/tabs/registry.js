// Purpose: the single source of truth for which tabs exist and in what order.
// Each tab module imports {registerTab} and registers itself on import;
// app.js imports every module for side effects, then hands TABS to tabs.js.
// Owned by Foundation Core lane; lanes append their own registrations inside
// their own files, never here.

/** @type {Array<{id,label:{en,zh},icon?,init:Function,mount?:Function}>} */
export const TABS = [];

export function registerTab(def) {
  if (!def?.id) throw new Error('tab definition requires an id');
  if (!def.label || !def.label.en) throw new Error(`tab "${def.id}" requires label.en`);
  if (TABS.some((x) => x.id === def.id)) throw new Error(`duplicate tab id "${def.id}"`);
  TABS.push(def);
}

/** Icon helper shared by all tab modules (path data -> svg element). */
export function iconFromPath(pathData) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('class', 'mr-tab-btn__icon');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', pathData);
  svg.append(p);
  return svg;
}
