// Purpose: the one choice-control this lane uses everywhere - a button that
// opens an ANCHORED, self-painted popover holding a search bar (plain text
// default, regex opt-in via the shared anchored builder) over a filtered
// option list. Keyboard complete: field focus on open, arrows move, Enter
// picks, Escape clears-then-closes, focus returns to the field.
// Owned by Appearance lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';

let openPicker = null; // only one picker popover at a time

/**
 * createFilterPicker({ label, options:[{value,label,hint?,disabled?,reason?}],
 *                      value, onChange(value), popoverClass? })
 * Returns { el, setOptions(list), setValue(v), get value, focus() }.
 */
export function createFilterPicker({ label, options = [], value = null, onChange = () => {}, popoverClass = '' }) {
  let current = options.find((o) => o.value === value) ? value : (options[0]?.value ?? null);
  let list = [...options];

  const valueLabel = h('span', { class: 'mr-fp__value' });
  const el = h('button', {
    type: 'button',
    class: 'm3-btn m3-btn--outlined mr-fp',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    title: label,
    onclick: () => toggle(),
  }, h('span', { class: 'mr-fp__label' }, label), valueLabel);

  function syncLabel() {
    const opt = list.find((o) => o.value === current);
    valueLabel.textContent = opt ? opt.label : String(current ?? '');
  }

  function setOptions(next) {
    list = [...next];
    if (!list.some((o) => o.value === current)) {
      const auto = list.find((o) => o.value === '') ?? list[0];
      current = auto ? auto.value : null;
    }
    syncLabel();
  }

  function setValue(v) {
    current = v;
    syncLabel();
  }

  function close() {
    if (openPicker) openPicker.close();
  }

  function toggle() {
    if (openPicker && openPicker.owner === api) {
      close();
      return;
    }
    close();
    openPicker = buildPopover();
  }

  function buildPopover() {
    const anchorRect = el.getBoundingClientRect();
    const search = createSearchBar({
      placeholder: t('appearance.picker.searchPlaceholder'),
      label: label || t('appearance.picker.searchPlaceholder'),
      onQuery: () => renderList(),
    });

    const listEl = h('div', { class: 'mr-fp__list', role: 'listbox', 'aria-label': label });
    const statusEl = h('div', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);padding:0 12px 8px' });
    let focusedIdx = -1;
    /** @type {HTMLElement[]} */
    let rows = [];

    function filtered() {
      const q = search.get();
      return list.filter((o) => matchesQuery(q, `${o.label} ${o.hint ?? ''} ${String(o.value)}`));
    }

    function renderList() {
      listEl.textContent = '';
      rows = [];
      focusedIdx = -1;
      const visible = filtered();
      for (const opt of visible) {
        const row = h('div', {
          class: `mr-fp__row${opt.disabled ? ' mr-fp__row--disabled' : ''}`,
          role: 'option',
          tabindex: '-1',
          'aria-selected': String(opt.value === current),
          'aria-disabled': opt.disabled ? 'true' : null,
          dataset: { value: String(opt.value) },
        },
          h('span', { class: 'mr-fp__row-label' }, opt.label),
          opt.hint ? h('span', { class: 'mr-fp__row-hint' }, opt.hint) : null,
        );
        if (!opt.disabled) {
          row.addEventListener('click', () => pick(opt));
          row.addEventListener('mousemove', () => setFocus(rows.indexOf(row)));
        }
        listEl.append(row);
        rows.push(row);
      }
      const count = visible.length;
      statusEl.textContent = count === 0
        ? t('appearance.picker.noMatches')
        : `${count} / ${list.length}`;
      setFocus(0);
    }

    function pick(opt) {
      current = opt.value;
      syncLabel();
      cleanup();
      onChange(current);
    }

    function setFocus(idx) {
      if (!rows.length) return;
      focusedIdx = Math.max(0, Math.min(rows.length - 1, idx));
      rows.forEach((r, i) => r.classList.toggle('focused', i === focusedIdx));
      rows[focusedIdx]?.scrollIntoView({ block: 'nearest' });
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // First Escape clears an active filter; second closes (search bar's
        // own input keeps its text until then).
        if (search.get().text) {
          search.clear();
          renderList();
          return;
        }
        cleanup();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocus(focusedIdx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocus(focusedIdx - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[focusedIdx];
        const opt = filtered()[focusedIdx];
        if (row && opt && !opt.disabled) pick(opt);
      }
    }

    function onPointerDown(e) {
      if (!pop.contains(e.target) && e.target !== el) cleanup();
    }

    function cleanup() {
      pop.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', cleanup);
      window.removeEventListener('scroll', reposition, true);
      el.setAttribute('aria-expanded', 'false');
      if (openPicker?.owner === api) openPicker = null;
      el.focus();
    }

    const pop = h('div', {
      class: `mr-fp__popover ${popoverClass}`,
      role: 'dialog',
      'aria-label': label,
    }, search.el, listEl, statusEl);

    function reposition() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = el.getBoundingClientRect();
      pop.style.minWidth = `${Math.max(240, Math.min(rect.width, vw - 24))}px`;
      const measured = pop.getBoundingClientRect();
      let left = Math.min(Math.max(8, rect.left), vw - measured.width - 8);
      let top = rect.bottom + 4;
      if (top + measured.height > vh - 8) top = Math.max(8, rect.top - measured.height - 4);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }

    document.body.append(pop);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', cleanup);
    window.addEventListener('scroll', reposition, true);
    el.setAttribute('aria-expanded', 'true');
    renderList();
    reposition();
    queueMicrotask(() => search.focus());

    const owner = api;
    return { owner, close: cleanup };
  }

  const api = { el, setOptions, setValue, get value() { return current; }, focus: () => el.focus() };
  syncLabel();
  return api;
}
