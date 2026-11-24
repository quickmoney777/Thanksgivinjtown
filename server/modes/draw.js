'use strict';

// Drawing round. One player gets a secret word and draws it on their phone.
// The drawing appears live on the TV and everyone else types guesses.
// Guessers score for getting it (more for being quick); the artist scores
// for every player who gets it.

const MAX_STROKES = 600;
const MAX_POINTS = 400;

// Compare guesses loosely: ignore case, punctuation, "a/the", and a
// trailing "s", and forgive one typo in longer words.
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\b(a|an|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const singular = (s) => (s.length > 3 && s.endsWith('s') ? s.slice(0, -1) : s);

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

function matches(guess, targets) {
  const g = singular(norm(guess));
  if (!g) return false;
  return targets.some((target) => {
    const t = singular(norm(target));
    if (g === t || g.replace(/ /g, '') === t.replace(/ /g, '')) return true;
    return t.length >= 6 && distance(g, t) <= 1;
  });
}

// ctx.turn counts drawing turns in this round, so the pen passes around.
function prepare(raw, ctx) {
  const players = ctx.players.filter((p) => p.connected);
  let pool = players.length ? players : ctx.players;
  const teamed = raw.aloud && pool.some((p) => p.side === 0) && pool.some((p) => p.side === 1);
  if (teamed) {
    // Teams take turns: one from each side, back and forth.
    const a = pool.filter((p) => p.side === 0);
    const b = pool.filter((p) => p.side !== 0);
    const order = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a.length) order.push(a[i % a.length]);
      if (b.length) order.push(b[i % b.length]);
    }
    pool = order;
  }
  const artist = pool.length ? pool[ctx.turn % pool.length] : null;
  // Who is guessing: the artist's team, or everyone if there are no teams.
  const team = artist ? ctx.players.filter((p) => p.id !== artist.id && (!teamed || p.side === artist.side)) : [];
  return {
    aloud: Boolean(raw.aloud),
    side: teamed && artist ? artist.side : null,
    teamIds: team.map((p) => p.id),
    artistId: artist ? artist.id : '',
    strokes: [], // each { color, size, points: [x, y, x, y, ...] } with 0..1 coordinates
    correct: new Map(), // playerId -> elapsedMs
    misses: [], // recent wrong guesses, shown on the TV for fun: { playerId, text }
  };
}

function seconds(q, settings) {
  return q.raw.timeSeconds || (q.raw.aloud ? settings.timers.pictionarySeconds : settings.timers.drawSeconds);
}

function publicView(q) {
  return {
    text: 'What is being drawn?',
    artistId: q.data.artistId,
    aloud: q.data.aloud,
    side: q.data.side,
    teamIds: q.data.teamIds,
    letters: q.raw.word.replace(/[A-Za-z0-9]/g, '_'), // blanks, so people know the length
    misses: q.data.misses.slice(-6),
  };
}

function submit(q, playerId, payload, elapsedMs) {
  const d = q.data;
  if (d.aloud) {
    // Guesses are shouted out. The artist or a teammate taps once it's been said.
    if (playerId !== d.artistId && !d.teamIds.includes(playerId)) return { error: 'The other team is guessing this one.' };
    if (!(payload || {}).gotIt) return { error: 'Tap the button when the word has been guessed.' };
    if (d.correct.size) return { error: 'Already marked as guessed.' };
    for (const id of d.teamIds) d.correct.set(id, elapsedMs);
    return { correct: true };
  }
  if (playerId === d.artistId) return { error: "You're drawing this one." };
  if (d.correct.has(playerId)) return { error: 'You already got it.' };
  const guess = String((payload || {}).text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  if (!guess) return { error: 'Type a guess first.' };
  if (matches(guess, [q.raw.word, ...q.raw.accept])) {
    d.correct.set(playerId, elapsedMs);
    return { correct: true };
  }
  d.misses.push({ playerId, text: guess });
  if (d.misses.length > 30) d.misses.shift();
  return { correct: false, changed: true };
}

// "Answered" here means "guessed it".
const answered = (q) => Array.from(q.data.correct.keys());

// The artist doesn't guess, so don't wait for them.
const expected = (q, players) =>
  q.data.aloud ? players.filter((p) => q.data.teamIds.includes(p.id)) : players.filter((p) => p.id !== q.data.artistId);

function privateView(q, playerId) {
  const d = q.data;
  if (playerId === d.artistId) return { artist: true, word: q.raw.word, aloud: d.aloud, correct: d.correct.size > 0 };
  return { artist: false, correct: d.correct.has(playerId), aloud: d.aloud, onTeam: d.teamIds.includes(playerId) };
}

// A stroke from the artist's phone. Returns the cleaned stroke to pass on.
function addStroke(q, playerId, payload) {
  const d = q.data;
  if (playerId !== d.artistId) return null;
  const p = payload || {};
  if (p.clear) {
    d.strokes = [];
    return { clear: true };
  }
  if (p.undo) {
    d.strokes.pop();
    return { undo: true };
  }
  const points = (Array.isArray(p.points) ? p.points : [])
    .slice(0, MAX_POINTS * 2)
    .map((n) => Math.round(Math.min(1, Math.max(0, Number(n) || 0)) * 1000) / 1000);
  if (points.length < 2 || points.length % 2) return null;
  const color = /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#2b1810';
  const size = Math.min(0.06, Math.max(0.004, Number(p.size) || 0.012));
  if (p.more && d.strokes.length) {
    // Continues the stroke in progress, so long lines arrive smoothly.
    const last = d.strokes[d.strokes.length - 1];
    if (last.points.length < MAX_POINTS * 2) last.points.push(...points);
    return { more: true, points };
  }
  if (d.strokes.length >= MAX_STROKES) return null;
  d.strokes.push({ color, size, points });
  return { color, size, points };
}

function finish(q, settings) {
  const d = q.data;
  const { drawGuessed, drawSpeedBonusMax, drawArtistPerGuess } = settings.points;
  const gains = {};
  for (const [playerId, elapsedMs] of d.correct) {
    const timeLeft = Math.max(0, 1 - elapsedMs / q.totalMs);
    gains[playerId] = drawGuessed + Math.round((drawSpeedBonusMax * timeLeft) / 10) * 10;
  }
  if (d.artistId && d.correct.size) {
    // Pictionary: the artist earns the same as the teammates who got it.
    gains[d.artistId] = d.aloud ? Math.max(...Object.values(gains)) : drawArtistPerGuess * d.correct.size;
  }
  return {
    gains,
    reveal: { word: q.raw.word, artistId: d.artistId, guessed: Array.from(d.correct.keys()) },
  };
}

function peek(q) {
  return q.raw.word;
}

module.exports = {
  prepare,
  seconds,
  publicView,
  submit,
  answered,
  expected,
  privateView,
  addStroke,
  finish,
  peek,
  matches,
};
