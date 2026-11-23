# The Great Gobble-Off

A party game for the living room. One laptop shows the game on the TV;
everyone else plays from their phone's browser. No apps, no logins.

- [Run it](#run-it)
- [Game night checklist](#game-night-checklist)
- [The three screens](#the-three-screens)
- [The rounds](#the-rounds)
- [Edit the content](#edit-the-content)
- [Pictures, song clips and music](#pictures-song-clips-and-music)
- [Put it on the internet (Render)](#put-it-on-the-internet-render)
- [Test it](#test-it)
- [If something goes wrong](#if-something-goes-wrong)

See also [VERIFY.md](VERIFY.md) (facts to check) and [MEDIA.md](MEDIA.md)
(where every picture and clip comes from).

## Run it

```bash
npm install
npm start
```

Open <http://localhost:3030/host> on the laptop and choose **Open the room**.
The terminal prints the address phones should use.

Run this way, phones must be on the same Wi-Fi as the laptop. The first time,
macOS may ask whether Node can accept incoming connections: choose Allow.
To let phones join from any network, [put it on Render](#put-it-on-the-internet-render).

## Game night checklist

1. The morning of: run `npm run media -- --all` to refresh the picture and
   clip links, then `npm test`.
2. Connect the laptop to the TV and turn the TV's sound up.
3. Open the host page, choose **Open the room**, press **F** for full screen.
4. Move the mouse, choose **Phone remote**, scan that code with your own
   phone, then close it.
5. Everyone scans the big code on the TV, types a name and picks a character.
6. On your remote: tick the rounds you want, switch on **Play in two teams**
   if you like, and press **Start game**.

A full game with every round takes about 45 minutes. Each round is five
questions (change `questionsPerRound` in the settings).

## The three screens

| Screen | Address | Who uses it |
| --- | --- | --- |
| Host screen | `/host` | The laptop, shown on the TV |
| Player | `/` (the QR code points here) | Everyone's phone |
| Host remote | Scan the code under **Phone remote** on the host screen | Your phone only |

**Host screen keys:** Enter or → moves on (start, next question, next round).
P or Space pauses. M mutes. F is full screen. R shows the remote code.
Move the mouse to show the buttons.

**The remote** does everything the keys do, plus: choose rounds, turn teams
on, skip a question or a round, end the game early, add or take points, move
a player to the other team, and remove a player. It also shows you the
answer to the current question. Nobody else can see that.

**Phones** that go to sleep or get refreshed come back to the same seat with
the same score, as long as they use the same browser.

## The rounds

| Round | File | How it plays |
| --- | --- | --- |
| Buckeyes & Keystone | `buckeyes-keystone.json` | Multiple choice. Ohio State, Pennsylvania, Pittsburgh, Johnstown. |
| Map It | `map-it.json` | A state outline or a lit-up US map. The reveal shows where it is. |
| Poster Reveal | `poster-reveal.json` | A blurred album cover or movie poster sharpens over 20 seconds. Fast answers score much more. |
| Name the Artist | `name-the-artist.json` | A 30-second clip plays on the TV. The cover slides out at the reveal. |
| Sketch It | `sketch.json` | One player draws a secret word on their phone. It appears live on the TV and everyone else types guesses. |
| Around the World | `around-the-world.json` | Multiple choice, general knowledge. |
| Bluff Round | `bluff.json` | Everyone types a fake answer, then votes for the one they think is real. |
| Bollywood Bonus | `bollywood.json` | Multiple choice with song clips, written so people who've never heard the songs can guess. Off unless you tick it. |

**Scoring.** A right answer is 500 points plus up to 500 for speed. Poster
Reveal is 250 plus up to 1,000 for speed. In the Bluff Round, finding the
truth is 1,000 and every player your fake fools is 500. In Sketch It, a right
guess is 500 plus up to 500 for speed, and the artist gets 300 for each
player who gets it. All of these are in `content/settings.json`.

**Teams.** With **Play in two teams** on, players are dealt into Team Scarlet
and Team Gray. Everyone still answers on their own phone; a team's score is
its players' scores added up. The TV shows both, and the winner screen
crowns the team and names the top scorer. In Sketch It everyone except the
artist guesses, whichever team they're on.

## Edit the content

Everything you'd want to change is in `content/`. Edits are picked up when
you start the next game. On the remote, **Reload question files** refreshes
the list of rounds without closing the room.

If a file has a typo, that round shows a warning on the remote and the rest
of the game still works. A question with a problem is skipped, not shown.

### settings.json

| Setting | What it does |
| --- | --- |
| `gameTitle` | The name on every screen |
| `questionsPerRound` | How many questions are drawn from each file |
| `autoAdvance` | `true`: reveals and scoreboards move on by themselves after a few seconds. `false`: they wait for you to press Next |
| `roundOrder` | Which rounds, in which order (file names without `.json`) |
| `bonusRounds` | Rounds that are offered on the remote but not ticked |
| `timers` | Seconds for each kind of question and each pause |
| `points` | Points for each kind of answer |
| `teams` | The two team names and colors |
| `lobbyMusic` | The soundtrack for the lobby and winner screen |

### characters.json

Each character has a `name`, an `emoji` (or an `image`), a `color` and a
`catchphrase`. There is one seat per character, so a sixth character adds a
sixth seat. For a picture instead of an emoji, put the file in
`public/media/characters/` and set `"image": "/media/characters/your-file.png"`.

### Question files

Every file in `content/questions/` starts the same way:

```json
{
  "title": "Around the World",
  "type": "multiple-choice",
  "icon": "🌍",
  "tagline": "One line shown when the round starts.",
  "questions": []
}
```

`type` is one of `multiple-choice`, `poster-reveal`, `name-the-artist`,
`map-it`, `bluff` or `draw`. To add a whole new round, copy a file, rename it,
and add its name to `roundOrder` in the settings.

**A multiple-choice question** (this shape works in all four choice types):

```json
{
  "question": "What is the capital of Canada?",
  "answer": "Ottawa",
  "wrong": ["Toronto", "Montreal", "Vancouver"],
  "fact": "Optional. Shown under the answers at the reveal."
}
```

The right answer and the wrong ones are shuffled each time, so order doesn't
matter. Give one to five wrong answers. Avoid "All of the above". If the
order does matter, list them yourself with `"choices": ["A", "B", "C"]`
instead of `"wrong"`, and make `"answer"` match one of them exactly.

Optional extras on any choice question:

| Field | What it does |
| --- | --- |
| `"image": "/media/posters/jaws.jpg"` | A picture shown with the question (blurred in Poster Reveal) |
| `"audio": "/media/audio/clip.mp3"` | A clip that plays during the question |
| `"itunes": { "kind": "album", "term": "Rumours Fleetwood Mac", "artist": "Fleetwood Mac" }` | Look the cover up on iTunes. `kind` is `album` or `song`; a song also brings its 30-second clip |
| `"wikipedia": "Jaws (film)"` | Use the main picture of that Wikipedia article (movie posters) |
| `"listenQuestion": "Who is this?"` | The wording used when a clip is playing, so the title isn't printed on screen |
| `"map": { "show": "outline", "state": "OH" }` | `outline` shows the state alone, `highlight` lights it up on the US map, `blank` shows the plain map and lights it at the reveal. `"also": ["MI"]` lights extra states in a second color |
| `"timeSeconds": 30` | A different timer for this one question |
| `"verify": true` | Keeps the question out of the game until you remove the line |

**A bluff question.** Write it with a blank. `decoys` are extra fakes the
game adds when there are fewer than three player fakes.

```json
{
  "question": "A group of turkeys is called a ____.",
  "answer": "Rafter",
  "decoys": ["Gobble", "Strut", "Waddle"]
}
```

**A drawing word.** `accept` lists other guesses that count. Capitals,
punctuation, a final "s" and one typo in longer words are already forgiven.

```json
{ "word": "Ketchup", "accept": ["catsup", "heinz"] }
```

## Pictures, song clips and music

You don't need to add any files. Album covers and song clips come from
Apple's free iTunes lookup, movie posters come from Wikipedia, and the state
shapes are built in. The links are saved in `content/media-cache.json`.

- `npm run media` looks up anything new after you add questions.
- `npm run media -- --all` looks everything up again. Do this the morning of
  the game, because Apple's clip links can change.
- Any file you add yourself wins over a looked-up one. [MEDIA.md](MEDIA.md)
  lists every question and where to put a replacement.

**Lobby music.** The lobby plays Apple's 30-second preview of "Here Comes the
Sun" on a loop. For the whole song, save your own copy as
`public/media/music/lobby.mp3`. To change or remove it, edit `lobbyMusic` in
the settings (`"enabled": false` turns it off).

The game needs the internet during play for covers and clips, even when you
run it on your laptop.

## Put it on the internet (Render)

This lets phones join from any network, with no Wi-Fi fuss. It is free.

1. Put the project on GitHub (a private repository is fine):
   ```bash
   git init
   git add .
   git commit -m "The Great Gobble-Off"
   ```
   Then create an empty repository on github.com and follow its "push an
   existing repository" steps.
2. On [render.com](https://render.com), choose **New > Blueprint**, pick the
   repository, and accept the defaults. The `render.yaml` file in this
   project sets everything up.
3. When it finishes you get an address like `https://gobble-off.onrender.com`.
   Open `/host` on it. The QR code now points at that address by itself.

Good to know about the free plan:

- The server goes to sleep after about 15 minutes with nobody on it and
  takes about a minute to wake. Open the host page a few minutes before you
  want to play. While the host page is open it keeps the server awake.
- If the server restarts, open rooms are lost. The host screen opens a fresh
  room by itself and phones are asked for the new code.
- After you change questions, commit and push again and Render redeploys.

## Test it

```bash
npm test
```

This starts a private copy of the server, plays a whole game through every
round with four pretend players in about ten seconds, and checks the rules:
scoring, pausing, reconnecting, the bluff and drawing rounds, teams, and that
answers never reach a screen early. Run it after editing questions; it also
reports any question file with a mistake.

To try two phones on one computer, use a normal window and a private window.
Two tabs in the same window share one seat.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Phones can't load the page | Same Wi-Fi as the laptop? Did you allow Node through the Mac firewall? Guest Wi-Fi networks often block this; use Render instead |
| A phone shows "Reconnecting…" | It will fix itself. If not, refresh the page; the seat comes back |
| Someone joined twice | Remove the extra on the remote |
| No sound on the TV | Press M (mute toggle). Check the TV input volume. Sound only starts after **Open the room** is clicked |
| A song clip doesn't play | The question still works as written text. Run `npm run media -- --all` |
| A wrong answer was marked right | Add or take points on the remote, and fix the file later |
| A question is a dud | **Skip question** on the remote. Nobody scores |
| The game is stuck | **Next** on the remote always moves on. Worst case: **End game**, then start again; scores can be re-entered by hand |
| `npm install` fails with EACCES | Run `sudo chown -R $(whoami) ~/.npm` once, then try again |

## How it's built

Node, Express and Socket.IO. One server holds every room in memory. The
screens are plain HTML, CSS and JavaScript with no build step.

- `server/engine.js` runs every round through the same loop: question,
  timer, lock in, reveal, scores.
- `server/modes/` has one small file per kind of question
  (`multiple-choice.js` covers four round types, plus `bluff.js` and
  `draw.js`). A new kind of round is a new file here and a view in
  `public/js/views.js`.
- `server/media.js` finds pictures and clips. `server/content.js` reads and
  checks the JSON files.
- `public/js/host.js` is the TV, `play.js` the phones, `remote.js` your remote.
