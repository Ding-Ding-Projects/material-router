// Purpose: Appearance tab - deep customization over core/tokens.css custom
// properties. tokens.css itself is never edited; this lane writes one runtime
// override style element (see engine.js).
//
// Sections: theme, density, accent seed (infinite colour picker + animated
// rainbow sentinel), typography (font family/size scale/weight), named
// presets with export/import + global reset, per-element editing (anchored,
// non-modal, per-property resets), the spoken-feedback narrator, and
// scheduled appearance rules. Every persisted write goes through settings
// (JSONStore atomic) and records local history.
// Owned by Appearance lane - keep the registerTab id ('appearance') stable.

import { h, attachRipple } from '../../core/util.js';
import { t, copy, languageMode, addBundle } from '../../core/i18n.js';
import * as settings from '../../core/settings.js';
import * as theme from '../../core/theme.js';
import { registerTab, iconFromPath } from '../registry.js';
import { registerSettingsSection } from '../../core/settings-ui.js';
import * as palette from '../../core/palette.js';
import { promptText, destructiveConfirm } from '../../core/dialogs.js';
import { toast } from '../../core/toasts.js';
import * as history from '../../core/history.js';
import { createSearchBar, matchesQuery } from '../../core/searchbar.js';

import { en } from './i18n/en.js';
import { zh } from './i18n/zh.js';
import * as engine from './engine.js';
import * as colorsMod from './colors.js';
import * as presetsMod from './presets.js';
import * as fontsMod from './fonts.js';
import * as narrator from './narrator.js';
import * as scheduled from './scheduled.js';
import * as elementEditor from './elementeditor.js';
import { createFilterPicker } from './filterpicker.js';
import { createColorPicker } from './colorpicker.js';
import { loadAppearanceCss } from './stylesheets.js';

addBundle('appearance', { en, zh });
loadAppearanceCss();

const RECENT_COLORS_MAX = 12;

// ---------------------------------------------------------------------------
// Small shared UI helpers (labels + progressive-disclosure explanation +
// truthful default-provenance line beside EVERY setting).
// ---------------------------------------------------------------------------

function formatValue(key, value) {
  if (value === '' || value == null) return t('appearance.provenance.unset');
  return String(value);
}

/**
 * One settings row: control + an info affordance holding a real explanation
 * + a provenance line naming the SHIPPED default and whether the current
 * value is still it.
 */
function settingRow({ key, titleKey, explainKey, buildControl, shippedDefault }) {
  const current = settings.get(key, undefined);
  const untouched = current === undefined;
  const provenance = untouched
    ? t('appearance.provenance.default').replace('{value}', formatValue(key, shippedDefault))
    : t('appearance.provenance.customised')
      .replace('{value}', formatValue(key, shippedDefault))
      .replace('{current}', formatValue(key, current));

  const controlHost = h('div', { class: 'mr-grow mr-col', style: 'gap:4px' });
  try {
    buildControl(controlHost);
  } catch (err) {
    controlHost.append(h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-error)' },
      `${t('common.errorTitle')}: ${err.message}`));
  }

  const el = h('div', { class: 'mr-setting-row', dataset: { settingKey: key } },
    h('div', { class: 'mr-row', style: 'gap:8px;align-items:flex-start' },
      h('strong', { class: 'mr-setting-row__title' }, t(titleKey)),
      h('details', { class: 'mr-setting-info' },
        h('summary', { 'aria-label': `${t('appearance.aboutSetting')}: ${t(titleKey)}` }, '?'),
        h('div', {},
          h('p', { class: 'mr-typography-body-small', style: 'margin:4px 0' }, t(explainKey)),
          h('p', { class: 'mr-typography-body-small', style: 'margin:4px 0;color:var(--md-sys-color-on-surface-variant)' }, provenance),
        ),
      ),
    ),
    controlHost,
    h('p', { class: 'mr-typography-body-small mr-setting-row__provenance', style: 'color:var(--md-sys-color-on-surface-variant)' }, provenance),
  );
  return el;
}

function recentColors() {
  const list = settings.get('appearance.recentColors', []);
  return Array.isArray(list) ? list.slice(-RECENT_COLORS_MAX).reverse() : [];
}

async function pushRecentColor(hex) {
  const existing = recentColors().filter((c) => c.toLowerCase() !== hex.toLowerCase());
  existing.unshift(hex);
  await settings.set('appearance.recentColors', existing.slice(0, RECENT_COLORS_MAX));
}

// ---------------------------------------------------------------------------
// Section builders (each returns DOM appended into the tab panel)
// ---------------------------------------------------------------------------

