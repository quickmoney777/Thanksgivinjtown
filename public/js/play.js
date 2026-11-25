// A player's phone. It keeps a seat token in the browser so that a phone
// that slept or refreshed gets the same seat and score back.
(() => {
  const { $, h, plate, store, cleanCode, ordinal, ranked, makeClock, points } = Gobble;
  const LAST_CODE = 'gobble.lastCode';
  const LAST_NAME = 'gobble.lastName';
  const seatKey = (code) => `gobble.seat.${code}`;
  const PEN_COLORS = ['#2b1810', '#bb0000', '#f28c28', '#4f7a4a', '#2e6f9e'];

  const socket = io();
  const params = new URLSearchParams(location.search);
  const clock = makeClock();

  let code = cleanCode(params.get('room')) || cleanCode(store.get(LAST_CODE));
  let seat = code ? store.get(seatKey(code)) : null; // { playerId, token }
  let state = null;
  let meId = null;
  let pick = null; // character chosen on the join form, before submitting
  let mine = null; // what only this player knows about the current question
  let gameKey = ''; // which game view is built, so taps aren't lost to redraws
  let feedback = ''; // a short message under the guess box in the drawing round
  let problem = ''; // why the last answer was refused, shown until the screen changes

  const views = ['code', 'join', 'lobby', 'game'];
  function show(name) {
    for (const v of views) $(`#view-${v}`).hidden = v !== name;
  }

  function note(id, message) {
    const el = $(id);
    el.textContent = message || '';
    el.hidden = !message;
  }

  // Maps for the pin-drop questions.
  const maps = { usa: null, world: null };
  for (const [kind, url] of [['usa', '/data/us-states.json'], ['world', '/data/world.json']]) {
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        maps[kind] = data;
        if (state && state.game && state.game.question && state.game.question.type === 'pin') {
          gameKey = '';
          render();
        }
      })
      .catch(() => {});
  }
  let myPin = null; // where this player has tapped, before locking it in

  // Show the game's name on the code screen, before we're in a room.
  fetch('/api/info')
    .then((res) => res.json())
    .then((data) => {
      if (data.title && !state) $('#game-title').textContent = data.title;
    })
    .catch(() => {});

  // ---------- Connection ----------

  socket.on('connect', () => {
    $('#banner').hidden = true;
    hello();
  });
  socket.on('disconnect', () => {
    $('#banner').hidden = false;
  });
  socket.on('state', apply);
  socket.on('mine', (data) => {
    mine = data;
    render();
  });
  socket.on('removed', () => leaveSeat('The host removed you from the game. Pick a seat to join again.'));
  socket.on('closed', () => leaveRoom('The host closed that room.'));

  // Phones pause the page when the screen locks. Reconnect as soon as it's back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!socket.connected) socket.connect();
    keepAwake();
  });

  function hello() {
    if (!code) return show('code');
    socket.emit('player:hello', { code, token: seat && seat.token }, (res) => {
      if (!res || !res.ok) return leaveRoom(`Room ${code} isn't open. Check the code on the TV.`);
      store.set(LAST_CODE, code);
      if (params.get('room') !== code) history.replaceState(null, '', `/?room=${code}`);
      meId = res.playerId;
      mine = res.mine || null;
      if (meId) keepAwake();
      if (!meId && seat) {
        // The seat is gone (removed while away). Start over in this room.
        store.del(seatKey(code));
        seat = null;
      }
      apply(res.state);
    });
  }

  function forget() {
    seat = null;
    meId = null;
    pick = null;
    mine = null;
    gameKey = '';
    feedback = '';
    problem = '';
  }

  function leaveSeat(message) {
    if (code) store.del(seatKey(code));
    forget();
    note('#join-note', message);
    render();
  }

  function leaveRoom(message) {
    if (code) store.del(seatKey(code));
    store.del(LAST_CODE);
    code = '';
    state = null;
    forget();
    history.replaceState(null, '', '/');
    $('#room-label').textContent = '';
    note('#code-note', message);
    show('code');
  }

  // ---------- Drawing the screens ----------

  function apply(next) {
    if (!next || next.code !== code) return;
    state = next;
    clock.sync(state.serverNow);
    render();
  }

  function render() {
    if (!state) return;
    document.title = state.title;
    $('#game-title').textContent = state.title;
    $('#room-label').textContent = `Room ${state.code}`;

    const me = state.players.find((p) => p.id === meId);
    if (state.phase === 'lobby') {
      // Between games: forget the last game's answer and screen.
      mine = null;
      gameKey = '';
      feedback = '';
    }
    if (!me) return renderJoin();
    if (state.phase === 'lobby') return renderLobby(me);
    renderGame(me);
  }

  const characterOf = (player) => state.characters.find((c) => c.id === player.characterId);
  const ownerOf = (character) => state.players.find((p) => p.characterId === character.id);
  const nameOf = (id) => (state.players.find((p) => p.id === id) || { name: 'Someone' }).name;

  function teamChip(me) {
    if (!state.teams) return null;
    const chip = h('span', { class: 'team-chip' }, state.teams.names[me.team]);
    chip.style.setProperty('--team', state.teams.colors[me.team]);
    return chip;
  }

  function renderJoin() {
    show('join');
    const nameInput = $('#name-input');
    nameInput.maxLength = state.settings.nameMaxLength;
    if (!nameInput.value && !nameInput.dataset.touched) nameInput.value = store.get(LAST_NAME) || '';

    if (pick && ownerOf({ id: pick })) {
      pick = null;
      note('#join-note', 'That character was just taken. Pick another.');
    }
    const full = state.players.length >= state.characters.length;

    // Seats whose phone has dropped off can be taken back with one tap.
    const away = state.players.filter((p) => !p.connected);
    $('#rejoin').hidden = away.length === 0;
    $('#rejoin-list').replaceChildren(
      ...away.map((player) =>
        h(
          'button',
          { class: 'pick', type: 'button', onclick: () => reclaim(player) },
          plate(characterOf(player)),
          h('span', null, h('span', { class: 'pick-name' }, `I'm ${player.name}`), h('span', { class: 'pick-sub' }, `${points(player.score)} points. Take this seat back.`))
        )
      )
    );
    if (full) note('#join-note', away.length ? 'Every seat is taken. Tap your name above to get back in.' : 'Every seat is taken. Ask the host to free one up.');

    drawPicker($('#join-picker'), {
      selected: pick,
      onPick(id) {
        pick = id;
        note('#join-note', '');
        renderJoin();
      },
    });
    updateJoinButton();
  }

  function reclaim(player) {
    if (!window.confirm(`Are you ${player.name}? This takes over ${player.name}'s seat and score.`)) return;
    socket.emit('player:reclaim', { playerId: player.id }, (res) => {
      if (!res || !res.ok) {
        if (res && res.error === 'no-room') return leaveRoom(`Room ${code} isn't open. Check the code on the TV.`);
        note('#join-note', (res && res.error) || 'Could not get that seat. Try again.');
        return undefined;
      }
      seat = { playerId: res.playerId, token: res.token };
      store.set(seatKey(code), seat);
      meId = res.playerId;
      mine = res.mine || null;
      pick = null;
      note('#join-note', '');
      keepAwake();
      return apply(res.state);
    });
  }

  // Change your name, from the lobby or the game menu.
  function rename() {
    const me = state && state.players.find((p) => p.id === meId);
    if (!me) return;
    const typed = window.prompt('Your name', me.name);
    if (typed == null || !typed.trim() || typed.trim() === me.name) return;
    socket.emit('player:rename', { name: typed }, (res) => {
      if (res && res.ok) {
        store.set(LAST_NAME, res.name);
        problem = '';
        note('#lobby-note', '');
      } else {
        const message = (res && res.error) || 'Could not change your name. Try again.';
        problem = message;
        note('#lobby-note', message);
        note('#game-note', message);
      }
    });
  }

  function updateJoinButton() {
    const full = state && state.players.length >= state.characters.length;
    $('#join-button').disabled = full || !pick || !$('#name-input').value.trim();
  }

  function renderLobby(me) {
    show('lobby');
    $('#lobby-me').replaceChildren(
      ...[plate(characterOf(me)), h('span', { class: 'me-name' }, me.name), teamChip(me)].filter(Boolean)
    );
    drawPicker($('#lobby-picker'), {
      selected: me.characterId,
      onPick(id) {
        if (id === me.characterId) return;
        socket.emit('player:character', { characterId: id }, (res) => {
          note('#lobby-note', res && res.ok ? '' : (res && res.error) || 'Could not switch. Try again.');
        });
      },
    });
  }

  function drawPicker(list, { selected, onPick }) {
    list.replaceChildren(
      ...state.characters.map((character) => {
        const owner = ownerOf(character);
        const taken = owner && owner.id !== meId;
        const button = h(
          'button',
          {
            class: 'pick',
            type: 'button',
            'aria-pressed': String(selected === character.id),
            disabled: Boolean(taken),
            onclick: () => onPick(character.id),
          },
          plate(character),
          h(
            'span',
            null,
            h('span', { class: 'pick-name' }, character.name),
            h('span', { class: 'pick-sub' }, taken ? `Taken by ${owner.name}` : character.catchphrase)
          )
        );
        button.style.setProperty('--c', character.color);
        return h('li', null, button);
      })
    );
  }

  // ---------- The game ----------

  function renderGame(me) {
    show('game');
    const g = state.game;
    const phase = state.phase;

    $('#me-bar').replaceChildren(
      ...[
        plate(characterOf(me)),
        h('span', { class: 'me-bar-name' }, me.name),
        teamChip(me),
        h('span', { class: 'me-bar-score' }, points(me.score)),
      ].filter(Boolean)
    );

    const q = g && g.question;
    const my = q && mine && mine.key === q.key ? mine : null;
    const waitingOnMe = phase === 'question' && q && needsInput(q, my);
    $('#timebar').hidden = !waitingOnMe;

    // One view per step. Rebuilding only when the step changes means a tap,
    // or half-typed text, can't be lost because someone else's answer
    // triggered a redraw.
    const menu = g && g.menu;
    const key = q
      ? `${phase}:${q.key}:${q.stage || ''}:${stepOf(q, my)}`
      : menu
        ? `menu:${g.rounds.length}:${menu.votes[me.id] || ''}:${menu.chosenId || ''}`
        : `${phase}:${g && g.round ? g.round.number : ''}`;
    if (key !== gameKey) problem = '';
    note('#game-note', g && g.paused ? 'The host paused the game.' : problem);
    if (key === gameKey) return;
    gameKey = key;
    $('#game-body').replaceChildren(...buildGame(me, g, phase, q, my).filter(Boolean));
  }

  // Is the game still waiting for this player to do something?
  function needsInput(q, my) {
    if (q.type === 'bluff') {
      const role = (my && my.role) || 'both';
      if (q.stage === 'write') return (role === 'both' || role === 'writer') && !(my && my.lie);
      return (role === 'both' || role === 'guesser') && !(my && my.voteId);
    }
    if (q.type === 'pin') return !(my && my.pin);
    if (q.type === 'number') return !(my && my.number != null);
    if (q.type === 'headsup') return Boolean(my && my.holder);
    if (q.type === 'draw' && q.aloud) return Boolean(my && (my.artist || my.onTeam) && !my.correct);
    if (q.type === 'draw') return !(my && (my.artist || my.correct));
    return !(my && my.choiceId);
  }

  // Where this player is within the question, for deciding when to redraw.
  function stepOf(q, my) {
    if (!my) return 'open';
    if (q.type === 'bluff') return `${my.role || ''}${my.lie ? 'L' : ''}${my.voteId ? 'V' : ''}${my.ownOptionId}${my.image ? 'P' : ''}`;
    if (q.type === 'pin') return my.pin ? 'pinned' : 'open';
    if (q.type === 'number') return my.number != null ? 'guessed' : 'open';
    if (q.type === 'headsup') return `${my.holder ? 'H' : 'C'}:${my.stage}:${my.index}`;
    if (q.type === 'draw' && q.aloud) return my.artist ? 'artist' : `${my.onTeam ? 'team' : 'other'}${my.correct ? ':got' : ''}`;
    if (q.type === 'draw') return my.artist ? 'artist' : my.correct ? 'got' : 'open';
    return my.choiceId ? 'done' : 'open';
  }

  function buildGame(me, g, phase, q, my) {
    if (phase === 'intro' || !g) {
      return [h('h1', null, 'Game on'), h('p', { class: 'lede' }, 'Eyes on the TV. Your buttons will show up here.')];
    }
    if (phase === 'menu' && g.menu) return buildMenu(me, g.menu);
    if (phase === 'roundIntro') {
      return [
        h('p', { class: 'kicker' }, g.round.count ? `Round ${g.round.number} of ${g.round.count}` : `Game ${g.round.number}`),
        h('h1', null, `${g.round.icon ? `${g.round.icon} ` : ''}${g.round.title}`),
        h('p', { class: 'lede' }, g.round.tagline || 'Get ready.'),
        g.round.sides && g.round.sides.of[me.id] != null
          ? h('p', { class: 'win' }, `You're on ${g.round.sides.names[g.round.sides.of[me.id]]}`)
          : null,
        g.round.howTo && g.round.howTo.length
          ? h('ol', { class: 'how-to' }, ...g.round.howTo.map((line) => h('li', null, line)))
          : null,
      ];
    }
    if (phase === 'scores' || phase === 'final') return buildStanding(me, g, phase);
    if (!q) return [h('p', { class: 'lede' }, 'Watch the TV.')];
    if (q.type === 'bluff') return buildBluff(me, g, phase, q, my);
    if (q.type === 'pin') return buildPin(me, g, phase, q, my);
    if (q.type === 'number') return buildNumber(me, g, phase, q, my);
    if (q.type === 'headsup') return buildHeadsUp(me, g, phase, q, my);
    if (q.type === 'draw') return buildDraw(me, g, phase, q, my);
    return buildChoice(me, g, phase, q, my);
  }

  // ----- The game menu: vote for what to play next -----

  function buildMenu(me, menu) {
    const chosen = menu.options.find((o) => o.id === menu.chosenId);
    if (chosen) {
      return [
        h('p', { class: 'kicker' }, 'Next up'),
        h('h1', null, `${chosen.icon ? `${chosen.icon} ` : ''}${chosen.title}`),
        h('p', { class: 'lede' }, chosen.tagline || 'Get ready.'),
      ];
    }
    const myVote = menu.votes[me.id];
    const buttons = menu.options.map((option) =>
      h(
        'button',
        {
          class: 'game-pick',
          type: 'button',
          'aria-pressed': String(myVote === option.id),
          onclick: () => send({ roundId: option.id }, buttons),
        },
        h('span', { class: 'game-pick-icon', 'aria-hidden': 'true' }, option.icon || '🎲'),
        h(
          'span',
          null,
          h('span', { class: 'game-pick-name' }, option.title),
          h('span', { class: 'game-pick-sub' }, option.played ? 'Played already. New questions.' : option.tagline || '')
        )
      )
    );
    return [
      h('h1', null, myVote ? 'Vote in' : 'Pick the next game'),
      h('p', { class: 'lede' }, myVote ? 'Tap another game to change your vote.' : 'Most votes wins.'),
      h('div', { class: 'game-picks' }, ...buttons),
      h('button', { class: 'link-button', type: 'button', onclick: rename }, 'Change my name'),
    ];
  }

  function gainLine(me, g) {
    const gain = (g.reveal && g.reveal.gains[me.id]) || 0;
    return gain ? h('p', { class: 'win' }, `+${points(gain)} points`) : null;
  }

  // ----- Multiple choice (all four kinds) -----

  function buildChoice(me, g, phase, q, my) {
    const answered = Boolean(my && my.choiceId);
    if (phase === 'question' && !answered) {
      const buttons = q.choices.map((choice, i) =>
        h(
          'button',
          { class: `answer tone-${i}`, type: 'button', onclick: () => send({ choiceId: choice.id }, buttons) },
          h('span', { class: 'answer-letter' }, choice.id),
          h('span', { class: 'answer-text' }, choice.text)
        )
      );
      return [h('p', { class: 'ask' }, q.text), h('div', { class: 'answers' }, ...buttons)];
    }
    if (phase === 'question' || phase === 'locked') {
      const choice = answered && q.choices.find((c) => c.id === my.choiceId);
      if (!choice) return [h('h1', null, "Time's up"), h('p', { class: 'lede' }, 'No answer from you this time. Watch the TV.')];
      return [
        h('h1', null, 'Locked in'),
        h('p', { class: 'lede' }, phase === 'locked' ? 'Answers are in. Watch the TV.' : 'Waiting for everyone else.'),
        answerCard(q.choices, choice),
      ];
    }
    if (!g.reveal) return [];
    const correct = q.choices.find((c) => c.id === g.reveal.correctId);
    if (g.reveal.gains[me.id]) {
      return [h('h1', { class: 'good' }, 'Correct!'), gainLine(me, g), answerCard(q.choices, correct)];
    }
    return [
      h('h1', null, answered ? 'Not this time' : 'No answer'),
      h('p', { class: 'lede' }, 'The answer was:'),
      answerCard(q.choices, correct),
    ];
  }

  function answerCard(list, item) {
    return h(
      'div',
      { class: `answer shown tone-${list.indexOf(item) % 6}` },
      h('span', { class: 'answer-letter' }, item.id),
      h('span', { class: 'answer-text' }, item.text)
    );
  }

  // Send an answer. Buttons are frozen while it's on its way.
  function send(payload, controls, onDone) {
    if (!socket.connected) {
      // Mid-reconnect: don't send into the void, and say why nothing happened.
      problem = 'Reconnecting. Try again in a second.';
      note('#game-note', problem);
      return;
    }
    controls.forEach((c) => (c.disabled = true));
    // If no reply comes back (a phone waking from sleep), free the buttons again.
    socket.timeout(5000).emit('player:answer', payload, (err, res) => {
      controls.forEach((c) => (c.disabled = false));
      if (err) {
        problem = 'That did not go through. Try again.';
        note('#game-note', problem);
        if (!socket.connected) socket.connect();
        return;
      }
      if (res && res.ok) {
        mine = res.mine || mine;
        problem = '';
      } else {
        problem = (res && res.error) || 'That did not go through. Try again.';
      }
      if (onDone) onDone(res || {});
      render();
    });
  }

  // ----- Closest Guess -----

  function buildNumber(me, g, phase, q, my) {
    const sent = my && my.number != null;
    const show = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: Boolean(q.unit) });
    if (phase === 'question' && !sent) {
      const input = h('input', { type: 'text', id: 'number-input', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'send', maxlength: 14 });
      const button = h('button', { class: 'action', type: 'submit' }, 'Lock in my guess');
      const form = h(
        'form',
        {
          onsubmit: (event) => {
            event.preventDefault();
            const value = input.value.replace(/[, ]/g, '');
            if (value === '' || !Number.isFinite(Number(value))) {
              problem = 'Type a number first.';
              note('#game-note', problem);
              return;
            }
            send({ number: Number(value) }, [button]);
          },
        },
        h('label', { for: 'number-input' }, q.unit ? `Your guess, in ${q.unit}` : 'Your guess'),
        input,
        button
      );
      return [h('p', { class: 'ask' }, q.text), h('p', { class: 'lede' }, 'No choices. The closest guess wins.'), form];
    }
    if (phase === 'question' || phase === 'locked') {
      if (!sent) return [h('h1', null, "Time's up"), h('p', { class: 'lede' }, 'No guess from you this time. Watch the TV.')];
      return [h('h1', null, 'Guess in'), h('p', { class: 'quote' }, show(my.number)), h('p', { class: 'lede' }, 'Watch the TV.')];
    }
    if (!g.reveal) return [];
    const mine = g.reveal.guesses.find((guess) => guess.playerId === me.id);
    return [
      h('h1', { class: g.reveal.gains[me.id] ? 'good' : '' }, g.reveal.gains[me.id] ? 'Close enough!' : 'Not the closest'),
      h('p', { class: 'lede' }, `The answer was ${show(g.reveal.number)}${g.reveal.unit ? ` ${g.reveal.unit}` : ''}.${mine ? ` You were off by ${show(mine.off)}.` : ''}`),
      gainLine(me, g),
    ];
  }

  // ----- Pin drop -----

  function buildPin(me, g, phase, q, my) {
    if (phase === 'question' && !(my && my.pin)) {
      myPin = null;
      const svg = Gobble.pinMap(q.mapKind, maps);
      if (!svg) return [h('p', { class: 'ask' }, q.text), h('p', { class: 'lede' }, 'Loading the map…')];
      const button = h('button', { class: 'action', type: 'button', disabled: true }, 'Zoom in, then drop your pin');
      const hint = h('p', { class: 'lede' }, 'Tap the map to zoom in on an area.');
      const zoomOut = h('button', { class: 'link-button', type: 'button', hidden: true }, 'Zoom out');
      const { w: W, h: H } = svg.mapSize;
      const ZOOM = 4; // how far one tap zooms in
      let view = { x: 0, y: 0, w: W, h: H };
      let dot = null;
      const drawDot = () => {
        if (dot) dot.remove();
        // Keep the pin the same size on screen whether zoomed in or out.
        dot = myPin ? Gobble.pinDot(svg, myPin, '#f28c28', 'mine', view.w / 55) : null;
      };
      const show = (next) => {
        view = next;
        svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
        const zoomed = view.w < W;
        zoomOut.hidden = !zoomed;
        svg.classList.toggle('zoomed', zoomed);
        hint.textContent = zoomed
          ? 'Tap the exact spot to drop your pin. Tap again to move it.'
          : 'Tap the map to zoom in on an area.';
        drawDot();
      };
      svg.addEventListener('pointerdown', (event) => {
        const box = svg.getBoundingClientRect();
        const fx = (event.clientX - box.left) / box.width;
        const fy = (event.clientY - box.top) / box.height;
        if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return;
        const mx = view.x + fx * view.w;
        const my = view.y + fy * view.h;
        if (view.w === W) {
          // First tap: zoom in around the tapped spot.
          const w = W / ZOOM;
          const hgt = H / ZOOM;
          show({ x: Math.min(W - w, Math.max(0, mx - w / 2)), y: Math.min(H - hgt, Math.max(0, my - hgt / 2)), w, h: hgt });
          return;
        }
        myPin = { x: mx / W, y: my / H };
        drawDot();
        button.disabled = false;
        button.textContent = 'Lock in my pin';
      });
      zoomOut.addEventListener('click', () => show({ x: 0, y: 0, w: W, h: H }));
      button.addEventListener('click', () => {
        if (myPin) send({ x: myPin.x, y: myPin.y }, [button]);
      });
      return [h('p', { class: 'ask' }, q.text), hint, h('div', { class: 'pin-pad' }, svg), button, zoomOut];
    }
    if (phase === 'question' || phase === 'locked') {
      if (!(my && my.pin)) return [h('h1', null, "Time's up"), h('p', { class: 'lede' }, 'No pin from you this time. Watch the TV.')];
      return [h('h1', null, 'Pin dropped'), h('p', { class: 'lede' }, phase === 'locked' ? 'Watch the TV.' : 'Waiting for everyone else.')];
    }
    if (!g.reveal) return [];
    const mine = g.reveal.pins[me.id];
    return [
      h('h1', { class: g.reveal.closestId === me.id ? 'good' : '' }, g.reveal.closestId === me.id ? 'Closest!' : g.reveal.place),
      mine
        ? h('p', { class: 'lede' }, mine.miles == null ? 'Your pin was off the map.' : `You were ${Number(mine.miles).toLocaleString('en-US')} miles away. It was ${g.reveal.place}.`)
        : h('p', { class: 'lede' }, `No pin from you. It was ${g.reveal.place}.`),
      gainLine(me, g),
    ];
  }

  // ----- Heads Up -----

  // Tilt detection. The phone is on the player's forehead, screen out.
  // Screen tipped up to the ceiling = right. Tipped down to the floor = pass.
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let tiltAction = null; // set while a Heads Up word is on this phone
  let tiltArmed = false; // the phone must come back upright between words
  let tiltListening = false;
  let tiltSmooth = 0; // smoothed reading, so a jolt or a nod doesn't count
  let uprightSince = 0; // how long the phone has been held upright
  let tiltSince = 0; // how long it has been held tipped
  let tiltQuietUntil = 0; // no new tilt until this time (after each word)
  const TILT_ON = 8.2; // out of 9.8: the screen has to face nearly straight up or down
  const TILT_OFF = 3; // back to roughly upright
  const TILT_HOLD_MS = 280; // tipped for this long before it counts
  const UPRIGHT_MS = 450; // upright for this long before the next word can be scored
  function onMotion(event) {
    const a = event.accelerationIncludingGravity;
    if (!a || a.z == null || !tiltAction) return;
    // Android reports +z with the screen facing up; iPhones report the opposite.
    const z = IOS ? -a.z : a.z;
    tiltSmooth = tiltSmooth * 0.8 + z * 0.2;
    const now = Date.now();
    const size = Math.abs(tiltSmooth);
    if (size < TILT_OFF) {
      tiltSince = 0;
      if (!uprightSince) uprightSince = now;
      if (now - uprightSince >= UPRIGHT_MS) tiltArmed = true;
      return;
    }
    uprightSince = 0;
    if (!tiltArmed || now < tiltQuietUntil || size < TILT_ON) {
      tiltSince = 0;
      return;
    }
    if (!tiltSince) tiltSince = now;
    if (now - tiltSince < TILT_HOLD_MS) return;
    tiltArmed = false;
    tiltSince = 0;
    tiltQuietUntil = now + 1200;
    tiltAction(tiltSmooth > 0 ? 'right' : 'pass');
  }

  // A short beep from the phone: iPhones can't vibrate from a web page.
  let beeper = null;
  function beep(right) {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!beeper) beeper = new Ctor();
      if (beeper.state === 'suspended') beeper.resume();
      const notes = right ? [660, 990] : [300, 220];
      notes.forEach((freq, i) => {
        const osc = beeper.createOscillator();
        const gain = beeper.createGain();
        osc.type = right ? 'triangle' : 'sawtooth';
        osc.frequency.value = freq;
        const at = beeper.currentTime + i * 0.13;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
        osc.connect(gain).connect(beeper.destination);
        osc.start(at);
        osc.stop(at + 0.18);
      });
    } catch (err) {
      /* no sound on this phone */
    }
  }
  async function startTilt() {
    if (tiltListening) return true;
    try {
      // iPhones ask the player for permission, and only from a tap.
      if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return false;
      }
      if (!window.DeviceMotionEvent) return false;
      window.addEventListener('devicemotion', onMotion);
      tiltListening = true;
      return true;
    } catch (err) {
      return false;
    }
  }

  function buildHeadsUp(me, g, phase, q, my) {
    const holder = Boolean(my && my.holder);
    const who = nameOf(q.holderId);
    tiltAction = null;
    if (phase === 'reveal' && g.reveal) {
      return [
        h('h1', { class: holder && g.reveal.right ? 'good' : '' }, holder ? `You got ${g.reveal.right}` : `${who} got ${g.reveal.right}`),
        holder ? gainLine(me, g) : null,
        h('p', { class: 'lede' }, g.reveal.results.map((r) => `${r.right ? '✓' : '✗'} ${r.word}`).join('   ')),
      ];
    }
    if (phase === 'locked') return [h('h1', null, "Time's up"), h('p', { class: 'lede' }, 'Watch the TV.')];

    if (!holder) {
      if (q.stage === 'ready') {
        return [
          h('p', { class: 'kicker' }, q.deck),
          h('h1', null, `${who} is up`),
          h('p', { class: 'lede' }, `When the word appears, help ${who} guess it. Describe it or act it out, but never say the word itself.`),
        ];
      }
      return [
        h('p', { class: 'kicker' }, `Help ${who} guess this. Don't say it!`),
        h('h1', { class: 'good' }, (my && my.word) || 'Look at the phone'),
        h('p', { class: 'lede' }, `${q.right} right so far.`),
      ];
    }

    if (q.stage === 'ready') {
      const button = h('button', { class: 'action', type: 'button' }, "I'm ready");
      const warn = h('p', { class: 'lede tight' }, '');
      button.addEventListener('click', async () => {
        beep(true); // a tap is what lets the phone make sound later
        const ok = await startTilt();
        if (!ok) warn.textContent = "Tilting isn't available on this phone, so use the two buttons instead.";
        send({ ready: true }, [button]);
      });
      return [
        h('p', { class: 'kicker' }, `Heads Up: ${q.deck}`),
        h('h1', null, "You're holding the phone"),
        h(
          'ol',
          { class: 'how-to' },
          h('li', null, 'Turn your phone sideways and hold it to your forehead, screen facing everyone else.'),
          h('li', null, 'They give you clues. You guess the word on the screen.'),
          h('li', null, 'Tip the screen all the way UP to the ceiling when you get it right, and hold it a moment.'),
          h('li', null, 'Tip it all the way DOWN to the floor to pass.'),
          h('li', null, 'Bring it back upright before the next word. Small nods are ignored.')
        ),
        button,
        warn,
      ];
    }

    // The word, as big as the screen allows, with buttons as a fallback.
    const card = h('div', { class: 'headsup-card' }, h('span', { class: 'headsup-word' }, (my && my.word) || ''));
    const right = h('button', { class: 'headsup-btn right', type: 'button' }, '▲ Right');
    const pass = h('button', { class: 'headsup-btn pass', type: 'button' }, '▼ Pass');
    let sent = false;
    const answer = (result) => {
      if (sent) return;
      sent = true;
      card.classList.add(result === 'right' ? 'flash-right' : 'flash-pass');
      card.querySelector('.headsup-word').textContent = result === 'right' ? 'Right!' : 'Pass';
      if (navigator.vibrate) navigator.vibrate(result === 'right' ? 180 : [90, 70, 90]);
      beep(result === 'right');
      // Hold the result on screen for a beat before the next word.
      setTimeout(() => send({ result }, [right, pass]), 650);
    };
    right.addEventListener('click', () => answer('right'));
    pass.addEventListener('click', () => answer('pass'));
    tiltAction = answer;
    tiltArmed = false; // wait for the phone to come back upright first
    uprightSince = 0;
    tiltSince = 0;
    // iPhones only switch tilting on from a tap. If the turn started before
    // "I'm ready" was tapped, one tap on the word does it.
    const hint = h('p', { class: 'headsup-hint', hidden: tiltListening }, 'Tap the word once to switch on tilting');
    card.append(hint);
    card.addEventListener('click', async () => {
      if (tiltListening) return;
      beep(true);
      if (await startTilt()) hint.hidden = true;
      else hint.textContent = 'Tilting is off on this phone. Use the buttons.';
    });
    if (!IOS) startTilt().then((ok) => { if (ok) hint.hidden = true; });
    return [card, h('div', { class: 'headsup-btns' }, right, pass)];
  }

  // ----- Bluff -----

  function buildBluff(me, g, phase, q, my) {
    const role = (my && my.role) || 'both';
    if (phase === 'question' && q.stage === 'write' && (role === 'guesser' || role === 'watcher')) {
      return [
        h('h1', null, 'Hang tight'),
        h('p', { class: 'lede' }, `${q.writerLabel || 'The other side'} are making up fake answers for you. Don't look at their phones.`),
      ];
    }
    if (phase === 'question' && q.stage === 'vote' && (role === 'writer' || role === 'watcher')) {
      return [
        h('h1', null, 'Watch them guess'),
        h('p', { class: 'lede' }, `${q.guesserLabel || 'The other side'} are choosing. You score for every one of them your fake fools.`),
        my && my.lie ? h('p', { class: 'quote' }, `“${my.lie}”`) : null,
      ];
    }
    if (phase === 'question' && q.stage === 'write') {
      if (my && my.lie) {
        return [
          h('h1', null, 'Fake sent'),
          h('p', { class: 'lede' }, 'Waiting for the others to finish lying.'),
          h('p', { class: 'quote' }, `“${my.lie}”`),
        ];
      }
      const input = h('input', {
        type: 'text',
        id: 'lie-input',
        maxlength: q.maxLength,
        autocomplete: 'off',
        autocapitalize: 'sentences',
        enterkeyhint: 'send',
      });
      const button = h('button', { class: 'action', type: 'submit' }, 'Send my fake');
      const form = h(
        'form',
        {
          onsubmit: (event) => {
            event.preventDefault();
            if (input.value.trim()) send({ text: input.value }, [button]);
          },
        },
        h('label', { for: 'lie-input' }, 'Your fake answer'),
        input,
        button
      );
      const ideas = (my && my.suggestions) || [];
      return [
        h('p', { class: 'ask' }, q.text),
        my && my.image ? h('img', { class: 'secret-photo', src: my.image, alt: 'The secret photo' }) : null,
        h(
          'p',
          { class: 'lede' },
          q.sided
            ? `Make up an answer that sounds real enough to fool ${q.guesserLabel}.`
            : 'Make up an answer that sounds real enough to fool everyone.'
        ),
        form,
        ideas.length
          ? h(
              'div',
              { class: 'ideas' },
              h('p', { class: 'ideas-title' }, 'Stuck? Tap one of these, then send it or change it.'),
              ...ideas.map((idea) =>
                h(
                  'button',
                  {
                    class: 'idea',
                    type: 'button',
                    onclick: () => {
                      input.value = idea;
                      input.focus();
                    },
                  },
                  idea
                )
              )
            )
          : null,
      ];
    }

    if (phase === 'question' && q.stage === 'vote') {
      if (my && my.voteId) {
        const voted = q.options.find((o) => o.id === my.voteId);
        return [
          h('h1', null, 'Vote in'),
          h('p', { class: 'lede' }, 'Waiting for the others.'),
          voted ? answerCard(q.options, voted) : null,
        ];
      }
      const buttons = [];
      q.options.forEach((option, i) => {
        const own = Boolean(my && my.ownOptionId === option.id);
        buttons.push(
          h(
            'button',
            {
              class: `answer tone-${i % 6}${own ? ' own' : ''}`,
              type: 'button',
              disabled: own, // your own fake is shown but can't be picked
              onclick: () => send({ optionId: option.id }, buttons.filter((b) => !b.classList.contains('own'))),
            },
            h('span', { class: 'answer-letter' }, option.id),
            h('span', { class: 'answer-text' }, option.text, own ? h('small', null, 'Your fake') : null)
          )
        );
      });
      return [
        h('p', { class: 'ask' }, q.text),
        h('p', { class: 'lede' }, q.blur ? 'Watch the photo on the TV get clearer. Faster right answers score more.' : 'Which one is the truth?'),
        h('div', { class: 'answers' }, ...buttons),
      ];
    }

    if (phase === 'locked') {
      return [h('h1', null, 'Votes are in'), h('p', { class: 'lede' }, 'Watch the TV to see who fooled who.')];
    }
    if (!g.reveal) return [];

    const truth = g.reveal.options.find((o) => o.truth);
    const foundIt = truth.voters.includes(me.id);
    const myLie = g.reveal.options.find((o) => o.authors.includes(me.id));
    const fooled = myLie ? myLie.voters.length : 0;
    const fellFor = g.reveal.options.find((o) => !o.truth && o.voters.includes(me.id));
    const lines = [];
    if (foundIt) lines.push('You found the truth.');
    else if (fellFor) {
      lines.push(
        fellFor.house ? 'You fell for a house fake.' : `You fell for ${fellFor.authors.map(nameOf).join(' and ')}'s fake.`
      );
    }
    if (fooled) lines.push(`Your fake fooled ${fooled} ${fooled === 1 ? 'player' : 'players'}.`);
    if (!lines.length) lines.push('No points this time.');
    return [
      h('h1', { class: foundIt || fooled ? 'good' : '' }, foundIt ? 'Truth found!' : fooled ? 'Nice bluff!' : 'Fooled you'),
      gainLine(me, g),
      ...lines.map((line) => h('p', { class: 'lede tight' }, line)),
      h('p', { class: 'lede tight' }, 'The truth:'),
      answerCard(g.reveal.options, truth),
    ];
  }

  // ----- Drawing round -----

  function buildDraw(me, g, phase, q, my) {
    const artist = Boolean(my && my.artist);
    if (phase === 'reveal' && g.reveal) {
      const got = g.reveal.guessed.includes(me.id);
      return [
        h('h1', { class: g.reveal.gains[me.id] ? 'good' : '' }, artist ? 'Pencils down' : got ? 'You got it!' : 'Not this time'),
        gainLine(me, g),
        h('p', { class: 'lede' }, 'The word was:'),
        h('p', { class: 'quote' }, g.reveal.word),
      ];
    }
    if (phase === 'locked') return [h('h1', null, 'Pencils down'), h('p', { class: 'lede' }, 'Watch the TV.')];

    if (q.aloud) {
      // Pictionary: guesses are shouted out, and a tap says it's been guessed.
      const sides = g.round && g.round.sides;
      const teamName = sides && q.side != null ? sides.names[q.side] : '';
      const got = (label) => {
        const button = h('button', { class: 'action got-it', type: 'button' }, label);
        button.addEventListener('click', () => send({ gotIt: true }, [button]));
        return button;
      };
      if (artist) return [...buildPad(my.word), got('They said it!')];
      if (my && my.onTeam) {
        return [
          h('p', { class: 'kicker' }, teamName ? `${teamName}, you're up` : "You're guessing"),
          h('h1', null, `Shout what ${nameOf(q.artistId)} is drawing`),
          h('p', { class: 'lede' }, `Watch the TV and call out your guesses. Tap the button only once ${nameOf(q.artistId)} says you got it.`),
          got('We got it!'),
        ];
      }
      return [
        h('h1', null, 'Shhh'),
        h('p', { class: 'lede' }, `${teamName || 'The other team'} is guessing this one. No helping!`),
      ];
    }

    if (artist) return buildPad(my.word);

    if (my && my.correct) {
      return [h('h1', { class: 'good' }, 'You got it!'), h('p', { class: 'lede' }, 'Sit tight while the others keep guessing.')];
    }
    const input = h('input', {
      type: 'text',
      id: 'guess-input',
      maxlength: 30,
      autocomplete: 'off',
      autocapitalize: 'none',
      autocorrect: 'off',
      enterkeyhint: 'send',
    });
    const button = h('button', { class: 'action', type: 'submit' }, 'Guess');
    const reply = h('p', { class: 'lede tight', role: 'status' }, feedback);
    const form = h(
      'form',
      {
        onsubmit: (event) => {
          event.preventDefault();
          const guess = input.value.trim();
          if (!guess) return;
          send({ text: guess }, [button], (res) => {
            if (res.ok && !res.correct) {
              feedback = `Not “${guess}”. Keep guessing!`;
              reply.textContent = feedback;
              input.value = '';
              input.focus();
            }
          });
        },
      },
      h('label', { for: 'guess-input' }, `What is ${nameOf(q.artistId)} drawing?`),
      input,
      button
    );
    const letters = q.letters.replace(/ /g, '').length;
    return [h('p', { class: 'kicker' }, `${letters} letters. Watch the TV.`), form, reply];
  }

  // The artist's drawing pad. Strokes are sent while they're being drawn,
  // as fractions of the pad's size, so they fit any screen.
  function buildPad(word) {
    const canvas = h('canvas', { class: 'pad', width: 700, height: 700 });
    const strokes = [];
    let color = PEN_COLORS[0];
    let current = null;
    let unsent = [];
    const redraw = () => Gobble.paint(canvas, strokes);

    const flush = () => {
      if (!current || unsent.length === 0) return;
      socket.emit(
        'draw:stroke',
        current.sent ? { more: true, points: unsent } : { color: current.color, size: current.size, points: unsent }
      );
      current.sent = true;
      unsent = [];
    };
    const timer = setInterval(() => {
      if (!canvas.isConnected) clearInterval(timer);
      else flush();
    }, 70);

    const at = (event) => {
      const box = canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
      return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    };

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
      current = { color, size: 0.014, points: at(event), sent: false };
      unsent = current.points.slice();
      strokes.push(current);
      redraw();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!current) return;
      event.preventDefault();
      const [x, y] = at(event);
      current.points.push(x, y);
      unsent.push(x, y);
      redraw();
    });
    const lift = () => {
      flush();
      current = null;
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);

    const swatches = PEN_COLORS.map((c) => {
      const b = h('button', { class: 'swatch', type: 'button', 'aria-label': 'Pen color', 'aria-pressed': String(c === color) });
      b.style.setProperty('--c', c);
      b.addEventListener('click', () => {
        color = c;
        swatches.forEach((s) => s.setAttribute('aria-pressed', String(s === b)));
      });
      return b;
    });
    const undo = h('button', { class: 'tool', type: 'button' }, 'Undo');
    undo.addEventListener('click', () => {
      if (!strokes.length) return;
      strokes.pop();
      socket.emit('draw:stroke', { undo: true });
      redraw();
    });
    const clear = h('button', { class: 'tool', type: 'button' }, 'Clear');
    clear.addEventListener('click', () => {
      strokes.length = 0;
      socket.emit('draw:stroke', { clear: true });
      redraw();
    });

    return [
      h('p', { class: 'kicker' }, 'Draw this. No letters or numbers!'),
      h('h1', { class: 'good' }, word),
      canvas,
      h('div', { class: 'pad-tools' }, ...swatches, undo, clear),
    ];
  }

  // ----- Scores and the winner -----

  function buildStanding(me, g, phase) {
    const list = ranked(state.players);
    const spot = list.find((p) => p.id === me.id);
    const tied = list.filter((p) => p.rank === spot.rank).length > 1;
    const place = `${tied ? 'tied for ' : ''}${ordinal(spot.rank)}`;
    const final = phase === 'final';

    let teamLine = null;
    let teamWon = false;
    if (state.teams) {
      const totals = [0, 1].map((t) => state.players.filter((p) => p.team === t).reduce((sum, p) => sum + p.score, 0));
      const ours = totals[me.team];
      const theirs = totals[1 - me.team];
      teamWon = ours > theirs;
      const verb = ours === theirs ? 'is tied with' : ours > theirs ? (final ? 'beat' : 'leads') : final ? 'lost to' : 'trails';
      teamLine = `${state.teams.names[me.team]} ${verb} ${state.teams.names[1 - me.team]}, ${points(ours)} to ${points(theirs)}.`;
    }

    if (final) {
      const won = state.teams ? teamWon : spot.rank === 1;
      const headline = state.teams
        ? teamWon
          ? 'Your team won!'
          : 'Good game'
        : spot.rank === 1
          ? tied
            ? 'You tied for the win!'
            : 'You won!'
          : `You finished ${place}`;
      return [
        h('h1', { class: won ? 'good' : '' }, headline),
        teamLine ? h('p', { class: 'lede tight' }, teamLine) : null,
        h('p', { class: 'lede' }, `You scored ${points(me.score)} points, ${place} overall. Thanks for playing.`),
      ];
    }
    return [
      h('p', { class: 'kicker' }, `After ${g.round.title}`),
      h('h1', null, `You're ${place}`),
      teamLine ? h('p', { class: 'lede tight' }, teamLine) : null,
      h('p', { class: 'lede' }, `${points(me.score)} points so far.`),
    ];
  }

  // The thin bar above the answers that drains with the timer.
  function frame() {
    requestAnimationFrame(frame);
    const bar = $('#timebar');
    if (bar.hidden || !state || !state.game || !state.game.timer) return;
    const share = clock.left(state.game) / state.game.timer.totalMs;
    bar.firstElementChild.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
  }
  requestAnimationFrame(frame);

  // ---------- Forms ----------

  $('#code-input').addEventListener('input', (event) => {
    event.target.value = cleanCode(event.target.value);
  });

  $('#rename-button').addEventListener('click', rename);
  $('#banner-retry').addEventListener('click', () => {
    if (socket.connected) hello();
    else {
      socket.disconnect();
      socket.connect();
    }
  });

  $('#code-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = cleanCode($('#code-input').value);
    if (typed.length !== 4) return note('#code-note', 'The code is four letters. Check the TV.');
    note('#code-note', '');
    code = typed;
    seat = store.get(seatKey(code));
    if (socket.connected) hello();
    else socket.connect();
  });

  $('#name-input').addEventListener('input', (event) => {
    event.target.dataset.touched = '1';
    if (state) updateJoinButton();
  });

  $('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#name-input').value.trim();
    if (!name || !pick) return;
    $('#join-button').disabled = true;
    socket.emit('player:join', { name, characterId: pick }, (res) => {
      if (!res || !res.ok) {
        if (res && res.error === 'no-room') return leaveRoom(`Room ${code} isn't open. Check the code on the TV.`);
        note('#join-note', (res && res.error) || 'Could not join. Try again.');
        return render();
      }
      seat = { playerId: res.playerId, token: res.token };
      store.set(seatKey(code), seat);
      store.set(LAST_NAME, name);
      meId = res.playerId;
      pick = null;
      note('#join-note', '');
      keepAwake();
      apply(res.state);
    });
  });

  // Ask the phone not to dim while the game is open. Only works on https,
  // and only after a tap, so failures are expected and ignored.
  let wakeLock = null;
  async function keepAwake() {
    if (!meId || !('wakeLock' in navigator) || (wakeLock && !wakeLock.released)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      wakeLock = null;
    }
  }
})();
