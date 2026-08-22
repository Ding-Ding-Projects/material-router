/* Unlock ladder: something to do while a lockout wait runs.
   dim-sum 4-choice -> ten easy sums -> whack-a-mole timed round -> clock.
   Winning clears WAITING only, never the credential, and never refunds the
   attempt budget. Budgeted: at most three ladder skips per rolling hour;
   after that, everyone serves the clock. Single-use nonce per challenge,
   consumed before grading (client-side best effort on a static host, stated
   in the panel). School mode starts the ladder at the sums. */

import { el, clamp, storage, reducedMotionPreferred } from './util.js';
import { getSettings } from './store.js';
import { DIMSUM_POOL } from './dimsum.js';
import { t } from './i18n.js';

const HOURLY_BUDGET = 3;

export function registerLadderBundle(addBundle) {
  addBundle('ladder', {
    en: {
      'ld.title': 'While you wait',
      'ld.lead': 'Solve this to end the waiting now — or just let the clock run. Either way your password is still needed; nothing here signs you in.',
      'ld.budget': 'Ladder skips left this hour:',
      'ld.exhausted': 'Ladder budget used up for this hour — the clock it is.',
      'ld.dimsum.prompt': 'Which one is this?',
      'ld.sums.prompt': 'Ten easy sums. Get every one right to clear the wait.',
      'ld.mole.prompt': 'Hit the moles before time runs out!',
      'ld.mole.time': 'Time left:',
      'ld.mole.score': 'Hits:',
      'ld.clock.waiting': 'Waiting…',
      'ld.skipToClock': 'Skip to the clock',
      'ld.won': 'Cleared! The waiting is over.',
      'ld.wrong': 'Not quite — next rung.',
      'ld.nonceNote': 'Each challenge carries a single-use nonce consumed before grading, so an answer cannot be replayed. On a static site this check lives in this page rather than on a server, which is stated here rather than implied away.',
    },
    zh: {
      'ld.title': '等緊嗰陣做啲嘢',
      'ld.lead': '解咗佢就可以即刻唔使等 —— 或者由個鐘自己行。無論點，密碼照樣要入；呢度無任何嘢會幫你登入。',
      'ld.budget': '今個鐘淨低可以玩嘅次數：',
      'ld.exhausted': '呢個鐘嘅配額用完喇 —— 惟有睇住個鐘。',
      'ld.dimsum.prompt': '呢個係邊樣？',
      'ld.sums.prompt': '十條簡單加減數。全中就完。',
      'ld.mole.prompt': '限時之內打晒啲地鼠！',
      'ld.mole.time': '剩低時間：',
      'ld.mole.score': '中咗：',
      'ld.clock.waiting': '等待中……',
      'ld.skipToClock': '跳去睇鐘',
      'ld.won': '過關！唔使再等喇。',
      'ld.wrong': '差少少 —— 下一關。',
      'ld.nonceNote': '每條挑戰都帶一個單次用的 nonce，計分之前先作廢，答案冇得重播。靜態網站冇伺服器，呢層檢查只存在於呢一頁，講明好過扮睇唔到。',
    },
  });
}

function budgetState() {
  const now = Date.now();
  const st = storage.get('ladder-budget', { windowStart: now, used: 0 });
  if (now - st.windowStart > 3600 * 1000) return { windowStart: now, used: 0 };
  return st;
}
export function budgetLeft() {
  return HOURLY_BUDGET - budgetState().used;
}
function consumeBudget() {
  const st = budgetState();
  st.used += 1;
  storage.set('ladder-budget', st);
}

/* nonce registry: challenges must be created before they can be graded */
const nonces = new Set();
function mintNonce() {
  const n = crypto.getRandomValues(new Uint8Array(8));
  const id = Array.from(n).map((b) => b.toString(16).padStart(2, '0')).join('');
  nonces.add(id);
  return id;
}
function consumeNonce(id) {
  if (!nonces.has(id)) return false;
  nonces.delete(id);
  return true;
}

/* runLadder({secondsLeft, onCleared}) — renders into #ladder-mount inside
   the unlock dialog. Resolves 'cleared' | 'clock' when done. */