function renderThemeSection(container, refs) {
  const card = h('div', { class: 'm3-card m3-card--outlined', dataset: { appearanceSection: 'theme' } },
    h('h2', { class: 'm3-card__title' }, copy('appearance.group.theme')),
  );

  const themeRow = settingRow({
    key: 'appearance.theme',
    titleKey: 'appearance.theme.label',
    explainKey: 'appearance.theme.explain',
    shippedDefault: 'system',
    buildControl: (host) => {
      const picker = createFilterPicker({
        label: t('appearance.theme.label'),
        value: theme.currentMode(),
        options: [
          { value: 'system', label: t('appearance.themeSystem') },
          { value: 'light', label: t('appearance.themeLight') },
          { value: 'dark', label: t('appearance.themeDark') },
        ],
        onChange: async (v) => {
          await theme.setTheme(v);
          history.record('appearance', t('appearance.theme.label'), v);
        },
      });
      host.append(picker.el);
    },
  });

  const densityRow = settingRow({
    key: 'appearance.density',
    titleKey: 'appearance.density.label',
    explainKey: 'appearance.density.explain',
    shippedDefault: 'comfortable',
    buildControl: (host) => {
      const picker = createFilterPicker({
        label: t('appearance.density.label'),
        value: settings.get('appearance.density', 'comfortable'),
        options: [
          { value: 'comfortable', label: t('appearance.density.comfortable') },
          { value: 'compact', label: t('appearance.density.compact') },
        ],
        onChange: async (v) => {
          await settings.set('appearance.density', v);
          history.record('appearance', t('appearance.density.label'), v);
        },
      });
      host.append(picker.el);
    },
  });

  card.append(themeRow, densityRow);
  refs.themeRow = themeRow;
  refs.densityRow = densityRow;
  container.append(card);
}

function renderAccentSection(container, refs) {
  const card = h('div', { class: 'm3-card m3-card--outlined', dataset: { appearanceSection: 'accent' } },
    h('h2', { class: 'm3-card__title' }, copy('appearance.group.accent')),
  );

  const accentRow = settingRow({
    key: 'appearance.accentSeed',
    titleKey: 'appearance.accent.label',
    explainKey: 'appearance.accent.explain',
    shippedDefault: '',
    buildControl: (host) => {
      const picker = createColorPicker({
        label: t('appearance.accent.label'),
        value: settings.get('appearance.accentSeed', ''),
        allowRainbow: true,
        getRecents: recentColors,
        addRecent: pushRecentColor,
        onChange: (v) => {
          // Sentinel ('rainbow') is stored EXACTLY as received - never
          // composed, never parsed as a colour.
          settings.set('appearance.accentSeed', v)
            .then(() => history.record('appearance', t('appearance.accent.label'), v))
            .catch((err) => toast(t('common.errorTitle'), err.message, { kind: 'error' }));
        },
      });
      host.append(picker.el);
      refs.accentSwatch = picker.el;
    },
  });
  card.append(accentRow);

  const speedRow = settingRow({
    key: 'appearance.rainbowSpeed',
    titleKey: 'appearance.accent.rainbowSpeed',
    explainKey: 'appearance.accent.speedExplain',
    shippedDefault: 3,
    buildControl: (host) => {
      const slider = h('input', {
        type: 'range', min: '1', max: '5', step: '1',
        value: String(settings.get('appearance.rainbowSpeed', 3)),
        'aria-label': t('appearance.accent.rainbowSpeed'),
        onchange: () => settings.set('appearance.rainbowSpeed', Number(slider.value))
          .then(() => history.record('appearance', t('appearance.accent.rainbowSpeed'), slider.value)),
      });
      host.append(slider, levelHint());
    },
  });
  card.append(speedRow);
  refs.accentRow = accentRow;
  refs.rainbowSpeedRow = speedRow;
  container.append(card);

  function levelHint() {
    return h('p', { class: 'mr-typography-body-small', style: 'margin:2px 0 0;color:var(--md-sys-color-on-surface-variant)' },
      `${t('appearance.accent.speedLevels')} ${Object.values(engine.RAINBOW_LEVELS).map((d, i) => `${i + 1}=${d}`).join(' · ')}`);
  }
}

