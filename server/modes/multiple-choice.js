'use strict';

// Multiple choice: everyone picks one answer. A correct pick earns the base
// points plus a speed bonus that shrinks as the timer runs down.
//
// Four round types share this file. They differ only in what the TV shows:
//   multiple-choice  - the question and the answers
//   poster-reveal    - a blurred picture that sharpens as time runs out
//   name-the-artist  - a song clip plays; the cover appears at the reveal
//   map-it           - a state outline or a highlighted US map
//
// Every mode exports this same set of functions, which is all the engine
// needs to run a question from start to reveal.

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build the live version of a question from the file version.
function prepare(raw) {
  const texts = raw.choices ? raw.choices.slice() : shuffle([raw.answer, ...raw.wrong]);
  const choices = texts.map((choice, i) => ({ id: LETTERS[i], text: choice }));
  return {
    choices,
    correctId: choices.find((c) => c.text === raw.answer).id,
    submissions: new Map(), // playerId -> { choiceId, elapsedMs }
  };
}

function seconds(q, settings) {
  if (q.raw.timeSeconds) return q.raw.timeSeconds;
  if (q.type === 'poster-reveal') return settings.timers.posterRevealSeconds;
  if (q.type === 'name-the-artist' || q.raw.audio) return settings.timers.audioSeconds;
  return settings.timers.questionSeconds;
}

// What every screen may see while the question is open. No answer in here,
// and no cover art that would give a song away.
function publicView(q) {
  return {
    text: q.raw.text,
    choices: q.data.choices,
    image: q.raw.image,
    blur: q.type === 'poster-reveal',
    audio: q.raw.audio,
    map: q.raw.map ? { show: q.raw.map.show, state: q.raw.map.show === 'blank' ? '' : q.raw.map.state } : null,
  };
}

function submit(q, playerId, payload, elapsedMs) {
  if (q.data.submissions.has(playerId)) return { error: 'You already answered.' };
  const choiceId = String((payload || {}).choiceId || '');
  if (!q.data.choices.some((c) => c.id === choiceId)) return { error: 'Pick one of the answers.' };
  q.data.submissions.set(playerId, { choiceId, elapsedMs });
  return {};
}

const answered = (q) => Array.from(q.data.submissions.keys());

// What one player sent, so their phone can show it after a refresh.
function privateView(q, playerId) {
  const mine = q.data.submissions.get(playerId);
  return mine ? { choiceId: mine.choiceId } : null;
}

// Score the question. Returns points per player and what to show on reveal.
function finish(q, settings) {
  const p = settings.points;
  const poster = q.type === 'poster-reveal';
  const base = poster ? p.posterCorrect : p.correct;
  const bonus = poster ? p.posterSpeedBonusMax : p.speedBonusMax;
  const gains = {};
  const picks = {};
  for (const [playerId, s] of q.data.submissions) {
    picks[playerId] = s.choiceId;
    if (s.choiceId !== q.data.correctId) continue;
    const timeLeft = Math.max(0, 1 - s.elapsedMs / q.totalMs);
    gains[playerId] = base + Math.round((bonus * timeLeft) / 10) * 10;
  }
  return {
    gains,
    reveal: {
      correctId: q.data.correctId,
      picks,
      fact: q.raw.fact,
      image: q.raw.revealImage,
      map: q.raw.map ? { state: q.raw.map.state, also: q.raw.map.also } : null,
    },
  };
}

// For the host's phone only: the answer, to read out or settle arguments.
function peek(q) {
  return `${q.data.correctId}: ${q.raw.answer}`;
}

module.exports = { prepare, seconds, publicView, submit, answered, privateView, finish, peek };
