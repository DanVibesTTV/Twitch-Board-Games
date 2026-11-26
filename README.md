# Twitch Board Games (v0.2)

Chat-playable board games as a stream overlay: a Three.js board with 3D pieces and dice, a DOM HUD, and connections to Twitch through Lumia Stream, Streamer.bot or plain anonymous chat. The first game is **Ludo**. More games plug in as add-ons and show up in the built-in game browser.

## Use it

### Option A: hosted (no install)
The overlay is published with GitHub Pages:
**https://danvibesttv.github.io/Twitch-Board-Games/**

Paste that URL plus the settings below into an OBS Browser Source. Every push to `main` runs the tests and redeploys.

### Option B: host your own copy
- **Fork** this repo, then in your fork go to **Settings → Pages → Source: "GitHub Actions"** and push any commit (or run the workflow from the Actions tab). Your copy goes live at `https://<you>.github.io/Twitch-Board-Games/`.
- **Or run it locally** (no npm install needed):
  ```bash
  node tools/serve.mjs
  ```
  Then use `http://127.0.0.1:8765/` instead of the GitHub URL. ES modules don't load from `file://`, so the folder has to be served over http.

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
| Streamer.bot | `https://danvibesttv.github.io/Twitch-Board-Games/?bridge=streamerbot` (see `docs/STREAMERBOT.md`) |

The hosted page still talks to Lumia / Streamer.bot on your own PC (`127.0.0.1`), so nothing goes through GitHub. Keep the Lumia token out of screenshots: it is part of the URL.

Options: `game=ludo` (skip the browser), `turn=30`, `lobby=45`, `vote=15`, `bots=0`, `predictions=0`, `after=menu`, `prefix=!`, `fps=60`, `volume=0.8`, `mute=1`.

**Sound:** tick **"Control audio via OBS"** on the browser source so the game shows up in the audio mixer. All sounds are synthesized in code (dice rattle, pawn steps, punch and whoosh on capture). To use your own recordings, see `sounds/README.md`. In a normal browser, click the page once to enable audio.

## Chat commands

| Who | Command | |
|---|---|---|
| everyone | `!join [color]`, `!leave` | take or leave a seat in the lobby |
| player | `!roll`, `!1` … `!9` | act on your turn (the bot plays for you on timeout, and takes over after 3 timeouts) |
| crowd | `!1` … | vote for a chat-controlled seat |
| mods | `!bg play ludo`, `!bg vote`, `!bg start`, `!bg stop`, `!bg menu`, `!bg crowd <seat>`, `!bg bot <seat>` | run the show |

When at least 2 humans play and the connection supports it (Lumia, Streamer.bot), a **Twitch prediction** with every seat as an outcome opens at game start. It resolves for the winner, or is refunded if the game is stopped.

## What each connection can do

| | Chat in | Chat out | Whisper | Predictions |
|---|---|---|---|---|
| `irc` (anonymous) | ✓ | – | – | – |
| `lumia` | ✓ | ✓ | – | ✓ |
| `streamerbot` | ✓ | ✓ | ✓ | ✓ |
| `dev` | typed | logged | logged | logged |

## Layout
```
core/        session (lobby, timers, votes, AFK, predictions), commands, registry, rng
bridges/     irc-anon, lumia, streamerbot, dev  → one interface (bridge.js)
renderer/    stage (render-on-demand), unfold (folding board), dice, pieces, view
ui/          HUD (game browser, seats, turn, moves, log, winner)
games/       add-ons: index.json + one folder per game
docs/        GAME_API.md (writing a game), STREAMERBOT.md
tests/       npm test  (logic + session, runs in Node)
```

## Status / to-do
- The 3D rendering (unfold, pawns, dice) is written but has **not been checked in a real browser yet**. Expect some tuning of the camera, sizes and timings on the first run.
- The Lumia chat format and prediction commands follow Lumia's developer docs and need a live test. Lumia offers no whisper command.
- The Streamer.bot action pack needs to be built and exported (see `docs/STREAMERBOT.md`).
- Planned: a local Node companion app (Twitch OAuth), and a Twitch Extension with a hosted backend for hidden-information games.
