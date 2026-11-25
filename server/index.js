'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const rooms = require('./rooms');
const content = require('./content');
const engine = require('./engine');
const media = require('./media');
const { resolveBase } = require('./net');

const PORT = Number(process.env.PORT) || 3030;
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
// Short pings so a sleeping phone shows as away within a few seconds.
const io = new Server(server, { pingInterval: 8000, pingTimeout: 6000 });

const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));
app.get('/', page('play.html'));
app.get('/play', page('play.html'));
app.get('/host', page('host.html'));
app.get('/remote', page('remote.html'));
// GIFs or pictures dropped into public/media/reactions/win and /lose pop up
// on the TV when an answer is revealed.
app.get('/api/reactions', (_req, res) => {
  const list = (kind) => {
    try {
      return fs
        .readdirSync(path.join(__dirname, '..', 'public', 'media', 'reactions', kind))
        .filter((name) => /\.(gif|png|jpe?g|webp)$/i.test(name))
        .map((name) => `/media/reactions/${kind}/${encodeURIComponent(name)}`);
    } catch (err) {
      return [];
    }
  };
  res.json({ win: list('win'), lose: list('lose') });
});

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.count() }));
app.get('/api/info', (req, res) => {
  try {
    res.json({ title: content.loadSettings().gameTitle });
  } catch (err) {
    res.json({ title: '', error: err.message });
  }
});
app.use(express.static(PUBLIC));

const QR_COLORS = { dark: '#2b1810', light: '#fff3dc' };
const qrSvg = (text) =>
  QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: QR_COLORS });

const fn = (ack) => (typeof ack === 'function' ? ack : () => {});

function broadcast(room) {
  rooms.touch(room);
  io.to(room.code).emit('state', rooms.publicState(room));
  // The answer goes to the host's phone only, never to the TV or players.
  io.to(`${room.code}:remote`).emit('peek', engine.hostPeek(room));
  // Each phone also gets what only that player should see: their own
  // answer, their secret word when drawing, and so on.
  if (room.game) {
    for (const player of room.players.values()) {
      if (player.sockets.size === 0) continue;
      const mine = engine.privateView(room, player.id);
      for (const id of player.sockets) io.to(id).emit('mine', mine);
    }
  }
}
engine.init({
  broadcast,
  emitToRoom: (room, event, payload) => io.to(room.code).emit(event, payload),
});

// Find the lobby soundtrack: your own file if there is one, else the
// 30-second iTunes preview. Runs in the background when a room opens.
async function loadMusic(room) {
  const m = room.settings.lobbyMusic;
  if (!m.enabled) return;
  if (media.localOk(m.file)) {
    room.music = { url: m.file, title: '', artist: '', volume: m.volume };
  } else if (m.itunes) {
    const found = await media.resolve(m.itunes);
    if (found && found.audio) room.music = { url: found.audio, title: found.title, artist: found.artist, volume: m.volume };
  }
  if (room.music && rooms.getRoom(room.code) === room) broadcast(room);
}

// Take a socket out of whatever room and seat it was in.
function detach(socket) {
  const { kind, code, playerId } = socket.data;
  socket.data = {};
  if (!code) return;
  socket.leave(code);
  socket.leave(`${code}:remote`);
  const room = rooms.getRoom(code);
  if (!room) return;
  if (kind === 'host') room.hostSockets.delete(socket.id);
  if (kind === 'player' && playerId) {
    const player = room.players.get(playerId);
    if (player) player.sockets.delete(socket.id);
    engine.presenceChanged(room);
  }
  broadcast(room);
}