function renderTypographySection(container, refs) {
  const card = h('div', { class: 'm3-card m3-card--outlined', dataset: { appearanceSection: 'typography' } },
    h('h2', { class: 'm3-card__title' }, copy('appearance.group.typography')),
  );

  const fontRow = settingRow({
    key: 'appearance.fontFamily',
    titleKey: 'appearance.font.label',
    explainKey: 'appearance.font.explain',
    shippedDefault: '',
    buildControl: (host) => {
      const statusLine = h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' },
        t('appearance.font.loading'));
      const picker = createFilterPicker({
        label: t('appearance.font.label'),
        value: settings.get('appearance.fontFamily', ''),
        options: [{ value: '', label: t('appearance.font.defaultOption') }],
        popoverClass: 'mr-ee__fontpopover',
        onChange: (v) => settings.set('appearance.fontFamily', v)
          .then(() => history.record('appearance', t('appearance.font.label'), v || '(default)'))
          .catch((err) => toast(t('common.errorTitle'), err.message, { kind: 'error' })),
      });
      host.append(picker.el, statusLine);
      refs.fontPickerEl = picker.el;
      fontsMod.enumerateFonts().then((info) => {
        picker.setOptions([
          { value: '', label: t('appearance.font.defaultOption') },
          ...info.families.map((f) => ({ value: f, label: f })),
        ]);
        statusLine.textContent = info.errors?.native
          ? t('appearance.font.nativeFailed')
          : t('appearance.font.status')
            .replace('{native}', String(info.meta.nativeCount))
            .replace('{local}', String(info.meta.localApiCount))
            .replace('{curated}', String(info.meta.curatedCount));
      }).catch(() => {
        statusLine.textContent = t('appearance.font.nativeFailed');
      });
    },
  });
  card.append(fontRow);

  const scaleRow = settingRow({
    key: 'appearance.typeScale',
    titleKey: 'appearance.typeScale.label',
    explainKey: 'appearance.typeScale.explain',
    shippedDefault: 1,
    buildControl: (host) => {
      const out = h('span', { class: 'mr-typography-label-medium', style: 'min-width:56px;text-align:right' },
        `${Math.round((settings.get('appearance.typeScale', 1)) * 100)}%`);
      const slider = h('input', {
        type: 'range', min: String(engine.TYPE_SCALE_MIN), max: String(engine.TYPE_SCALE_MAX), step: '0.01',
        value: String(settings.get('appearance.typeScale', 1)),
        'aria-label': t('appearance.typeScale.label'),
        oninput: () => { out.textContent = `${Math.round(Number(slider.value) * 100)}%`; },
        onchange: () => settings.set('appearance.typeScale', Number(slider.value))
          .then(() => history.record('appearance', t('appearance.typeScale.label'), `${out.textContent}`)),
      });
      host.append(h('div', { class: 'mr-row' }, slider, out));
      refs.typeScaleSlider = slider;
    },
  });
  card.append(scaleRow);

  const weightRow = settingRow({
    key: 'appearance.baseWeight',
    titleKey: 'appearance.baseWeight.label',
    explainKey: 'appearance.baseWeight.explain',
    shippedDefault: 400,
    buildControl: (host) => {
      const picker = createFilterPicker({
        label: t('appearance.baseWeight.label'),
        value: settings.get('appearance.baseWeight', 400),
        options: engine.WEIGHT_OPTIONS.map((w) => ({ value: w, label: String(w) })),
        onChange: (v) => settings.set('appearance.baseWeight', Number(v))
          .then(() => history.record('appearance', t('appearance.baseWeight.label'), String(v))),
      });
      host.append(picker.el);
    },
  });
  card.append(weightRow);
  refs.fontRow = fontRow;
  refs.typeScaleRow = scaleRow;
  refs.weightRow = weightRow;
  container.append(card);
}

