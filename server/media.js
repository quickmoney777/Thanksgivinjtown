'use strict';

// Pictures and song clips.
//
// A question can point at its own file ("image": "/media/posters/jaws.jpg")
// or have one looked up online:
//   "itunes": { "kind": "album" | "song", "term": "Abbey Road Beatles" }   (covers, 30-second clips)
//   "wikipedia": "Jaws (film)"                                             (movie posters)
// A file you add always wins over a looked-up one.
//
// Apple only allows about 20 lookups a minute, so results are saved in
// content/media-cache.json. `npm run media` fills that file for every
// question ahead of time; during a game we only look up what's missing.

const fs = require('fs');
const path = require('path');
const { DIR } = require('./content');

const CACHE_FILE = path.join(DIR, 'media-cache.json');
const PUBLIC = path.join(__dirname, '..', 'public');

let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (err) {
  cache = {};
}

const keyOf = (spec) => `${spec.kind}:${spec.id || spec.term.toLowerCase()}`;

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (err) {
    /* read-only disk: keep going with what's in memory */
  }
}

const bigArt = (url) => (url ? url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1') : '');

const ENTITY = { album: 'album', movie: 'movie', song: 'song' };
// Versions we'd rather not play at a party when the original is available.
const NOT_ORIGINAL = /\b(lofi|lo-fi|remix|flip|karaoke|cover|tribute|instrumental|mashup|reprise|slowed|reverb|8d|live)\b/i;

const plain = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Polite identification for Wikipedia, without naming anyone.
const HEADERS = { 'User-Agent': 'GobbleOffPartyGame/1.0 (home trivia game)' };

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: HEADERS });
    if (!res.ok) throw new Error(`Lookup answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Wikipedia: the main picture of an article, which for a film is its poster.
async function fetchWiki(spec, timeoutMs) {
  const title = encodeURIComponent(spec.term.replace(/ /g, '_'));
  const data = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, timeoutMs);
  const original = data.originalimage;
  const thumb = data.thumbnail;
  if (!original && !thumb) return null;
  // Big originals are slow to load on a TV; ask for a 500px version instead.
  let image = original ? original.source : thumb.source;
  if (original && original.width > 1000 && thumb) image = thumb.source.replace(/\/\d+px-/, '/500px-');
  return {
    image: image.split('?')[0],
    audio: '',
    title: data.title || spec.term,
    artist: data.description || '',
    id: 0,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

// Ask iTunes (or Wikipedia). Returns { image, audio, title, artist } or
// null if nothing fits. "expect" is text the result's title or artist must
// contain, so a search for one album can't come back with another.
async function fetchSpec(spec, timeoutMs = 6000, expect = '') {
  if (spec.kind === 'wiki') return fetchWiki(spec, timeoutMs);
  const url = spec.id
    ? `https://itunes.apple.com/lookup?id=${encodeURIComponent(spec.id)}&country=US`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(spec.term)}&entity=${ENTITY[spec.kind]}&country=US&limit=25`;
  const data = await fetchJson(url, timeoutMs);
  const results = (Array.isArray(data.results) ? data.results : []).filter((r) =>
    spec.kind === 'song' ? r.previewUrl : r.artworkUrl100
  );
  const need = plain(spec.match || expect);
  const titleOf = (r) => r.trackName || r.collectionName || '';
  const artist = plain(spec.artist);
  const fits = results.filter(
    (r) =>
      (!need || plain(titleOf(r)).includes(need) || plain(r.artistName).includes(need)) &&
      (!artist || plain(r.artistName).includes(artist))
  );
  const hit = fits.find((r) => !NOT_ORIGINAL.test(titleOf(r))) || fits[0];
  if (!hit) return null;
  return {
    image: bigArt(hit.artworkUrl100),
    audio: spec.kind === 'song' ? hit.previewUrl || '' : '',
    title: titleOf(hit),
    artist: hit.artistName || '',
    id: hit.trackId || hit.collectionId || 0,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

async function resolve(spec, options = {}) {
  if (!spec) return null;
  const key = keyOf(spec);
  if (cache[key] && !options.refresh) return cache[key];
  try {
    const found = await fetchSpec(spec, options.timeoutMs, options.expect);
    if (found) {
      cache[key] = found;
      saveCache();
    }
    return found || cache[key] || null;
  } catch (err) {
    return cache[key] || null; // offline or rate-limited: use what we had
  }
}

const cached = (spec) => (spec ? cache[keyOf(spec)] || null : null);

// A path like /media/posters/jaws.jpg only counts if the file is really there.
function localOk(value) {
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  return fs.existsSync(path.join(PUBLIC, value.replace(/^\/+/, '')));
}

// Fill in a question's picture and sound from its own files or the cache.
// Returns a copy; the original from the JSON file is left alone.
function attach(question, type) {
  if (!question || question.word) return question; // drawing words have no media
  const q = { ...question };
  const found = cached(q.lookup) || {};
  const localImage = localOk(q.image) ? q.image : '';
  const localAudio = localOk(q.audio) ? q.audio : '';
  const localReveal = localOk(q.revealImage) ? q.revealImage : '';

  if (type === 'poster-reveal') {
    q.image = localImage || found.image || '';
    q.audio = localAudio;
    q.revealImage = localReveal;
  } else {
    // Song clips play during the question; the cover art appears at the reveal.
    q.image = localImage;
    q.audio = localAudio || found.audio || '';
    q.revealImage = localReveal || found.image || '';
    // With a clip playing, don't print the song title in the question.
    if (q.audio && q.listenText) q.text = q.listenText;
  }
  return q;
}

// Does this question have what its round needs to be worth playing?
function playable(question, type) {
  if (type === 'poster-reveal') return Boolean(attach(question, type).image);
  return true; // audio rounds fall back to the written question
}

// Look up anything not in the cache yet, a few at a time, within a time limit.
async function warm(questions, limit = 8, timeoutMs = 5000) {
  const missing = questions.filter((q) => q && q.lookup && !cached(q.lookup)).slice(0, limit);
  if (missing.length === 0) return;
  await Promise.race([
    Promise.all(missing.map((q) => resolve(q.lookup, { timeoutMs, expect: q.answer }))),
    new Promise((done) => setTimeout(done, timeoutMs + 500)),
  ]);
}

module.exports = { resolve, cached, attach, playable, warm, localOk, keyOf };
