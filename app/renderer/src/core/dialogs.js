// Purpose: modal dialog helper (focus trap, Escape, focus return), anchored
// context menus that paint their own surface and never cover their anchor,
// prompt helpers, and the foundation's basic two-step destructive confirm.
// The full super-confirmation gate arrives in the Delight lane; other lanes
// can build on destructiveConfirm() without changes.
// Owned by Foundation Core lane.

import { h } from './util.js';
import { copy, t } from './i18n.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open a modal. Returns {close, el}. Focus is trapped; Escape closes;
 * focus returns to the invoking element.
 */
export function openModal({ title, body, actions = [], onClose = null, labelId } = {}) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const bodyEl = h('div', { class: 'm3-dialog__body' });
  if (body) {
    if (typeof body === 'function') body(bodyEl);
    else if (body instanceof Node) bodyEl.append(body);
    else bodyEl.textContent = String(body);
  }

  const actionsEl = h('div', { class: 'm3-dialog__actions' });
  for (const action of actions) {
    actionsEl.append(h('button', {
      class: `m3-btn ${action.kind || 'm3-btn--text'}`,
      onclick: () => { if (action.run?.() !== false) close(); },
    }, action.label));
  }

  const headingId = labelId || `mr-dialog-title-${Math.random().toString(36).slice(2)}`;
  const dialogEl = h('div', {
    class: 'm3-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': headingId,
  },
    h('h2', { class: 'm3-dialog__title', id: headingId }, title ?? ''),
    bodyEl,
    actionsEl,
  );

  const scrim = h('div', { class: 'm3-dialog-scrim' }, dialogEl);

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') trapTab(e);
  }
  function trapTab(e) {
    const focusables = [...dialogEl.querySelectorAll(FOCUSABLE)]
      .filter((n) => n.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function close() {
    scrim.remove();
    document.removeEventListener('keydown', onKeydown, true);
    onClose?.();
    if (opener?.isConnected) opener.focus();
  }

  document.addEventListener('keydown', onKeydown, true);
  document.body.append(scrim);

  const initialFocus = dialogEl.querySelector(FOCUSABLE) || dialogEl;
  queueMicrotask(() => initialFocus.focus());

  return { close, el: dialogEl };
}

/** Simple confirm dialog. Resolves true when confirmed. */
export function confirm({ title, body, confirmLabel }) {
  return new Promise((resolve) => {
    let settled = false;
    const dlg = openModal({
      title,
      body,
      onClose: () => { if (!settled) resolve(false); },
      actions: [
        { label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} },
        { label: confirmLabel ?? copy('common.confirm'), kind: 'm3-btn--filled', run: () => { settled = true; resolve(true); } },
      ],
    });
    void dlg;
  });
}

/**
 * Foundation's destructive confirmation: two sequential confirms naming what
 * is affected. The Delight lane upgrades this to the full two-key +
 * slider gate; callers keep this exact signature.
 */
export async function destructiveConfirm({ title, body, confirmLabel }) {
  const step1 = await confirm({
    title,
    body,
    confirmLabel: t('dialogs.continue'),
  });
  if (!step1) return false;
  return confirm({
    title: t('dialogs.destructiveSecondTitle'),
    body: `${body}\n\n${t('dialogs.destructiveSecondBody')}`,
    confirmLabel: confirmLabel ?? t('dialogs.destructiveConfirm'),
  });
}

/** Text prompt. Resolves string or null. */
export function promptText({ title, label, value = '', placeholder = '' }) {
  return new Promise((resolve) => {
    let settled = false;
    let inputEl;
    const dlg = openModal({
      title,
      body: (container) => {
        inputEl = h('input', {
          class: 'mr-grow',
          value,
          placeholder,
          'aria-label': label ?? title,
          style: 'width:100%',
        });
        container.append(inputEl);
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            settled = true;
            resolve(inputEl.value);
            dlg.close();
          }
        });
      },
      onClose: () => { if (!settled) resolve(null); },
      actions: [
        { label: copy('common.cancel'), kind: 'm3-btn--text', run: () => {} },
        { label: copy('common.ok'), kind: 'm3-btn--filled', run: () => { settled = true; resolve(inputEl.value); } },
      ],
    });
  });
}

/**
 * Anchored popover menu. items: [{label?, shortcut?, checked?, disabled?,
 * run?, separator?}] — a plain {separator:true} entry renders a divider.
 * Paints its own surface, flips within the viewport, closes on Escape with
 * focus returned to the anchor.
 */
export function showMenu(items, { x = null, y = null, anchor = null } = {}) {
  const opener = anchor && anchor.isConnected
    ? anchor
    : (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const menu = h('div', { class: 'mr-menu', role: 'menu' });

  let index = -1;
  const itemEls = [];
  for (const item of items) {
    if (item.separator) {
      menu.append(h('hr', { class: 'mr-menu__sep' }));
      continue;
    }
    index += 1;
    const btn = h('button', {
      class: 'mr-menu__item',
      role: 'menuitem',
      disabled: item.disabled ? true : null,
      dataset: { index: String(index) },
      onclick: () => {
        if (item.disabled) return;
        cleanup();
        item.run?.();
      },
    },
      item.checked != null
        ? h('span', { 'aria-hidden': 'true' }, item.checked ? '✓' : '')
        : null,
      h('span', {}, item.label ?? ''),
      item.shortcut ? h('span', { class: 'mr-menu__shortcut', 'aria-hidden': 'true' }, item.shortcut) : null,
    );
    itemEls.push(btn);
    menu.append(btn);
  }

  function position() {
    // Measure offscreen, place, then clamp/flip.
    menu.style.visibility = 'hidden';
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x ?? (opener?.getBoundingClientRect().left ?? 24);
    let top = y ?? ((opener?.getBoundingClientRect().bottom ?? 24) + 4);
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
    if (top + rect.height > vh - 8) top = Math.max(8, top - rect.height - (opener ? opener.getBoundingClientRect().height : 0));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      return;
    }
    const currentIdx = itemEls.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      let next = currentIdx + (e.key === 'ArrowDown' ? 1 : -1);
      next = (next + itemEls.length) % itemEls.length;
      itemEls[next]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      itemEls[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      itemEls[itemEls.length - 1]?.focus();
    }
  }

  function onPointerDown(e) {
    if (!menu.contains(e.target)) cleanup();
  }

  function cleanup() {
    menu.remove();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', cleanup);
    if (opener?.isConnected) opener.focus();
  }

  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', cleanup);
  position();
  itemEls[0]?.focus();
  return { close: cleanup };
}
