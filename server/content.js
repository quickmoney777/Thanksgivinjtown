'use strict';

// Loads the editable JSON in /content. Files are re-read when a room opens
// and again when a game starts, so edits show up without a restart.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'content');

// Round types the engine can play. Each has a module in server/modes.
const CHOICE_TYPES = ['multiple-choice', 'poster-reveal', 'name-the-artist', 'map-it'];
const SUPPORTED_TYPES = [...CHOICE_TYPES, 'bluff', 'draw'];

function readJson(file) {
  const full = path.join(DIR, file);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    throw new Error(`content/${file} is missing.`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`content/${file} has a typo: ${err.message}`);
  }
}

// ---------- Characters ----------

function loadCharacters() {
  const list = readJson('characters.json');
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('content/characters.json needs a list with at least one character.');
  }
  const seen = new Set();
  return list.map((c, i) => {
    const where = `content/characters.json, character ${i + 1}`;
    if (!c || typeof c !== 'object') throw new Error(`${where} is not an object.`);
    if (!c.id || typeof c.id !== 'string') throw new Error(`${where} needs an "id".`);
    if (seen.has(c.id)) throw new Error(`${where} repeats the id "${c.id}".`);
    seen.add(c.id);
    if (!c.name) throw new Error(`${where} needs a "name".`);
    if (!c.emoji && !c.image) throw new Error(`${where} needs an "emoji" or an "image".`);
    return {
      id: c.id,
      name: String(c.name),
      emoji: c.emoji ? String(c.emoji) : '',
      image: c.image ? String(c.image) : '',
      color: /^#[0-9a-f]{3,8}$/i.test(c.color || '') ? c.color : '#A6B0B5',
      catchphrase: c.catchphrase ? String(c.catchphrase) : '',
    };
  });
}

// ---------- Settings ----------

const SETTING_DEFAULTS = {
  gameTitle: 'Party Trivia',
  nameMaxLength: 12,
  scoreAdjustStep: 100,
  questionsPerRound: 5,
  autoAdvance: true,
  roundOrder: [],
  bonusRounds: [],
  timers: {
    roundIntroSeconds: 6,
    questionSeconds: 20,
    posterRevealSeconds: 20,
    audioSeconds: 25,
    bluffWriteSeconds: 60,
    bluffVoteSeconds: 30,
    bluffRevealSeconds: 16,
    drawSeconds: 75,
    lockedSeconds: 2,
    revealSeconds: 8,
    scoreboardSeconds: 10,
  },
  points: {
    correct: 500,
    speedBonusMax: 500,
    posterCorrect: 250,
    posterSpeedBonusMax: 1000,
    bluffFoundTruth: 1000,
    bluffFooledPlayer: 500,
    drawGuessed: 500,
    drawSpeedBonusMax: 500,
    drawArtistPerGuess: 300,
  },
  teams: {
    names: ['Team Scarlet', 'Team Gray'],
    colors: ['#BB0000', '#A6B0B5'],
  },
  lobbyMusic: {
    enabled: true,
    file: '',
    itunes: null,
    volume: 0.5,
  },
};

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Keep every number in a group sane, falling back to the default when a
// value is missing or isn't a number.
function numberGroup(raw, defaults, min, max) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    out[key] = clampInt(value, min, max, defaults[key] != null ? defaults[key] : min);
  }
  return out;
}

const idList = (value) =>
  (Array.isArray(value) ? value : []).map(String).filter((id) => /^[a-z0-9][a-z0-9-]*$/i.test(id));

function loadSettings() {
  const raw = readJson('settings.json');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('content/settings.json needs to be an object.');
  }
  return {
    gameTitle: String(raw.gameTitle || SETTING_DEFAULTS.gameTitle),
    nameMaxLength: clampInt(raw.nameMaxLength, 3, 20, SETTING_DEFAULTS.nameMaxLength),
    scoreAdjustStep: clampInt(raw.scoreAdjustStep, 1, 10000, SETTING_DEFAULTS.scoreAdjustStep),
    questionsPerRound: clampInt(raw.questionsPerRound, 1, 50, SETTING_DEFAULTS.questionsPerRound),
    autoAdvance: raw.autoAdvance !== false,
    roundOrder: idList(raw.roundOrder),
    bonusRounds: idList(raw.bonusRounds),
    timers: numberGroup(raw.timers, SETTING_DEFAULTS.timers, 1, 600),
    points: numberGroup(raw.points, SETTING_DEFAULTS.points, 0, 100000),
    teams: teamSettings(raw.teams),
    lobbyMusic: musicSettings(raw.lobbyMusic),
  };
}

function teamSettings(raw) {
  const d = SETTING_DEFAULTS.teams;
  const t = raw && typeof raw === 'object' ? raw : {};
  const pair = (value, fallback) =>
    Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string' && v.trim())
      ? value.map((v) => v.trim())
      : fallback;
  return { names: pair(t.names, d.names), colors: pair(t.colors, d.colors) };
}

function musicSettings(raw) {
  const d = SETTING_DEFAULTS.lobbyMusic;
  const m = raw && typeof raw === 'object' ? raw : {};
  const volume = Number(m.volume);
  return {
    enabled: m.enabled !== false,
    file: text(m.file),
    itunes: lookupSpec(m.itunes),
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : d.volume,
  };
}