function renderPresetsSection(container, refs) {
  const card = h('div', { class: 'm3-card m3-card--outlined', dataset: { appearanceSection: 'presets' } },
    h('h2', { class: 'm3-card__title' }, copy('appearance.group.presets')),
  );

  let queryState = null;
  const listEl = h('div', { class: 'mr-col', style: 'gap:6px' });
  const search = createSearchBar({
    placeholder: t('appearance.presets.searchPlaceholder'),
    label: t('appearance.presets.searchPlaceholder'),
    onQuery: (q) => { queryState = q; renderList(); },
  });

  const selectedIds = new Set();
  const exportSelectedBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm', disabled: true,
    onclick: () => presetsMod.downloadPresets(`appearance-presets-${Date.now()}.json`,
      { includeBuiltIns: false, ids: [...selectedIds] }),
  }, t('common.exportJson'));
  const deleteSelectedBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm', disabled: true,
    onclick: async () => {
      const ids = [...selectedIds];
      if (!ids.length) return;
      const ok = await destructiveConfirm({
        title: t('appearance.presets.deleteConfirmTitle'),
        body: t('appearance.presets.deleteConfirmBody'),
        confirmLabel: t('common.delete'),
      });
      if (!ok) return;
      for (const id of ids) await presetsMod.deleteUserPreset(id);
      selectedIds.clear();
      history.record('presets', t('appearance.presets.deleted'), String(ids.length));
      renderList();
    },
  }, t('common.delete'));

  function visiblePresets() {
    const q = queryState ?? { text: '', mode: 'plain' };
    return presetsMod.allPresets().filter((p) => matchesQuery(q, `${nameOf(p)} ${p.id}`));
  }

  function nameOf(preset) {
    const mode = languageMode();
    if (typeof preset.name === 'string') return preset.name;
    if (mode === 'zh') return preset.name?.zh ?? preset.name?.en ?? preset.id;
    return preset.name?.en ?? preset.id;
  }

  function renderList() {
    listEl.textContent = '';
    const rows = visiblePresets();
    if (rows.length === 0) {
      listEl.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
        t('appearance.presets.empty')));
    }
    for (const preset of rows) {
      const swatch = h('span', {
        class: `mr-preset__swatch${preset.accentSeed === colorsMod.RAINBOW ? ' mr-cp--rainbow' : ''}`,
        style: `background:${/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(preset.accentSeed)) ? preset.accentSeed : 'var(--md-sys-color-primary-container)'}`,
        'aria-hidden': 'true',
      });
      const checkbox = preset.builtIn ? null : h('input', {
        type: 'checkbox', 'aria-label': t('common.select'),
        onchange: (e) => {
          if (e.target.checked) selectedIds.add(preset.id);
          else selectedIds.delete(preset.id);
          exportSelectedBtn.disabled = deleteSelectedBtn.disabled = selectedIds.size === 0;
        },
      });
      const applyBtn = h('button', {
        class: 'm3-btn m3-btn--tonal m3-btn--sm',
        onclick: async () => {
          try {
            await presetsMod.applyPreset(preset);
            history.record('presets', nameOf(preset), t('appearance.presets.applied'));
            toast(t('appearance.presets.appliedToast'), nameOf(preset), { kind: 'success' });
          } catch (err) {
            toast(t('common.errorTitle'), err.message, { kind: 'error' });
          }
        },
      }, t('appearance.presets.applyBtn'));
      attachRipple(applyBtn);

      const row = h('div', { class: 'mr-row', dataset: { presetId: preset.id } },
        checkbox ? h('label', { class: 'm3-checkbox' }, checkbox) : h('span', { style: 'width:26px' }),
        swatch,
        h('span', { class: 'mr-grow' }, nameOf(preset)),
        preset.builtIn ? h('span', { class: 'mr-typography-label-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, t('appearance.presets.builtIn')) : null,
        applyBtn,
        !preset.builtIn ? h('button', {
          class: 'm3-btn m3-btn--text m3-btn--sm',
          onclick: async () => {
            const ok = await destructiveConfirm({
              title: t('appearance.presets.deleteOneTitle'),
              body: `${t('appearance.presets.deleteOneBody')} “${nameOf(preset)}”`,
              confirmLabel: t('common.delete'),
            });
            if (!ok) return;
            await presetsMod.deleteUserPreset(preset.id);
            history.record('presets', nameOf(preset), t('appearance.presets.deleted'));
            renderList();
          },
          'aria-label': `${t('common.delete')} ${nameOf(preset)}`,
        }, t('common.delete')) : null,
      );
      listEl.append(row);
    }
  }

  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', class: 'mr-visually-hidden',
    'aria-label': t('appearance.presets.importTitle'),
    id: 'mr-appearance-preset-import',
    onchange: async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > 512 * 1024) {
        toast(t('common.errorTitle'), t('appearance.presets.importTooBig'), { kind: 'error' });
        return;
      }
      try {
        const text = await file.text();
        const result = await presetsMod.importFromText(text);
        history.record('presets', t('appearance.presets.importTitle'), String(result.imported));
        toast(t('appearance.presets.importedToast'), String(result.imported), { kind: 'success' });
        renderList();
      } catch (err) {
        toast(t('common.errorTitle'), err.message, { kind: 'error' });
      }
    },
  });
  const importLabel = h('label', { class: 'm3-btn m3-btn--text m3-btn--sm', for: 'mr-appearance-preset-import' },
    t('appearance.presets.importTitle'));

  const saveAsBtn = h('button', {
    class: 'm3-btn m3-btn--filled m3-btn--sm',
    onclick: async () => {
      const name = await promptText({
        title: t('appearance.presets.saveAs'),
        label: t('appearance.presets.namePrompt'),
      });
      if (name === null) return;
      try {
        await presetsMod.saveCurrentAsPreset(name);
        history.record('presets', name.trim(), t('appearance.presets.savedFromCurrent'));
        renderList();
        toast(t('appearance.presets.savedToast'), name.trim(), { kind: 'success' });
      } catch (err) {
        toast(t('common.errorTitle'), err.message, { kind: 'error' });
      }
    },
  }, t('appearance.presets.saveAs'));

  const exportAllBtn = h('button', {
    class: 'm3-btn m3-btn--text m3-btn--sm',
    onclick: () => presetsMod.downloadPresets(`appearance-presets-${Date.now()}.json`, { includeBuiltIns: true }),
  }, t('common.exportJson'));

  const globalResetBtn = h('button', {
    class: 'm3-btn m3-btn--danger m3-btn--sm',
    onclick: async () => {
      const ok = await destructiveConfirm({
        title: t('appearance.presets.globalResetTitle'),
        body: t('appearance.presets.globalResetBody'),
        confirmLabel: t('appearance.presets.globalResetConfirm'),
      });
      if (!ok) return;
      await presetsMod.resetAllToDefaults();
      history.record('appearance', t('appearance.presets.globalResetDone'), '');
      toast(t('appearance.presets.globalResetToast'), '', { kind: 'success' });
    },
  }, t('appearance.presets.globalReset'));

  card.append(
    settingRow({
      key: 'appearance.presets',
      titleKey: 'appearance.presets.label',
      explainKey: 'appearance.presets.explain',
      shippedDefault: '',
      buildControl: (host) => host.append(search.el),
    }),
    listEl,
    h('div', { class: 'mr-row', style: 'flex-wrap:wrap;margin-top:8px' },
      saveAsBtn, exportAllBtn, importLabel, exportSelectedBtn, deleteSelectedBtn, globalResetBtn,
    ),
    fileInput,
  );

  refs.presetSearch = search.el;
  renderList();
  container.append(card);
}

