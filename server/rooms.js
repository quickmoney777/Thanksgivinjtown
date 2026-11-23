'use strict';

// Room state, held in memory. A room has one host and a seat per character.
// Each seat has a secret token the phone keeps, which is how a phone that
// slept or refreshed gets its seat and score back.

const crypto = require('crypto');
const content = require('./content');
const engine = require('./engine');

// No vowels, so a code can't spell a word. No I or O to confuse with 1 and 0.
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const rooms = new Map();

const secret = () => crypto.randomBytes(18).toString('base64url');

function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function createRoom() {
  const settings = content.loadSettings();
  const room = {
    code: makeCode(),
    hostKey: secret(),
    phase: 'lobby',
    characters: content.loadCharacters(),
    settings,
    catalog: engine.catalog(settings), // rounds the host can pick from
    game: null, // set by the engine while a game is running
    usedQuestionIds: new Set(), // so a second game gets fresh questions
    teamsOn: false, // two-team play, switched on by the host in the lobby
    music: null, // lobby soundtrack { url, title, artist }, filled in by the server
    players: new Map(),
    hostSockets: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase().trim()) || null;
}

function closeRoom(room) {
  engine.stop(room);
  rooms.delete(room.code);
}

function touch(room) {
  room.lastActivity = Date.now();
}

function cleanName(raw, max) {
  const text = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, max).join('').trim();
}

function characterTaken(room, characterId, exceptPlayerId) {
  for (const p of room.players.values()) {
    if (p.characterId === characterId && p.id !== exceptPlayerId) return true;
  }
  return false;
}

function addPlayer(room, { name, characterId }) {
  const clean = cleanName(name, room.settings.nameMaxLength);
  if (!clean) return { error: 'Type a name first.' };
  if (room.players.size >= room.characters.length) return { error: 'Every seat is taken.' };
  if (!room.characters.some((c) => c.id === characterId)) return { error: 'Pick a character.' };
  if (characterTaken(room, characterId)) return { error: 'That character was just taken. Pick another.' };
  for (const p of room.players.values()) {
    if (p.name.toLowerCase() === clean.toLowerCase()) return { error: 'That name is taken. Try another.' };
  }
  const player = {
    id: crypto.randomBytes(6).toString('base64url'),
    token: secret(),
    name: clean,
    characterId,
    score: 0,
    team: smallerTeam(room),
    sockets: new Set(),
    joinedAt: Date.now(),
  };
  room.players.set(player.id, player);
  return { player };
}

function changeCharacter(room, player, characterId) {
  if (room.phase !== 'lobby') return { error: 'Characters are locked once the game starts.' };
  if (!room.characters.some((c) => c.id === characterId)) return { error: 'Pick a character.' };
  if (characterTaken(room, characterId, player.id)) return { error: 'That character was just taken. Pick another.' };
  player.characterId = characterId;
  return { player };
}

// ---------- Teams ----------

function teamSizes(room) {
  const sizes = [0, 0];
  for (const p of room.players.values()) sizes[p.team === 1 ? 1 : 0] += 1;
  return sizes;
}

// New players go to whichever team has fewer people.
function smallerTeam(room) {
  const [a, b] = teamSizes(room);
  return b < a ? 1 : 0;
}

// Deal everyone out evenly, in the order they joined.
function setTeams(room, on) {
  room.teamsOn = Boolean(on);
  if (!room.teamsOn) return;
  Array.from(room.players.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .forEach((p, i) => {
      p.team = i % 2;
    });
}

function switchTeam(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return { error: 'That player already left.' };
  player.team = player.team === 1 ? 0 : 1;
  return {};
}

function findByToken(room, token) {
  if (!token) return null;
  for (const p of room.players.values()) {
    if (p.token === token) return p;
  }
  return null;
}

// What every screen is allowed to see. Tokens and the host key never leave.
function publicState(room) {
  return {
    code: room.code,
    title: room.settings.gameTitle,
    phase: room.phase,
    hostOnline: room.hostSockets.size > 0,
    characters: room.characters,
    players: Array.from(room.players.values())
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        id: p.id,
        name: p.name,
        characterId: p.characterId,
        score: p.score,
        team: p.team === 1 ? 1 : 0,
        connected: p.sockets.size > 0,
      })),
    teams: room.teamsOn ? room.settings.teams : null,
    music: room.settings.lobbyMusic.enabled ? room.music : null,
    settings: {
      nameMaxLength: room.settings.nameMaxLength,
      scoreAdjustStep: room.settings.scoreAdjustStep,
      autoAdvance: room.settings.autoAdvance,
    },
    catalog: room.catalog,
    game: engine.publicGame(room),
    serverNow: Date.now(),
  };
}

function sweep() {
  const cutoff = Date.now() - ROOM_IDLE_MS;
  for (const room of rooms.values()) {
    if (room.lastActivity < cutoff) closeRoom(room);
  }
}
setInterval(sweep, 10 * 60 * 1000).unref();

module.exports = {
  createRoom,
  getRoom,
  closeRoom,
  touch,
  addPlayer,
  changeCharacter,
  setTeams,
  switchTeam,
  findByToken,
  publicState,
  count: () => rooms.size,
};
