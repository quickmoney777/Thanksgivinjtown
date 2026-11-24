'use strict';

// Pin drop: "Where is Johnstown?" Everyone taps the map on their phone.
// The closer the pin, the more points, and the closest pin gets a bonus.
//
// Two maps: "usa" (the same layout as Map It) and "world" (a plain
// latitude/longitude grid). Pins travel as 0..1 positions on the map.

const { geoAlbersUsa } = require('d3-geo');

const USA = { w: 975, h: 610, rangeMiles: 500 };
const WORLD = { w: 1000, h: 500, rangeMiles: 2500 };
const usa = geoAlbersUsa().scale(1300).translate([487.5, 305]);

// lon/lat -> 0..1 on the map, or null if it can't be shown there.
function toMap(kind, lon, lat) {
  if (kind === 'world') return { x: (lon + 180) / 360, y: (90 - lat) / 180 };
  const p = usa([lon, lat]);
  return p ? { x: p[0] / USA.w, y: p[1] / USA.h } : null;
}

// 0..1 on the map -> [lon, lat], or null for a spot off the map's edge.
function fromMap(kind, x, y) {
  if (kind === 'world') return [x * 360 - 180, 90 - y * 180];
  return usa.invert([x * USA.w, y * USA.h]) || null;
}

function miles(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function prepare(raw) {
  return { pins: new Map() }; // playerId -> { x, y }
}

const seconds = (q, settings) => q.raw.timeSeconds || settings.timers.pinSeconds;

function publicView(q) {
  return { text: q.raw.text, mapKind: q.raw.mapKind };
}

function submit(q, playerId, payload) {
  if (q.data.pins.has(playerId)) return { error: 'Your pin is already in.' };
  const x = Number((payload || {}).x);
  const y = Number((payload || {}).y);
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { error: 'Tap the map to drop your pin first.' };
  q.data.pins.set(playerId, { x, y });
  return {};
}

const answered = (q) => Array.from(q.data.pins.keys());

function privateView(q, playerId) {
  const pin = q.data.pins.get(playerId);
  return pin ? { pin } : null;
}

function finish(q, settings) {
  const { pinMax, pinClosestBonus } = settings.points;
  const kind = q.raw.mapKind;
  const range = (kind === 'world' ? WORLD : USA).rangeMiles;
  const target = [q.raw.lon, q.raw.lat];
  const gains = {};
  const pins = {};
  let best = null;
  for (const [playerId, pin] of q.data.pins) {
    const spot = fromMap(kind, pin.x, pin.y);
    const off = spot ? Math.round(miles(spot, target)) : null; // null: tapped off the map
    pins[playerId] = { x: pin.x, y: pin.y, miles: off };
    if (off == null) continue;
    const points = Math.round((pinMax * Math.max(0, 1 - off / range)) / 10) * 10;
    if (points) gains[playerId] = points;
    if (!best || off < best.miles) best = { playerId, miles: off };
  }
  if (best && q.data.pins.size > 1) gains[best.playerId] = (gains[best.playerId] || 0) + pinClosestBonus;
  return {
    gains,
    reveal: {
      place: q.raw.answer,
      target: toMap(kind, q.raw.lon, q.raw.lat),
      pins,
      closestId: best ? best.playerId : '',
      fact: q.raw.fact,
    },
  };
}

const peek = (q) => q.raw.answer;
const fullPoints = (settings) => settings.points.pinMax;

module.exports = { prepare, seconds, publicView, submit, answered, privateView, finish, peek, fullPoints, toMap };