function renderElementEditorSection(container, refs) {
  const card = h('div', { class: 'm3-card m3-card--outlined', dataset: { appearanceSection: 'elements' } },
    h('h2', { class: 'm3-card__title' }, copy('appearance.group.elements')));

  const demoCardTarget = 'appearance.demo-card';
  const demoButtonTarget = 'appearance.demo-button';

  const demoCard = h('div', {
    class: 'm3-card m3-card--elevated mr-demo-target',
    dataset: { mrAppearanceTarget: demoCardTarget },
    tabindex: '0',
    role: 'group',
    'aria-label': `${t('appearance.editor.kindElement')}: ${demoCardTarget}`,
  }, h('p', { class: 'mr-typography-body-medium', style: 'margin:0' }, t('appearance.elements.demoCardText')));

  const demoButton = h('button', {
    class: 'm3-btn m3-btn--tonal mr-demo-target',
    dataset: { mrAppearanceTarget: demoButtonTarget },
    tabindex: '0',
  }, t('appearance.elements.demoButtonText'));

  for (const target of [demoCard, demoButton]) {
    wireAppearanceTarget(target, 'element');
  }

  card.append(
    h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
      t('appearance.elements.intro')),
    h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
      t('appearance.elements.howToOpen')),
    demoCard,
    h('div', {}, demoButton),
  );

  refs.elementTargets = [demoCard, demoButton];
  container.append(card);
}

/** Context menu + keyboard path for any in-lane element target. */
function wireAppearanceTarget(targetEl, kind) {
  const open = () => {
    const key = targetEl.dataset.mrAppearanceTarget;
    elementEditor.openElementEditor({
      kind,
      id: key,
      anchor: targetEl,
      title: `${t('appearance.editor.title')} · ${key}`,
    });
  };
  targetEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    open();
  });
  targetEl.addEventListener('keydown', (e) => {
    // Keyboard equivalents: the ContextMenu key and Shift+F10.
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      open();
    }
  });
}

