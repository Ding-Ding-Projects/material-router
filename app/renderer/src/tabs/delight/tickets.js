// Purpose: Support Tickets - the application's own fictional service desk,
// reachable from the unlock prompt's Forgotten-password link and from Help.
// A real ticket form (category, description, generated number, severity
// nobody honours, advancing status), a canned first response, and one honest
// resolution action: open the application-data folder in the OS file manager.
// Nothing is ever sent anywhere; the desk never deletes anything itself.
// Owned by Delight lane.

import { h, saveText, fmtDate, writeClipboard } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { invoke } from '../../core/bridge.js';
import { toast } from '../../core/toasts.js';
import { record as historyRecord } from '../../core/history.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';
import { destructiveConfirmSuper } from './dialogs-super.js';
import { dc, getUserDataPath } from './common.js';

const STATUS_KEYS = {
  open: 'dl.tickets.stOpen',
  'first-response': 'dl.tickets.stFirstResponse',
  'being-looked-at': 'dl.tickets.stLooking',
  resolved: 'dl.tickets.stResolved',
};

let tickets = [];

async function reload() {
  try {
    const res = await invoke('vault:delight-ticket-list');
    tickets = res.tickets ?? [];
  } catch {
    tickets = [];
  }
}

/**
 * Render the whole desk into `container`. `topic` = 'lockout' preselects the
 * locked-out category when opened from an unlock prompt.
 */
export async function renderTicketsSection(container, { topic = null } = {}) {
  await reload();
  container.replaceChildren();

  const head = h('div', {});
  head.append(h('h2', { class: 'mr-typography-headline-small', style: 'margin:0' }, dc('dl.tickets.title')));
  head.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant);margin:4px 0 0' }, dc('dl.tickets.tagline')));
  // The unmissable honesty line - plain words, untouched by the funny level.
  head.append(h('p', {
    class: 'mr-typography-body-medium mr-honesty-line',
    style: 'font-weight:600;border:2px solid var(--md-sys-color-error);border-radius:var(--md-sys-shape-corner-sm);padding:8px 12px;color:var(--md-sys-color-on-surface)',
  }, t('dl.tickets.honesty')));

  const listHost = h('div');
  const formCard = buildForm(topic, async () => {
    await reload();
    listHost.replaceChildren(buildList());
  });
  listHost.replaceChildren(buildList());

  container.append(head, formCard, listHost);
}

function buildForm(preTopic, onChanged) {
  const card = h('div', { class: 'm3-card m3-card--outlined' });

  const catSel = h('select', { class: 'm3-select', id: 'mr-ticket-cat', 'aria-label': t('dl.tickets.category') },
    h('option', { value: 'general' }, t('dl.tickets.catGeneral')),
    h('option', { value: 'lockout' }, t('dl.tickets.catLockout')),
    h('option', { value: 'mole' }, t('dl.tickets.catComplaint')),
  );
  if (preTopic === 'lockout') catSel.value = 'lockout';

  const sevSel = h('select', { class: 'm3-select', id: 'mr-ticket-sev', 'aria-label': t('dl.tickets.severity') },
    h('option', { value: 'nobody-honours-low' }, t('dl.tickets.sevLow')),
    h('option', { value: 'nobody-honours-mid' }, t('dl.tickets.sevMid')),
    h('option', { value: 'nobody-honours-high' }, t('dl.tickets.sevHigh')),
  );

  const descInput = h('textarea', {
    id: 'mr-ticket-desc',
    rows: '4',
    maxlength: '4000',
    'aria-label': t('dl.tickets.description'),
    placeholder: t('dl.tickets.description'),
    style: 'width:100%',
  });

  const submitBtn = h('button', {
    class: 'm3-btn m3-btn--filled',
    disabled: true,
    onclick: async () => {
      submitBtn.disabled = true;
      try {
        const res = await invoke('vault:delight-ticket-create', {
          category: catSel.value,
          severity: sevSel.value,
          description: descInput.value,
        });
        descInput.value = '';
        historyRecord('ticket created', res.ticket.number);
        toast(t('common.ok'), t('dl.tickets.created', { number: res.ticket.number }), { kind: 'success' });
        await onChanged();
      } catch (err) {
        toast(t('common.errorTitle'), err.message, { kind: 'error' });
      } finally {
        submitBtn.disabled = descInput.value.trim().length === 0;
      }
    },
  }, t('dl.tickets.submit'));
  // Disabled control names exactly which condition is unmet.
  const hintEl = h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:4px 0 0' },
    t('dl.tickets.description'));
  descInput.addEventListener('input', () => {
    submitBtn.disabled = descInput.value.trim().length === 0;
    hintEl.textContent = descInput.value.trim().length === 0 ? t('dl.tickets.description') : '';
  });

  card.append(
    labelled(t('dl.tickets.category'), catSel),
    labelled(t('dl.tickets.severity'), sevSel),
    labelled(t('dl.tickets.description'), descInput),
    hintEl,
    h('div', { class: 'mr-row' }, submitBtn),
  );
  return card;
}

