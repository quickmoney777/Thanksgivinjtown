// Small helpers shared by the TV, phones and the host remote.
window.Gobble = (() => {
  const $ = (selector, root = document) => root.querySelector(selector);

  // h('div', { class: 'x', onclick: fn }, 'text', childNode)
  // Strings always go in as text, never as HTML, so player names are safe.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // A character on its dinner plate.
  function plate(character) {
    const el = h('span', { class: 'plate', 'aria-hidden': 'true' });
    if (!character) return el;
    el.style.setProperty('--c', character.color);
    if (character.image) el.append(h('img', { src: character.image, alt: '' }));
    else el.append(h('span', null, character.emoji));
    return el;
  }

  // localStorage that never throws (private browsing can block it).
  const store = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch (err) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        /* carry on without it */
      }
    },
    del(key) {
      try {
        localStorage.removeItem(key);
      } catch (err) {
        /* nothing to remove */
      }
    },
  };

  const cleanCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  // 1 -> "1st", 2 -> "2nd", 11 -> "11th"
  function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  }

  // Players sorted by score, each with a rank. Tied players share a rank.
  function ranked(players) {
    const sorted = players.slice().sort((a, b) => b.score - a.score);
    return sorted.map((p) => ({ ...p, rank: 1 + sorted.filter((o) => o.score > p.score).length }));
  }

  // The server owns the timer. This turns its timestamps into "ms left"
  // on this device, allowing for the device's clock being a little off.
  function makeClock() {
    let offset = 0;
    return {
      sync(serverNow) {
        offset = serverNow - Date.now();
      },
      left(game) {
        const t = game && game.timer;
        if (!t) return null;
        if (game.paused || !t.endsAt) return t.remainingMs;
        return Math.max(0, t.endsAt - (Date.now() + offset));
      },
    };
  }

  const points = (n) => Number(n || 0).toLocaleString('en-US');

  // Draws strokes sent as 0..1 coordinates onto a square canvas.
  function paint(canvas, strokes, from = 0) {
    const c = canvas.getContext('2d');
    const size = canvas.width;
    if (from === 0) c.clearRect(0, 0, size, size);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (let i = from; i < strokes.length; i += 1) {
      const s = strokes[i];
      c.strokeStyle = s.color;
      c.fillStyle = s.color;
      c.lineWidth = s.size * size;
      const p = s.points;
      if (p.length === 2) {
        c.beginPath();
        c.arc(p[0] * size, p[1] * size, (s.size * size) / 2, 0, Math.PI * 2);
        c.fill();
        continue;
      }
      c.beginPath();
      c.moveTo(p[0] * size, p[1] * size);
      for (let j = 2; j < p.length; j += 2) c.lineTo(p[j] * size, p[j + 1] * size);
      c.stroke();
    }
  }


  return { $, h, plate, store, cleanCode, ordinal, ranked, makeClock, points, paint };
})();