function renderNarratorSection(container, refs) {
  const card = h('div', { class: 'm3-card m3-card--outlined', dataset: { appearanceSection: 'narrator' } },
    h('h2', { class: 'm3-card__title' }, copy('appearance.group.narrator')));

  if (!narrator.supported()) {
    card.append(h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-error)' },
      t('appearance.narrator.unsupported')));
    refs.narratorCard = card;
    container.append(card);
    return;
  }

  const cfg = () => settings.get('appearance.narrator', {}) ?? {};

  const enableRow = settingRow({
    key: 'appearance.narrator.enabled',
    titleKey: 'appearance.narrator.enable',
    explainKey: 'appearance.narrator.enableExplain',
    shippedDefault: false,
    buildControl: (host) => {
      const cb = h('input', {
        type: 'checkbox', checked: Boolean(cfg().enabled) ? true : null,
        'aria-label': t('appearance.narrator.enable'),
        onchange: async () => {
          await narrator.setEnabled(cb.checked);
          history.record('appearance', t('appearance.narrator.enable'), cb.checked ? 'on' : 'off');
        },
      });
      host.append(h('label', { class: 'm3-checkbox' }, cb, h('span', {}, t('appearance.narrator.enable'))));
    },
  });
  card.append(enableRow);

  const langRow = settingRow({
    key: 'appearance.narrator.language',
    titleKey: 'appearance.narrator.language',
    explainKey: 'appearance.narrator.languageExplain',
    shippedDefault: 'en',
    buildControl: (host) => {
      const picker = createFilterPicker({
        label: t('appearance.narrator.language'),
        value: cfg().language ?? 'en',
        options: [
          { value: 'en', label: t('appearance.narrator.langEn') },
          { value: 'zh', label: t('appearance.narrator.langZh') },
          { value: 'both', label: t('appearance.narrator.langBoth') },
        ],
        onChange: (v) => narrator.setLanguage(v)
          .then(() => history.record('appearance', t('appearance.narrator.language'), v)),
      });
      host.append(picker.el);
    },
  });
  card.append(langRow);

  // One voice picker PER narrated language, each with its own honest status.
  const voiceEnStatus = h('p', { class: 'mr-typography-body-small', style: 'margin:2px 0 0;color:var(--md-sys-color-on-surface-variant)' });
  const voiceZhStatus = h('p', { class: 'mr-typography-body-small', style: 'margin:2px 0 0;color:var(--md-sys-color-on-surface-variant)' });

  function voiceOptions(lang) {
    const voices = narrator.voicesFor(lang);
    return [
      { value: '', label: t('appearance.narrator.autoVoice') },
      ...voices.map((v) => ({ value: v.voiceURI, label: v.name, hint: v.lang })),
    ];
  }

  function refreshVoiceStatus(statusEl, lang) {
    const status = narrator.voiceStatus(lang);
    const map = {
      unsupported: 'appearance.narrator.status.unsupported',
      noneForLang: 'appearance.narrator.status.noneForLang',
      fallback: 'appearance.narrator.status.fallback',
      network: 'appearance.narrator.status.network',
      auto: 'appearance.narrator.status.auto',
      ok: 'appearance.narrator.status.ok',
    };
    statusEl.textContent = t(map[status.kind] ?? 'appearance.narrator.status.auto');
  }

  const voiceEnRow = settingRow({
    key: 'appearance.narrator.voiceEn',
    titleKey: 'appearance.narrator.voiceEn',
    explainKey: 'appearance.narrator.voiceExplain',
    shippedDefault: '',
    buildControl: (host) => {
      const picker = createFilterPicker({
        label: t('appearance.narrator.voiceEn'),
        value: cfg().voiceEn ?? '',
        options: voiceOptions('en'),
        popoverClass: 'mr-ee__fontpopover',
        onChange: async (v) => {
          await narrator.setVoice('en', v);
          history.record('appearance', t('appearance.narrator.voiceEn'), v || '(auto)');
          refreshVoiceStatus(voiceEnStatus, 'en');
        },
      });
      host.append(picker.el, voiceEnStatus);
      refs.voiceEnPicker = picker;
    },
  });
  const voiceZhRow = settingRow({
    key: 'appearance.narrator.voiceZh',
    titleKey: 'appearance.narrator.voiceZh',
    explainKey: 'appearance.narrator.voiceExplain',
    shippedDefault: '',
    buildControl: (host) => {
      const picker = createFilterPicker({
        label: t('appearance.narrator.voiceZh'),
        value: cfg().voiceZh ?? '',
        options: voiceOptions('zh'),
        popoverClass: 'mr-ee__fontpopover',
        onChange: async (v) => {
          await narrator.setVoice('zh', v);
          history.record('appearance', t('appearance.narrator.voiceZh'), v || '(auto)');
          refreshVoiceStatus(voiceZhStatus, 'zh');
        },
      });
      host.append(picker.el, voiceZhStatus);
      refs.voiceZhPicker = picker;
    },
  });
  card.append(voiceEnRow, voiceZhRow);

  // Voices arrive late on Chromium: re-fill both pickers as the platform
  // enumerates them, and keep the honest statuses fresh.
  narrator.onVoicesChanged(() => {
    refs.voiceEnPicker?.setOptions(voiceOptions('en'));
    refs.voiceZhPicker?.setOptions(voiceOptions('zh'));
    refreshVoiceStatus(voiceEnStatus, 'en');
    refreshVoiceStatus(voiceZhStatus, 'zh');
  });
  refreshVoiceStatus(voiceEnStatus, 'en');
  refreshVoiceStatus(voiceZhStatus, 'zh');

  const rateRow = settingRow({
    key: 'appearance.narrator.rate',
    titleKey: 'appearance.narrator.rate',
    explainKey: 'appearance.narrator.rateExplain',
    shippedDefault: 1,
    buildControl: (host) => {
      const out = h('span', { class: 'mr-typography-label-medium', style: 'min-width:40px;text-align:right' },
        String(narrator.clampRate(cfg().rate ?? 1)));
      const slider = h('input', {
        type: 'range', min: '0.5', max: '3', step: '0.1',
        value: String(narrator.clampRate(cfg().rate ?? 1)),
        'aria-label': t('appearance.narrator.rate'),
        oninput: () => { out.textContent = String(narrator.clampRate(slider.value)); },
        onchange: () => narrator.setRate(slider.value)
          .then(() => history.record('appearance', t('appearance.narrator.rate'), out.textContent)),
      });
      host.append(h('div', { class: 'mr-row' }, slider, out));
    },
  });
  const pitchRow = settingRow({
    key: 'appearance.narrator.pitch',
    titleKey: 'appearance.narrator.pitch',
    explainKey: 'appearance.narrator.pitchExplain',
    shippedDefault: 1,
    buildControl: (host) => {
      const out = h('span', { class: 'mr-typography-label-medium', style: 'min-width:40px;text-align:right' },
        String(narrator.clampPitch(cfg().pitch ?? 1)));
      const slider = h('input', {
        type: 'range', min: '0', max: '2', step: '0.1',
        value: String(narrator.clampPitch(cfg().pitch ?? 1)),
        'aria-label': t('appearance.narrator.pitch'),
        oninput: () => { out.textContent = String(narrator.clampPitch(slider.value)); },
        onchange: () => narrator.setPitch(slider.value)
          .then(() => history.record('appearance', t('appearance.narrator.pitch'), out.textContent)),
      });
      host.append(h('div', { class: 'mr-row' }, slider, out));
    },
  });
  card.append(rateRow, pitchRow);

  const testBtn = h('button', {
    class: 'm3-btn m3-btn--tonal m3-btn--sm',
    onclick: () => narrator.speakSample(t('appearance.narrator.sampleLine')),
  }, t('appearance.narrator.test'));

  card.append(
    h('p', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' },
      t('appearance.narrator.duckNote')),
    testBtn,
  );

  refs.narratorCard = card;
  container.append(card);
}

