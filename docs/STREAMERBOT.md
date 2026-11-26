# Streamer.bot setup

The overlay connects to Streamer.bot's WebSocket server. It reads chat from the `Twitch.ChatMessage` event and runs **two actions** for everything it sends out: chat messages, whispers and predictions.

> **One-click import:** once `streamerbot/BoardGames.import.txt` exists in this repo, paste its contents into Streamer.bot → **Import** and skip step 2. Until then, set it up by hand (about 5 minutes, once).

## 1. Enable the WebSocket server
Streamer.bot → **Servers/Clients → WebSocket Server**:
- **Auto Start** and **Start Server**: on
- Address `127.0.0.1`, port `8080`, endpoint `/` (the defaults)
- **Authentication: off** (the overlay doesn't support WebSocket passwords yet)

Overlay URL: `https://danvibesttv.github.io/Twitch-Board-Games/?bridge=streamerbot` (add `&port=…` if you changed the port).

## 2. Create the two actions
Action names must match **exactly**, including the `·` (middle dot). Copy them from here.

### Action 1: `BoardGames · Bridge`
Handles chat messages, whispers, and creating, locking and cancelling predictions.
1. **Actions** tab → right-click → **Add**. Name: `BoardGames · Bridge`, Group: `BoardGames`. Leave everything else at the defaults. No trigger is needed.
2. In the Sub-Actions panel, right-click → **Core → C# → Execute C# Code**.
3. Delete the example code and paste the entire contents of [`streamerbot/BoardGamesBridge.cs`](../streamerbot/BoardGamesBridge.cs).
4. Click **Compile**. The log at the bottom should say *Compiled successfully*. Then click **Save and Compile**.

### Action 2: `BoardGames · Resolve`
Pays out the prediction to whoever bet on the winner.
1. Add another action, named `BoardGames · Resolve`, Group: `BoardGames`. No trigger.
2. Sub-Actions → right-click → **Twitch → Predictions → Resolve Last Prediction**.
3. In the index field, enter `%winnerIndex0%`. This is the zero-based number of the winning outcome, which the overlay sends.

That's it. Start a game with at least 2 human players and a prediction opens with every seat as an outcome. It resolves for the winner, or is cancelled (points refunded) if a mod types `!bg stop`.

## 3. Share it (export)
Once both actions work, select them in the Actions list → right-click → **Export**, and copy the export string. Saved as `streamerbot/BoardGames.import.txt` in this repo, it lets other streamers skip step 2.

## What the overlay sends

| Action | Arguments |
|---|---|
| `BoardGames · Bridge` | `op=chat`, `message` |
| | `op=whisper`, `user`, `message` |
| | `op=predictionCreate`, `title`, `outcomes` (`a\|b\|c`, 2–10), `seconds` |
| | `op=predictionLock` / `op=predictionCancel` |
| `BoardGames · Resolve` | `winnerIndex0` (0-based), `winnerIndex` (1-based), `winnerTitle` |

All arguments are strings. The prediction id is kept in the non-persisted global variable `boardGamesPredictionId`.

## Requirements and limits
- Predictions need an **Affiliate or Partner** channel with Channel Points enabled, and Streamer.bot connected to your *broadcaster* account. You can have one prediction running at a time, with 2–10 outcomes and a betting window of 30 s to 30 min.
- Whispers are sent from your bot account, which needs a verified phone number. Twitch limits whispers to 40 different recipients per day. No game uses whispers yet.

## Troubleshooting
- **The overlay shows "is the Streamer.bot WebSocket server started?"**: check step 1, and that nothing else uses port 8080.
- **The overlay shows "authentication is on"**: turn off WebSocket authentication.
- **No chat messages or predictions**: open Streamer.bot's **Action History**. If the actions don't appear there, the names don't match exactly. If they appear with errors, check the log.
- **The prediction isn't resolved**: check that `BoardGames · Resolve` uses `%winnerIndex0%`, not `%winnerIndex%`.
