'use strict';

// The shared round engine. Every game mode runs through the same steps:
//
//   intro -> [ roundIntro -> ( question -> locked -> reveal ) x N -> scores ] x rounds -> final
//
// With "players pick each game" on, a menu step comes before every round:
// everyone votes for the game they want on their phone, the round plays,
// and the menu comes back until the host ends the game.
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
  pin: require('./modes/pin'),
  headsup: require('./modes/headsup'),
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
      const usable = r.questions.filter((q) => media.playable(q, q.type || r.type)).length;
      return {
        id: r.id,
        title: r.title,
        tagline: r.tagline,
        icon: r.icon,
        type: r.type,
        questionCount: usable,
        perGame: Math.min(usable, r.perGame || settings.questionsPerRound),
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

// Draw one round's questions. Prefers questions this room hasn't seen.
function buildRound(room, round) {
  const typeOf = (q) => q.type || round.type;
  const usable = round.questions.filter((q) => media.playable(q, typeOf(q)));
  // Take `count` from a list: unseen questions first, then repeats if it runs short.
  const draw = (list, count) => {
    const fresh = shuffle(list.filter((q) => !room.usedQuestionIds.has(q.id)));
    const seen = shuffle(list.filter((q) => room.usedQuestionIds.has(q.id)));
    return [...fresh, ...seen].slice(0, count);
  };
  const want = round.perPlayer
    ? round.perPlayer * Math.max(1, room.players.size) // everyone gets the same number of turns
    : round.perGame || room.settings.questionsPerRound;
  let picked;
  if (round.mix) {
    // So many from each category, topped up from the rest if a category runs short.
    picked = Object.entries(round.mix).flatMap(([category, count]) =>
      draw(usable.filter((q) => q.category === category), count)
    );
    const total = Math.max(want, picked.length);
    if (picked.length < Math.min(total, usable.length)) {
      picked.push(...draw(usable.filter((q) => !picked.includes(q)), total - picked.length));
    }
    picked = shuffle(picked);
  } else {
    picked = draw(usable, want);
  }
  picked.forEach((q) => room.usedQuestionIds.add(q.id));
  return {
    id: round.id,
    title: round.title,
    tagline: round.tagline,
    icon: round.icon,
    type: round.type,
    howTo: round.howTo,
    teams: round.teams,
    questions: picked.map((q) => media.attach(q, typeOf(q))),
  };
}

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

  // Games that can actually be played (a picture round with no pictures can't).
  const library = ids
    .map((id) => loaded.rounds.get(id))
    .filter((round) => round.questions.some((q) => media.playable(q, q.type || round.type)));
  if (library.length === 0) return { error: 'None of those rounds have playable questions yet.' };

  // Players pick each game from a menu, or the rounds run in the host's order.
  const pick = Boolean(room.pickOn);
  const rounds = pick ? [] : library.map((round) => buildRound(room, round));

  for (const player of room.players.values()) player.score = 0;

  room.game = {
    pick,
    library, // every game on the menu
    played: {}, // round id -> how many times it has been played
    menu: null, // { votes: { playerId: roundId }, chosenId } while the menu is up
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

// "parents" or "kids", from the character a player picked.
const groupOf = (room, player) => (room.characters.find((c) => c.id === player.characterId) || {}).group || '';

const playerList = (room) =>
  Array.from(room.players.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.sockets.size > 0,
      group: groupOf(room, p),
      // 0 or 1 when this game dealt random teams
      side: room.game && room.game.roundTeams && p.id in room.game.roundTeams ? room.game.roundTeams[p.id] : null,
    }));

// ---------- The game menu (when players pick each game) ----------

function beginMenu(room) {
  const g = room.game;
  clearTimer(room); // no clock until the first vote comes in
  g.current = null;
  g.result = null;
  g.menu = { votes: {}, chosenId: null };
  room.phase = 'menu';
  broadcast(room);
}

const connectedIds = (room) => playerList(room).filter((p) => p.connected).map((p) => p.id);

