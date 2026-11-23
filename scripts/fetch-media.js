'use strict';

// Looks up every picture and song clip the questions ask for and saves the
// links in content/media-cache.json, so game night doesn't depend on doing
// the lookups live. Run it after you add or change "itunes" entries:
//
//   npm run media            look up anything new
//   npm run media -- --all   look everything up again (do this the morning of)
//
// Apple allows about 20 lookups a minute, so this pauses between each one.

const content = require('../server/content');
const media = require('../server/media');

const refresh = process.argv.includes('--all');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

(async () => {
  const settings = content.loadSettings();
  const { rounds, warnings } = content.loadRounds(settings);
  warnings.forEach((w) => console.log(`Warning: ${w}`));

  const jobs = [];
  if (settings.lobbyMusic.itunes) jobs.push({ where: 'Lobby music', spec: settings.lobbyMusic.itunes, expect: '' });
  for (const round of rounds.values()) {
    for (const q of round.questions) {
      if (q.lookup) jobs.push({ where: round.title, spec: q.lookup, expect: round.type === 'multiple-choice' ? '' : q.answer });
    }
  }

  let missing = 0;
  for (const job of jobs) {
    const had = media.cached(job.spec);
    if (had && !refresh) {
      console.log(`have   ${job.where}: ${job.spec.term}  ->  ${had.title} / ${had.artist}`);
      continue;
    }
    const found = await media.resolve(job.spec, { refresh: true, timeoutMs: 10000, expect: job.expect });
    if (found) {
      console.log(`found  ${job.where}: ${job.spec.term}  ->  ${found.title} / ${found.artist}${found.audio ? '  [clip]' : ''}`);
    } else {
      missing += 1;
      console.log(`MISSING ${job.where}: ${job.spec.term} (answer: ${job.expect})`);
    }
    await wait(job.spec.kind === 'wiki' ? 400 : 3300);
  }
  console.log(`\nDone. ${jobs.length - missing} of ${jobs.length} found.${missing ? ' Add your own files for the missing ones (see MEDIA.md).' : ''}`);
})();
