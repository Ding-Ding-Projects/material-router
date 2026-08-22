// Purpose: the unlock ladder. Offered after three failed credential attempts
// instead of making a person watch a countdown. Rung 1 is one dim-sum
// question (four choices), rung 2 ten easy sums after five wrong dishes
// (here: after one wrong dish, matching the shipped escalation), rung 3
// whack-a-mole after a wrong sum, and the clock after a lost round or an
// exhausted budget. Challenges are generated and graded main-side against a
// single-use nonce; winning clears THIS wait only - it never signs anyone in
// and never refunds attempts.
// Owned by Delight lane.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { invoke } from '../../core/bridge.js';
import { openModal } from '../../core/dialogs.js';
import { announce } from '../../core/toasts.js';
import { dc } from './common.js';

const MOLES_NEEDED = 6;

/**
 * Ask whether the ladder may be offered for this scope right now.
 * @returns {Promise<{attempts:number, waitRemainingMs:number, eligible:boolean, clockOnly:boolean}>}
 */
export async function ladderState(scope) {
  try {
    const s = await invoke('vault:delight-attempt-state', { scope });
    return {
      attempts: Number(s.attempts ?? 0),
      waitRemainingMs: Number(s.waitRemainingMs ?? 0),
      eligible: Boolean(s.ladderEligible),
      clockOnly: Boolean(s.clockOnly),
    };
  } catch {
    return { attempts: 0, waitRemainingMs: 0, eligible: false, clockOnly: false };
  }
}

/**
 * Run the ladder flow for a scope. Resolves true when a round was WON (the
 * caller should re-enable its normal sign-in state immediately); false when
 * the user chose to wait, lost, or closed.
 */
