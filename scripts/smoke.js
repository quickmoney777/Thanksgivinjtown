'use strict';

// Plays a whole game with pretend players, very fast, and checks the rules
// hold. Run it after changing the server or the question files:
//
//   npm test
//
// It starts its own copy of the server on a spare port, so it's safe to run
// while a real room is open.

const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

let failures = 0;
function check(ok, label) {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function connect() {
  const socket = io(URL, { forceNew: true, transports: ['websocket'] });
  socket.ask = (event, payload) => new Promise((done) => socket.emit(event, payload, done));
  return new Promise((done) => socket.on('connect', () => done(socket)));
}

async function waitFor(test, label, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = test();
    if (value) return value;
    await wait(15);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), TIMER_SCALE: '0.03', PUBLIC_URL: URL },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((done) => server.stdout.on('data', (d) => String(d).includes('Host screen') && done()));

  try {
    // ----- Room, host, remote -----
    const host = await connect();
    const made = await host.ask('host:create', null);
    check(made.ok && /^[A-Z]{4}$/.test(made.code), 'host opens a room with a 4-letter code');
    check(made.join.url.includes(`?room=${made.code}`) && made.join.qrSvg.includes('<svg'), 'join link and QR code are built');
    const { code, hostKey } = made;

    let state = made.state;
    let answer = '';
    let answerKey = '';
    const remote = await connect();
    remote.on('state', (s) => (state = s));
    remote.on('peek', (p) => {
      answer = p.answer;
      answerKey = p.key;
    });
    const attached = await remote.ask('host:attach', { code, hostKey, role: 'remote' });
    check(attached.ok, 'phone remote attaches with the host key');
    check(!(await remote.ask('host:attach', { code, hostKey: 'nope', role: 'remote' })).ok, 'a wrong host key is refused');

    const catalog = state.catalog;
    console.log(`  rounds: ${catalog.rounds.map((r) => `${r.id}(${r.questionCount})`).join(', ')}`);
    check(catalog.warnings.length === 0, `no problems in the question files${catalog.warnings.length ? `: ${catalog.warnings.join(' | ')}` : ''}`);

    // ----- Players -----
    const characters = state.characters.map((c) => c.id);
    const players = [];
    for (const [i, name] of ['Dad', 'Mom', 'Jake', 'Anna'].entries()) {
      const socket = await connect();
      const p = { name, socket, mine: null, token: '', id: '' };
      socket.on('mine', (m) => (p.mine = m));
      await socket.ask('player:hello', { code });
      const joined = await socket.ask('player:join', { name, characterId: characters[i] });
      check(joined.ok, `${name} joins`);
      p.token = joined.token;
      p.id = joined.playerId;
      players.push(p);
    }
    const dupe = await connect();
    await dupe.ask('player:hello', { code });
    check(!(await dupe.ask('player:join', { name: 'Eve', characterId: characters[0] })).ok, 'a taken character is refused');
    check(!(await dupe.ask('player:join', { name: 'dad', characterId: characters[4] })).ok, 'a taken name is refused');
    dupe.disconnect();
    check(!JSON.stringify(state).includes(players[0].token) && !JSON.stringify(state).includes(hostKey), 'no secrets in what screens receive');

    // ----- Teams -----
    await remote.ask('host:action', { type: 'teams', on: true });
    await waitFor(() => state.teams, 'teams on');
    const sizes = [0, 1].map((t) => state.players.filter((p) => p.team === t).length);
    check(sizes[0] === 2 && sizes[1] === 2, 'teams are dealt two and two');

    // ----- Start with every round, bonus included, played in order -----
    check(state.pickGames === true, 'players pick each game is on by default');
    await remote.ask('host:action', { type: 'pickGames', on: false });
    await waitFor(() => state.pickGames === false, 'pick games off');
    const roundIds = catalog.rounds.map((r) => r.id);
    const started = await remote.ask('host:action', { type: 'start', roundIds });
    check(started.ok, `game starts${started.error ? `: ${started.error}` : ''}`);
    await waitFor(() => state.phase === 'intro', 'intro');
    await remote.ask('host:action', { type: 'next' });

    let questions = 0;
    let lastKey = '';
    let reconnected = false;
    let paused = false;
    let sawPin = false;
    let sawSided = false;
    let sidedTruth = '';
    let overruled = false;
    let sawSlow = false;
    let sawHeadsUp = false;
    let drawTeam = [];
    let slowNow = false;
    const seenTypes = new Set();

    while (state.phase !== 'final') {
      const q = state.game && state.game.question;
      if (state.phase === 'question' && q && `${q.key}:${q.stage || ''}` !== lastKey) {
        lastKey = `${q.key}:${q.stage || ''}`;
        seenTypes.add(q.type);
        await waitFor(() => answer && answerKey === q.key, 'the remote to be told the answer');
        check(state.game.reveal === null, `[${q.type} ${q.key}${q.stage ? ` ${q.stage}` : ''}] nothing revealed while answers are open`);

        if (q.type === 'number') {
          check(!q.choices, '  a closest-guess question has no choices');
          check(!(await players[0].socket.ask('player:answer', { number: 'lots' })).ok, '  a guess that is not a number is refused');
          await players[0].socket.ask('player:answer', { number: Number(answer.replace(/[^0-9.-]/g, '')) });
          await players[1].socket.ask('player:answer', { number: 1 });
          await players[2].socket.ask('player:answer', { number: 999999999 });
        } else         if (q.type === 'pin') {
          check(!q.choices && ['usa', 'world'].includes(q.mapKind), '  a pin question has a map and no choices');
          check((await players[0].socket.ask('player:answer', { x: 0.5, y: 0.45 })).ok, '  a pin is accepted');
          check(!(await players[0].socket.ask('player:answer', { x: 0.2, y: 0.2 })).ok, '  moving a locked pin is refused');
          check(!(await players[1].socket.ask('player:answer', { x: 7, y: 0.2 })).ok, '  a pin off the map is refused');
          await players[1].socket.ask('player:answer', { x: 0.05, y: 0.95 });
          sawPin = true;
        } else if (q.type === 'bluff' && q.sided) {
          sawSided = true;
          const writers = players.filter((p) => q.writers.includes(p.id));
          const guessers = players.filter((p) => q.guessers.includes(p.id));
          if (q.stage === 'write') {
            check(writers.length === 2 && guessers.length === 2, '  one side writes, the other side answers');
            check(!(await guessers[0].socket.ask('player:answer', { text: 'sneaky' })).ok, '  the answering side cannot write a fake');
            await waitFor(() => writers[0].mine && writers[0].mine.suggestions, 'suggestions');
            check(writers[0].mine.suggestions.length > 0 && !(guessers[0].mine && guessers[0].mine.suggestions.length), '  only the writers get suggested fakes');
            if (q.pictureOnPhones) {
              sawSlow = true;
              check(!q.image && writers[0].mine.image && !(guessers[0].mine && guessers[0].mine.image), '  a slow-reveal photo is only on the writers\' phones while fakes are written');
            }
            await writers[0].socket.ask('player:answer', { text: writers[0].mine.suggestions[0] });
            await writers[1].socket.ask('player:answer', { text: 'Totally made up' });
          } else {
            const truth = q.options.find((o) => o.text === answer);
            slowNow = Boolean(q.blur);
            if (q.blur) check(Boolean(q.image), '  the photo reaches the TV, blurred, when the vote starts');
            check(!(await writers[0].socket.ask('player:answer', { optionId: truth.id })).ok, '  the writing side cannot vote');
            await guessers[0].socket.ask('player:answer', { optionId: truth.id });
            await guessers[1].socket.ask('player:answer', { optionId: q.options.find((o) => o.id !== truth.id).id });
            sidedTruth = guessers[0].id;
          }
        } else if (q.type === 'bluff') {
          if (q.stage === 'write') {
            const truthTry = await players[0].socket.ask('player:answer', { text: answer });
            check(!truthTry.ok, '  writing the real answer as your fake is refused');
            for (const [i, p] of players.entries()) await p.socket.ask('player:answer', { text: i < 2 ? 'Same fake' : `Fake ${i}` });
          } else {
            check(q.options.length >= 4, `  ${q.options.length} choices to vote on`);
            const truth = q.options.find((o) => o.text === answer);
            check(Boolean(truth), '  the truth is among the choices');
            const own = players[0].mine && players[0].mine.ownOptionId;
            check(!(await players[0].socket.ask('player:answer', { optionId: own })).ok, "  can't vote for your own fake");
            await players[0].socket.ask('player:answer', { optionId: truth.id });
            for (const p of players.slice(1)) {
              const pick = q.options.find((o) => o.id !== truth.id && o.id !== (p.mine && p.mine.ownOptionId));
              await p.socket.ask('player:answer', { optionId: pick.id });
            }
          }
        } else if (q.type === 'headsup') {
          const holder = players.find((p) => p.id === q.holderId);
          const other = players.find((p) => p !== holder);
          if (q.stage === 'ready') {
            check(!(await other.socket.ask('player:answer', { ready: true })).ok, '  only the holder can start a Heads Up turn');
            await holder.socket.ask('player:answer', { ready: true });
          } else {
            await waitFor(() => holder.mine && holder.mine.word && other.mine && other.mine.word, 'the word');
            check(!JSON.stringify(state.game.question).includes(holder.mine.word), '  the current word is not on the TV');
            const first = holder.mine.word;
            check((await holder.socket.ask('player:answer', { result: 'right' })).ok, '  tipping up counts a word as right');
            await waitFor(() => holder.mine.word !== first, 'next word');
            await holder.socket.ask('player:answer', { result: 'pass' });
            await holder.socket.ask('player:answer', { result: 'right' });
            check(!(await other.socket.ask('player:answer', { result: 'right' })).ok, '  nobody else can score the holder\'s words');
            sawHeadsUp = true;
          }
        } else if (q.type === 'draw') {
          const artist = players.find((p) => p.id === q.artistId);
          check(Boolean(artist) && artist.mine && artist.mine.word === answer, '  only the artist is told the word');
          check(players.filter((p) => p !== artist).every((p) => !p.mine || !p.mine.word), '  guessers are not told the word');
          let strokes = 0;
          remote.on('draw', () => (strokes += 1));
          artist.socket.emit('draw:stroke', { color: '#2b1810', size: 0.01, points: [0.1, 0.1, 0.5, 0.5] });
          artist.socket.emit('draw:stroke', { more: true, points: [0.9, 0.9] });
          players.find((p) => p !== artist).socket.emit('draw:stroke', { points: [0, 0, 1, 1] }); // not the artist: ignored
          await wait(60);
          remote.off('draw');
          const synced = await remote.ask('draw:sync', null);
          check(strokes === 2 && synced.strokes.length === 1 && synced.strokes[0].points.length === 6, '  strokes reach the TV, and only from the artist');
          const sides = state.game.round.sides;
          check(q.aloud && sides && q.teamIds.length === 1 && sides.of[q.teamIds[0]] === sides.of[artist.id], '  Pictionary: random teams of two, and the artist\'s teammate guesses');
          const mate = players.find((p) => p.id === q.teamIds[0]);
          const rival = players.find((p) => p !== artist && p !== mate);
          check(!(await rival.socket.ask('player:answer', { gotIt: true })).ok, '  the other team cannot claim the word');
          check((await mate.socket.ask('player:answer', { gotIt: true })).ok, '  a teammate taps "We got it!"');
          drawTeam = [artist.id, mate.id];
        } else {
          const right = answer.split(':')[0];
          const wrong = q.choices.find((c) => c.id !== right).id;
          if (q.type === 'poster-reveal') check(Boolean(q.image) && q.blur, '  has a picture to un-blur');
          if (q.type === 'sketch') check(Boolean(q.map), '  has a map');

          // Once per game: pause, and check the clock stops and answers wait.
          if (!paused) {
            paused = true;
            await remote.ask('host:action', { type: 'pause' });
            await waitFor(() => state.game.paused, 'pause');
            const frozen = state.game.timer.remainingMs;
            const blocked = await players[0].socket.ask('player:answer', { choiceId: right });
            await wait(120);
            check(!blocked.ok && state.game.timer.remainingMs === frozen && state.phase === 'question', '  pausing stops the clock and holds answers');
            await remote.ask('host:action', { type: 'resume' });
          }

          const first = await players[0].socket.ask('player:answer', { choiceId: right });
          check(first.ok, '  an answer is accepted');
          check(!(await players[0].socket.ask('player:answer', { choiceId: wrong })).ok, '  changing your answer is refused');

          // Once per game: a phone refreshes mid-question and gets its seat and answer back.
          if (!reconnected) {
            reconnected = true;
            players[0].socket.disconnect();
            const again = await connect();
            again.on('mine', (m) => (players[0].mine = m));
            const back = await again.ask('player:hello', { code, token: players[0].token });
            check(back.playerId === players[0].id && back.mine && back.mine.choiceId === right, '  a refreshed phone gets its seat and answer back');
            players[0].socket = again;
          }
          await players[1].socket.ask('player:answer', { choiceId: wrong });
          // The other two don't answer: the timer has to end the question.
        }
        questions += 1;
      }

      if (state.phase === 'reveal' && state.game.reveal && lastKey !== `r:${state.game.question.key}`) {
        const q = state.game.question;
        lastKey = `r:${q.key}`;
        const gains = state.game.reveal.gains;
        if (q.type === 'number') {
          check(gains[players[0].id] === 1500 && gains[players[1].id] === 500 && !gains[players[2].id], '  spot on scores 1,500, second closest 500, furthest nothing');
        } else         if (q.type === 'pin') {
          const r = state.game.reveal;
          check(r.target && r.pins[players[0].id].miles >= 0 && r.closestId, '  pins are measured in miles and the closest is named');
          check((gains[r.closestId] || 0) >= 250, '  the closest pin scores');
        } else if (q.type === 'bluff' && q.sided) {
          check(gains[sidedTruth] >= 1000, '  the side answering scores for finding the truth');
          if (slowNow) check(gains[sidedTruth] > 1000 && gains[sidedTruth] <= 1500, `  a fast right answer on a slow reveal earns a bonus (${gains[sidedTruth]})`);
          if (!overruled) {
            overruled = true;
            const loser = players.find((p) => q.guessers.includes(p.id) && p.id !== sidedTruth);
            const before = state.players.find((p) => p.id === loser.id).score;
            await remote.ask('host:action', { type: 'overrule', playerId: loser.id, correct: true });
            await waitFor(() => state.players.find((p) => p.id === loser.id).score === before + 1000, 'overrule right');
            await remote.ask('host:action', { type: 'overrule', playerId: loser.id, correct: false });
            await waitFor(() => state.players.find((p) => p.id === loser.id).score === before, 'overrule wrong');
            check(true, '  the host can mark an answer right or wrong after the reveal');
          }
        } else if (q.type === 'bluff') {
          check(gains[players[0].id] >= 1000, '  finding the truth scores');
          const shared = state.game.reveal.options.find((o) => o.authors.length === 2);
          check(Boolean(shared), '  two identical fakes are merged into one');
        } else if (q.type === 'headsup') {
          check(gains[q.holderId] === 400 && state.game.reveal.results.length === 3, '  two right and one pass scores 400 for the holder');
        } else if (q.type === 'draw') {
          check(Object.keys(gains).sort().join() === drawTeam.slice().sort().join() && gains[drawTeam[0]] === gains[drawTeam[1]], '  the artist and teammate score the same, the other team nothing');
        } else {
          check(gains[players[0].id] > 0 && !gains[players[1].id], '  right answer scores, wrong answer does not');
        }
      }
      await wait(10);
    }

    check(questions > 0, `played ${questions} question stages across ${state.game.rounds.length} rounds`);
    check(sawPin, 'played a pin-drop map question');
    check(sawSided, 'played a parents-against-kids question');
    check(sawSlow, 'played a slow-reveal photo question');
    check(sawHeadsUp, 'played a Heads Up turn');
    check(state.game.rounds.find((r) => r.id === 'trivia') && true, 'the Trivia game was played');
    for (const type of ['multiple-choice', 'poster-reveal', 'name-the-artist', 'pin', 'bluff', 'draw', 'headsup', 'number']) {
      check(seenTypes.has(type), `played a ${type} round`);
    }
    const scores = state.players.map((p) => `${p.name} ${p.score}`).join(', ');
    check(state.players.every((p) => Number.isInteger(p.score)) && state.players[0].score > state.players[3].score, `final scores make sense (${scores})`);

    // ----- Afterwards -----
    const before = state.players[3].score;
    await remote.ask('host:action', { type: 'adjustScore', playerId: players[3].id, delta: 250 });
    await waitFor(() => state.players[3].score === before + 250, 'score change');
    check(true, 'the host can adjust a score');
    await remote.ask('host:action', { type: 'lobby' });
    await waitFor(() => state.phase === 'lobby', 'lobby');
    check(state.game === null, 'back to the lobby for another game');

    // ----- A second game where players vote for each game from a menu -----
    await remote.ask('host:action', { type: 'pickGames', on: true });
    const menuIds = ['trivia', 'sketch', 'bluff'];
    const again = await remote.ask('host:action', { type: 'start', roundIds: menuIds });
    check(again.ok, `a pick-your-game game starts${again.error ? `: ${again.error}` : ''}`);
    await waitFor(() => state.phase === 'intro', 'intro');
    await remote.ask('host:action', { type: 'next' });
    await waitFor(() => state.phase === 'menu', 'the game menu');
    check(state.game.menu.options.map((o) => o.id).join() === menuIds.join(), 'the menu lists the ticked games');
    check(state.game.timer === null, 'no clock runs until someone votes');
    check(!(await players[0].socket.ask('player:answer', { roundId: 'nope' })).ok, 'a vote for a game not on the menu is refused');
    await players[0].socket.ask('player:answer', { roundId: 'sketch' });
    await waitFor(() => state.game.menu.votes[players[0].id] === 'sketch' && state.game.timer, 'first vote');
    await players[0].socket.ask('player:answer', { roundId: 'trivia' });
    await waitFor(() => state.game.menu.votes[players[0].id] === 'trivia', 'changed vote');
    check(true, 'a vote can be changed, and the first vote starts the clock');
    await players[1].socket.ask('player:answer', { roundId: 'trivia' });
    await players[2].socket.ask('player:answer', { roundId: 'sketch' });
    await players[3].socket.ask('player:answer', { roundId: 'trivia' });
    await waitFor(() => state.game.menu && state.game.menu.chosenId, 'a winner');
    check(state.game.menu.chosenId === 'trivia', 'the game with the most votes wins');
    check(!(await players[0].socket.ask('player:answer', { roundId: 'sketch' })).ok, 'votes close once the game is picked');
    await waitFor(() => state.phase === 'roundIntro', 'the chosen round');
    check(state.game.round.id === 'trivia' && state.game.round.count === 0, 'the chosen game starts');
    await remote.ask('host:action', { type: 'next' });
    await waitFor(() => state.phase === 'question', 'a question');
    check((await remote.ask('host:action', { type: 'exitRound' })).ok, 'the host can exit a game part-way through');
    await waitFor(() => state.phase === 'menu', 'menu again');
    check(state.game.menu.options.find((o) => o.id === 'trivia').played === 1, 'after the round the menu comes back and marks it played');
    const forced = await remote.ask('host:action', { type: 'pickRound', roundId: 'bluff' });
    await waitFor(() => state.phase === 'roundIntro', 'host pick intro');
    await remote.ask('host:action', { type: 'skipQuestion' }).catch(() => {});
    while (state.phase !== 'scores') {
      await remote.ask('host:action', { type: state.phase === 'question' ? 'skipQuestion' : 'next' });
      await wait(30);
    }
    const before2 = state.game.rounds.length;
    check((await remote.ask('host:action', { type: 'replay' })).ok, 'the host can play the same game again from the scoreboard');
    await waitFor(() => state.phase === 'roundIntro' && state.game.rounds.length === before2 + 1, 'replay');
    await waitFor(() => state.phase === 'roundIntro', 'host pick');
    check(forced.ok && state.game.round.id === 'bluff', 'the host can pick the game from the remote');
    await remote.ask('host:action', { type: 'skipRound' });
    await waitFor(() => state.phase === 'menu', 'menu a third time');
    await remote.ask('host:action', { type: 'next' });
    await waitFor(() => state.game.menu && state.game.menu.chosenId, 'surprise pick');
    check(state.game.menu.chosenId === 'sketch', 'with no votes, a game that has not been played is picked');
    await remote.ask('host:action', { type: 'endGame' });
    await waitFor(() => state.phase === 'final', 'final');
    check(true, 'the host ends the game from the menu and the winner screen shows');

    [host, remote, ...players.map((p) => p.socket)].forEach((s) => s.disconnect());
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${err.message}`);
  } finally {
    server.kill();
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main();
