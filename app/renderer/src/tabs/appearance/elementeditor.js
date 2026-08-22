// Purpose: the anchored, NON-MODAL per-element appearance editor. Opens
// beside the triggering element (a tab button, or any element carrying
// data-mr-appearance-target), tracks its anchor while open, stays inside the
// viewport, never covers the anchor's own surface, closes on Escape and
// returns focus to the originating element on close AND on cancel.
//
// Per-property resets remove that property so it inherits again; reset-all
// goes through destructiveConfirm because it discards several stored values
// at once. Every change persists through settings (JSONStore-backed) and is
// recorded in local history.
// Owned by Appearance lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import * as settings from '../../core/settings.js';
import { destructiveConfirm } from '../../core/dialogs.js';
import * as history from '../../core/history.js';
import { createFilterPicker } from './filterpicker.js';
import { createColorPicker } from './colorpicker.js';
import { RAINBOW } from './colors.js';

const PROP_KEYS = [
  'fontFamily', 'fontSize', 'fontWeight', 'italic',
  'textColor', 'bgColor', 'radius', 'iconEmoji',
  'underline', 'underlineColor', 'strike', 'overline', 'caps', 'smallCaps',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'script',
  'shadowBlur', 'shadowOpacity',
];

let activeEditor = null;

function storeKey(kind) {
  return kind === 'tab' ? 'appearance.tabOverrides' : 'appearance.elementOverrides';
}

export function getOverrides(kind, id) {
  const all = settings.get(storeKey(kind), {}) ?? {};
  const entry = all[id];
  if (!entry || typeof entry !== 'object') return {};
  const { __explicit, ...props } = entry;
  void __explicit;
  return structuredClone(props);
}

export function getExplicitList(kind, id) {
  const all = settings.get(storeKey(kind), {}) ?? {};
  const entry = all[id];
  return Array.isArray(entry?.__explicit) ? [...entry.__explicit] : null;
}

async function writeProps(kind, id, props, explicitList) {
  const all = settings.get(storeKey(kind), {}) ?? {};
  const record = {};
  for (const key of PROP_KEYS) {
    if (props[key] !== undefined && props[key] !== null) record[key] = props[key];
  }
  if (explicitList) record.__explicit = [...explicitList];
  if (Object.keys(record).length === 0) delete all[id];
  else all[id] = record;
  await settings.set(storeKey(kind), all);
}

async function patchProp(kind, id, prop, value, explicitList) {
  const props = getOverrides(kind, id);
  if (value === undefined || value === null) delete props[prop];
  else props[prop] = value;
  await writeProps(kind, id, props, explicitList);
  history.record('appearance-element', `${targetName(kind)} · ${propLabel(prop)}`,
    value === null || value === undefined ? t('appearance.editor.resetToInherit') : describeValue(prop, value));
}

async function clearAllProps(kind, id) {
  const all = settings.get(storeKey(kind), {}) ?? {};
  delete all[id];
  await settings.set(storeKey(kind), all);
}

function targetName(kind) {
  return kind === 'tab' ? t('appearance.editor.kindTab') : t('appearance.editor.kindElement');
}

function propLabel(prop) {
  try {
    return t(`appearance.editor.prop.${prop}`);
  } catch {
    return prop;
  }
}

function describeValue(prop, value) {
  if (prop === 'iconEmoji' || typeof value === 'string') return String(value);
  return String(value);
}

/**
 * Open the editor. opts: { kind:'tab'|'element', id, anchor:HTMLElement,
 *                          title }.
 */
