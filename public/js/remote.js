// The host's phone. It runs the game: start, next, pause, skip, scores.
// It is also the only screen that gets told the answer early.
(() => {
  const { $, h, plate, store, makeClock, points } = Gobble;
  const REMOTE_KEY = 'gobble.remote';

  // The link looks like /remote#CODE.hostKey. Keep it so a refresh still works,
  // then clear it from the address bar.
  const fromHash = location.hash.slice(1).match(/^([A-Z]{4})\.([\w-]+)$/);
  let creds = fromHash ? { code: fromHash[1], hostKey: fromHash[2] } : store.get(REMOTE_KEY);
  if (fromHash) {
    store.set(REMOTE_KEY, creds);
    history.replaceState(null, '', '/remote');
  }

  // Scanning a fresh remote code while this page is open only changes the
  // #fragment, which doesn't reload the page on its own.
  window.addEventListener('hashchange', () => location.reload());

  let state = null;
  let answer = ''; // the current question's answer, sent only to this remote
  let catalogKey = ''; // which round list is drawn
  const chosen = new Map(); // round id -> ticked or not
  const clock = makeClock();

  if (!creds) {
    $('#view-expired').hidden = false;
    return;
  }

  const socket = io();

  socket.on('connect', () => {
    $('#banner').hidden = true;
    socket.emit('host:attach', { ...creds, role: 'remote' }, (res) => {
      if (!res || !res.ok) return expire();
      apply(res.state);
    });
  });
  socket.on('disconnect', () => {
    $('#banner').hidden = false;
  });
  socket.on('state', apply);
  socket.on('peek', (peek) => {
    answer = (peek && peek.answer) || '';
    drawStatus();
  });
  socket.on('closed', expire);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
  });

  function expire() {
    store.del(REMOTE_KEY);
    state = null;
    $('#room-label').textContent = '';
    $('#view-remote').hidden = true;
    $('#view-expired').hidden = false;
  }

  function note(message) {
    const el = $('#remote-note');
    el.textContent = message || '';
    el.hidden = !message;
  }

  // Send a host action. Problems come back as a message at the top.
  function act(action) {
    socket.emit('host:action', action, (res) => note(res && !res.ok ? res.error : ''));
  }

  function apply(next) {
    if (!next || next.code !== creds.code) return;
    state = next;
    clock.sync(state.serverNow);
    $('#view-expired').hidden = true;
    $('#view-remote').hidden = false;
    $('#room-label').textContent = `Room ${state.code}`;

    const inLobby = state.phase === 'lobby';
    $('#lobby-panel').hidden = !inLobby;
    $('#game-panel').hidden = inLobby;
    if (inLobby) drawLobby();
    else drawGame();
    drawRoster();
  }

  // ---------- Lobby: pick rounds, start ----------

  function drawLobby() {
    const count = state.players.length;
    $('#lobby-help').textContent = `${count} of ${state.characters.length} seats taken. Start when everyone is in.`;

    const catalog = state.catalog || { rounds: [], pending: [], warnings: [] };
    const key = JSON.stringify(catalog);
    if (key !== catalogKey) {
      catalogKey = key;
      for (const round of catalog.rounds) {
        if (!chosen.has(round.id)) chosen.set(round.id, !round.bonus);
      }
      $('#rounds').replaceChildren(
        ...catalog.rounds.map((round) => {
          const box = h('input', { type: 'checkbox' });
          box.checked = chosen.get(round.id);
          box.addEventListener('change', () => {
            chosen.set(round.id, box.checked);
            drawStart();
          });
          return h(
            'li',
            null,
            h(
              'label',
              null,
              box,
              h(
                'span',
                null,
                `${round.icon ? `${round.icon} ` : ''}${round.title}`,
                h('small', null, roundDetail(round))
              )
            )
          );
        })
      );
      const lines = [];
      if (catalog.rounds.length === 0) lines.push('No question files found in content/questions yet.');
      if (catalog.pending.length) lines.push(`Not written yet: ${catalog.pending.join(', ')}.`);
      lines.push(...catalog.warnings);
      const fine = $('#rounds-fine');
      fine.replaceChildren(...lines.map((line) => h('span', { style: 'display:block' }, line)));
      fine.hidden = lines.length === 0;
    }
    $('#teams-toggle').checked = Boolean(state.teams);
    $('#teams-help').textContent = state.teams
      ? `${state.teams.names[0]} vs ${state.teams.names[1]}. Use "Switch team" below to move someone.`
      : 'Points still count per player and add up for each team.';
    $('#pick-toggle').checked = Boolean(state.pickGames);
    $('#pick-help').textContent = state.pickGames
      ? 'Before every game, everyone votes on their phone from the rounds ticked above.'
      : 'The ticked rounds are played once each, in order.';
    $('#rounds-heading').textContent = state.pickGames ? 'Games on the menu' : 'Rounds to play';
    drawStart();
  }

  function roundDetail(round) {
    const parts = [`${round.questionCount} ${round.type === 'draw' ? 'words' : 'questions'}`];
    if (round.bonus) parts.push('bonus round');
    if (round.missingMedia) parts.push(`${round.missingMedia} missing a picture`);
    if (round.held) parts.push(`${round.held} waiting for your fact check`);
    return parts.join(', ');
  }

  const pickedRounds = () =>
    ((state.catalog && state.catalog.rounds) || []).filter((r) => chosen.get(r.id)).map((r) => r.id);

  function drawStart() {
    const button = $('#start-button');
    const rounds = pickedRounds().length;
    button.disabled = state.players.length === 0 || rounds === 0;
    button.textContent =
      rounds > 1 ? `Start game (${rounds} ${state.pickGames ? 'games on the menu' : 'rounds'})` : 'Start game';
  }

  $('#start-button').addEventListener('click', () => {
    const button = $('#start-button');
    button.disabled = true;
    button.textContent = 'Getting things ready…';
    socket.emit('host:action', { type: 'start', roundIds: pickedRounds() }, (res) => {
      note(res && !res.ok ? res.error : '');
      if (state && state.phase === 'lobby') drawStart();
    });
  });
  $('#reload-button').addEventListener('click', () => act({ type: 'reload' }));
  $('#teams-toggle').addEventListener('change', (event) => act({ type: 'teams', on: event.target.checked }));
  $('#pick-toggle').addEventListener('change', (event) => act({ type: 'pickGames', on: event.target.checked }));

  // ---------- Game: status and controls ----------

  const NEXT_LABEL = {
    intro: 'Start the first round',
    roundIntro: 'Show the first question',
    question: 'Close answers now',
    locked: 'Reveal the answer',
    final: 'Back to lobby',
  };

  function drawGame() {
    const g = state.game;
    const phase = state.phase;
    const round = g && g.round;

    let label = NEXT_LABEL[phase] || 'Next';
    if (phase === 'reveal' && g.question) {
      label = g.question.number < round.questionCount ? 'Next question' : 'Show the scores';
    } else if (phase === 'scores') {
      label = g.pick ? 'Back to the game menu' : round.number < round.count ? 'Next round' : 'Show the winner';
    } else if (phase === 'intro' && g.pick) {
      label = 'Show the game menu';
    } else if (phase === 'menu') {
      label = g.menu && g.menu.chosenId ? 'Start it now' : g.answered.length ? 'Go with the votes so far' : 'Surprise us';
    }
    drawMenuPicks(g, phase);
    const next = $('#next-button');
    next.textContent = label;
    next.classList.toggle('quiet', phase === 'final');

    const running = phase !== 'final' && phase !== 'intro' && phase !== 'menu';
    $('#pad').hidden = phase === 'final';
    $('#pause-button').disabled = !running;
    $('#pause-button').textContent = g && g.paused ? 'Resume' : 'Pause';
    $('#skip-question').disabled = !['question', 'locked', 'reveal'].includes(phase);
    $('#skip-round').disabled = !running;
    $('#end-game').textContent = g && g.pick ? 'End game, show the winner' : 'End game';
    drawStatus();
  }

  // While the menu is up, the host can pick a game directly.
  let menuKey = '';
  function drawMenuPicks(g, phase) {
    const open = phase === 'menu' && g.menu && !g.menu.chosenId;
    $('#menu-picks').hidden = !open;
    const key = open ? JSON.stringify([g.menu.options, g.menu.votes]) : '';
    if (key === menuKey) return;
    menuKey = key;
    if (!open) return;
    const tally = {};
    for (const id of Object.values(g.menu.votes)) tally[id] = (tally[id] || 0) + 1;
    $('#menu-pick-list').replaceChildren(
      ...g.menu.options.map((option) =>
        h(
          'button',
          { type: 'button', onclick: () => act({ type: 'pickRound', roundId: option.id }) },
          `${option.icon ? `${option.icon} ` : ''}${option.title}`,
          h('small', null, `${tally[option.id] || 0} vote${tally[option.id] === 1 ? '' : 's'}${option.played ? ', played' : ''}`)
        )
      )
    );
  }

  function drawStatus() {
    if (!state || !state.game) return;
    const g = state.game;
    const phase = state.phase;
    const round = g.round;

    let line = '';
    if (phase === 'intro') line = 'Meeting the players';
    else if (phase === 'final') line = 'Winner screen';
    else if (phase === 'menu') {
      const picked = g.menu && g.menu.options.find((o) => o.id === g.menu.chosenId);
      line = picked ? `Next up: ${picked.title}` : 'Game menu: players are voting';
    } else if (phase === 'roundIntro') line = `${round.count ? `Round ${round.number} of ${round.count}` : `Game ${round.number}`}: ${round.title}`;
    else if (phase === 'scores') line = `Scores after ${round.title}`;
    else if (g.question) line = `${round.title}, question ${g.question.number} of ${round.questionCount}`;
    $('#status-line').textContent = line;

    const parts = [];
    if (g.paused) parts.push('Paused.');
    if (phase === 'question') parts.push(`${g.answered.length} of ${state.players.length} answered.`);
    if (phase === 'menu' && !(g.menu && g.menu.chosenId)) parts.push(`${g.answered.length} of ${state.players.length} voted.`);
    if (phase === 'locked') parts.push('Answers are closed.');
    if (phase === 'reveal') parts.push('Showing the answer. Use Mark right or Mark wrong below to overrule it.');
    if (phase === 'roundIntro' && round && round.howTo && round.howTo.length) parts.push('Instructions are on the TV.');
    const left = clock.left(g);
    if (left != null && phase !== 'locked') {
      const seconds = Math.ceil(left / 1000);
      parts.push(phase === 'question' ? `${seconds}s left.` : `Moves on in ${seconds}s.`);
    } else if (!g.timer && !['intro', 'final', 'question', 'locked', 'menu'].includes(phase)) {
      parts.push('Waiting for you to press the button.');
    }
    $('#status-sub').textContent = parts.join(' ');

    const answerEl = $('#status-answer');
    answerEl.hidden = !answer;
    answerEl.textContent = answer ? `Answer (only you can see this): ${answer}` : '';
  }
  setInterval(drawStatus, 250);

  $('#next-button').addEventListener('click', () => {
    if (!state) return;
    act({ type: state.phase === 'final' ? 'lobby' : 'next' });
  });
  $('#pause-button').addEventListener('click', () => {
    if (state && state.game) act({ type: state.game.paused ? 'resume' : 'pause' });
  });
  $('#skip-question').addEventListener('click', () => act({ type: 'skipQuestion' }));
  $('#skip-round').addEventListener('click', () => {
    if (window.confirm('Skip the rest of this round?')) act({ type: 'skipRound' });
  });
  $('#end-game').addEventListener('click', () => {
    if (window.confirm('End the game now and show the winner?')) act({ type: 'endGame' });
  });

  // ---------- Players: scores and removal ----------

  function drawRoster() {
    const step = state.settings.scoreAdjustStep;
    const characters = new Map(state.characters.map((c) => [c.id, c]));
    $('#roster-empty').hidden = state.players.length > 0;
    $('#roster').replaceChildren(
      ...state.players.map((player) =>
        h(
          'li',
          null,
          h(
            'div',
            { class: 'roster-top' },
            plate(characters.get(player.characterId)),
            h(
              'span',
              { class: 'roster-name' },
              player.name,
              h(
                'small',
                null,
                `${state.teams ? `${state.teams.names[player.team]}. ` : ''}${player.connected ? 'Connected' : 'Away, will rejoin'}`
              )
            ),
            h('span', { class: 'roster-score' }, points(player.score))
          ),
          h(
            'div',
            { class: 'roster-tools' },
            h(
              'button',
              {
                type: 'button',
                'aria-label': `Take ${step} points from ${player.name}`,
                onclick: () => act({ type: 'adjustScore', playerId: player.id, delta: -step }),
              },
              `− ${step}`
            ),
            h(
              'button',
              {
                type: 'button',
                'aria-label': `Give ${step} points to ${player.name}`,
                onclick: () => act({ type: 'adjustScore', playerId: player.id, delta: step }),
              },
              `+ ${step}`
            ),
            h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  const typed = window.prompt(`New name for ${player.name}`, player.name);
                  if (typed && typed.trim()) act({ type: 'renamePlayer', playerId: player.id, name: typed });
                },
              },
              'Rename'
            ),
            state.teams
              ? h('button', { type: 'button', onclick: () => act({ type: 'switchTeam', playerId: player.id }) }, 'Switch team')
              : null,
            state.phase === 'reveal'
              ? h('button', { type: 'button', onclick: () => act({ type: 'overrule', playerId: player.id, correct: true }) }, 'Mark right')
              : null,
            state.phase === 'reveal'
              ? h('button', { type: 'button', onclick: () => act({ type: 'overrule', playerId: player.id, correct: false }) }, 'Mark wrong')
              : null,
            h(
              'button',
              {
                class: 'remove',
                type: 'button',
                onclick: () => {
                  if (window.confirm(`Remove ${player.name}? Their seat and score will be cleared.`)) {
                    act({ type: 'removePlayer', playerId: player.id });
                  }
                },
              },
              'Remove'
            )
          )
        )
      )
    );
  }
})();
