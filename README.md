# Twitch Board Games (v0.10)

Chat-playable board games as a stream overlay: a Three.js board with 3D pieces and dice, a DOM HUD, and connections to Twitch through Lumia Stream, Streamer.bot or plain anonymous chat. Games plug in as add-ons and show up in the built-in game browser.

| Game | Players | |
|---|---|---|
| **Ludo** | 2–4 | Roll a 6 to leave the yard, race your pawns home, knock rivals back to start. |
| **Tubes & Teleporters** | 2–8 | Snakes and Ladders in a neon cyberpunk grid: teleporters beam you up, tubes suck you down. |
| **Four in a Row** | 2 | Drop discs, line up four. Modes: *Duel the Streamer*, *Viewer Duel*, *Chat vs Streamer*. |
| **Trivia Champ** | 2–6 | Trivial Pursuit style on a sci-fi holo-wheel: answer questions from Open Trivia DB, collect category wedges. Modes: *Standard* (4 wedges + final, ~20 min), *Quick* (3 wedges, ~8 min), *Classic* (6 wedges + final, ~40 min). |

## Use it

### Option A: hosted (no install)
The overlay is published with GitHub Pages:
**https://danvibesttv.github.io/Twitch-Board-Games/**

Paste that URL plus the settings below into an OBS Browser Source. Every push to `main` runs the tests and redeploys.

### Option B: companion app (runs on your PC)
A small program that serves the overlay, logs in to Twitch itself and keeps everything on your PC. You need it if you use neither Lumia Stream nor Streamer.bot but still want chat messages and predictions. It's also handy alongside them:

- **Twitch login built in:** read and write chat, plus Twitch predictions (Affiliate/Partner), with no extra app. Optionally connect your **bot account** so game messages come from the bot instead of you.
- **Stats in a file** on your PC instead of the browser source's cache, with daily backups.
- **Updates from this repo:** the app checks GitHub for new versions and installs them with one click. Your stats and login are kept.

