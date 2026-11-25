'use strict';

// Bluff round. Two stages per question:
//   write - everyone types a believable fake answer
//   vote  - the fakes are mixed in with the truth; everyone picks the one
//           they think is real (your own fake isn't offered to you)
// Points for finding the truth, and for every player your fake fools.

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const MAX_LIE = 40;
const MIN_OPTIONS = 4; // pad with the file's "decoys" up to this many choices

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Two answers are "the same" if they match ignoring case, spacing and
// punctuation. Stops "a rafter" and "Rafter!" being listed twice.
const norm = (s) => {
  const plain = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\b(a|an|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Emoji or another alphabet: compare the text as typed.
  return plain || String(s).trim().toLowerCase();
};

// A question marked "for": "parents" (or "kids") is answered by that side
// only, and the other side writes the fakes. Without both sides at the
// table it plays the usual way: everyone writes, everyone votes.
function prepare(raw, ctx) {
  const players = (ctx && ctx.players) || [];
  const guessers = raw.for ? players.filter((p) => p.group === raw.for).map((p) => p.id) : [];
  const writers = raw.for ? players.filter((p) => p.group !== raw.for).map((p) => p.id) : [];
  const sided = guessers.length > 0 && writers.length > 0;
  const groups = (ctx && ctx.settings && ctx.settings.groups) || {};
  return {
    sided,
    guessers: sided ? guessers : null,
    writers: sided ? writers : null,
    guesserLabel: sided ? groups[raw.for] || raw.for : '',
    writerLabel: sided ? groups[raw.for === 'parents' ? 'kids' : 'parents'] || '' : '',
    stage: 'write',
    lies: new Map(), // playerId -> text
    options: [], // built when voting starts: { id, text, truth, authors: [playerId], house }
    votes: new Map(), // playerId -> option id
    voteShare: new Map(), // playerId -> how much of the voting clock was left (0..1)
  };
}

function seconds(q, settings) {
  return q.data.stage === 'write' ? settings.timers.bluffWriteSeconds : settings.timers.bluffVoteSeconds;
}

function revealSeconds(settings) {
  return settings.timers.bluffRevealSeconds;
}

function publicView(q) {
  return {
    text: q.raw.text,
    // A slow-reveal picture stays off the TV while the fakes are written
    // (the writers see it on their phones), then sharpens during the vote.
    image: q.raw.slowReveal && q.data.stage === 'write' ? '' : q.raw.image || '',
    blur: Boolean(q.raw.slowReveal && q.raw.image && q.data.stage === 'vote'),
    pictureOnPhones: Boolean(q.raw.slowReveal && q.raw.image && q.data.stage === 'write'),
    stage: q.data.stage,
    maxLength: MAX_LIE,
    sided: q.data.sided,
    guessers: q.data.guessers,
    writers: q.data.writers,
    guesserLabel: q.data.guesserLabel,
    writerLabel: q.data.writerLabel,
    // Authors stay secret until the reveal.
    options: q.data.stage === 'vote' ? q.data.options.map((o) => ({ id: o.id, text: o.text })) : [],
  };
}

function submit(q, playerId, payload, elapsedMs) {
  const d = q.data;
  if (d.stage === 'write') {
    if (d.sided && !d.writers.includes(playerId)) return { error: 'The other side is writing fakes for you. Hang tight.' };
    if (d.lies.has(playerId)) return { error: 'Your answer is already in.' };
    const lie = String((payload || {}).text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LIE);
    if (!lie) return { error: 'Type an answer first.' };
    if (norm(lie) === norm(q.raw.answer)) {
      return { error: "That's suspiciously close to the truth. Make something up!" };
    }
    d.lies.set(playerId, lie);
    return {};
  }
  if (d.sided && !d.guessers.includes(playerId)) return { error: 'This one is for the other side to answer.' };
  if (d.votes.has(playerId)) return { error: 'You already voted.' };
  const optionId = String((payload || {}).optionId || '');
  const option = d.options.find((o) => o.id === optionId);
  if (!option) return { error: 'Pick one of the answers.' };
  if (option.authors.includes(playerId)) return { error: "That one's yours. Pick another." };
  d.votes.set(playerId, optionId);
  d.voteShare.set(playerId, q.totalMs ? Math.max(0, 1 - (elapsedMs || 0) / q.totalMs) : 0); // share of the clock left
  return {};
}

const answered = (q) => Array.from((q.data.stage === 'write' ? q.data.lies : q.data.votes).keys());

// Who the game is waiting for in this stage.
function expected(q, players) {
  if (!q.data.sided) return players;
  const ids = q.data.stage === 'write' ? q.data.writers : q.data.guessers;
  return players.filter((p) => ids.includes(p.id));
}

// After writing comes voting. Returns true if there is another stage.
function nextStage(q) {
  const d = q.data;
  if (d.stage !== 'write') return false;

  const options = [{ text: q.raw.answer, truth: true, authors: [], house: false }];
  for (const [playerId, lie] of d.lies) {
    const twin = options.find((o) => !o.truth && norm(o.text) === norm(lie));
    if (twin) twin.authors.push(playerId); // two players wrote the same fake: share it
    else options.push({ text: lie, truth: false, authors: [playerId], house: false });
  }
  for (const decoy of shuffle(q.raw.decoys)) {
    if (options.length >= MIN_OPTIONS) break;
    if (options.some((o) => norm(o.text) === norm(decoy))) continue;
    options.push({ text: decoy, truth: false, authors: [], house: true });
  }
  d.options = shuffle(options).map((o, i) => ({ ...o, id: LETTERS[i] }));
  d.stage = 'vote';
  return true;
}

function privateView(q, playerId) {
  const d = q.data;
  const mine = d.options.find((o) => o.authors.includes(playerId));
  const role = !d.sided ? 'both' : d.writers.includes(playerId) ? 'writer' : d.guessers.includes(playerId) ? 'guesser' : 'watcher';
  return {
    stage: d.stage,
    role,
    // Ready-made fakes, only for the people writing.
    suggestions: d.stage === 'write' && (role === 'both' || role === 'writer') ? (q.raw.suggestions || []).slice(0, 3) : [],
    // The secret picture, for the people writing fakes about it.
    image: q.raw.slowReveal && d.stage === 'write' && (role === 'both' || role === 'writer') ? q.raw.image || '' : '',
    lie: d.lies.get(playerId) || '',
    ownOptionId: mine ? mine.id : '',
    voteId: d.votes.get(playerId) || '',
  };
}

function finish(q, settings) {
  const d = q.data;
  const { bluffFoundTruth, bluffFooledPlayer } = settings.points;
  const gains = {};
  const add = (playerId, points) => {
    gains[playerId] = (gains[playerId] || 0) + points;
  };
  // If answers closed before voting started (host skipped ahead), still show the truth.
  if (d.stage === 'write') nextStage(q);

  const options = d.options.map((o) => ({
    id: o.id,
    text: o.text,
    truth: o.truth,
    house: o.house,
    authors: o.authors,
    voters: [],
  }));
  for (const [playerId, optionId] of d.votes) {
    const option = options.find((o) => o.id === optionId);
    if (!option) continue;
    option.voters.push(playerId);
    if (option.truth) {
      add(playerId, bluffFoundTruth);
      // Slow reveal: the sooner you spotted it, the bigger the bonus.
      if (q.raw.slowReveal) {
        add(playerId, Math.round(((settings.points.bluffSpeedBonusMax || 0) * (d.voteShare.get(playerId) || 0)) / 10) * 10);
      }
    }
    else option.authors.forEach((author) => add(author, bluffFooledPlayer));
  }
  return {
    gains,
    reveal: { options, fact: q.raw.fact, correctId: options.find((o) => o.truth).id },
  };
}

function peek(q) {
  return q.raw.answer;
}

const fullPoints = (settings) => settings.points.bluffFoundTruth;

module.exports = { prepare, seconds, revealSeconds, publicView, submit, answered, expected, nextStage, privateView, finish, peek, fullPoints };
