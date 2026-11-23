// The TV. It draws whatever state the server sends and plays the sounds.
(() => {
  const { $, h, plate, store, ranked, makeClock, points } = Gobble;
  const HOST_KEY = 'gobble.host';
  const CONFETTI = ['#f28c28', '#bb0000', '#f4c542', '#a6b0b5', '#fff3dc', '#4f7a4a'];

  const socket = io({ autoConnect: false });
  const clock = makeClock();
  let creds = store.get(HOST_KEY); // { code, hostKey } for the room this laptop opened
  let state = null;
  let info = null; // join and remote links from the server
  let knownPlayers = null; // ids we've already drawn, to animate only new arrivals
  let viewKey = ''; // which stage view is built, so we only rebuild when it changes
  let lastTick = null; // last whole second we played a tick for
  let mapData = null; // US state shapes, for Map It
  let muted = store.get('gobble.muted') === true;
  let clipKey = ''; // which question's song clip is loaded

  fetch('/data/us-states.json')
    .then((res) => res.json())
    .then((data) => {
      mapData = data;
    })
    .catch(() => {});

  // Show the game's name on the opening screen before any room exists.
  fetch('/api/info')
    .then((res) => res.json())
    .then((data) => {
      if (data.title && !state) $('#gate-title').textContent = data.title;
    })
    .catch(() => {});

  // ---------- Getting into a room ----------

  $('#open').addEventListener('click', () => {
    Sfx.unlock();
    $('#gate-error').hidden = true;
    if (socket.connected) enter();
    else socket.connect();
  });

  socket.on('connect', enter);
  socket.on('state', apply);
  // Pen strokes from whoever is drawing.
  socket.on('draw', (data) => {
    const root = $('#stage-main .q.draw');
    const q = state && state.game && state.game.question;
    if (root && q && data.key === q.key) Views.forType('draw').stroke(root, data);
  });

  function enter() {
    if (!creds) return create();
    socket.emit('host:attach', { ...creds, role: 'screen' }, (res) => {
      if (res && res.ok) ready(res);
      else create(); // the server restarted, or the room timed out
    });
  }

  function create() {
    socket.emit('host:create', null, (res) => {
      if (!res || !res.ok) return fail((res && res.error) || 'Could not open a room.');
      knownPlayers = null;
      ready(res);
    });
  }

  function ready(res) {
    creds = { code: res.code, hostKey: res.hostKey };
    store.set(HOST_KEY, creds);
    info = res;
    $('#gate').classList.remove('on');
    drawJoin();
    apply(res.state);
  }

  function fail(message) {
    $('#gate').classList.add('on');
    $('#gate-error').textContent = message;
    $('#gate-error').hidden = false;
  }

  // ---------- Drawing ----------

  function drawJoin() {
    $('#join-qr').innerHTML = info.join.qrSvg; // SVG built by our own server
    $('#remote-qr').innerHTML = info.remote.qrSvg;
    $('#join-url').textContent = info.join.display;
    $('#code').replaceChildren(...info.code.split('').map((ch) => h('span', { class: 'patch' }, ch)));
  }

  const characterMap = () => new Map(state.characters.map((c) => [c.id, c]));

  function apply(next) {
    // Updates can arrive a beat before the room's join links do; ready() redraws.
    if (!next || !creds || !info || next.code !== creds.code) return;
    const previous = state;
    state = next;
    clock.sync(state.serverNow);

    document.title = `${state.title} (host)`;
    document.querySelectorAll('[data-title]').forEach((el) => (el.textContent = state.title));
    $('#gate-title').textContent = state.title;

    const ids = new Set(state.players.map((p) => p.id));
    const arrivals = knownPlayers ? state.players.filter((p) => !knownPlayers.has(p.id)) : [];
    const someoneLeft = knownPlayers ? [...knownPlayers].some((id) => !ids.has(id)) : false;
    knownPlayers = ids;

    if (arrivals.length) Sfx.join();
    else if (someoneLeft) Sfx.leave();
    playSounds(previous);

    const phase = state.phase;
    $('#lobby').classList.toggle('on', phase === 'lobby');
    $('#intro').classList.toggle('on', phase === 'intro');
    $('#stage').classList.toggle('on', phase !== 'lobby' && phase !== 'intro');

    if (phase === 'lobby') drawLobby(new Set(arrivals.map((p) => p.id)));
    else if (phase === 'intro') drawIntro();
    else drawStage();
    if (phase === 'lobby' || phase === 'intro') viewKey = '';
    drawControls();
    syncSound();
  }

  // What every view needs to draw players and maps.
  const viewContext = () => ({ state, characters: characterMap(), mapData });

  const teamTotals = () =>
    state.teams
      ? state.teams.names.map((name, i) => ({
          name,
          color: state.teams.colors[i],
          score: state.players.filter((p) => p.team === i).reduce((sum, p) => sum + p.score, 0),
          players: state.players.filter((p) => p.team === i),
        }))
      : null;

  function playSounds(previous) {
    if (!previous) return;
    const was = previous.phase;
    const now = state.phase;
    if (was !== now) {
      if (now === 'intro') Sfx.start();
      else if (now === 'roundIntro') Sfx.round();
      else if (now === 'question') Sfx.question();
      else if (now === 'locked') state.game.lockReason === 'time' ? Sfx.timeUp() : Sfx.allIn();
      else if (now === 'reveal') Sfx.reveal();
      else if (now === 'scores') Sfx.scores();
      else if (now === 'final') Sfx.final();
      return;
    }
    if (now !== 'question' || !previous.game || !previous.game.question) return;
    const before = previous.game.question;
    const q = state.game.question;
    if (before.stage !== q.stage) Sfx.round(); // bluff: writing is over, time to vote
    else if (state.game.answered.length > previous.game.answered.length) Sfx.lockIn();
    else if (q.misses && before.misses && q.misses.length !== before.misses.length) Sfx.miss();
  }

  function drawLobby(arrivalIds) {
    const byCharacter = new Map(state.players.map((p) => [p.characterId, p]));
    const seated = state.players.length;
    const total = state.characters.length;

    $('#count').textContent = state.teams
      ? `${state.teams.names[0]} vs ${state.teams.names[1]}`
      : seated === 0
        ? `${total} seats open`
        : `${seated} of ${total} seated`;

    const hint = $('#hint');
    hint.classList.toggle('warn', Boolean(info.join.lanMissing));
    if (info.join.lanMissing) {
      hint.textContent = "This laptop isn't on Wi-Fi, so phones can't reach it yet.";
    } else if (seated === 0) {
      hint.textContent = info.join.local ? 'Phones need to be on the same Wi-Fi as this laptop.' : '';
    } else {
      hint.textContent = 'Host: press Enter when everyone has a seat.';
    }

    $('#seats').replaceChildren(
      ...state.characters.map((character) => {
        const player = byCharacter.get(character.id);
        const classes = ['seat'];
        if (!player) classes.push('open');
        else if (!player.connected) classes.push('away');
        if (player && arrivalIds.has(player.id)) classes.push('landing');
        return h(
          'li',
          { class: classes.join(' ') },
          plate(character),
          teamCard(player),
          player && !player.connected ? h('span', { class: 'away-tag' }, 'Away') : null
        );
      })
    );
  }

  function teamTag(player) {
    const tag = h('span', { class: 'team-tag' }, state.teams.names[player.team]);
    tag.style.setProperty('--team', state.teams.colors[player.team]);
    return tag;
  }

  // A name card, edged in the player's team color when teams are on.
  function teamCard(player, cls = 'place-card') {
    const card = h('span', { class: cls }, player ? player.name : 'Open seat');
    if (player && state.teams) {
      card.classList.add('teamed');
      card.style.setProperty('--team', state.teams.colors[player.team]);
    }
    return card;
  }

  function drawIntro() {
    const characters = characterMap();
    $('#lineup').replaceChildren(
      ...state.players.map((player) => {
        const character = characters.get(player.characterId);
        return h(
          'li',
          null,
          plate(character),
          h('span', { class: 'who' }, player.name),
          state.teams ? teamTag(player) : null,
          character && character.catchphrase ? h('span', { class: 'says' }, `“${character.catchphrase}”`) : null
        );
      })
    );
  }

  // ---------- The stage: everything from round one to the winner ----------

  function drawStage() {
    const g = state.game;
    const phase = state.phase;
    if (!g) return;
    $('#stage').dataset.phase = phase;

    const round = g.round;
    $('#round-name').textContent = phase === 'final' ? state.title : round ? round.title : '';
    $('#progress').textContent =
      phase === 'final'
        ? 'Final scores'
        : g.question
          ? `Question ${g.question.number} of ${round.questionCount}`
          : round
            ? `Round ${round.number} of ${round.count}`
            : '';

    // Question, locked and reveal share one view, so the answer tiles stay
    // put and only change state.
    const key =
      phase === 'roundIntro'
        ? `intro:${round.number}`
        : g.question
          ? `q:${g.question.key}`
          : phase === 'scores'
            ? `scores:${round.number}`
            : phase;

    if (key !== viewKey) {
      viewKey = key;
      lastTick = null;
      const main = $('#stage-main');
      if (phase === 'roundIntro') main.replaceChildren(buildRoundIntro(round));
      else if (g.question) {
        const view = Views.forType(g.question.type);
        const root = view.build(g.question, viewContext());
        main.replaceChildren(root);
        if (view.sync) {
          // Joining mid-drawing (a refresh): fetch what's been drawn so far.
          socket.emit('draw:sync', null, (res) => {
            if (res && res.key === g.question.key && root.isConnected) view.sync(root, res.strokes);
          });
        }
      } else if (phase === 'scores') main.replaceChildren(buildScores(round, g.roundPoints || {}));
      else if (phase === 'final') main.replaceChildren(...buildFinal());
    }

    const root = $('#stage-main .q');
    if (g.question && root) Views.forType(g.question.type).update(root, g, viewContext());
    drawTeamBar();
    drawStrip(g);
    $('#paused').hidden = !g.paused;
  }

  // Team totals in the middle of the header, when teams are on.
  function drawTeamBar() {
    const bar = $('#team-bar');
    const teams = teamTotals();
    bar.hidden = !teams || state.phase === 'scores' || state.phase === 'final';
    if (!teams) return;
    bar.replaceChildren(
      ...teams.map((team) => {
        const chip = h('span', { class: 'team-chip' }, h('b', null, team.name), points(team.score));
        chip.style.setProperty('--team', team.color);
        return chip;
      })
    );
  }

  function buildRoundIntro(round) {
    const count = round.questionCount;
    return h(
      'div',
      { class: 'round-card' },
      round.icon ? h('p', { class: 'round-icon', 'aria-hidden': 'true' }, round.icon) : null,
      h('p', { class: 'round-num' }, `Round ${round.number} of ${round.count}`),
      h('h2', { class: 'round-title' }, round.title),
      round.tagline ? h('p', { class: 'round-tag' }, round.tagline) : null,
      h('p', { class: 'round-count' }, `${count} question${count === 1 ? '' : 's'}`)
    );
  }

  // The players along the bottom: who has answered, and what they just won.
  function drawStrip(g) {
    const characters = characterMap();
    const answered = new Set(g.answered);
    const phase = state.phase;
    $('#strip').replaceChildren(
      ...state.players.map((player) => {
        const gain = phase === 'reveal' && g.reveal ? g.reveal.gains[player.id] : 0;
        const showCheck = (phase === 'question' || phase === 'locked') && answered.has(player.id);
        return h(
          'li',
          { class: `strip-seat${player.connected ? '' : ' away'}` },
          plate(characters.get(player.characterId)),
          h(
            'div',
            { class: 'strip-who' },
            teamCard(player, 'strip-name'),
            h('span', { class: 'strip-score' }, points(player.score))
          ),
          showCheck ? h('span', { class: 'badge' }, '✓') : null,
          g.question && g.question.artistId === player.id && phase !== 'reveal' ? h('span', { class: 'badge pen' }, '✏️') : null,
          gain ? h('span', { class: 'gain' }, `+${points(gain)}`) : null
        );
      })
    );
  }

  function buildScores(round, roundPoints) {
    const characters = characterMap();
    const list = ranked(state.players);
    const top = Math.max(1, ...list.map((p) => p.score));
    const teams = teamTotals();
    const teamBlock = teams
      ? h(
          'div',
          { class: 'team-board' },
          ...teams.map((team) => {
            const card = h(
              'div',
              { class: `team-card${team.score === Math.max(...teams.map((t) => t.score)) ? ' ahead' : ''}` },
              h('span', { class: 'team-name' }, team.name),
              h('span', { class: 'team-score' }, points(team.score)),
              h('span', { class: 'team-plates' }, ...team.players.map((p) => plate(characters.get(p.characterId))))
            );
            card.style.setProperty('--team', team.color);
            return card;
          })
        )
      : null;
    return h(
      'div',
      { class: teams ? 'with-teams' : '' },
      h('h2', { class: 'board-title' }, `Scores after ${round.title}`),
      teamBlock,
      h(
        'ol',
        { class: 'board' },
        ...list.map((player) => {
          const character = characters.get(player.characterId);
          const bar = h('span', { class: 'bar' }, h('i'));
          bar.style.setProperty('--w', `${Math.max(3, (Math.max(0, player.score) / top) * 100)}%`);
          bar.style.setProperty('--c', character ? character.color : '#a6b0b5');
          const earned = roundPoints[player.id] || 0;
          return h(
            'li',
            null,
            h('span', { class: 'rank' }, player.rank),
            plate(character),
            h('span', { class: 'who' }, player.name),
            bar,
            h(
              'span',
              { class: 'total' },
              points(player.score),
              h('span', { class: 'plus' }, earned ? `+${points(earned)} this round` : 'No points this round')
            )
          );
        })
      )
    );
  }

  function buildFinal() {
    const characters = characterMap();
    const list = ranked(state.players);
    const winners = list.filter((p) => p.rank === 1);
    const rest = list.filter((p) => p.rank > 1);
    const names = winners.map((p) => p.name);
    const teams = teamTotals();
    if (teams) return buildTeamFinal(teams, list, characters);
    const headline =
      winners.length === 0
        ? 'Game over'
        : winners.length === 1
          ? `${names[0]} wins!`
          : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} tie for the win!`;
    const first = winners[0] && characters.get(winners[0].characterId);

    const confetti = h(
      'div',
      { class: 'confetti', 'aria-hidden': 'true' },
      ...Array.from({ length: 70 }, (_, i) => {
        const piece = h('i');
        piece.style.setProperty('--x', `${Math.random() * 100}%`);
        piece.style.setProperty('--c', CONFETTI[i % CONFETTI.length]);
        piece.style.setProperty('--d', `${3 + Math.random() * 3}s`);
        piece.style.setProperty('--delay', `${-Math.random() * 6}s`);
        return piece;
      })
    );

    const body = h(
      'div',
      { class: 'final' },
      h(
        'div',
        { class: 'winners' },
        ...winners.map((p) => {
          const el = plate(characters.get(p.characterId));
          el.classList.add('big');
          return el;
        })
      ),
      h('h2', null, headline),
      winners.length
        ? h(
            'p',
            { class: 'line' },
            `${points(winners[0].score)} points`,
            winners.length === 1 && first && first.catchphrase ? `. “${first.catchphrase}”` : ''
          )
        : null,
      rest.length
        ? h(
            'ol',
            { class: 'also' },
            ...rest.map((p) =>
              h(
                'li',
                null,
                plate(characters.get(p.characterId)),
                h('span', null, `${Gobble.ordinal(p.rank)}: ${p.name}`, h('small', null, `${points(p.score)} points`))
              )
            )
          )
        : null
    );
    return [confetti, body];
  }

  function makeConfetti() {
    return h(
      'div',
      { class: 'confetti', 'aria-hidden': 'true' },
      ...Array.from({ length: 70 }, (_, i) => {
        const piece = h('i');
        piece.style.setProperty('--x', `${Math.random() * 100}%`);
        piece.style.setProperty('--c', CONFETTI[i % CONFETTI.length]);
        piece.style.setProperty('--d', `${3 + Math.random() * 3}s`);
        piece.style.setProperty('--delay', `${-Math.random() * 6}s`);
        return piece;
      })
    );
  }

  // With teams on, the winning team takes the bow and the top scorer gets a nod.
  function buildTeamFinal(teams, list, characters) {
    const best = Math.max(...teams.map((t) => t.score));
    const winners = teams.filter((t) => t.score === best);
    const tie = winners.length > 1;
    const shown = tie ? teams : winners;
    const mvp = list[0];
    const other = teams.find((t) => t.score !== best);
    const body = h(
      'div',
      { class: 'final' },
      h(
        'div',
        { class: 'winners' },
        ...shown.flatMap((t) => t.players).map((p) => {
          const el = plate(characters.get(p.characterId));
          el.classList.add('big', 'team-size');
          return el;
        })
      ),
      h('h2', null, tie ? "It's a tie!" : `${winners[0].name} wins!`),
      h(
        'p',
        { class: 'line' },
        tie ? `${points(best)} points each` : `${points(best)} to ${points(other ? other.score : 0)}`
      ),
      mvp ? h('p', { class: 'line mvp' }, `Top scorer: ${mvp.name} with ${points(mvp.score)} points`) : null
    );
    return [makeConfetti(), body];
  }

  // ---------- Clock: the pie timer, the top bar and the last-seconds tick ----------

  function frame() {
    requestAnimationFrame(frame);
    const g = state && state.game;
    const bar = $('#autobar');
    if (!g || !g.timer) {
      bar.style.width = '0';
      return;
    }
    const left = clock.left(g);
    const share = Math.max(0, Math.min(1, left / g.timer.totalMs));
    const root = g.question && $('#stage-main .q');
    const view = root && Views.forType(g.question.type);
    if (view && view.frame) view.frame(root, state.phase === 'question' ? share : 0, viewContext());

    if (state.phase === 'question') {
      bar.style.width = '0';
      const seconds = Math.ceil(left / 1000);
      const pie = $('#pie');
      pie.style.setProperty('--p', (share * 100).toFixed(1));
      pie.classList.toggle('hurry', seconds <= 5);
      $('#pie-num').textContent = seconds;
      if (!g.paused && seconds <= 5 && seconds > 0 && seconds !== lastTick) {
        lastTick = seconds;
        Sfx.tick();
      }
    } else {
      // Other screens only show a thin line, so the host can see it will move on.
      bar.style.width = state.phase === 'locked' ? '0' : `${share * 100}%`;
    }
  }
  requestAnimationFrame(frame);

  // ---------- Song clips and the lobby soundtrack ----------

  const clip = new Audio();
  const music = new Audio();
  music.loop = true;
  clip.preload = 'auto';

  function play(audio) {
    const attempt = audio.play();
    if (attempt && attempt.catch) attempt.catch(() => {}); // blocked or missing file: stay silent
  }

  function syncSound() {
    const g = state.game;
    const phase = state.phase;
    const q = g && g.question;
    clip.muted = muted;
    music.muted = muted;

    // The question's clip plays from the start of the question to the end of the reveal.
    const wantClip = q && q.audio && ['question', 'locked', 'reveal'].includes(phase) ? q.key : '';
    if (wantClip !== clipKey) {
      clipKey = wantClip;
      clip.pause();
      if (wantClip) {
        clip.src = q.audio;
        clip.currentTime = 0;
      }
    }
    if (clipKey) {
      clip.volume = phase === 'locked' ? 0.35 : 1;
      if (g.paused) clip.pause();
      else if (clip.paused) play(clip);
    }

    // The soundtrack plays in the lobby, while players are introduced, and for the winner.
    const wantMusic = state.music && ['lobby', 'intro', 'final'].includes(phase);
    if (wantMusic) {
      if (!music.src.endsWith(state.music.url)) music.src = state.music.url;
      music.volume = state.music.volume;
      if (music.paused) play(music);
    } else if (!music.paused) {
      music.pause();
    }
  }

  function toggleMute() {
    muted = !muted;
    store.set('gobble.muted', muted);
    Sfx.mute(muted);
    if (state) {
      syncSound();
      drawControls();
    }
  }
  Sfx.mute(muted);

  // ---------- Host controls ----------

  const act = (action) => socket.emit('host:action', action);

  function drawControls() {
    const phase = state.phase;
    const main = $('#btn-phase');
    main.textContent = phase === 'lobby' ? 'Start game' : phase === 'final' ? 'Back to lobby' : 'Next';
    main.disabled = phase === 'lobby' && state.players.length === 0;

    const pause = $('#btn-pause');
    const inGame = Boolean(state.game) && phase !== 'final' && phase !== 'intro';
    pause.hidden = !inGame;
    pause.textContent = state.game && state.game.paused ? 'Resume' : 'Pause';
    $('#btn-new').hidden = phase !== 'lobby';
    $('#btn-mute').textContent = muted ? 'Sound on' : 'Mute';
  }

  // Start, Next, or Back to lobby, depending on where we are.
  function mainAction() {
    if (!state) return;
    if (state.phase === 'lobby') {
      if (state.players.length) act({ type: 'start' });
    } else if (state.phase === 'final') {
      act({ type: 'lobby' });
    } else {
      act({ type: 'next' });
    }
  }

  function togglePause() {
    if (!state || !state.game) return;
    act({ type: state.game.paused ? 'resume' : 'pause' });
  }

  function showRemote(show) {
    $('#remote-overlay').hidden = !show;
  }

  function toggleFullScreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  }

  function newRoom() {
    if (!state) return;
    if (!window.confirm('Close this room and open a new one? Everyone will need to join again.')) return;
    socket.emit('host:action', { type: 'close' }, () => {
      store.del(HOST_KEY);
      creds = null;
      state = null;
      info = null;
      create();
    });
  }

  $('#btn-phase').addEventListener('click', mainAction);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-mute').addEventListener('click', toggleMute);
  $('#btn-remote').addEventListener('click', () => showRemote(true));
  $('#remote-close').addEventListener('click', () => showRemote(false));
  $('#btn-full').addEventListener('click', toggleFullScreen);
  $('#btn-new').addEventListener('click', newRoom);

  document.addEventListener('keydown', (event) => {
    if (!state || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.target.closest('button, input')) return;
    const overlayOpen = !$('#remote-overlay').hidden;
    const key = event.key.toLowerCase();
    if (key === 'escape') showRemote(false);
    else if (overlayOpen) return;
    else if (key === 'enter' || key === 'arrowright') {
      // Enter never ends the game by accident from the winner screen.
      if (state.phase !== 'final') mainAction();
    } else if (key === 'p' || key === ' ') {
      event.preventDefault();
      togglePause();
    } else if (key === 'm') toggleMute();
    else if (key === 'f') toggleFullScreen();
    else if (key === 'r') showRemote(true);
  });

  // Free hosting puts a quiet server to sleep, which would close the room.
  // A small request every few minutes keeps it awake while this screen is open.
  setInterval(() => fetch('/health').catch(() => {}), 4 * 60 * 1000);

  // Controls stay out of the way until the mouse moves.
  let hideTimer = null;
  document.addEventListener('mousemove', () => {
    document.body.classList.add('show-controls');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.body.classList.remove('show-controls'), 3000);
  });
})();