function buildList() {
  const host = h('div', { class: 'mr-col', style: 'gap:8px' });

  const search = createSearchBar({
    placeholder: t('dl.tickets.searchPlaceholder'),
    label: t('dl.tickets.searchPlaceholder'),
    onQuery: () => renderRows(),
  });
  const rowsEl = h('div', { class: 'mr-col', style: 'gap:8px' });

  function filtered() {
    const q = search.get();
    return tickets.filter((tk) => matchesQuery(q, `${tk.number} ${tk.category} ${tk.description} ${tk.status}`));
  }

  function renderRows() {
    rowsEl.replaceChildren();
    const rows = filtered();
    if (rows.length === 0) {
      rowsEl.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, t('dl.tickets.empty')));
      return;
    }
    for (const tk of rows) rowsEl.append(ticketRow(tk, renderRows));
  }

  const exportBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => saveText(`support-tickets-${Date.now()}.json`, JSON.stringify(filtered(), null, 2), 'application/json'),
  }, t('dl.tickets.export'));

  host.append(
    h('h3', { class: 'mr-typography-title-medium', style: 'margin:0' }, t('dl.tickets.list')),
    search.el,
    rowsEl,
    h('div', { class: 'mr-row' }, exportBtn),
  );
  renderRows();
  return host;
}

function ticketRow(tk, rerender) {
  const details = h('details', { class: 'mr-ticket' });
  const statusLabel = t(STATUS_KEYS[tk.status] ?? STATUS_KEYS.open);
  details.append(h('summary', {},
    h('strong', {}, tk.number), ` — ${statusLabel} · `, tk.description.slice(0, 60)));

  const bodyEl = h('div', { class: 'mr-col', style: 'gap:6px;padding:8px 0' });
  bodyEl.append(h('pre', { class: 'mr-ticket__desc' }, tk.description));
  let firstResponseShown = false;
  for (const ev of tk.events ?? []) {
    bodyEl.append(h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' },
      `${fmtDate(ev.at)} — ${t(STATUS_KEYS[ev.status] ?? ev.status)}${ev.note && !firstResponseShown && ev.status !== 'open' ? `\n${t('dl.tickets.firstResponse')} ${ev.note}` : ''}`));
    if (ev.status !== 'open') firstResponseShown = true;
  }

  // Resolution: the only action that actually works is opening the folder.
  const pathSpan = h('code', { class: 'mr-ticket__path' }, '');
  getUserDataPath().then((p) => { pathSpan.textContent = p; });
  const copyBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: async () => {
      await writeClipboard(pathSpan.textContent);
      toast(t('common.copied'), '', { kind: 'info' });
    },
  }, t('dl.tickets.copyPath'));
  const openBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    onclick: async () => {
      try {
        await invoke('shell:open-path', { requestedPath: pathSpan.textContent });
        historyRecord('opened app-data folder', tk.number);
      } catch (err) {
        toast(t('common.errorTitle'), err.message, { kind: 'error' });
      }
    },
  }, t('dl.tickets.openFolder'));

  const advanceBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: async () => {
      try {
        await invoke('vault:delight-ticket-advance', { number: tk.number });
        await reload();
        rerender();
      } catch (err) {
        toast(t('common.errorTitle'), err.message, { kind: 'error' });
      }
    },
  }, t('dl.tickets.advance'));

  const deleteBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    style: 'color:var(--md-sys-color-error)',
    onclick: async () => {
      const ok = await destructiveConfirmSuper({
        title: t('dl.tickets.deleteConfirmTitle'),
        body: t('dl.tickets.deleteConfirmBody', { number: tk.number }),
        confirmLabel: t('dl.tickets.delete'),
      });
      if (!ok) return;
      try {
        await invoke('vault:delight-ticket-delete', { number: tk.number });
        historyRecord('ticket deleted', tk.number);
        await reload();
        rerender();
      } catch (err) {
        toast(t('common.errorTitle'), err.message, { kind: 'error' });
      }
    },
  }, t('dl.tickets.delete'));

  bodyEl.append(
    h('p', { class: 'mr-typography-body-medium', style: 'margin:0;font-weight:600' },
      `${t('dl.tickets.resolution')}: ${dc('dl.tickets.resolutionBody')}`),
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap;gap:6px;align-items:center' },
      h('span', {}, `${t('dl.tickets.path')}:`), pathSpan, copyBtn, openBtn),
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap;gap:6px' }, advanceBtn, deleteBtn),
  );
  details.append(bodyEl);
  return details;
}

function labelled(text, control) {
  control.id ||= `mr-tk-${Math.random().toString(36).slice(2, 8)}`;
  return h('div', { class: 'mr-col', style: 'gap:2px' },
    h('label', { for: control.id, class: 'mr-typography-body-medium' }, text), control);
}
