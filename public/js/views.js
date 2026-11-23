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
      return h(
        'div',
        { class: `q bluff${q.text.length > 95 ? ' long' : ''}` },
        h('h2', { class: 'q-text' }, q.text),
        h('p', { class: 'bluff-how' }),
        h('ol', { class: 'choices' }),
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
        how.textContent = 'Make something up! Type a fake answer on your phone.';
        list.replaceChildren();
        foot.textContent = '';
        return;
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
        how.textContent = 'One of these is true. Pick it on your phone.';
        foot.textContent = '';
      } else if (phase === 'locked') {
        how.textContent = g.lockReason === 'time' ? "Time's up." : 'All votes are in.';
      } else if (phase === 'reveal' && g.reveal) {
        how.textContent = 'Who fooled who?';
        foot.textContent = g.reveal.fact || '';
      }
    },
  };

  // ---------- Drawing ----------

  const paint = Gobble.paint;

  const drawView = {
    build(q, ctx) {
      const canvas = h('canvas', { class: 'easel', width: 900, height: 900 });
      const root = h(
        'div',
        { class: 'q draw' },
        h(
          'div',
          { class: 'draw-side' },
          h('div', { class: 'draw-artist' }, plateFor(ctx, q.artistId), h('span', null, `${nameOf(ctx, q.artistId)} is drawing`)),
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

  const forType = (type) => (type === 'bluff' ? bluffView : type === 'draw' ? drawView : choiceView);

  return { forType, mapSvg };
})();
