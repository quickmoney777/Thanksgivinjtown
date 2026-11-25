'use strict';

// Closest Guess: the answer is a number and nobody gets choices.
// Everyone types a number. The closest guess wins the most.

function prepare() {
  return { guesses: new Map() }; // playerId -> number
}

const seconds = (q, settings) => q.raw.timeSeconds || settings.timers.numberSeconds;

function publicView(q) {
  return { text: q.raw.text, unit: q.raw.unit };
}

function submit(q, playerId, payload) {
  if (q.data.guesses.has(playerId)) return { error: 'Your guess is already in.' };
  const raw = String((payload || {}).number == null ? '' : (payload || {}).number).replace(/[, ]/g, '');
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || Math.abs(n) > 1e12) return { error: 'Type a number first.' };
  q.data.guesses.set(playerId, n);
  return {};
}

const answered = (q) => Array.from(q.data.guesses.keys());

function privateView(q, playerId) {
  return q.data.guesses.has(playerId) ? { number: q.data.guesses.get(playerId) } : null;
}

function finish(q, settings) {
  const { numberClosest, numberSecond, numberExactBonus } = settings.points;
  const target = q.raw.number;
  const list = Array.from(q.data.guesses, ([playerId, guess]) => ({ playerId, guess, off: Math.abs(guess - target) })).sort(
    (a, b) => a.off - b.off
  );
  const gains = {};
  if (list.length) {
    const best = list[0].off;
    const next = (list.find((g) => g.off > best) || {}).off;
    for (const g of list) {
      if (g.off === best) gains[g.playerId] = numberClosest + (g.off === 0 ? numberExactBonus : 0);
      else if (g.off === next && list.length > 2) gains[g.playerId] = numberSecond;
    }
  }
  return { gains, reveal: { number: target, unit: q.raw.unit, guesses: list, fact: q.raw.fact } };
}

// Years have no unit and are shown without a thousands comma.
const peek = (q) => `${q.raw.number.toLocaleString('en-US', { useGrouping: Boolean(q.raw.unit) })}${q.raw.unit ? ` ${q.raw.unit}` : ''}`;
const fullPoints = (settings) => settings.points.numberClosest;

module.exports = { prepare, seconds, publicView, submit, answered, privateView, finish, peek, fullPoints };