async function attachHost(socket, room, role) {
  detach(socket);
  socket.data = { kind: 'host', role, code: room.code };
  socket.join(room.code);
  if (role === 'screen') room.hostSockets.add(socket.id);
  else socket.join(`${room.code}:remote`);

  const headers = socket.handshake.headers;
  const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const base = resolveBase({ host: headers.host, proto, port: PORT });
  const joinUrl = `${base.url}/?room=${room.code}`;
  // The host key rides in the #fragment, so it never reaches server logs.
  const remoteUrl = `${base.url}/remote#${room.code}.${room.hostKey}`;

  const reply = {
    ok: true,
    code: room.code,
    hostKey: room.hostKey,
    state: rooms.publicState(room),
  };
  if (role === 'screen') {
    reply.join = {
      url: joinUrl,
      display: base.url.replace(/^https?:\/\//, ''),
      qrSvg: await qrSvg(joinUrl),
      local: base.local,
      lanMissing: base.lanMissing,
    };
    reply.remote = { url: remoteUrl, qrSvg: await qrSvg(remoteUrl) };
  }
  broadcast(room);
  return reply;
}

function hostAction(room, action) {
  switch (action && action.type) {
    case 'lobby':
      engine.toLobby(room);
      return {};
    case 'next':
      engine.next(room);
      return {};
    case 'pause':
      engine.pause(room);
      return {};
    case 'resume':
      engine.resume(room);
      return {};
    case 'skipQuestion':
      engine.skipQuestion(room);
      return {};
    case 'skipRound':
      engine.skipRound(room);
      return {};
    case 'endGame':
      engine.endGame(room);
      return {};
    case 'overrule':
      return engine.overrule(room, action.playerId, action.correct);
    case 'replay':
      return engine.replay(room);
    case 'exitRound':
      return engine.exitRound(room);
    case 'pickRound':
      return engine.pickRound(room, action.roundId);
    case 'pickGames':
      if (room.phase !== 'lobby') return { error: 'This can only be changed in the lobby.' };
      room.pickOn = Boolean(action.on);
      return {};
    case 'reload':
      // Re-read the question files, for edits made while the room is open.
      if (room.phase !== 'lobby') return { error: 'Go back to the lobby first.' };
      try {
        room.catalog = engine.catalog(content.loadSettings());
      } catch (err) {
        return { error: err.message };
      }
      return {};
    case 'teams':
      if (room.phase !== 'lobby') return { error: 'Teams can only be changed in the lobby.' };
      rooms.setTeams(room, action.on);
      return {};
    case 'switchTeam':
      return rooms.switchTeam(room, action.playerId);
    case 'adjustScore': {
      const player = room.players.get(action.playerId);
      const delta = Math.round(Number(action.delta));
      if (!player || !Number.isFinite(delta) || Math.abs(delta) > 100000) return { error: 'Could not change that score.' };
      player.score += delta;
      return {};
    }
    case 'removePlayer': {
      const player = room.players.get(action.playerId);
      if (!player) return { error: 'That player already left.' };
      room.players.delete(player.id);
      for (const id of player.sockets) {
        const s = io.sockets.sockets.get(id);
        if (!s) continue;
        s.data.playerId = null;
        s.emit('removed');
      }
      engine.presenceChanged(room);
      return {};
    }
    default:
      return { error: 'Unknown action.' };
  }
}

io.on('connection', (socket) => {
  socket.data = {};

  // ---- Host screen and host remote ----

  socket.on('host:create', async (_payload, ack) => {
    const reply = fn(ack);
    try {
      const room = rooms.createRoom();
      loadMusic(room).catch(() => {});
      reply(await attachHost(socket, room, 'screen'));
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  });

  socket.on('host:attach', async (payload, ack) => {
    const reply = fn(ack);
    const p = payload || {};
    const room = rooms.getRoom(p.code);
    if (!room || room.hostKey !== p.hostKey) return reply({ ok: false, error: 'no-room' });
    try {
      reply(await attachHost(socket, room, p.role === 'remote' ? 'remote' : 'screen'));
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  });

  socket.on('host:action', (action, ack) => {
    const reply = fn(ack);
    if (socket.data.kind !== 'host') return reply({ ok: false, error: 'Not the host.' });
    const room = rooms.getRoom(socket.data.code);
    if (!room) return reply({ ok: false, error: 'no-room' });

    if (action && action.type === 'close') {
      io.to(room.code).emit('closed');
      rooms.closeRoom(room);
      io.in(room.code).socketsLeave(room.code);
      socket.data = {};
      return reply({ ok: true });
    }

    if (action && action.type === 'start') {
      // Starting can take a moment while pictures and song clips are fetched.
      engine
        .startGame(room, action.roundIds)
        .then((result) => reply(result.error ? { ok: false, error: result.error } : { ok: true }))
        .catch((err) => reply({ ok: false, error: err.message }));
      return undefined;
    }

    const result = hostAction(room, action);
    if (result.error) return reply({ ok: false, error: result.error });
    broadcast(room);
    return reply({ ok: true });
  });

  // The TV asks for the drawing so far when it (re)connects mid-drawing.
  socket.on('draw:sync', (_payload, ack) => {
    const room = rooms.getRoom(socket.data.code);
    fn(ack)(room ? engine.drawSync(room) : { key: '', strokes: [] });
  });

  // ---- Phones ----

  // First thing a phone says. With a valid seat token it gets its seat back.
  socket.on('player:hello', (payload, ack) => {
    const reply = fn(ack);
    const p = payload || {};
    const room = rooms.getRoom(p.code);
    if (!room) return reply({ ok: false, error: 'no-room' });

    detach(socket);
    socket.data = { kind: 'player', code: room.code, playerId: null };
    socket.join(room.code);

    const player = rooms.findByToken(room, p.token);
    if (player) {
      socket.data.playerId = player.id;
      player.sockets.add(socket.id);
      broadcast(room);
    }
    reply({
      ok: true,
      playerId: player ? player.id : null,
      state: rooms.publicState(room),
      mine: player ? engine.privateView(room, player.id) : null, // an answer already sent
    });
  });

  socket.on('player:join', (payload, ack) => {
    const reply = fn(ack);
    if (socket.data.kind !== 'player') return reply({ ok: false, error: 'no-room' });
    const room = rooms.getRoom(socket.data.code);
    if (!room) return reply({ ok: false, error: 'no-room' });
    if (socket.data.playerId) return reply({ ok: false, error: 'You already have a seat.' });

    const p = payload || {};
    const result = rooms.addPlayer(room, { name: p.name, characterId: p.characterId });
    if (result.error) return reply({ ok: false, error: result.error });

    const { player } = result;
    player.sockets.add(socket.id);
    socket.data.playerId = player.id;
    broadcast(room);
    reply({ ok: true, playerId: player.id, token: player.token, state: rooms.publicState(room) });
  });

  socket.on('player:character', (payload, ack) => {
    const reply = fn(ack);
    const room = rooms.getRoom(socket.data.code);
    const player = room && room.players.get(socket.data.playerId);
    if (!player) return reply({ ok: false, error: 'Join the game first.' });
    const result = rooms.changeCharacter(room, player, (payload || {}).characterId);
    if (result.error) return reply({ ok: false, error: result.error });
    broadcast(room);
    reply({ ok: true });
  });

  socket.on('player:answer', (payload, ack) => {
    const reply = fn(ack);
    const room = rooms.getRoom(socket.data.code);
    const player = room && room.players.get(socket.data.playerId);
    if (!player) return reply({ ok: false, error: 'Join the game first.' });
    const result = engine.submit(room, player, payload);
    if (result.error) return reply({ ok: false, error: result.error });
    reply({ ok: true, mine: result.mine, correct: result.correct });
  });

  // Pen strokes from the phone of whoever is drawing.
  socket.on('draw:stroke', (payload) => {
    const room = rooms.getRoom(socket.data.code);
    const player = room && room.players.get(socket.data.playerId);
    if (player) engine.drawStroke(room, player, payload);
  });

  socket.on('disconnect', () => detach(socket));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\nPort ${PORT} is already in use, so the game is probably running already.`);
    console.log(`Try opening http://localhost:${PORT}/host, or stop the other copy first.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const base = resolveBase({ host: `localhost:${PORT}`, proto: 'http', port: PORT });
  console.log(`\nHost screen (open this on the laptop):  http://localhost:${PORT}/host`);
  if (base.lanMissing) {
    console.log('No Wi-Fi address found. Phones will not be able to reach this laptop.');
  } else {
    console.log(`Phones join at:                         ${base.url}\n`);
  }
});