function renderScheduledSection(container, refs) {
  const card = h('div', { class: 'm3-card m3-card--outlined', dataset: { appearanceSection: 'schedules' } },
    h('h2', { class: 'm3-card__title' }, copy('appearance.group.schedules')));
  refs.scheduledManager = scheduled.renderManager(card);
  refs.scheduledCard = card;
  container.append(card);
}

// ---------------------------------------------------------------------------
// Tab-strip integration: mr:tab-edit-appearance + emoji icons
// ---------------------------------------------------------------------------

let emojiReconcileTimer = null;

function scheduleEmojiReconcile() {
  clearTimeout(emojiReconcileTimer);
  emojiReconcileTimer = setTimeout(reconcileTabIcons, 120);
}

export function reconcileTabIcons() {
  const overrides = settings.get('appearance.tabOverrides', {}) ?? {};
  for (const btn of document.querySelectorAll('.mr-tab-btn[data-tab-id]')) {
    const tabId = btn.dataset.tabId;
    const emoji = typeof overrides[tabId]?.iconEmoji === 'string'
      ? overrides[tabId].iconEmoji.trim() : '';
    let span = btn.querySelector(':scope > .mr-appearance__tab-emoji');
    if (emoji) {
      if (!span) {
        span = h('span', { class: 'mr-appearance__tab-emoji', 'aria-hidden': 'true' }, emoji);
        const label = btn.querySelector('.mr-tab-btn__label');
        if (label) label.before(span);
        else btn.append(span);
      } else {
        span.textContent = emoji;
      }
      btn.classList.add('mr-appearance--emoji-icon');
    } else if (span) {
      span.remove();
      btn.classList.remove('mr-appearance--emoji-icon');
    }
  }
}

