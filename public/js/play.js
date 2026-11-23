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
    if (full) note('#join-note', 'Every seat is taken. Ask the host to free one up.');

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
    const key = q
      ? `${phase}:${q.key}:${q.stage || ''}:${stepOf(q, my)}`
      : `${phase}:${g && g.round ? g.round.number : ''}`;
    if (key !== gameKey) problem = '';
    note('#game-note', g && g.paused ? 'The host paused the game.' : problem);
    if (key === gameKey) return;
    gameKey = key;
    $('#game-body').replaceChildren(...buildGame(me, g, phase, q, my).filter(Boolean));
  }

  // Is the game still waiting for this player to do something?
  function needsInput(q, my) {
    if (q.type === 'bluff') return q.stage === 'write' ? !(my && my.lie) : !(my && my.voteId);
    if (q.type === 'draw') return !(my && (my.artist || my.correct));
    return !(my && my.choiceId);
  }

  // Where this player is within the question, for deciding when to redraw.
  function stepOf(q, my) {
    if (!my) return 'open';
    if (q.type === 'bluff') return `${my.lie ? 'L' : ''}${my.voteId ? 'V' : ''}${my.ownOptionId}`;
    if (q.type === 'draw') return my.artist ? 'artist' : my.correct ? 'got' : 'open';
    return my.choiceId ? 'done' : 'open';
  }

  function buildGame(me, g, phase, q, my) {
    if (phase === 'intro' || !g) {
      return [h('h1', null, 'Game on'), h('p', { class: 'lede' }, 'Eyes on the TV. Your buttons will show up here.')];
    }
    if (phase === 'roundIntro') {
      return [
        h('p', { class: 'kicker' }, `Round ${g.round.number} of ${g.round.count}`),
        h('h1', null, `${g.round.icon ? `${g.round.icon} ` : ''}${g.round.title}`),
        h('p', { class: 'lede' }, g.round.tagline || 'Get ready.'),
      ];
    }
    if (phase === 'scores' || phase === 'final') return buildStanding(me, g, phase);
    if (!q) return [h('p', { class: 'lede' }, 'Watch the TV.')];
    if (q.type === 'bluff') return buildBluff(me, g, phase, q, my);
    if (q.type === 'draw') return buildDraw(me, g, phase, q, my);
    return buildChoice(me, g, phase, q, my);
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
    controls.forEach((c) => (c.disabled = true));
    socket.emit('player:answer', payload, (res) => {
      controls.forEach((c) => (c.disabled = false));
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

  // ----- Bluff -----

  function buildBluff(me, g, phase, q, my) {
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
      return [
        h('p', { class: 'ask' }, q.text),
        h('p', { class: 'lede' }, 'Make up an answer that sounds real enough to fool everyone.'),
        form,
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
        h('p', { class: 'lede' }, 'Which one is the truth?'),
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
