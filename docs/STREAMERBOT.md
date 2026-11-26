# Streamer.bot setup

The overlay connects to Streamer.bot's WebSocket server. It reads chat from the `Twitch.ChatMessage` event and runs **two actions** for everything it sends out: chat messages, whispers and predictions. Setup takes about 2 minutes: turn on the WebSocket server and import one file.

## 1. Enable the WebSocket server
Streamer.bot → **Servers/Clients → WebSocket Server**:
- **Auto Start** and **Start Server**: on
- Address `127.0.0.1`, port `8080`, endpoint `/` (the defaults)
- **Authentication: off** (the overlay doesn't support WebSocket passwords yet)

Overlay URL: `https://danvibesttv.github.io/Twitch-Board-Games/?bridge=streamerbot` (add `&port=…` if you changed the port).

## 2. Import the actions (one click)
1. Download [`streamerbot/BoardGames.sb`](../streamerbot/BoardGames.sb). On GitHub, open the file and click the **Download raw file** button.
2. In Streamer.bot, click **Import** at the top.
3. Drag the `.sb` file into the **Import String** field, or open it in a text editor and paste its contents there.
4. Check that you see **BoardGames** with 2 actions, then click **Import**.
5. Open the action `BoardGames · Bridge`, double-click the *Execute C# Code* sub-action and click **Compile** once. The log should say *Compiled successfully*. Then **Save and Compile**.

That's it. Start a game with at least 2 human players and a prediction opens with every seat as an outcome. It resolves for the winner, or is cancelled (points refunded) if a mod types `!bg stop`.

The pack contains only these two actions: no commands, timers or triggers, and nothing that changes your existing setup.

### Manual setup (if the import doesn't work)
**`BoardGames · Bridge`** handles chat messages, whispers, and creating, locking and cancelling predictions.
1. **Actions** tab → right-click → **Add**. Name: `BoardGames · Bridge` (exactly, including the `·`). No trigger.
2. Sub-Actions → right-click → **Core → C# → Execute C# Code**. Replace the example code with [`streamerbot/BoardGamesBridge.cs`](../streamerbot/BoardGamesBridge.cs) → **Compile** → **Save and Compile**.

**`BoardGames · Resolve`** pays out the prediction.
1. Add an action named `BoardGames · Resolve`. No trigger.
2. Sub-Actions → right-click → **Twitch → Predictions → Resolve Last Prediction**, index `%winnerIndex0%`.

### Updating the pack
If `BoardGamesBridge.cs` changes, re-import the new `.sb`, or paste the new C# into the existing sub-action. To make a new export: select both actions → right-click → **Export**.

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
- **No chat messages or predictions**: open Streamer.bot's **Action History**. If the actions don't appear there, they weren't imported or the names don't match exactly. If they appear with errors, check the log and recompile the C# sub-action.
- **The prediction isn't resolved**: check that `BoardGames · Resolve` uses `%winnerIndex0%`, not `%winnerIndex%`.