// Where to find a picture or clip online. Two ways to ask:
//   "itunes": { "kind": "album" | "song", "term": "what to search for",
//               "match": "must appear in the title", "artist": "must appear in the artist" }
//   "wikipedia": "Jaws (film)"      (the article's exact title; uses its main picture)
function lookupSpec(itunes, wikipedia) {
  if (itunes && typeof itunes === 'object') {
    const kind = ['album', 'movie', 'song'].includes(itunes.kind) ? itunes.kind : 'song';
    const term = text(itunes.term);
    const id = Number(itunes.id) || 0;
    if (term || id) return { kind, term, id, match: text(itunes.match), artist: text(itunes.artist) };
  }
  const title = text(wikipedia);
  if (title) return { kind: 'wiki', term: title, id: 0, match: '' };
  return null;
}

// ---------- Questions ----------

const text = (value) => (value == null ? '' : String(value).trim());
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// Returns { question }, { error } or { held: true }. A bad question is
// skipped with a warning rather than stopping the game. A question marked
// "verify": true is held back until you've checked it and removed the flag.
function normalizeQuestion(q, index, file, type) {
  const where = `content/${file}, question ${index + 1}`;
  if (!q || typeof q !== 'object') return { error: `${where} is not an object.` };
  if (q.verify) return { held: true };
  const id = text(q.id) || `${file}#${index + 1}`;

  if (type === 'draw') {
    const word = text(q.word);
    if (!word) return { error: `${where} needs a "word".` };
    const accept = (Array.isArray(q.accept) ? q.accept : []).map(text).filter(Boolean);
    return { question: { id, word, accept, timeSeconds: q.timeSeconds ? clampInt(q.timeSeconds, 10, 600, 0) : 0 } };
  }

  const prompt = text(q.question);
  const answer = text(q.answer);
  if (!prompt) return { error: `${where} needs a "question".` };
  if (!answer) return { error: `${where} needs an "answer".` };

  if (type === 'bluff') {
    const decoys = (Array.isArray(q.decoys) ? q.decoys : []).map(text).filter((d) => d && !same(d, answer));
    return {
      question: {
        id,
        text: prompt,
        answer,
        decoys,
        fact: text(q.fact),
        timeSeconds: 0,
      },
    };
  }

  const map = q.map && typeof q.map === 'object' ? q.map : null;
  const out = {
    id,
    text: prompt,
    listenText: text(q.listenQuestion), // shown instead when a song clip is playing
    answer,
    wrong: null,
    choices: null,
    fact: text(q.fact),
    image: text(q.image),
    revealImage: text(q.revealImage),
    audio: text(q.audio),
    lookup: lookupSpec(q.itunes, q.wikipedia),
    map: map && text(map.state)
      ? {
          show: ['outline', 'highlight', 'blank'].includes(map.show) ? map.show : 'outline',
          state: text(map.state).toUpperCase(),
          also: (Array.isArray(map.also) ? map.also : []).map((c) => text(c).toUpperCase()).filter(Boolean),
        }
      : null,
    timeSeconds: q.timeSeconds ? clampInt(q.timeSeconds, 3, 600, 0) : 0,
  };

  if (Array.isArray(q.choices)) {
    // "choices" keeps the order written in the file (no shuffling).
    const choices = q.choices.map(text).filter(Boolean);
    if (choices.length < 2 || choices.length > 6) return { error: `${where} needs 2 to 6 "choices".` };
    if (choices.filter((c) => c === answer).length !== 1) {
      return { error: `${where}: the "answer" must match exactly one of the "choices".` };
    }
    out.choices = choices;
    return { question: out };
  }

  const wrong = (Array.isArray(q.wrong) ? q.wrong : []).map(text).filter(Boolean);
  if (wrong.length < 1 || wrong.length > 5) return { error: `${where} needs 1 to 5 "wrong" answers.` };
  if (wrong.some((w) => same(w, answer))) return { error: `${where} lists the right answer under "wrong".` };
  if (new Set(wrong.map((w) => w.toLowerCase())).size !== wrong.length) {
    return { error: `${where} repeats a "wrong" answer.` };
  }
  out.wrong = wrong;
  return { question: out };
}

// Reads every round named in settings. Missing files are "pending" (not
// written yet); files with problems produce warnings the host can see.
function loadRounds(settings) {
  const rounds = new Map();
  const pending = [];
  const warnings = [];
  const ids = Array.from(new Set([...settings.roundOrder, ...settings.bonusRounds]));

  for (const id of ids) {
    const file = `questions/${id}.json`;
    if (!fs.existsSync(path.join(DIR, file))) {
      pending.push(id);
      continue;
    }
    let raw;
    try {
      raw = readJson(file);
    } catch (err) {
      warnings.push(err.message);
      continue;
    }
    const type = raw.type || 'multiple-choice';
    if (!SUPPORTED_TYPES.includes(type)) {
      warnings.push(`content/${file}: the "${type}" round type isn't built yet.`);
      continue;
    }
    const questions = [];
    let held = 0;
    (Array.isArray(raw.questions) ? raw.questions : []).forEach((q, i) => {
      const result = normalizeQuestion(q, i, file, type);
      if (result.held) held += 1;
      else if (result.error) warnings.push(result.error);
      else questions.push(result.question);
    });
    if (questions.length === 0) {
      warnings.push(`content/${file} has no usable questions.`);
      continue;
    }
    rounds.set(id, {
      id,
      title: text(raw.title) || id,
      tagline: text(raw.tagline),
      icon: text(raw.icon),
      type,
      bonus: !settings.roundOrder.includes(id),
      held, // questions waiting for a fact check ("verify": true)
      questions,
    });
  }
  return { rounds, pending, warnings };
}

module.exports = { loadCharacters, loadSettings, loadRounds, CHOICE_TYPES, DIR };