export function offerLadder({ scope } = {}) {
  return new Promise((resolveOuter) => {
    let settled = false;
    let timers = [];
    let wrongDishes = 0; // five wrong dishes descend to the sums rung
    const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

    const finish = (won) => {
      if (settled) return;
      settled = true;
      clearTimers();
      try { dlg.close(); } catch { /* already closing */ }
      resolveOuter(won);
    };

    let bodyEl;
    let dlg;

    function setBody(...nodes) {
      bodyEl.replaceChildren(...nodes);
    }

    // -- offer card -------------------------------------------------------------
    async function showOffer(attempts) {
      const playBtn = h('button', {
        class: 'm3-btn m3-btn--filled',
        onclick: () => startLadder(1),
      }, t('dl.ladder.play'));
      const waitBtn = h('button', {
        class: 'm3-btn m3-btn--text',
        onclick: () => finish(false),
      }, t('dl.ladder.waitInstead'));
      setBody(
        h('p', { class: 'mr-typography-body-medium', style: 'margin:0' },
          t('dl.ladder.offerBody', { attempts: String(attempts) })),
        h('p', { class: 'mr-typography-body-small', style: 'margin:0;color:var(--md-sys-color-on-surface-variant)' },
          t('dl.ladder.win')),
        h('div', { class: 'mr-row', style: 'flex-wrap:wrap;margin-top:8px' }, playBtn, waitBtn),
      );
      queueMicrotask(() => playBtn.focus());
    }

    // -- entry ---------------------------------------------------------------------
    async function startLadder(rung, noteKey = null) {
      let ch;
      try {
        ch = await invoke('vault:delight-ladder-challenge', { scope, rung });
      } catch (err) {
        if (err?.code === 'CLOCK_ONLY') return showClock();
        if (err?.code === 'CHALLENGE_EXPIRED') return showClock();
        return showClock();
      }
      if (!ch.kind) return showClock();
      const nodes = [];
      if (noteKey === 'dl.ladder.offlineNote' || (!ch.dishes && ch.rung === 2 && rung === 1)) {
        nodes.push(h('p', { class: 'mr-typography-body-small', style: 'margin:0 0 8px;color:var(--md-sys-color-on-surface-variant)' },
          t('dl.ladder.offlineNote')));
      }
      if (noteKey && noteKey !== 'dl.ladder.offlineNote') {
        nodes.push(h('p', { class: 'mr-typography-body-small', style: 'margin:0 0 8px;color:var(--md-sys-color-on-surface-variant)' },
          t(noteKey)));
      }
      setBody(...nodes);
      if (ch.kind === 'dimsum') renderDimSum(ch);
      else if (ch.kind === 'sums') renderSums(ch);
      else if (ch.kind === 'moles') renderMoles(ch);
    }

    async function answer(nonce, answer, onWrong) {
      try {
        const result = await invoke('vault:delight-ladder-answer', { nonce, answer });
        if (result.cleared) {
          announce(t('dl.ladder.win'));
          finish(true);
          return;
        }
        onWrong(result);
      } catch (err) {
        if (err?.code === 'ROUND_EARLY') {
          announce(t('dl.ladder.roundEarly'));
          return; // keep the round going; the honest rejection is not a loss
        }
        showClock();
      }
    }

    // -- rung 1: dim sum ------------------------------------------------------------------
    function renderDimSum(ch) {
      const grid = h('div', { class: 'mr-ladder-dishes', role: 'group', 'aria-label': t('dl.ladder.dimsumQ') });
      grid.append(h('h3', { style: 'margin:4px 0 8px;font-size:var(--md-sys-type-title-medium-size)' }, t('dl.ladder.dimsumQ')));
      const row = h('div', { class: 'mr-ladder-dish-row' });
      for (const dish of ch.dishes) {
        const img = h('img', {
          src: dish.imageDataUrl,
          alt: dish.altEn || `${dish.en}`,
          class: 'mr-ladder-dish-img',
        });
        const btn = h('button', {
          class: 'mr-ladder-dish',
          onclick: () => answer(ch.nonce, { dishId: dish.id }, () => {
            wrongDishes += 1;
            if (wrongDishes >= 5) startLadder(2, 'dl.ladder.wrongDish');
            else startLadder(1);
          }),
        }, img, h('span', {}, `${dish.en} · ${dish.zh}`));
        row.append(btn);
      }
      grid.append(row);
      setBody(grid);
    }

    // -- rung 2: ten sums -------------------------------------------------------------------
    function renderSums(ch) {
      const wrap = h('div', {});
      wrap.append(h('h3', { style: 'margin:4px 0 8px;font-size:var(--md-sys-type-title-medium-size)' }, t('dl.ladder.sumsTitle')));
      const inputs = [];
      const list = h('div', { class: 'mr-ladder-sums' });
      ch.questions.forEach((q, i) => {
        const input = h('input', {
          type: 'text',
          inputmode: 'numeric',
          autocomplete: 'off',
          class: 'mr-ladder-sum-input',
          'aria-label': `${q.a} + ${q.b}`,
        });
        inputs.push(input);
        list.append(
          h('span', {}, `${q.a} + ${q.b} =`),
          input,
        );
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') inputs[Math.min(i + 1, inputs.length - 1)]?.focus();
        });
      });
      wrap.append(list);
      const submit = h('button', {
        class: 'm3-btn m3-btn--filled',
        style: 'margin-top:12px',
        onclick: () => answer(
          ch.nonce,
          { sums: inputs.map((el) => Number(el.value)) },
          () => startLadder(3, 'dl.ladder.wrongSum'),
        ),
      }, t('common.ok'));
      wrap.append(submit);
      setBody(wrap);
      queueMicrotask(() => inputs[0]?.focus());
    }

    // -- rung 3: whack-a-mole --------------------------------------------------------------------
    function renderMoles(ch) {
      const startedAt = Date.now();
      const hits = new Map(); // mole i -> {mole, cell, t}
      const cells = [];
      const grid = h('div', { class: 'mr-ladder-moles', role: 'group', 'aria-label': t('dl.ladder.molesTitle') });

      const scoreEl = h('span', { class: 'mr-typography-label-large' }, t('dl.ladder.molesScore', { hits: '0', needed: String(MOLES_NEEDED) }));
      const timeEl = h('span', { class: 'mr-typography-label-large', 'aria-hidden': 'true' }, '');
      const liveEl = h('span', { class: 'mr-visually-hidden', 'aria-live': 'polite' });

      for (let c = 0; c < 16; c++) {
        const cell = h('button', {
          class: 'mr-ladder-cell',
          'aria-label': t('dl.ladder.moleCell', { cell: String(c + 1) }),
          onclick: () => {
            const active = cell.dataset.mole;
            if (active === undefined || hits.has(Number(active))) return;
            const mole = Number(active);
            const tMs = Date.now() - startedAt;
            hits.set(mole, { mole, cell: c, t: tMs });
            cell.classList.add('hit');
            cell.textContent = t('dl.ladder.moleHit');
            scoreEl.textContent = t('dl.ladder.molesScore', { hits: String(hits.size), needed: String(MOLES_NEEDED) });
            liveEl.textContent = `${t('dl.ladder.moleHit')} ${hits.size}`;
          },
        });
        cells.push(cell);
        grid.append(cell);
      }

      const header = h('div', { class: 'mr-row', style: 'justify-content:space-between;margin-bottom:8px' },
        h('h3', { style: 'margin:0;font-size:var(--md-sys-type-title-medium-size)' }, t('dl.ladder.molesTitle')),
        scoreEl, timeEl, liveEl);

      // Schedule each mole from the server-issued record relative to receipt.
      for (const mole of ch.moles) {
        timers.push(setTimeout(() => {
          const cell = cells[mole.cell];
          cell.classList.add('up');
          cell.dataset.mole = String(mole.i);
        }, mole.start));
        timers.push(setTimeout(() => {
          const cell = cells[mole.cell];
          cell.classList.remove('up');
          delete cell.dataset.mole;
        }, mole.end));
      }

      // The round cannot be submitted before its own duration has elapsed:
      // the client posts exactly once when the server-issued duration is over.
      timers.push(setTimeout(() => {
        answer(ch.nonce, { hits: [...hits.values()] }, () => showClock('dl.ladder.molesLost'));
      }, ch.roundDurationMs));

      const tickTimer = setInterval(() => {
        const left = Math.max(0, Math.ceil((ch.roundDurationMs - (Date.now() - startedAt)) / 1000));
        timeEl.textContent = t('dl.ladder.molesTime', { seconds: String(left) });
        if (left <= 0) clearInterval(tickTimer);
      }, 250);
      timers.push(tickTimer);

      setBody(header, grid);
      announce(`${t('dl.ladder.molesTitle')}. ${t('dl.ladder.molesGo')}`);
    }

    // -- the clock ---------------------------------------------------------------------------------
    function showClock(noteKey = null) {
      clearTimers();
      invoke('vault:delight-attempt-state', { scope }).then((s) => {
        const total = Math.max(1, Math.ceil((Number(s.waitRemainingMs ?? 1000)) / 1000));
        const remain = h('span', { class: 'mr-ladder-clock-num', role: 'timer', 'aria-live': 'off' }, String(total));
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const ring = h('div', { class: `mr-ladder-clock${reducedMotion ? '' : ' mr-pulse'}` }, remain);
        const body = [
          h('h3', { style: 'margin:4px 0 8px;font-size:var(--md-sys-type-title-medium-size)' }, t('dl.ladder.clockTitle')),
          ring,
          h('p', { class: 'mr-typography-body-medium', style: 'margin:8px 0 0' },
            t('dl.ladder.clockBody', { seconds: String(total) })),
        ];
        if (noteKey) {
          body.unshift(h('p', { class: 'mr-typography-body-small', style: 'margin:0 0 8px;color:var(--md-sys-color-on-surface-variant)' }, t(noteKey)));
        }
        const closeBtn = h('button', {
          class: 'm3-btn m3-btn--tonal',
          style: 'margin-top:12px',
          onclick: () => finish(false),
        }, t('dl.ladder.close'));
        setBody(...body, closeBtn);
        queueMicrotask(() => closeBtn.focus());

        const endAt = Date.now() + Number(s.waitRemainingMs ?? 1000);
        const tick = setInterval(() => {
          const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
          remain.textContent = String(left);
          if (left <= 0) {
            clearInterval(tick);
            finish(false); // wait served; caller restores the normal prompt
          }
        }, 500);
        timers.push(tick);
      }).catch(() => finish(false));
    }

    // -- shell ---------------------------------------------------------------------------------------
    bodyEl = h('div', { class: 'mr-col', style: 'min-height:220px;min-width:min(480px,80vw)' });
    dlg = openModal({
      title: t('dl.ladder.title'),
      body: bodyEl,
      onClose: () => finish(false),
      actions: [],
    });
    void dc;
    ladderState(scope).then((s) => {
      if (settled) return;
      if (s.clockOnly) showClock();
      else showOffer(s.attempts);
    }).catch(() => finish(false));
  });
}
