/* Dim sum surprise: a 10% chance at page load of showing one dish.
   Photos are hotlinked from the public catalog release assets
   (Ding-Ding-Projects/dim-sum-photos, tag catalog-v1) — nothing is bundled
   or fetched through any proxy. Not shown on a first visit and suppressed
   by School mode. There is deliberately no off switch. */

import { el } from './util.js';
import { getSettings } from './store.js';
import { t } from './i18n.js';

const ASSET_BASE = 'https://github.com/Ding-Ding-Projects/dim-sum-photos/releases/download/catalog-v1';

export const DIMSUM_POOL = [
  { file: 'hk-dish-0001-classic-har-gow.png', en: 'Classic Har Gow', zh: '蝦餃' },
  { file: 'hk-dish-0011-classic-siu-mai.png', en: 'Classic Siu Mai', zh: '燒賣' },
  { file: 'hk-dish-0027-black-bean-chicken-feet.png', en: 'Steamed Chicken Feet in Black Bean Sauce', zh: '豉汁蒸鳳爪' },
  { file: 'hk-dish-0104-vegetable-spring-rolls.png', en: 'Vegetable Spring Rolls', zh: '素菜春卷' },
  { file: 'hk-dish-0111-sesame-balls.png', en: 'Sesame Balls', zh: '煎堆' },
  { file: 'hk-dish-0139-puff-pastry-egg-tarts.png', en: 'Puff Pastry Egg Tarts', zh: '酥皮蛋撻' },
  { file: 'hk-dish-0162-fried-dough-rice-rolls.png', en: 'Fried Dough Stick Rice Noodle Rolls', zh: '炸兩' },
  { file: 'hk-dish-0651-hong-kong-festive-pan-fried-turnip-cake.png', en: 'Pan-Fried Turnip Cake', zh: '香煎蘿蔔糕' },
];

export function registerDimsumBundle(addBundle) {
  addBundle('dimsum', {
    en: {
      'ds.title': 'A little something from the steamer basket',
      'ds.note': 'Photos come straight from the public dim-sum catalog.',
      'ds.alt': 'Photograph of',
    },
    zh: {
      'ds.title': '蒸籠入面揀咗味嘢畀你',
      'ds.note': '相直接嚟自公開點心圖鑑。',
      'ds.alt': '相片：',
    },
  });
}

function firstVisitDone() {
  if (!localStorage.getItem('mr-site:visited')) {
    localStorage.setItem('mr-site:visited', JSON.stringify(Date.now()));
    return false;
  }
  return true;
}

/* Returns true if the surprise fired. Called once per full page load. */
export function maybeShowSurprise() {
  const s = getSettings();
  if (s.schoolMode) return false;
  if (!firstVisitDone()) return false;
  if (Math.random() >= 0.10) return false;
  const dish = DIMSUM_POOL[Math.floor(Math.random() * DIMSUM_POOL.length)];
  const lang = s.language;
  const name = lang === 'zh' ? dish.zh : `${dish.en} · ${dish.zh}`;

  const host = el('div', { class: 'dimsum-card', role: 'status' });
  const img = el('img', {
    src: `${ASSET_BASE}/${dish.file}`,
    alt: `${t('ds.alt')} ${name}`,
    width: '160',
    height: '160',
    loading: 'lazy',
  });
  img.addEventListener('error', () => {
    // If the public asset cannot load (offline), show the name only.
    img.remove();
  });
  host.append(
    el('div', { class: 'dimsum-title', text: t('ds.title') }),
    img,
    el('div', { class: 'dimsum-name', text: name }),
    el('div', { class: 'dimsum-note', text: t('ds.note') }),
  );
  const closeBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text dimsum-x', 'aria-label': '✕', text: '✕' });
  closeBtn.addEventListener('click', () => host.remove());
  host.append(closeBtn);
  document.body.append(host);
  setTimeout(() => host.remove(), 9000);
  return true;
}