function watchStripForIcons() {
  const target = document.getElementById('mr-app') ?? document.body;
  const observer = new MutationObserver(scheduleEmojiReconcile);
  observer.observe(target, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const refs = {};

function render(container) {
  container.textContent = '';
  container.classList.add('mr-appearance-panel');

  const intro = h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' },
    copy('appearance.section.intro'));

  const grid = h('div', { class: 'mr-col', style: 'gap:16px;max-width:860px' });
  renderThemeSection(grid, refs);
  renderAccentSection(grid, refs);
  renderTypographySection(grid, refs);
  renderPresetsSection(grid, refs);
  renderElementEditorSection(grid, refs);
  renderNarratorSection(grid, refs);
  renderScheduledSection(grid, refs);

  container.append(intro, grid);
  scheduleEmojiReconcile();
}

registerTab({
  id: 'appearance',
  label: { en: 'Appearance', zh: '外觀' },
  get icon() { return iconFromPath('M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8Zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z'); },
  init: render,
});

// Settings-shell section (searchable entries teleport to exact controls).
// Entries is a plain ARRAY per registerSettingsSection's contract; resolve()
// closures read the refs object lazily so teleport works after first render.
registerSettingsSection({
  id: 'appearance',
  label: { en: 'Appearance', zh: '外觀' },
  render(container) {
    render(container);
  },
  entries: [
    { label: { en: 'Theme mode', zh: '主題模式' }, keywords: ['theme', 'dark', 'light', 'system'], resolve: () => refs.themeRow ?? null },
    { label: { en: 'Density', zh: '密度' }, keywords: ['density', 'compact', 'spacing'], resolve: () => refs.densityRow ?? null },
    { label: { en: 'Accent colour', zh: '強調色' }, keywords: ['accent', 'seed', 'colour', 'rainbow'], resolve: () => refs.accentRow ?? null },
    { label: { en: 'Rainbow speed', zh: '彩虹速度' }, keywords: ['rainbow', 'speed', 'animation'], resolve: () => refs.rainbowSpeedRow ?? null },
    { label: { en: 'Interface font', zh: '介面字體' }, keywords: ['font', 'family', 'typeface'], resolve: () => refs.fontRow ?? null },
    { label: { en: 'Text size scale', zh: '文字大小比例' }, keywords: ['font size', 'scale', 'zoom'], resolve: () => refs.typeScaleRow ?? null },
    { label: { en: 'Body text weight', zh: '內文字重' }, keywords: ['weight', 'bold'], resolve: () => refs.weightRow ?? null },
    { label: { en: 'Presets', zh: '預設' }, keywords: ['preset', 'theme pack', 'export', 'import'], resolve: () => refs.presetSearch ?? null },
    { label: { en: 'Narration', zh: '語音旁述' }, keywords: ['narrator', 'tts', 'speech', 'voice', 'read aloud'], resolve: () => refs.narratorCard ?? null },
    { label: { en: 'Scheduled appearance', zh: '排程外觀' }, keywords: ['schedule', 'timer', 'night'], resolve: () => refs.scheduledCard ?? null },
  ],
});

// Command palette coverage (titles resolved at registration, matching the
// foundation's own palette items). Guarded so non-browser import checks that
// lack HTMLElement can still load this module. Wrapped so the language-change
// pass can re-register localized titles (palette.register replaces by id).
function registerAppearancePaletteItems() {
  if (typeof HTMLElement === 'undefined') return;
  for (const def of paletteItems()) palette.register(def);
}
registerAppearancePaletteItems();

function paletteItems() {
  return [
    {
      id: 'appearance.openTab',
      title: t('tabs.appearance'),
      section: 'Appearance',
      run: () => import('../../core/tabs.js').then((m) => m.activate('appearance')),
    },
    {
      id: 'appearance.toggleDensity',
      title: t('appearance.palette.toggleDensity'),
      section: 'Appearance',
      run: () => {
        const next = settings.get('appearance.density', 'comfortable') === 'comfortable' ? 'compact' : 'comfortable';
        settings.set('appearance.density', next)
          .then(() => history.record('appearance', t('appearance.density.label'), next));
      },
    },
    {
      id: 'appearance.toggleNarrator',
      title: t('appearance.palette.toggleNarrator'),
      section: 'Appearance',
      run: () => {
        const next = !(settings.get('appearance.narrator', {}) ?? {}).enabled;
        narrator.setEnabled(next)
          .then(() => history.record('appearance', t('appearance.narrator.enable'), next ? 'on' : 'off'))
          .then(() => toast(t('appearance.narrator.enable'), next ? 'on' : 'off', { kind: 'info' }));
      },
    },
    {
      id: 'appearance.resetAccent',
      title: t('appearance.palette.resetAccent'),
      section: 'Appearance',
      run: () => settings.set('appearance.accentSeed', '')
        .then(() => history.record('appearance', t('appearance.accent.label'), '')),
    },
    {
      id: 'appearance.editActiveTab',
      title: t('appearance.palette.editActiveTab'),
      section: 'Appearance',
      run: () => {
        import('../../core/tabs.js').then((tabsMod) => {
          const active = tabsMod.activeId();
          if (!active) return;
          const anchor = document.getElementById(`mr-tab-btn-${active}`);
          elementEditor.openElementEditor({
            kind: 'tab',
            id: active,
            anchor,
            title: `${t('appearance.editor.title')} · ${active}`,
          });
        });
      },
    },
    ...presetsMod.builtInPresets().map((preset) => ({
      id: `appearance.preset.${preset.id}`,
      title: `${t('appearance.presets.applyBtn')} · ${preset.name.en}`,
      section: 'Appearance',
      run: () => presetsMod.applyPreset(preset)
        .then(() => history.record('presets', preset.name.en, t('appearance.presets.applied'))),
    })),
  ];
}

// Bootstrap once settings are ready: engine, narrator feed, scheduler,
// tab-edit-appearance listener, icon reconciliation.
function bootstrap() {
  engine.init();

  window.addEventListener('mr:tab-edit-appearance', (event) => {
    const { tabId, anchor } = event.detail ?? {};
    if (!tabId) return;
    elementEditor.openElementEditor({
      kind: 'tab',
      id: tabId,
      anchor: anchor instanceof HTMLElement && anchor.isConnected
        ? anchor
        : document.getElementById(`mr-tab-btn-${tabId}`),
      title: `${t('appearance.editor.title')} · ${tabId}`,
    });
  });

  narrator.init();
  scheduled.initEngine();
  watchStripForIcons();
  settings.onChange(() => scheduleEmojiReconcile());
  ensureLanguagePass();
}

/**
 * Live retranslate: the panel rebuilds from the existing render functions and
 * reads every control value back from settings, so no draft text exists to
 * lose (colour/font pickers re-adopt persisted values). An open element-editor
 * popover keeps functioning against its settings-backed overrides; it closes
 * itself when its anchor scrolls away, and its own title refreshes on the
 * next open.
 */
let languageUnsub = null;
function ensureLanguagePass() {
  if (languageUnsub) return;
  languageUnsub = settings.onChange((key) => {
    if (key !== 'general.languageMode' && key !== 'school.active') return;
    registerAppearancePaletteItems();
    const panel = document.getElementById('mr-tab-panel-appearance');
    if (!panel?.isConnected) return;
    const scroll = panel.scrollTop;
    render(panel);
    panel.scrollTop = scroll;
  });
}

if (typeof document === 'undefined') {
  // Outside a renderer (import checks): registration alone is the contract.
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', waitForSettingsThen(bootstrap));
} else {
  waitForSettingsThen(bootstrap)();
}

function waitForSettingsThen(fn) {
  return () => {
    if (settings.ready()) fn();
    else setTimeout(waitForSettingsThen(fn), 60);
  };
}
