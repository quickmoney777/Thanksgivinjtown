'use strict';

// The shared round engine. Every game mode runs through the same steps:
//
//   intro -> [ roundIntro -> ( question -> locked -> reveal ) x N -> scores ] x rounds -> final
//
// The server owns the clock. Screens only draw what publicGame() returns.
// room.phase holds the current step; room.game holds everything else.
//
// A "mode" (server/modes/*.js) knows how one kind of question works: what
// to show, what counts as an answer, and how to score it. The engine does
// the rest. Some modes have more than one stage per question (Bluff has
// "write" then "vote"); the engine runs a timer for each stage.

const content = require('./content');
const media = require('./media');

const choice = require('./modes/multiple-choice');
const MODES = {
  'multiple-choice': choice,
  'poster-reveal': choice,
  'name-the-artist': choice,
  'map-it': choice,
  bluff: require('./modes/bluff'),
  draw: require('./modes/draw'),
};

// Tests set TIMER_SCALE (for example 0.02) to race through a whole game.
const TIMER_SCALE = Number(process.env.TIMER_SCALE) || 1;

let broadcast = () => {};
let emitToRoom = () => {};
function init(options) {
  broadcast = options.broadcast;
  emitToRoom = options.emitToRoom || emitToRoom;
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- The list of rounds a host can pick from ----------

function catalog(settings) {
  const { rounds, pending, warnings } = content.loadRounds(settings);
  return {
    rounds: Array.from(rounds.values()).map((r) => {
      const usable = r.questions.filter((q) => media.playable(q, r.type)).length;
      return {
        id: r.id,
        title: r.title,
        tagline: r.tagline,
        icon: r.icon,
        type: r.type,
        questionCount: usable,
        missingMedia: r.questions.length - usable, // picture rounds: questions with no picture yet
        held: r.held, // waiting for a fact check
        bonus: r.bonus,
      };
    }),
    pending,
    warnings,
  };
}

// ---------- Timer (pausable) ----------

function clearTimer(room) {
  const g = room.game;
  if (!g || !g.timer) return;
  if (g.timer.handle) clearTimeout(g.timer.handle);
  g.timer = null;
}

function arm(room, timer) {
  timer.endsAt = Date.now() + timer.remainingMs;
  timer.handle = setTimeout(() => {
    if (!room.game || room.game.timer !== timer) return; // replaced or cleared
    room.game.timer = null;
    timer.fn();
  }, timer.remainingMs);
}

function setTimer(room, ms, fn) {
  clearTimer(room);
  const scaled = Math.max(20, Math.round(ms * TIMER_SCALE));
  const timer = { totalMs: scaled, remainingMs: scaled, endsAt: null, handle: null, fn };
  room.game.timer = timer;
  if (!room.game.paused) arm(room, timer);
  return scaled;
}

const timeLeft = (timer) => (timer.endsAt ? Math.max(0, timer.endsAt - Date.now()) : timer.remainingMs);

// Steps that move on by themselves when autoAdvance is on. With it off,
// they wait for the host to press Next.
function autoTimer(room, seconds, fn) {
  if (room.settings.autoAdvance) setTimer(room, seconds * 1000, fn);
  else clearTimer(room);
}

function pause(room) {
  const g = room.game;
  if (!g || g.paused || room.phase === 'final') return;
  g.paused = true;
  const t = g.timer;
  if (t && t.handle) {
    clearTimeout(t.handle);
    t.remainingMs = timeLeft(t);
    t.handle = null;
    t.endsAt = null;
  }
  broadcast(room);
}

function resume(room) {
  const g = room.game;
  if (!g || !g.paused) return;
  g.paused = false;
  if (g.timer) arm(room, g.timer);
  broadcast(room);
}

// ---------- Starting and stopping ----------

async function startGame(room, roundIds) {
  if (room.phase !== 'lobby') return { error: 'The game has already started.' };
  if (room.players.size === 0) return { error: 'Nobody has joined yet.' };
  if (room.starting) return { error: 'The game is already starting.' };

  let settings;
  try {
    settings = content.loadSettings(); // pick up edits made since the room opened
  } catch (err) {
    return { error: err.message };
  }
  const loaded = content.loadRounds(settings);
  const wanted = Array.isArray(roundIds) && roundIds.length ? roundIds : settings.roundOrder;
  const ids = wanted.filter((id, i) => loaded.rounds.has(id) && wanted.indexOf(id) === i);
  if (ids.length === 0) return { error: 'There are no rounds to play. Add question files in content/questions.' };

  // Fetch any pictures or song clips we don't have yet. Short wait, then go.
  room.starting = true;
  try {
    await media.warm(ids.flatMap((id) => loaded.rounds.get(id).questions));
  } finally {
    room.starting = false;
  }
  if (room.phase !== 'lobby' || room.players.size === 0) return { error: 'The room changed. Try again.' };

  room.settings = settings;
  room.catalog = catalog(settings);

  const rounds = [];
  for (const id of ids) {
    const round = loaded.rounds.get(id);
    const usable = round.questions.filter((q) => media.playable(q, round.type));
    if (usable.length === 0) continue; // a picture round with no pictures at all
    // Prefer questions this room hasn't seen. Once they run out, reuse.
    let pool = usable.filter((q) => !room.usedQuestionIds.has(q.id));
    if (pool.length < Math.min(settings.questionsPerRound, usable.length)) pool = usable;
    const questions = shuffle(pool)
      .slice(0, settings.questionsPerRound)
      .map((q) => media.attach(q, round.type));
    questions.forEach((q) => room.usedQuestionIds.add(q.id));
    rounds.push({ id: round.id, title: round.title, tagline: round.tagline, icon: round.icon, type: round.type, questions });
  }
  if (rounds.length === 0) return { error: 'None of those rounds have playable questions yet.' };

  for (const player of room.players.values()) player.score = 0;

  room.game = {
    rounds,
    roundIndex: -1,
    questionIndex: -1,
    current: null, // the live question: { key, type, raw, mode, data, totalMs }
    result: null, // { gains, reveal } once the question is locked
    roundPoints: {}, // points each player earned in the current round
    lockReason: '',
    timer: null,
    paused: false,
  };
  room.phase = 'intro';
  broadcast(room);
  return {};
}

function toLobby(room) {
  clearTimer(room);
  room.game = null;
  room.phase = 'lobby';
  try {
    room.catalog = catalog(room.settings);
  } catch (err) {
    /* keep the old list */
  }
  broadcast(room);
}

// Called when a room is deleted, so no timer fires into a dead room.
function stop(room) {
  clearTimer(room);
  room.game = null;
}

// ---------- Moving through a game ----------

const playerList = (room) =>
  Array.from(room.players.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((p) => ({ id: p.id, name: p.name, connected: p.sockets.size > 0 }));

function beginRound(room, index) {
  const g = room.game;
  if (index >= g.rounds.length) return finishGame(room);
  g.roundIndex = index;
  g.questionIndex = -1;
  g.current = null;
  g.result = null;
  g.roundPoints = {};
  room.phase = 'roundIntro';
  autoTimer(room, room.settings.timers.roundIntroSeconds, () => beginQuestion(room, 0));
  broadcast(room);
}

function beginQuestion(room, index) {
  const g = room.game;
  const round = g.rounds[g.roundIndex];
  if (index >= round.questions.length) return showScores(room);

  const raw = round.questions[index];
  const mode = MODES[round.type];
  const q = { key: `${g.roundIndex}:${index}`, type: round.type, raw, mode, data: null, totalMs: 0 };
  q.data = mode.prepare(raw, { players: playerList(room), turn: index, settings: room.settings });
  g.questionIndex = index;
  g.current = q;
  g.result = null;
  g.lockReason = '';
  room.phase = 'question';
  q.totalMs = setTimer(room, mode.seconds(q, room.settings) * 1000, () => stageDone(room, 'time'));
  broadcast(room);
}

function everyoneAnswered(room) {
  const q = room.game.current;
  let here = playerList(room).filter((p) => p.connected);
  if (q.mode.expected) here = q.mode.expected(q, here);
  if (here.length === 0) return false;
  const done = new Set(q.mode.answered(q));
  return here.every((p) => done.has(p.id));
}

// The current stage is over. Start the mode's next stage, or close answers.
function stageDone(room, reason) {
  const g = room.game;
  if (room.phase !== 'question' || !g.current) return;
  const q = g.current;
  if (q.mode.nextStage && q.mode.nextStage(q)) {
    q.totalMs = setTimer(room, q.mode.seconds(q, room.settings) * 1000, () => stageDone(room, 'time'));
    broadcast(room);
    return;
  }
  lock(room, reason);
}

function submit(room, player, payload) {
  const g = room.game;
  if (!g || room.phase !== 'question' || !g.current) return { error: 'Answers are closed.' };
  if (g.paused) return { error: 'The game is paused.' };
  const q = g.current;
  const elapsedMs = q.totalMs - (g.timer ? timeLeft(g.timer) : 0);
  const result = q.mode.submit(q, player.id, payload, elapsedMs);
  if (result.error) return result;
  if (everyoneAnswered(room)) stageDone(room, 'all-in');
  else broadcast(room);
  return { mine: privateView(room, player.id), correct: result.correct };
}

// Someone left or was removed. If everyone still here has answered, move on.
function presenceChanged(room) {
  const g = room.game;
  if (!g || room.phase !== 'question' || g.paused || !g.current) return;
  if (everyoneAnswered(room)) stageDone(room, 'all-in');
}

// Answers close. A short beat of suspense, then the reveal.
function lock(room, reason) {
  const g = room.game;
  if (room.phase !== 'question') return;
  g.lockReason = reason;
  g.result = g.current.mode.finish(g.current, room.settings);
  room.phase = 'locked';
  setTimer(room, room.settings.timers.lockedSeconds * 1000, () => reveal(room));
  broadcast(room);
}

function reveal(room) {
  const g = room.game;
  if (room.phase !== 'locked') return;
  for (const [playerId, points] of Object.entries(g.result.gains)) {
    const player = room.players.get(playerId);
    if (!player) continue;
    player.score += points;
    g.roundPoints[playerId] = (g.roundPoints[playerId] || 0) + points;
  }
  room.phase = 'reveal';
  const mode = g.current.mode;
  const seconds = mode.revealSeconds ? mode.revealSeconds(room.settings) : room.settings.timers.revealSeconds;
  autoTimer(room, seconds, () => beginQuestion(room, g.questionIndex + 1));
  broadcast(room);
}

function showScores(room) {
  const g = room.game;
  g.current = null;
  g.result = null;
  room.phase = 'scores';
  autoTimer(room, room.settings.timers.scoreboardSeconds, () => beginRound(room, g.roundIndex + 1));
  broadcast(room);
}

function finishGame(room) {
  clearTimer(room);
  const g = room.game;
  g.current = null;
  g.result = null;
  g.paused = false;
  room.phase = 'final';
  broadcast(room);
}

// The host's Next button: do whatever comes after the current step.
// Pressing it while paused also un-pauses.
function next(room) {
  const g = room.game;
  if (!g) return;
  g.paused = false;
  switch (room.phase) {
    case 'intro':
      return beginRound(room, 0);
    case 'roundIntro':
      return beginQuestion(room, 0);
    case 'question':
      return stageDone(room, 'host');
    case 'locked':
      return reveal(room);
    case 'reveal':
      return beginQuestion(room, g.questionIndex + 1);
    case 'scores':
      return beginRound(room, g.roundIndex + 1);
    default:
      return undefined;
  }
}

// Throw the current question out: nobody scores, on to the next one.
function skipQuestion(room) {
  const g = room.game;
  if (!g || !['question', 'locked', 'reveal'].includes(room.phase)) return;
  g.paused = false;
  beginQuestion(room, g.questionIndex + 1);
}

function skipRound(room) {
  const g = room.game;
  if (!g || !['roundIntro', 'question', 'locked', 'reveal', 'scores'].includes(room.phase)) return;
  g.paused = false;
  beginRound(room, g.roundIndex + 1);
}

function endGame(room) {
  if (!room.game || room.phase === 'final') return;
  finishGame(room);
}

// ---------- Drawing round: strokes from the artist's phone ----------

function drawStroke(room, player, payload) {
  const g = room.game;
  if (!g || room.phase !== 'question' || g.paused || !g.current || !g.current.mode.addStroke) return;
  const stroke = g.current.mode.addStroke(g.current, player.id, payload);
  if (stroke) emitToRoom(room, 'draw', { key: g.current.key, ...stroke });
}

// The whole drawing so far, for a screen that just (re)connected.
function drawSync(room) {
  const g = room.game;
  const q = g && g.current;
  if (!q || !q.data || !q.data.strokes) return { key: '', strokes: [] };
  return { key: q.key, strokes: q.data.strokes };
}

// ---------- What screens get to see ----------

function publicGame(room) {
  const g = room.game;
  if (!g) return null;
  const round = g.rounds[g.roundIndex] || null;
  const q = g.current;
  const showQuestion = q && ['question', 'locked', 'reveal'].includes(room.phase);

  return {
    paused: g.paused,
    timer: g.timer
      ? { endsAt: g.timer.endsAt, totalMs: g.timer.totalMs, remainingMs: timeLeft(g.timer) }
      : null,
    rounds: g.rounds.map((r, i) => ({
      id: r.id,
      title: r.title,
      status: i < g.roundIndex ? 'done' : i === g.roundIndex ? 'current' : 'next',
    })),
    round: round
      ? {
          number: g.roundIndex + 1,
          count: g.rounds.length,
          id: round.id,
          title: round.title,
          tagline: round.tagline,
          icon: round.icon,
          type: round.type,
          questionCount: round.questions.length,
        }
      : null,
    question: showQuestion
      ? { key: q.key, number: g.questionIndex + 1, type: q.type, ...q.mode.publicView(q) }
      : null,
    answered: showQuestion ? q.mode.answered(q) : [],
    lockReason: g.lockReason,
    // The answer and everyone's picks only leave the server at the reveal.
    reveal: room.phase === 'reveal' && g.result ? { ...g.result.reveal, gains: g.result.gains } : null,
    roundPoints: room.phase === 'scores' ? g.roundPoints : null,
  };
}

function privateView(room, playerId) {
  const g = room.game;
  if (!g || !g.current) return null;
  const mine = g.current.mode.privateView(g.current, playerId);
  return mine ? { key: g.current.key, ...mine } : null;
}

// Sent only to the host's phone remote.
function hostPeek(room) {
  const g = room.game;
  const live = g && g.current && ['question', 'locked', 'reveal'].includes(room.phase);
  return { key: live ? g.current.key : '', answer: live ? g.current.mode.peek(g.current) : '' };
}

module.exports = {
  init,
  catalog,
  startGame,
  toLobby,
  stop,
  next,
  pause,
  resume,
  skipQuestion,
  skipRound,
  endGame,
  submit,
  presenceChanged,
  drawStroke,
  drawSync,
  publicGame,
  privateView,
  hostPeek,
};
