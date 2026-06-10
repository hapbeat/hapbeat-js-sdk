/**
 * Best-score persistence (localStorage). Per game + difficulty. Some games are
 * "lower is better" (maze time, reflex ms), others "higher is better" (rhythm
 * score, hotcold found). Returns whether a submitted value is a new best so the
 * UI can celebrate it.
 */

const KEY = "hapbeat-arcade-best-v1";

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
function save(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
  } catch {
    /* storage disabled / private mode — scores just won't persist */
  }
}

const id = (game, diff) => `${game}:${diff}`;

/** Current best for game+difficulty, or null. Drops any non-finite poison. */
export function best(game, diff) {
  const v = load()[id(game, diff)];
  return Number.isFinite(v) ? v : null;
}

/**
 * Submit a result. lowerIsBetter=true for times/ms. Returns
 * { isBest:boolean, best:number|null }. Non-finite values (NaN/Infinity from a
 * divide-by-zero average etc.) are rejected so they can't become an unbeatable
 * "best" rendered as "NaNms".
 */
export function submit(game, diff, value, lowerIsBetter) {
  if (!Number.isFinite(value)) return { isBest: false, best: best(game, diff) };
  const all = load();
  const k = id(game, diff);
  const prev = all[k];
  const havePrev = Number.isFinite(prev);
  const better = !havePrev || (lowerIsBetter ? value < prev : value > prev);
  if (better) {
    all[k] = value;
    save(all);
    return { isBest: true, best: value };
  }
  return { isBest: false, best: prev };
}