export function openElementEditor({ kind, id, anchor, title }) {
  if (activeEditor) activeEditor.close();
  if (!anchor || !anchor.isConnected) return;

  let explicitMode = Boolean(getExplicitList(kind, id));

  const body = h('div', { class: 'mr-col mr-ee__body' });

  const pop = h('div', {
    class: 'mr-ee',
    role: 'dialog',
    'aria-label': title ?? t('appearance.editor.title'),
  },
    h('div', { class: 'mr-row', style: 'margin-bottom:6px;padding-right:28px' },
      h('strong', {}, title ?? t('appearance.editor.title')),
      h('span', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, `(${id})`),
    ),
    buildHeaderControls(),
    body,
  );

  function buildHeaderControls() {
    const explicitCb = h('input', {
      type: 'checkbox',
      checked: explicitMode ? true : null,
      onchange: async () => {
        explicitMode = explicitCb.checked;
        if (explicitMode) {
          // Freeze exactly what is set right now as the explicit set.
          await writeProps(kind, id, getOverrides(kind, id),
            Object.keys(getOverrides(kind, id)));
        } else {
          await writeProps(kind, id, getOverrides(kind, id), null);
        }
        history.record('appearance-element', `${targetName(kind)} · ${t('appearance.editor.inheritExplicit')}`,
          explicitMode ? 'on' : 'off');
      },
    });
    return h('div', {},
      h('label', { class: 'm3-checkbox' }, explicitCb,
        h('span', {}, t('appearance.editor.inheritExplicit'))),
      h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant);margin:2px 0 8px' },
        t('appearance.editor.inheritExplicitExplain')),
    );
  }

  // -- row builders ---------------------------------------------------------

  function section(label) {
    return h('div', { class: 'mr-typography-label-medium mr-ee__section', style: 'color:var(--md-sys-color-on-surface-variant);margin-top:6px' }, label);
  }

  function row(prop, control, { note = '', disabledReason = '' } = {}) {
    const isSet = prop in getOverrides(kind, id);
    const resetBtn = h('button', {
      type: 'button',
      class: 'm3-btn m3-btn--text m3-btn--sm mr-ee__reset',
      'aria-label': `${t('appearance.editor.resetProperty')}: ${propLabel(prop)}`,
      disabled: !isSet ? true : null,
      onclick: async () => {
        await patchProp(kind, id, prop, null, explicitListForWrite());
        rerender();
      },
    }, t('appearance.editor.resetShort'));
    return h('div', { class: 'mr-col', style: 'gap:2px;margin-bottom:6px' },
      h('div', { class: 'mr-row', style: 'gap:6px' },
        control.el ?? control,
        h('span', { style: 'flex:1' }),
        resetBtn,
      ),
      disabledReason ? h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-error)' }, disabledReason) : null,
      note ? h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' }, note) : null,
    );
  }

  /** When explicit mode is ON every write must refresh the frozen list. */
  function explicitListForWrite() {
    if (!explicitMode) return null;
    const props = getOverrides(kind, id);
    return Object.keys(props);
  }

  function sliderRow(prop, { min, max, step, unit = '', format }) {
    const current = Number(getOverrides(kind, id)[prop]);
    const valueSpan = h('span', { class: 'mr-typography-label-medium', style: 'min-width:52px;text-align:right' },
      Number.isFinite(current) ? `${format ? format(current) : current}${unit}` : t('appearance.editor.inherited'));
    const slider = h('input', {
      type: 'range', min: String(min), max: String(max), step: String(step),
      value: Number.isFinite(current) ? String(current) : String((min + max) / 2),
      'aria-label': propLabel(prop),
      disabled: Number.isFinite(current) ? null : false,
      oninput: () => {
        const v = Number(slider.value);
        valueSpan.textContent = `${format ? format(v) : v}${unit}`;
      },
      onchange: async () => {
        await patchProp(kind, id, prop, Number(slider.value), explicitListForWrite());
      },
    });
    return row(prop, h('div', { class: 'mr-grow mr-row' }, slider, valueSpan));
  }

  function pickerRow(prop, options, extra = {}) {
    const current = getOverrides(kind, id)[prop];
    const picker = createFilterPicker({
      label: propLabel(prop),
      value: current === undefined ? '__inherit__' : String(current),
      options: [{ value: '__inherit__', label: t('appearance.editor.inherit') }, ...options],
      onChange: async (value) => {
        if (value === '__inherit__') await patchProp(kind, id, prop, null, explicitListForWrite());
        else await patchProp(kind, id, prop, value, explicitListForWrite());
      },
      ...extra,
    });
    return row(prop, picker.el);
  }

  function colorRow(prop, allowRainbow = true) {
    const holder = h('div', { class: 'mr-grow mr-row' });
    const current = getOverrides(kind, id)[prop];
    const picker = createColorPicker({
      label: propLabel(prop),
      value: current === undefined ? '' : current,
      allowRainbow,
      onChange: async (value) => {
        await patchProp(kind, id, prop, value, explicitListForWrite());
      },
    });
    holder.append(picker.el);
    return row(prop, holder);
  }

  function checkboxRow(prop, label) {
    const cb = h('input', {
      type: 'checkbox',
      checked: Boolean(getOverrides(kind, id)[prop]) ? true : null,
      'aria-label': propLabel(prop),
      onchange: async () => {
        await patchProp(kind, id, prop, cb.checked ? true : null, explicitListForWrite());
      },
    });
    return row(prop, h('label', { class: 'm3-checkbox mr-grow' }, cb, h('span', {}, label)));
  }

  function textRow(prop, placeholder, maxLength = 8) {
    const input = h('input', {
      type: 'text',
      value: String(getOverrides(kind, id)[prop] ?? ''),
      placeholder,
      maxlength: String(maxLength),
      'aria-label': propLabel(prop),
      style: 'width:120px',
      onchange: async () => {
        const v = input.value.trim();
        await patchProp(kind, id, prop, v === '' ? null : v, explicitListForWrite());
      },
    });
    return row(prop, input);
  }

  // -- content --------------------------------------------------------------

  async function buildBody() {
    body.textContent = '';

    const fontsMod = await import('./fonts.js');
    const fontInfo = await fontsMod.enumerateFonts();

    body.append(
      section(t('appearance.editor.section.type')),
      row('fontFamily', buildFontPicker(fontInfo)),
      sliderRow('fontSize', { min: 9, max: 40, step: 1, unit: 'px' }),
      pickerRow('fontWeight', [300, 400, 500, 600, 700].map((w) => ({ value: w, label: String(w) }))),
      checkboxRow('italic', t('appearance.editor.prop.italic')),
      pickerRow('script', [
        { value: 'super', label: t('appearance.editor.script.super') },
        { value: 'sub', label: t('appearance.editor.script.sub') },
      ]),
      sliderRow('letterSpacing', { min: -2, max: 8, step: 0.5, unit: 'px' }),
      sliderRow('wordSpacing', { min: -4, max: 16, step: 0.5, unit: 'px' }),
      sliderRow('lineHeight', { min: 0.8, max: 2.5, step: 0.05 }),

      section(t('appearance.editor.section.colour')),
      colorRow('textColor'),
      colorRow('bgColor', false),
      sliderRow('radius', { min: 0, max: 32, step: 1, unit: 'px' }),

      section(t('appearance.editor.section.decoration')),
      pickerRow('underline', ['solid', 'double', 'wavy', 'dashed', 'dotted'].map((v) => ({ value: v, label: t(`appearance.editor.underline.${v}`) }))),
      colorRow('underlineColor', false),
      pickerRow('strike', [
        { value: 'single', label: t('appearance.editor.strike.single') },
        // Honest platform limit: CSS cannot draw TWO line-through lines, only
        // an underline can be doubled. The option stays visible, disabled,
        // with the reason stated rather than silently missing.
        { value: 'double', label: t('appearance.editor.strike.double'), disabled: true, hint: t('appearance.editor.strike.doubleUnsupported') },
      ]),
      checkboxRow('overline', t('appearance.editor.prop.overline')),
      pickerRow('caps', ['uppercase', 'lowercase', 'capitalize'].map((v) => ({ value: v, label: t(`appearance.editor.caps.${v}`) }))),
      (() => {
        const r = checkboxRow('smallCaps', t('appearance.editor.prop.smallCaps'));
        r.append(h('p', { class: 'mr-typography-body-small', style: 'margin:-2px 0 6px;color:var(--md-sys-color-on-surface-variant)' },
          t('appearance.editor.smallCapsNote')));
        return r;
      })(),

      section(t('appearance.editor.section.effects')),
      sliderRow('shadowBlur', { min: 0, max: 30, step: 1, unit: 'px' }),
      sliderRow('shadowOpacity', { min: 0, max: 100, step: 5, unit: '%', format: (v) => String(v) }),
      kind === 'tab'
        ? textRow('iconEmoji', t('appearance.editor.iconPlaceholder'))
        : null,

      h('div', { class: 'mr-row', style: 'margin-top:10px;justify-content:flex-end' },
        h('button', {
          type: 'button', class: 'm3-btn m3-btn--danger m3-btn--sm',
          onclick: async () => {
            const ok = await destructiveConfirm({
              title: t('appearance.editor.resetAllTitle'),
              body: t('appearance.editor.resetAllBody'),
              confirmLabel: t('common.delete'),
            });
            if (!ok) return;
            await clearAllProps(kind, id);
            history.record('appearance-element', `${targetName(kind)} · ${id}`, t('appearance.editor.resetAllDone'));
            rerender();
          },
        }, t('appearance.editor.resetAll')),
      ),
    );
  }

  function buildFontPicker(fontInfo) {
    const current = getOverrides(kind, id).fontFamily;
    const statusLine = h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' },
      fontStatusText(fontInfo));
    const picker = createFilterPicker({
      label: t('appearance.font.label'),
      value: current === undefined ? '__inherit__' : String(current),
      options: [
        { value: '__inherit__', label: t('appearance.editor.inherit') },
        { value: '', label: t('appearance.font.defaultOption') },
        ...fontInfo.families.map((f) => ({ value: f, label: f })),
      ],
      onChange: async (value) => {
        if (value === '__inherit__') await patchProp(kind, id, 'fontFamily', null, explicitListForWrite());
        else await patchProp(kind, id, 'fontFamily', value, explicitListForWrite());
      },
      popoverClass: 'mr-ee__fontpopover',
    });
    const wrap = h('div', { class: 'mr-col', style: 'gap:2px' }, picker.el, statusLine);
    wrap.dataset.role = 'fontrow';
    return wrap;
  }

  function fontStatusText(fontInfo) {
    if (fontInfo.errors?.native) return t('appearance.font.nativeFailed');
    const m = fontInfo.meta;
    if (!m) return '';
    return t('appearance.font.status')
      .replace('{native}', String(m.nativeCount))
      .replace('{local}', String(m.localApiCount))
      .replace('{curated}', String(m.curatedCount));
  }

  // -- anchoring ------------------------------------------------------------

  function reposition() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    pop.style.maxHeight = `${vh - 24}px`;
    const rect = anchor.getBoundingClientRect();
    const measured = pop.getBoundingClientRect();
    const width = Math.min(360, vw - 24);
    pop.style.width = `${width}px`;
    let left = rect.right + 10;
    if (left + width > vw - 8) left = Math.max(8, rect.left - width - 10);
    let top = rect.top;
    top = Math.min(Math.max(8, top), vh - measured.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function onPointerDown(e) {
    if (pop.contains(e.target)) return;
    if (e.target.closest('.mr-fp__popover, .mr-cp__popover')) return; // pickers own their surfaces
    close();
  }

  function onAnchorScroll() {
    if (!anchor.isConnected) close();
    else reposition();
  }

  function close() {
    pop.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onAnchorScroll, true);
    if (activeEditor?.close === close) activeEditor = null;
    try { anchor.focus({ preventScroll: true }); } catch { /* anchor may be gone */ }
  }

  function rerender() {
    buildBody(); // async but safe: replaces children when ready
  }

  document.body.append(pop);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', onAnchorScroll, true);

  reposition();
  buildBody();

  const editor = { close };
  activeEditor = editor;
  return editor;
}

/** Currently-open editor (tests/integration may assert single-instance). */
export function isOpen() {
  return Boolean(activeEditor);
}

export { RAINBOW };
