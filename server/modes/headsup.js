'use strict';

// Heads Up. One player holds their phone to their forehead with a word on
// it. Everyone else gives clues without saying the word. The holder tilts
// the phone up for "got it" and down for "pass", and the next word appears.
// One turn per "question": a ready step, then the clock runs.

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function prepare(raw, ctx) {
  // Everyone keeps their place in the order. If it's the turn of someone
  // whose phone is away, the next connected player goes instead.
  const all = ctx.players;
  let holder = null;
  for (let k = 0; k < all.length && !holder; k += 1) {
    const candidate = all[(ctx.turn + k) % all.length];
    if (candidate.connected) holder = candidate;
  }
  if (!holder && all.length) holder = all[ctx.turn % all.length];
  return {
    holderId: holder ? holder.id : '',
    stage: 'ready',
    ready: false,
    words: shuffle(raw.words),
    index: 0,
    results: [], // { word, right }
  };
}

function seconds(q, settings) {
  return q.data.stage === 'ready' ? settings.timers.headsUpReadySeconds : settings.timers.headsUpSeconds;
}

function publicView(q) {
  const d = q.data;
  return {
    text: q.raw.deck,
    deck: q.raw.deck,
    holderId: d.holderId,
    stage: d.stage,
    results: d.results, // words already played are safe to show
    right: d.results.filter((r) => r.right).length,
  };
}

function submit(q, playerId, payload) {
  const d = q.data;
  if (playerId !== d.holderId) return { error: "It isn't your turn to hold the phone." };
  if (d.stage === 'ready') {
    d.ready = true;
    return {};
  }
  const result = (payload || {}).result;
  if (result !== 'right' && result !== 'pass') return { error: 'Tilt up for right, down for pass.' };
  if (d.index >= d.words.length) return { error: 'That was the last word.' };
  d.results.push({ word: d.words[d.index], right: result === 'right' });
  d.index += 1;
  return { changed: true };
}

// The ready step ends when the holder says so; the turn ends when the
// clock runs out or the deck does.
function answered(q) {
  const d = q.data;
  if (d.stage === 'ready') return d.ready ? [d.holderId] : [];
  return d.index >= d.words.length ? [d.holderId] : [];
}

const expected = (q, players) => players.filter((p) => p.id === q.data.holderId);

function nextStage(q) {
  if (q.data.stage !== 'ready') return false;
  q.data.stage = 'play';
  return true;
}

// The holder gets the word (it faces away from them). So does everyone
// else, in case they can't read it off the phone across the room.
function privateView(q, playerId) {
  const d = q.data;
  return {
    holder: playerId === d.holderId,
    stage: d.stage,
    index: d.index,
    word: d.stage === 'play' && d.index < d.words.length ? d.words[d.index] : '',
  };
}

function finish(q, settings) {
  const d = q.data;
  const right = d.results.filter((r) => r.right).length;
  const gains = {};
  if (d.holderId && right) gains[d.holderId] = right * settings.points.headsUpRight;
  return { gains, reveal: { holderId: d.holderId, deck: q.raw.deck, results: d.results, right } };
}

const peek = (q) => `Heads Up deck: ${q.raw.deck}`;
const fullPoints = (settings) => settings.points.headsUpRight;

module.exports = { prepare, seconds, publicView, submit, answered, expected, nextStage, privateView, finish, peek, fullPoints };
