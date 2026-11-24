// What the TV shows for each kind of question. host.js decides WHEN to
// build and update; this file knows HOW each round type looks.
//
// Each view has three parts:
//   build(q, ctx)        -> the DOM for a new question
//   update(root, g, ctx) -> adjust it as the step changes (locked, reveal...)
//   frame(root, share)   -> optional, runs every animation frame
window.Views = (() => {
  const { h, plate } = Gobble;
  const SVG = 'http://www.w3.org/2000/svg';

  const playerById = (ctx, id) => ctx.state.players.find((p) => p.id === id);
  const plateFor = (ctx, id) => {
    const player = playerById(ctx, id);
    return plate(player ? ctx.characters.get(player.characterId) : null);
  };
  const nameOf = (ctx, id) => {
    const player = playerById(ctx, id);
    return player ? player.name : 'Someone';
  };

  // ---------- US map ----------

  // mode: 'outline' (one state on its own), 'highlight' (US map, one state
  // lit up), 'blank' (US map, nothing lit). "also" states get a second color.
  function mapSvg(data, mode, state, also = []) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', `map-svg ${mode}`);
    const add = (code, cls, solo) => {
      const shape = data.states[code];
      if (!shape) return;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', solo ? shape.solo.d : shape.d);
      path.setAttribute('class', cls);
      svg.append(path);
    };
    if (mode === 'outline' && data.states[state]) {
      // On its own, a state is shown north-up like in an atlas.
      const [x, y, w, hgt] = data.states[state].solo.box;
      const pad = Math.max(w, hgt) * 0.08;
      svg.setAttribute('viewBox', `${x - pad} ${y - pad} ${w + pad * 2} ${hgt + pad * 2}`);
      add(state, 'st solo', true);
      return svg;
    }
    svg.setAttribute('viewBox', data.viewBox);
    for (const code of Object.keys(data.states)) {
      if (code === state || also.includes(code)) continue;
      add(code, 'st');
    }
    also.forEach((code) => add(code, 'st warm'));
    if (state) add(state, 'st hot');
    return svg;
  }

  // ---------- Multiple choice (plain, poster, song clip, map) ----------

  const choiceView = {
    build(q, ctx) {
      let mediaEl = null;
      if (q.image) {
        mediaEl = h('div', { class: `media poster${q.blur ? ' blurred' : ''}` }, h('img', { src: q.image, alt: '' }));
      } else if (q.audio) {
        mediaEl = h(
          'div',
          { class: 'media record' },
          h('div', { class: 'sleeve' }),
          h('div', { class: 'disc' }, h('span')),
          h('p', { class: 'media-note' }, 'Listen…')
        );
      } else if (q.map && ctx.mapData) {
        mediaEl = h('div', { class: 'media map' }, mapSvg(ctx.mapData, q.map.show, q.map.state));
      }

      const classes = ['q'];
      if (mediaEl) classes.push('has-media');
      if (q.text.length > (mediaEl ? 60 : 95)) classes.push('long');

      const choices = h(
        'ol',
        { class: 'choices' },
        ...q.choices.map((choice, i) =>
          h(
            'li',
            { class: `choice tone-${i}${choice.text.length > 34 ? ' wordy' : ''}`, 'data-id': choice.id },
            h('span', { class: 'letter' }, choice.id),
            h('span', { class: 'choice-text' }, choice.text),
            h('span', { class: 'pickers' })
          )
        )
      );
      return h(
        'div',
        { class: classes.join(' ') },
        h('h2', { class: 'q-text' }, q.text),
        h('div', { class: 'q-body' }, mediaEl, choices),
        h('p', { class: 'q-foot' })
      );
    },

    update(root, g, ctx) {
      const phase = ctx.state.phase;
      const list = root.querySelector('.choices');
      const foot = root.querySelector('.q-foot');
      list.classList.toggle('locked', phase === 'locked');
      list.classList.toggle('revealed', phase === 'reveal');
      root.classList.toggle('spinning', phase === 'question' && !g.paused);

      if (phase === 'question') {
        foot.textContent = '';
      } else if (phase === 'locked') {
        foot.textContent = g.lockReason === 'time' ? "Time's up." : 'All answers are in.';
      } else if (phase === 'reveal' && g.reveal) {
        foot.textContent = g.reveal.fact || '';
        if (root.dataset.shown) return; // already revealed; don't restart animations
        root.dataset.shown = '1';
        for (const tile of list.children) {
          const id = tile.dataset.id;
          tile.classList.toggle('correct', id === g.reveal.correctId);
          const pickers = ctx.state.players.filter((p) => g.reveal.picks[p.id] === id);
          tile.querySelector('.pickers').replaceChildren(...pickers.map((p) => plateFor(ctx, p.id)));
        }
        // The cover slides out of the record sleeve.
        const sleeve = root.querySelector('.sleeve');
        if (sleeve && g.reveal.image) {
          sleeve.replaceChildren(h('img', { src: g.reveal.image, alt: '' }));
          root.querySelector('.media').classList.add('opened');
        }
        // The map zooms out to show where the state sits.
        const map = root.querySelector('.media.map');
        if (map && g.reveal.map && ctx.mapData) {
          const shape = ctx.mapData.states[g.reveal.map.state];
          map.replaceChildren(
            mapSvg(ctx.mapData, 'highlight', g.reveal.map.state, g.reveal.map.also || []),
            shape ? h('p', { class: 'map-label' }, shape.name) : null
          );
        }
      }
    },

    // The poster sharpens as the timer runs down.
    frame(root, share, ctx) {
      const img = root.querySelector('.media.blurred img');
      if (!img) return;
      const phase = ctx.state.phase;
      const amount = phase === 'question' ? Math.pow(Math.max(0, share), 1.3) : 0;
      img.style.filter = amount > 0.001 ? `blur(calc(var(--u) * ${(amount * 3.4).toFixed(3)}))` : 'none';
    },
  };

  // ---------- Bluff ----------

  const bluffView = {
    build(q) {
      const picture = q.image ? h('div', { class: 'media poster' }, h('img', { src: q.image, alt: '' })) : null;
      return h(
        'div',
        { class: `q bluff${picture ? ' has-media' : ''}${q.text.length > 95 ? ' long' : ''}` },
        h('h2', { class: 'q-text' }, q.text),
        h('p', { class: 'bluff-how' }),
        h('div', { class: 'q-body' }, picture, h('ol', { class: 'choices' })),
        h('p', { class: 'q-foot' })
      );
    },

    update(root, g, ctx) {
      const phase = ctx.state.phase;
      const q = g.question;
      const how = root.querySelector('.bluff-how');
      const list = root.querySelector('.choices');
      const foot = root.querySelector('.q-foot');

      if (phase === 'question' && q.stage === 'write') {
        how.textContent = q.pictureOnPhones
          ? `${q.sided ? q.writerLabel : 'Everyone'}: a secret photo is on your phone. Send a fake name for it${q.sided ? ` to fool ${q.guesserLabel}` : ''}.`
          : q.sided
            ? `${q.writerLabel}: send a fake answer from your phone to fool ${q.guesserLabel}.`
            : 'Make something up! Type a fake answer on your phone.';
        list.replaceChildren();
        foot.textContent = '';
        return;
      }

      // A slow-reveal picture arrives with the vote: add it, blurred.
      if (q.image && !root.querySelector('.media')) {
        root.classList.add('has-media');
        root.querySelector('.q-body').prepend(
          h('div', { class: `media poster${q.blur ? ' blurred' : ''}` }, h('img', { src: q.image, alt: '' }))
        );
      }

      // Voting has started (or we skipped straight to the reveal): show the choices.
      const options = phase === 'reveal' && g.reveal ? g.reveal.options : q.options;
      if (root.dataset.optionsFor !== `${options.length}:${phase === 'reveal'}`) {
        root.dataset.optionsFor = `${options.length}:${phase === 'reveal'}`;
        const revealing = phase === 'reveal';
        // Fakes are unmasked one by one; the truth comes last.
        const order = revealing ? [...options.filter((o) => !o.truth), ...options.filter((o) => o.truth)] : [];
        list.replaceChildren(
          ...options.map((option, i) => {
            const tile = h(
              'li',
              { class: `choice tone-${i % 6}${option.text.length > 30 ? ' wordy' : ''}`, 'data-id': option.id },
              h('span', { class: 'letter' }, option.id),
              h('span', { class: 'choice-body' }, h('span', { class: 'choice-text' }, option.text))
            );
            if (revealing) {
              const who = option.truth
                ? 'The truth'
                : option.house
                  ? 'A fake from the house'
                  : `${option.authors.map((id) => nameOf(ctx, id)).join(' and ')} made this up`;
              tile.querySelector('.choice-body').append(h('span', { class: 'tag' }, who));
              tile.append(h('span', { class: 'pickers' }, ...option.voters.map((id) => plateFor(ctx, id))));
              tile.classList.add(option.truth ? 'correct' : 'fake', 'unmask');
              tile.style.setProperty('--step', order.indexOf(option));
            }
            return tile;
          })
        );
      }
      list.classList.toggle('locked', phase === 'locked');
      list.classList.toggle('revealed', phase === 'reveal');

      if (phase === 'question') {
        how.textContent = q.blur
          ? `${q.sided ? `${q.guesserLabel}: w` : 'W'}ho is it? The photo gets clearer, but faster right answers score more.`
          : q.sided
            ? `${q.guesserLabel}: one of these is true. Pick it on your phone.`
            : 'One of these is true. Pick it on your phone.';
        foot.textContent = '';
      } else if (phase === 'locked') {
        how.textContent = g.lockReason === 'time' ? "Time's up." : 'All votes are in.';
      } else if (phase === 'reveal' && g.reveal) {
        how.textContent = 'Who fooled who?';
        foot.textContent = g.reveal.fact || '';
      }
    },
  };

  // The slow-reveal photo sharpens through the vote, like Poster Reveal.
  bluffView.frame = (root, share, ctx) => choiceView.frame(root, share, ctx);

  // ---------- Drawing ----------

  const paint = Gobble.paint;

  // The team guessing a Pictionary drawing, by name, when teams were dealt.
  const teamOf = (ctx, q) => {
    const sides = ctx.state.game && ctx.state.game.round && ctx.state.game.round.sides;
    return sides && q.side != null ? sides.names[q.side] : '';
  };

  // ---------- Heads Up ----------

  const headsUpView = {
    build(q, ctx) {
      return h(
        'div',
        { class: 'q headsup' },
        h('div', { class: 'hu-head' }, plateFor(ctx, q.holderId), h('h2', { class: 'q-text' }, '')),
        h('p', { class: 'hu-how' }),
        h('ul', { class: 'hu-words' }),
        h('p', { class: 'q-foot' })
      );
    },

    update(root, g, ctx) {
      const phase = ctx.state.phase;
      const q = g.question;
      const who = nameOf(ctx, q.holderId);
      const results = phase === 'reveal' && g.reveal ? g.reveal.results : q.results;
      const right = results.filter((r) => r.right).length;
      root.querySelector('.q-text').textContent =
        phase === 'reveal' ? `${who} got ${right}` : q.stage === 'ready' ? `${who}, phone to your forehead` : `${q.deck}: ${right} right`;
      root.querySelector('.hu-how').textContent =
        q.stage === 'ready' && phase === 'question'
          ? `Deck: ${q.deck}. Everyone else gives clues without saying the word. Tip the phone up for right, down to pass.`
          : phase === 'question'
            ? `Help ${who} guess the word on the phone. Don't say it!`
            : '';
      const list = root.querySelector('.hu-words');
      if (list.dataset.n !== String(results.length)) {
        list.dataset.n = String(results.length);
        list.replaceChildren(...results.map((r) => h('li', { class: r.right ? 'right' : 'pass' }, `${r.right ? '✓' : '✗'} ${r.word}`)));
      }
      root.querySelector('.q-foot').textContent = phase === 'locked' ? "Time's up." : '';
    },
  };

  const drawView = {
    build(q, ctx) {
      const canvas = h('canvas', { class: 'easel', width: 900, height: 900 });
      const root = h(
        'div',
        { class: 'q draw' },
        h(
          'div',
          { class: 'draw-side' },
          h(
            'div',
            { class: 'draw-artist' },
            plateFor(ctx, q.artistId),
            h('span', null, `${nameOf(ctx, q.artistId)} is drawing${teamOf(ctx, q) ? ` for ${teamOf(ctx, q)}` : ''}`)
          ),
          q.aloud
            ? h('p', { class: 'draw-how' }, `${teamOf(ctx, q) || 'Everyone'}: shout your guesses. Tap "We got it!" once it's been said.`)
            : null,
          h('p', { class: 'letters' }, q.letters.split('').join(' ')),
          h('ul', { class: 'guesses' }),
          h('p', { class: 'q-foot' })
        ),
        canvas
      );
      root.strokes = [];
      return root;
    },

    // Called by host.js when strokes arrive from the artist's phone.
    stroke(root, data) {
      const canvas = root.querySelector('.easel');
      if (data.clear) root.strokes = [];
      else if (data.undo) root.strokes.pop();
      else if (data.more) {
        const last = root.strokes[root.strokes.length - 1];
        if (last) last.points.push(...data.points);
      } else root.strokes.push({ color: data.color, size: data.size, points: data.points.slice() });
      paint(canvas, root.strokes);
    },

    sync(root, strokes) {
      root.strokes = strokes.map((s) => ({ ...s, points: s.points.slice() }));
      paint(root.querySelector('.easel'), root.strokes);
    },

    update(root, g, ctx) {
      const phase = ctx.state.phase;
      const q = g.question;
      const feed = root.querySelector('.guesses');
      const key = q.misses.map((m) => m.text).join('|');
      if (feed.dataset.key !== key) {
        feed.dataset.key = key;
        feed.replaceChildren(
          ...q.misses.map((m) => h('li', null, plateFor(ctx, m.playerId), h('span', null, `${m.text}?`)))
        );
      }
      const foot = root.querySelector('.q-foot');
      if (phase === 'locked') foot.textContent = g.lockReason === 'time' ? "Time's up." : 'Everyone got it!';
      else if (phase === 'reveal' && g.reveal) {
        root.querySelector('.letters').textContent = g.reveal.word;
        root.querySelector('.letters').classList.add('solved');
        const n = g.reveal.guessed.length;
        foot.textContent = n === 0 ? 'Nobody got that one.' : `${n} ${n === 1 ? 'player' : 'players'} got it.`;
      } else foot.textContent = '';
    },
  };

  // ---------- Pin drop ----------

  const pinView = {
    build(q, ctx) {
      const map = Gobble.pinMap(q.mapKind, ctx.maps);
      return h(
        'div',
        { class: `q pin-q ${q.mapKind}` },
        h('h2', { class: 'q-text' }, q.text),
        h('div', { class: 'pin-body' }, h('div', { class: 'pin-stage' }, map), h('ol', { class: 'pin-list' })),
        h('p', { class: 'q-foot' })
      );
    },

    update(root, g, ctx) {
      const phase = ctx.state.phase;
      const foot = root.querySelector('.q-foot');
      const list = root.querySelector('.pin-list');
      if (phase === 'question') {
        foot.textContent = 'Tap the spot on your phone. Closest pin wins.';
      } else if (phase === 'locked') {
        foot.textContent = g.lockReason === 'time' ? "Time's up." : 'All pins are in.';
      } else if (phase === 'reveal' && g.reveal) {
        foot.textContent = g.reveal.fact || '';
        if (root.dataset.shown) return;
        root.dataset.shown = '1';
        const svg = root.querySelector('.pin-map');
        const ranked = ctx.state.players
          .filter((p) => g.reveal.pins[p.id])
          .map((p) => ({ player: p, pin: g.reveal.pins[p.id] }))
          .sort((a, b) => (a.pin.miles == null ? 1e9 : a.pin.miles) - (b.pin.miles == null ? 1e9 : b.pin.miles));
        if (svg && g.reveal.target) {
          const { w, h: hgt } = svg.mapSize;
          for (const { player, pin } of ranked) {
            const line = document.createElementNS(SVG, 'line');
            line.setAttribute('x1', pin.x * w);
            line.setAttribute('y1', pin.y * hgt);
            line.setAttribute('x2', g.reveal.target.x * w);
            line.setAttribute('y2', g.reveal.target.y * hgt);
            line.setAttribute('class', 'pin-line');
            svg.append(line);
          }
          for (const { player, pin } of ranked) {
            const character = ctx.characters.get(player.characterId);
            Gobble.pinDot(svg, pin, character ? character.color : '#a6b0b5', 'guess');
          }
          Gobble.pinDot(svg, g.reveal.target, '#f4c542', 'target');
        }
        list.replaceChildren(
          h('li', { class: 'pin-answer' }, g.reveal.place),
          ...ranked.map(({ player, pin }) =>
            h(
              'li',
              { class: player.id === g.reveal.closestId ? 'closest' : '' },
              plateFor(ctx, player.id),
              h('span', { class: 'pin-who' }, player.name),
              h('span', { class: 'pin-miles' }, pin.miles == null ? 'off the map' : `${Number(pin.miles).toLocaleString('en-US')} mi`)
            )
          )
        );
      }
    },
  };

  const forType = (type) =>
    type === 'bluff' ? bluffView : type === 'draw' ? drawView : type === 'pin' ? pinView : type === 'headsup' ? headsUpView : choiceView;

  return { forType, mapSvg };
})();
