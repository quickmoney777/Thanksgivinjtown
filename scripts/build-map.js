'use strict';

// Builds public/data/us-states.json: one SVG path per state, already laid out
// as a US map (Alaska and Hawaii tucked in the corner). The game uses it for
// "which state is this?" outlines and for highlighting states on the map.
//
// You only need to run this if the file is ever lost:
//   npm install --no-save us-atlas topojson-client topojson-simplify
//   node scripts/build-map.js
//
// Shapes come from the US Census Bureau via the us-atlas package (ISC license).

const fs = require('fs');
const path = require('path');
const topojson = { ...require('topojson-client'), ...require('topojson-simplify') };

const FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
  '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
  '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
  '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY',
};

const source = require('us-atlas/states-albers-10m.json');
// Drop detail too small to see on a TV. Keeps the file light.
const simple = topojson.simplify(topojson.presimplify(source), 0.6);
const features = topojson.feature(simple, simple.objects.states).features;

const round = (n) => Math.round(n * 10) / 10;

// The US map layout tilts states away from the middle of the country, so
// Maine leans one way and California the other. For "which state is this?"
// we also store each state turned north-up, the way an atlas shows it.
// The tilt is about 0.6 degrees for every degree of longitude from 96W.
const lonLat = require('us-atlas/states-10m.json');
const centerLon = {};
for (const f of topojson.feature(lonLat, lonLat.objects.states).features) {
  let min = Infinity;
  let max = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      // Alaska's far islands cross the date line; keep them on one side.
      const lon = c[0] > 0 ? c[0] - 360 : c[0];
      min = Math.min(min, lon);
      max = Math.max(max, lon);
    } else c.forEach(visit);
  };
  visit(f.geometry.coordinates);
  centerLon[f.id] = (min + max) / 2;
}

function outline(polygons, turnDegrees) {
  const a = (turnDegrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let d = '';
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 4) continue;
      ring.forEach(([px, py], i) => {
        const x = px * cos - py * sin;
        const y = px * sin + py * cos;
        d += `${i === 0 ? 'M' : 'L'}${round(x)},${round(y)}`;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      });
      d += 'Z';
    }
  }
  return { d, box: [round(x0), round(y0), round(x1 - x0), round(y1 - y0)] };
}

const states = {};
for (const feature of features) {
  const code = FIPS[feature.id];
  if (!code) continue;
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  // Alaska and Hawaii are placed separately on the map and are already upright enough.
  const tilt = code === 'AK' || code === 'HI' ? 0 : 0.603 * (centerLon[feature.id] + 96);
  const onMap = outline(polygons, 0);
  states[code] = { name: feature.properties.name, d: onMap.d, box: onMap.box, solo: outline(polygons, tilt) };
}

const out = { viewBox: '0 0 975 610', states };
const file = path.join(__dirname, '..', 'public', 'data', 'us-states.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
console.log(`Wrote ${Object.keys(states).length} states, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