**Windows (no install needed):**
1. Download **`StreamBoardGames-vX.Y.Z-windows-x64.zip`** from the latest [release](https://github.com/DanVibesTTV/Twitch-Board-Games/releases/latest) and extract it somewhere permanent, e.g. `Documents\StreamBoardGames`.
2. Double-click **`StreamBoardGames.exe`**. The first time, Windows may show *"Windows protected your PC"* because the exe isn't code-signed: click **More info → Run anyway**.
3. The control panel opens in your browser (`http://127.0.0.1:8765/panel/`). Click **Log in with Twitch** and confirm the code on twitch.tv.
4. In OBS, add a Browser Source with **`http://127.0.0.1:8765/?bridge=node`**. The panel's OBS section has checkboxes and fields for the game options and builds the URL for you (copy button included).

Keep the exe in its folder: it loads the game files next to it, and updates replace those files.

**macOS/Linux (or Windows with Node.js):**
1. Install **Node.js 22 or newer** ([how](#installing-nodejs)).
2. Download this repo (green **Code** button → **Download ZIP**) and extract it somewhere permanent.
3. Open a terminal in the folder and run `npm start` (same as `node app/companion.mjs`). On Windows you can double-click **`Start Board Games.bat`** instead.
4. Continue with steps 3–4 above.

Keep the app's window open while you stream. Details, troubleshooting and how updates work: [`docs/COMPANION.md`](docs/COMPANION.md).

### Option C: host your own copy
- **Fork** this repo, then in your fork go to **Settings → Pages → Source: "GitHub Actions"** and push any commit (or run the workflow from the Actions tab). Your copy goes live at `https://<you>.github.io/Twitch-Board-Games/`.
- **Or just serve the folder** without the companion's extras: `node tools/serve.mjs` (or `npm run serve`), then use `http://127.0.0.1:8765/` instead of the GitHub URL. ES modules don't load from `file://`, so the folder has to be served over http.

### Installing Node.js
Not needed for the Windows exe. Only needed for running the companion app from the source files, or `tools/serve.mjs` (and `npm test` if you work on the code). The hosted URL and GitHub Pages forks need nothing installed.

You need version **22 or newer**; just pick the current **LTS** ("Long Term Support") release.

**Windows**
1. Go to **https://nodejs.org**, download the **LTS** Windows Installer (`.msi`) and run it. Clicking *Next* through the default options is fine.
   *Or*, in a terminal: `winget install -e --id OpenJS.NodeJS.LTS`
2. **Close and reopen** any terminal windows so the `node` command is found.

**macOS**
1. Download the **LTS** macOS Installer (`.pkg`) from **https://nodejs.org** and run it.
   *Or*, with Homebrew: `brew install node`

**Linux**
Use your distro's package manager or the instructions on https://nodejs.org/en/download.

**Check it worked:** open a new terminal and run
```bash
node -v
```
It should print `v22.x.x` or higher.

**Opening a terminal in the folder** (for `npm start` or `node tools/serve.mjs`):
- Windows: open the folder in Explorer, click the address bar, type `cmd` and press Enter (or right-click an empty spot → *Open in Terminal*).
- macOS: right-click the folder in Finder → *New Terminal at Folder*.

**Troubleshooting**
- *"'node' is not recognized"* / *"command not found: node"*: the terminal was opened before Node.js was installed. Close it and open a new one (restart the PC if it still fails).
- *"needs Node.js 22 or newer"*: install the current LTS from nodejs.org over your old version.
- *"Cannot find module …"*: the terminal isn't in the repo folder. Check that the folder you opened contains `index.html` and the `app` and `tools` folders.
- *"Port 8765 is already in use"*: the app is already running in another window (or another program uses the port). Close the other window, or pick another port: `node app/companion.mjs 8766` (then use that port in the URLs).

### Try it without Twitch
Open the overlay URL with `?bridge=dev` in a normal browser. Use the box at the bottom to chat as anyone:
`!bg play ludo` → `alice: !join red` → `bob: !join` → `!bg start` → `alice: !roll` → `alice: !1`

Lines without a name are sent as the streamer. Names starting with `@` are mods.

Three.js is loaded from jsDelivr (pinned to 0.170.0, see the import map in `index.html`).

## In OBS
Add a **Browser Source** (1920×1080). Use the hosted URL (or your own / `http://127.0.0.1:8765/`) with one of these settings:

| Setup | URL |
|---|---|
| No extra app (chat read-only) | `https://danvibesttv.github.io/Twitch-Board-Games/?bridge=irc&channel=YOURNAME` |
| Lumia Stream | `https://danvibesttv.github.io/Twitch-Board-Games/?bridge=lumia&token=YOUR_LUMIA_API_TOKEN` |
| Streamer.bot | `https://danvibesttv.github.io/Twitch-Board-Games/?bridge=streamerbot` (import `streamerbot/BoardGames.sb` once, see `docs/STREAMERBOT.md`) |
| Companion app | `http://127.0.0.1:8765/?bridge=node` (only while the app runs, see [Option B](#option-b-companion-app-runs-on-your-pc)) |

The hosted page still talks to Lumia / Streamer.bot on your own PC (`127.0.0.1`), so nothing goes through GitHub. Keep the Lumia token out of screenshots: it is part of the URL.

Options: `game=ludo`, `game=tubes`, `game=four` or `game=trivia` (skip the browser; add `mode=duel` etc. for a game's mode), `turn=30`, `lobby=45`, `vote=15`, `bots=0`, `predictions=0`, `after=lobby` (rematch instead of returning to game select), `prefix=!`, `fps=60`, `volume=0.8`, `mute=1`, `stats=0`.

**Sound:** tick **"Control audio via OBS"** on the browser source so the game shows up in the audio mixer. All sounds are synthesized in code: a classic set (dice rattle, wooden steps, punch, whoosh) and a futuristic set (zaps, teleport, tube slide, win jingle). To use your own recordings, see `sounds/README.md`. In a normal browser, click the page once to enable audio.

## Chat commands

| Who | Command | |
|---|---|---|
| everyone | `!join [color]`, `!leave` | take or leave a seat in the lobby |
| player | `!roll`, `!1` … `!9` | act on your turn (the bot plays for you on timeout, and takes over after 3 timeouts) |
| crowd | `!1` … | vote for a chat-controlled seat |
| everyone | `!bgstats`, `!bgstats me`, `!bgstats <game>` | next leaderboard page on the game select screen; your own stats in chat; jump to a game's board |
| everyone (draw modes) | `!join` | enter the draw; players are picked at random when the lobby closes |
| mods | `!bg play ludo` / `!bg play tubes` / `!bg play four [streamer\|duel\|chat]` / `!bg play trivia [standard\|quick\|classic]`, `!bg mode <mode>`, `!bg cat …` (trivia categories), `!bg vote`, `!bg start`, `!bg stop`, `!bg menu`, `!bg crowd <seat>`, `!bg bot <seat>`, `!bg bots <n>`, `!bg stats reset [game] confirm` | run the show (`!bg bots 6` = bots fill up to 6 seats, `0` = no bots) |

While a lobby is open, the board area shows a **How to play** panel with the game's steps, the join call-to-action and a big countdown that turns red in the last 10 seconds. Chat gets reminders at **30 s and 10 s left**, with the seat or entry count. Short countdowns skip the reminders that wouldn't fit.

When at least 2 humans play and the connection supports it (Lumia, Streamer.bot, companion app), a **Twitch prediction** with every seat as an outcome opens at game start. It resolves for the winner, or is refunded if the game is stopped or ends in a draw. A chat-vote seat counts as a player, so *Chat vs Streamer* gets a prediction too.

## Trivia Champ
- **Turn:** `!roll`, then pick a destination (`!1`…). You move exactly the number rolled, you can't step back, and you can turn at an HQ or the hub. You then answer a question in that space's category (`!1`–`!4`, 30 s). A right answer lets you roll again, and on a category HQ it also earns that wedge. A wrong answer or a timeout passes the turn. Roll-again spaces skip the question, and on the hub you pick the category.
- **Winning (Standard/Classic):** with enough wedges, reach the hub and answer a final question. The *next player* picks its category.
- **Categories:** General Knowledge, History, Entertainment (Film + Music + TV + Video Games), Science & Nature, Mathematics, Comics. Mods change them in the lobby with `!bg cat <1-6> <category>` (e.g. `!bg cat 6 sports`), list them with `!bg cat`, and reset with `!bg cat reset`. Choices are saved. Available: general, history, entertainment, science, math, comics, arts, books, film, music, theatre, tv, videogames, boardgames, computers, mythology, sports, geography, politics, art, celebrities, animals, vehicles, gadgets, anime, cartoons.
- **Questions** come from the [Open Trivia Database](https://opentdb.com) (CC BY-SA 4.0, credited on screen). The API allows one request per IP every 5 seconds, so questions start loading as soon as the lobby opens, and unused ones are cached for next time. A session token avoids repeats. If the API can't be reached, a small built-in question set keeps the game going.
- A crowd seat (`!bg crowd <seat>`) works too: chat votes on moves and answers.

## Viewer stats
The game select screen shows a leaderboard. `!bgstats` turns the page: **most wins across all games**, then **longest winning streak**, then **most wins per game** (a game's page appears once it has results). `!bgstats me` posts your own numbers in chat: wins, games played, best streak, current streak and best game.

- Only human players count; bots and chat-vote seats are never credited.
- Everyone seated at the start has played, even if they leave or go AFK. Leaving can't protect a streak, and a bot playing for you can't win for you.
- A win adds to your streak, a loss resets it, and a draw leaves it unchanged. Games stopped with `!bg stop` aren't recorded.
- Stats are saved in the browser source's own storage (localStorage). They survive OBS restarts, but they belong to that one URL in that one browser: the hosted page and `127.0.0.1` keep separate stats, and clearing the browser source's cache can delete them.
- With the **companion app** (`?bridge=node`) stats go to a file on your PC instead, with daily backups. The first time the overlay connects to the app, stats that browser source already saved for `127.0.0.1:8765` are copied into the file (stats from the hosted GitHub URL live under a different address and stay there).
- Turn stats off with `&stats=0`; mods reset them with `!bg stats reset confirm` (or `!bg stats reset four confirm` for one game).

## What each connection can do

| | Chat in | Chat out | Whisper | Predictions |
|---|---|---|---|---|
| `irc` (anonymous) | ✓ | – | – | – |
| `lumia` | ✓ | ✓ | – | ✓ |
| `streamerbot` | ✓ | ✓ | ✓ | ✓ |
| `node` (companion app) | ✓ | ✓ | – | ✓ |
| `dev` | typed | logged | logged | logged |

## Layout
```
core/        session (lobby, timers, votes, AFK, predictions), commands, registry, rng
bridges/     irc-anon, lumia, streamerbot, dev  → one interface (bridge.js)
renderer/    stage (render-on-demand), unfold (folding board), dice, pieces, view
ui/          HUD (game browser, seats, turn, moves, log, winner)
games/       add-ons: index.json + one folder per game
docs/        GAME_API.md (writing a game), STREAMERBOT.md (Streamer.bot setup)
streamerbot/ BoardGames.sb (Streamer.bot import file) + the C# source of its bridge action
tests/       npm test  (logic + session, runs in Node)
```

## Status
- **Tested live:** Ludo and Tubes & Teleporters in OBS. Twitch predictions work through both Lumia Stream and Streamer.bot.
- Lumia has no whisper command, so future hidden-information games will need Streamer.bot for private hands.
- **Companion app** (0.8): Twitch login, stats file, one-click updates, OBS URL builder. Tested live.
- **Bot account** (0.9): optional bot for the companion's chat messages (first release delivered through the in-app updater). Tested live.
- **New in 0.10:** Windows exe (`StreamBoardGames.exe`), so streamers don't need Node.js. Built and smoke-tested by GitHub Actions for every release.
- **Planned:** a Twitch Extension with a hosted backend for hidden-information games.