export function runLadder(mount, { secondsLeft = 30, onCleared } = {}) {
  mount.textContent = '';
  const left = () => budgetLeft();

  const header = el('div', { class: 'ladder-header' }, [
    el('h3', { class: 'modal-title', text: t('ld.title') }),
    el('p', { class: 'modal-lead', text: t('ld.lead') }),
    el('p', { class: 'ladder-budget' }, [
      document.createTextNode(`${t('ld.budget')} ${left()}`),
    ]),
    el('p', { class: 'ladder-nonce-note', text: t('ld.nonceNote') }),
  ]);
  mount.append(header);

  const stage = el('div', { class: 'ladder-stage' });
  mount.append(stage);

  function win() {
    stage.textContent = '';
    stage.append(el('p', { class: 'ladder-won', text: t('ld.won') }));
    setTimeout(() => onCleared && onCleared(), 700);
  }

  function fallThrough(message) {
    stage.textContent = '';
    stage.append(el('p', { class: 'ladder-lost', text: message || t('ld.wrong') }));
    setTimeout(() => startClock(), 600);
  }

  /* Rung 1: dim sum, four choices. Absent entirely under School mode. */
  function startDimSum() {
    stage.textContent = '';
    const target = DIMSUM_POOL[Math.floor(Math.random() * DIMSUM_POOL.length)];
    const others = DIMSUM_POOL.filter((d) => d !== target).sort(() => Math.random() - 0.5).slice(0, 3);
    const options = [target, ...others].sort(() => Math.random() - 0.5);
    const nonce = mintNonce();
    stage.append(el('p', { class: 'ladder-prompt', text: t('ld.dimsum.prompt'), dataset: { nonce } }));
    const grid = el('div', { class: 'ladder-dimsum-grid', role: 'group', 'aria-label': t('ld.dimsum.prompt') });
    for (const dish of options) {
      const b = el('button', { type: 'button', class: 'ladder-dish' }, [
        el('img', { src: `https://github.com/Ding-Ding-Projects/dim-sum-photos/releases/download/catalog-v1/${dish.file}`, alt: '', width: '72', height: '72', loading: 'lazy' }),
        el('span', { text: getSettings().language === 'zh' ? dish.zh : `${dish.en} · ${dish.zh}` }),
      ]);
      b.addEventListener('click', () => {
        if (!consumeNonce(nonce)) return; // replay refused
        if (dish === target) win(); else fallThrough();
      });
      grid.append(b);
    }
    stage.append(grid);
  }

  /* Rung 2: ten easy sums, every one right. */
  function startSums() {
    stage.textContent = '';
    stage.append(el('p', { class: 'ladder-prompt', text: t('ld.sums.prompt') }));
    let index = 0;
    let current = null;
    let currentNonce = null;
    const inputRow = el('div', { class: 'ladder-sum-row' });
    const promptEl = el('span', { class: 'ladder-sum-q mono' });
    const answerIn = el('input', { type: 'text', inputmode: 'numeric', class: 'mr-input ladder-sum-in', 'aria-label': 'answer' });
    const progress = el('span', { class: 'ladder-progress' });
    inputRow.append(promptEl, answerIn, progress);
    stage.append(inputRow);

    const nextQuestion = () => {
      if (index >= 10) { win(); return; }
      currentNonce = mintNonce();
      const a = 2 + Math.floor(Math.random() * 48);
      const b = 2 + Math.floor(Math.random() * 48);
      const plus = Math.random() < 0.5;
      current = plus ? a + b : Math.max(a, b) - Math.min(a, b);
      promptEl.textContent = plus ? `${a} + ${b} = ?` : `${Math.max(a, b)} − ${Math.min(a, b)} = ?`;
      progress.textContent = `${index}/10`;
      answerIn.value = '';
      answerIn.focus();
    };
    const submit = () => {
      if (!currentNonce) return;
      const guess = parseInt(answerIn.value, 10);
      const ok = Number.isFinite(guess) && guess === current;
      consumeNonce(currentNonce);
      currentNonce = null;
      if (!ok) { fallThrough(); return; }
      index += 1;
      nextQuestion();
    };
    answerIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    nextQuestion();
  }

  /* Rung 3: whack-a-mole inside a real timed round; submissions arriving
     before the round's own duration are rejected, each mole grades once. */
  function startMoles() {
    stage.textContent = '';
    stage.append(el('p', { class: 'ladder-prompt', text: t('ld.mole.prompt') }));
    const DURATION_MS = 10000;
    const TARGET_HITS = 6;
    const startedAt = Date.now();
    const roundNonce = mintNonce();

    const statusRow = el('div', { class: 'ladder-mole-status' });
    const timeEl = el('span', { class: 'mono', text: `${t('ld.mole.time')} 10s` });
    const scoreEl = el('span', { class: 'mono', text: `${t('ld.mole.score')} 0/${TARGET_HITS}` });
    statusRow.append(timeEl, scoreEl);
    const grid = el('div', { class: 'mole-grid', role: 'group', 'aria-label': t('ld.mole.prompt') });
    stage.append(statusRow, grid);

    let hits = 0;
    let finished = false;
    const cells = [];
    for (let i = 0; i < 9; i += 1) {
      const cell = el('button', { type: 'button', class: 'mole-cell', 'aria-label': `cell ${i + 1}` });
      cell.dataset.state = 'empty';
      cell.disabled = true;
      cell.__graded = false;
      cells.push(cell);
      grid.append(cell);
    }

    const showMole = () => {
      if (finished) return;
      const free = cells.filter((c) => c.dataset.state === 'empty');
      if (!free.length) return;
      const cell = free[Math.floor(Math.random() * free.length)];
      cell.dataset.state = 'up';
      cell.textContent = '🐹';
      cell.setAttribute('aria-label', 'mole up');
      cell.disabled = false;
      const lifetime = 700 + Math.random() * 600;
      setTimeout(() => {
        if (cell.dataset.state === 'up') {
          cell.dataset.state = 'empty';
          cell.textContent = '';
          cell.disabled = true;
        }
      }, reducedMotionPreferred() ? lifetime : lifetime * 0.9);
    };

    const timerId = setInterval(() => {
      const remainMs = DURATION_MS - (Date.now() - startedAt);
      timeEl.textContent = `${t('ld.mole.time')} ${Math.max(0, Math.ceil(remainMs / 1000))}s`;
      if (remainMs <= 0) endRound(false, 'time');
    }, 200);

    const moleTimer = setInterval(showMole, 650);
    showMole();

    for (const cell of cells) {
      cell.addEventListener('click', () => {
        if (finished || cell.__graded || cell.dataset.state !== 'up') return;
        cell.__graded = true; // grade each mole once
        hits += 1;
        scoreEl.textContent = `${t('ld.mole.score')} ${hits}/${TARGET_HITS}`;
        cell.dataset.state = 'empty';
        cell.textContent = '';
        cell.disabled = true;
        if (hits >= TARGET_HITS) endRound(true, 'hits');
      });
    }

    function endRound(success, why) {
      if (finished) return;
      finished = true;
      clearInterval(timerId);
      clearInterval(moleTimer);
      const elapsed = Date.now() - startedAt;
      // A timed game cannot be won faster than it lasts; early "wins" are refused.
      if (success && elapsed < DURATION_MS * 0.95) success = false;
      if (!consumeNonce(roundNonce)) success = false;
      if (success) { stage.textContent = ''; win(); }
      else fallThrough(why === 'time' ? undefined : undefined);
    }
  }

  /* Rung 4: the clock. Not offered again once reached during this lockout. */
  function startClock() {
    stage.textContent = '';
    stage.append(el('p', { class: 'ladder-prompt', text: t('ld.clock.waiting') }));
    let remaining = secondsLeft;
    const timeEl = el('div', { class: 'ladder-clock mono', text: formatRemain(remaining), role: 'timer' });
    stage.append(timeEl);
    const id = setInterval(() => {
      remaining -= 1;
      timeEl.textContent = formatRemain(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(id);
        if (onCleared) onCleared();
      }
    }, 1000);
  }

  function formatRemain(sec) {
    const s = Math.max(0, sec);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const skipBtn = el('button', { type: 'button', class: 'mr-btn mr-btn--text', text: t('ld.skipToClock') });
  skipBtn.addEventListener('click', () => { stage.textContent = ''; startClock(); });
  mount.append(skipBtn);

  // entry point
  if (left() <= 0) {
    stage.append(el('p', { class: 'ladder-lost', text: t('ld.exhausted') }));
    startClock();
  } else if (getSettings().schoolMode) {
    startSums(); // School mode: dim-sum rung absent, not skipped-with-message
  } else {
    startDimSum();
  }

  return {
    /* called by the host when a rung fails so the budget is spent only when
       the ladder actually replaced a wait */
    noteFailureAndConsume() { consumeBudget(); },
  };
}

/* Wait escalation: consecutive lockouts lengthen the wait, capped. */
export function computeWaitSeconds(consecutiveFailures) {
  const base = 15;
  const capped = clamp(consecutiveFailures - 1, 0, 5);
  return base * 2 ** capped;
}