function vote(room, player, payload) {
  const g = room.game;
  if (g.paused) return { error: 'The game is paused.' };
  if (!g.menu || g.menu.chosenId) return { error: 'The game has been picked.' };
  const id = payload && payload.roundId;
  if (!g.library.some((round) => round.id === id)) return { error: 'Pick one of the games on the list.' };
  g.menu.votes[player.id] = id;
  const here = connectedIds(room);
  if (here.length && here.every((pid) => g.menu.votes[pid])) decideMenu(room);
  else {
    // The first vote starts the clock for everyone else.
    if (!g.timer) setTimer(room, room.settings.timers.menuSeconds * 1000, () => decideMenu(room));
    broadcast(room);
  }
  return { mine: null };
}

// Most votes wins. A tie, or no votes at all, is settled by chance.
function decideMenu(room, forcedId) {
  const g = room.game;
  if (room.phase !== 'menu' || !g.menu || g.menu.chosenId) return;
  let chosenId = g.library.some((round) => round.id === forcedId) ? forcedId : null;
  if (!chosenId) {
    const tally = {};
    for (const [playerId, id] of Object.entries(g.menu.votes)) {
      if (room.players.has(playerId)) tally[id] = (tally[id] || 0) + 1;
    }
    const best = Math.max(0, ...Object.values(tally));
    let top = Object.keys(tally).filter((id) => tally[id] === best);
    if (top.length === 0) {
      const fresh = g.library.filter((round) => !g.played[round.id]);
      top = (fresh.length ? fresh : g.library).map((round) => round.id);
    }
    chosenId = top[Math.floor(Math.random() * top.length)];
  }
  g.menu.chosenId = chosenId;
  // A beat to show which game won, then it starts.
  setTimer(room, room.settings.timers.menuChosenSeconds * 1000, () => launchChosen(room));
  broadcast(room);
}

function launchChosen(room) {
  const g = room.game;
  if (room.phase !== 'menu' || !g.menu || !g.menu.chosenId) return;
  const round = g.library.find((r) => r.id === g.menu.chosenId);
  g.menu = null;
  g.played[round.id] = (g.played[round.id] || 0) + 1;
  g.rounds.push(buildRound(room, round));
  beginRound(room, g.rounds.length - 1);
}

// The host picks the game from the remote, whatever the votes say.
function pickRound(room, roundId) {
  const g = room.game;
  if (!g || room.phase !== 'menu') return { error: 'The game menu is not showing.' };
  if (!g.library.some((round) => round.id === roundId)) return { error: 'That game is not on the menu.' };
  if (g.menu.chosenId) return { error: 'The game has been picked.' };
  g.paused = false;
  decideMenu(room, roundId);
  return {};
}

function beginRound(room, index) {
  const g = room.game;
  if (index >= g.rounds.length) return g.pick ? beginMenu(room) : finishGame(room);
  g.roundIndex = index;
  g.questionIndex = -1;
  g.current = null;
  g.result = null;
  g.roundPoints = {};
  // Some games deal everyone into two random teams, fresh each time.
  g.roundTeams = null;
  if (g.rounds[index].teams === 'random' && room.players.size >= 2) {
    g.roundTeams = {};
    shuffle(Array.from(room.players.keys())).forEach((id, i) => {
      g.roundTeams[id] = i % 2;
    });
  }
  room.phase = 'roundIntro';
  // Longer when there are instructions to read.
  const t = room.settings.timers;
  const introSeconds = g.rounds[index].howTo.length ? t.instructionsSeconds : t.roundIntroSeconds;
  autoTimer(room, introSeconds, () => beginQuestion(room, 0));
  broadcast(room);
}

