// Purpose: the dim sum surprise - a 10% chance at startup of a small
// non-blocking card in the bottom corner showing one dish's English and
// Chinese names plus its bundled-from-the-public-catalog photo. Auto-dismisses
// after eight seconds, never gates startup, never steals focus, never fires
// twice per launch, is suppressed during first-run / error / update flows and
// entirely under School mode, ships NO opt-out setting by design, and
// respects reduced motion. Photos come from the local cache fed once by the
// public catalog; nothing is generated or fetched at render time beyond that
// one-time fetch.
// Owned by Delight lane.

import { h } from '../../core/util.js';
import { invoke, on } from '../../core/bridge.js';
import * as settings from '../../core/settings.js';
import { t } from '../../core/i18n.js';
import { dc, schoolActive, whenReady } from './common.js';

let drawnThisLaunch = false;
let updateFlowSeen = false;

export function bootDimSumSurprise() {
  on('update-status', () => { updateFlowSeen = true; });
  whenReady(() => {
    // First-run flows stay undisturbed; afterwards this flag records reality.
    const firstRun = settings.get('general.firstRunCompleted', false) !== true;
    if (!firstRun) maybeDraw();
    settings.set('general.firstRunCompleted', true).catch(() => {});
  });
}

async function maybeDraw() {
  if (drawnThisLaunch) return; // never twice per launch
  drawnThisLaunch = true;
  if (updateFlowSeen) return;
  if (schoolActive()) return;
  // Fresh random draw each launch; exactly the stated frequency.
  if (Math.random() >= 0.1) return;
  let dish = null;
  try {
    dish = await invoke('vault:delight-dimsum-draw');
  } catch {
    dish = null; // offline or no cached catalog yet: honestly show nothing
  }
  if (!dish) return;
  if (schoolActive()) return; // re-checked after the await
  showCard(dish);
}

function showCard(dish) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const img = h('img', {
    src: dish.imageDataUrl,
    alt: dish.altEn || dish.en || t('dl.dimsum.altFallback'),
    class: 'mr-dimsum__img',
  });
  const credit = h('a', {
    href: '#',
    class: 'mr-typography-label-small',
    onclick: (e) => {
      e.preventDefault();
      invoke('shell:open-external', { url: `https://github.com/${dish.attribution?.repository ?? 'Ding-Ding-Projects/dim-sum-photos'}` }).catch(() => {});
    },
  }, t('dl.dimsum.photoCredit'));

  const closeBtn = h('button', {
    class: 'mr-dimsum__close',
    'aria-label': t('common.close'),
    onclick: () => card.remove(),
  }, '✕');

  const card = h('aside', {
    class: `mr-dimsum${reducedMotion ? '' : ' mr-dimsum--animate'}`,
    role: 'complementary',
    'aria-label': `${dish.en} · ${dish.zh}`,
  },
    img,
    h('div', { class: 'mr-col', style: 'gap:2px;min-width:0' },
      h('strong', { class: 'mr-dimsum__name' }, `${dish.en} · ${dish.zh}`),
      h('span', { class: 'mr-typography-body-small', style: 'color:var(--md-sys-color-on-surface-variant)' }, dc('dl.dimsum.caption')),
      credit,
    ),
    closeBtn,
  );

  document.body.append(card);
  const timer = setTimeout(() => card.remove(), 8000);
  card.addEventListener('click', () => { clearTimeout(timer); });
}