function beginQuestion(room, index) {
  const g = room.game;
  const round = g.rounds[g.roundIndex];
  if (index >= round.questions.length) return showScores(room);

  const raw = round.questions[index];
  const type = raw.type || round.type; // a mixed round sets the kind per question
  const mode = MODES[type];
  const q = { key: `${g.roundIndex}:${index}`, type, raw, mode, data: null, totalMs: 0 };
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
  if (g && room.phase === 'menu') return vote(room, player, payload);
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
  if (g && room.phase === 'menu' && !g.paused && g.menu && !g.menu.chosenId) {
    const here = connectedIds(room);
    if (here.length && here.every((id) => g.menu.votes[id])) decideMenu(room);
    return;
  }
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

// The host overrules the game on the answer screen: this player was right
// (full base points) or wrong (nothing) on the question just revealed.
function overrule(room, playerId, correct) {
  const g = room.game;
  if (!g || room.phase !== 'reveal' || !g.result || !g.current) return { error: 'You can do this while an answer is on screen.' };
  const player = room.players.get(playerId);
  if (!player) return { error: 'That player already left.' };
  const mode = g.current.mode;
  const p = room.settings.points;
  const full = mode.fullPoints ? mode.fullPoints(room.settings) : g.current.type === 'poster-reveal' ? p.posterCorrect : p.correct;
  const had = g.result.gains[playerId] || 0;
  const now = correct ? Math.max(had, full) : 0;
  player.score += now - had;
  g.roundPoints[playerId] = (g.roundPoints[playerId] || 0) + now - had;
  if (now) g.result.gains[playerId] = now;
  else delete g.result.gains[playerId];
  g.result.reveal.overruled = { ...(g.result.reveal.overruled || {}), [playerId]: Boolean(correct) };
  broadcast(room);
  return {};
}

function showScores(room) {
  const g = room.game;
  // Parents against kids: add up what each side won this game.
  const sides = {};
  for (const p of playerList(room)) {
    if (p.group) sides[p.group] = (sides[p.group] || 0) + (g.roundPoints[p.id] || 0);
  }
  const round = g.rounds[g.roundIndex];
  g.sidePoints = round && round.questions.some((q) => q.for) && Object.keys(sides).length === 2 ? sides : null;
  if (g.roundTeams) {
    // Random teams: what each team won this game, by team name.
    const names = room.settings.teams.names;
    g.sidePoints = { [names[0]]: 0, [names[1]]: 0 };
    for (const [id, side] of Object.entries(g.roundTeams)) g.sidePoints[names[side]] += g.roundPoints[id] || 0;
  }
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
    case 'menu':
      // Go with the votes so far, or straight in if the game is already picked.
      return g.menu && g.menu.chosenId ? launchChosen(room) : decideMenu(room);
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
    pick: g.pick,
    // The game menu: what's on offer, who voted for what, and the winner.
    menu:
      room.phase === 'menu' && g.menu
        ? {
            options: g.library.map((r) => ({
              id: r.id,
              title: r.title,
              tagline: r.tagline,
              icon: r.icon,
              type: r.type,
              played: g.played[r.id] || 0,
            })),
            votes: g.menu.votes,
            chosenId: g.menu.chosenId,
          }
        : null,
    rounds: g.rounds.map((r, i) => ({
      id: r.id,
      title: r.title,
      status: i < g.roundIndex ? 'done' : i === g.roundIndex ? 'current' : 'next',
    })),
    round: round
      ? {
          number: g.roundIndex + 1,
          count: g.pick ? 0 : g.rounds.length, // 0: open-ended, players keep picking
          id: round.id,
          title: round.title,
          tagline: round.tagline,
          icon: round.icon,
          type: round.type,
          howTo: round.howTo,
          sides: g.roundTeams ? { names: room.settings.teams.names, colors: room.settings.teams.colors, of: g.roundTeams } : null,
          questionCount: round.questions.length,
        }
      : null,
    question: showQuestion
      ? { key: q.key, number: g.questionIndex + 1, type: q.type, category: q.raw.category || '', ...q.mode.publicView(q) }
      : null,
    answered: showQuestion ? q.mode.answered(q) : room.phase === 'menu' && g.menu ? Object.keys(g.menu.votes) : [],
    lockReason: g.lockReason,
    // The answer and everyone's picks only leave the server at the reveal.
    reveal: room.phase === 'reveal' && g.result ? { ...g.result.reveal, gains: g.result.gains } : null,
    roundPoints: room.phase === 'scores' ? g.roundPoints : null,
    sidePoints: room.phase === 'scores' ? g.sidePoints || null : null,
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
  pickRound,
  overrule,
  endGame,
  submit,
  presenceChanged,
  drawStroke,
  drawSync,
  publicGame,
  privateView,
  hostPeek,
};
