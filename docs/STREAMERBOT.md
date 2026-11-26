# Streamer.bot setup

The overlay connects to Streamer.bot's WebSocket server. It reads chat from the `Twitch.ChatMessage` event and runs **named actions** for everything it sends out.

## 1. Enable the WebSocket server
Streamer.bot → **Servers/Clients → WebSocket Server**: enable it and use the defaults (`127.0.0.1`, port `8080`, endpoint `/`). Turn **authentication off** for now (the bridge doesn't do auth yet).

Overlay URL: `http://127.0.0.1:8765/?bridge=streamerbot` (add `&port=…` if you changed it).

## 2. Create the actions
Create these actions with **exactly** these names. The overlay passes arguments that you can use as `%arg%` in sub-actions.

| Action name | Arguments | What it should do |
|---|---|---|
| `BoardGames · Send Chat` | `message` | Twitch → Chat → Send Message: `%message%` |
| `BoardGames · Whisper` | `user`, `message` | send a whisper to `%user%` |
| `BoardGames · Prediction Create` | `title`, `outcomes` (`a\|b\|c`), `outcomeCount`, `seconds` | Twitch → Predictions → Create Prediction |
| `BoardGames · Prediction Lock` | – | Lock Active Prediction |
| `BoardGames · Prediction Resolve` | `winnerIndex` (1-based), `winnerTitle` | Resolve Last Prediction with outcome `%winnerIndex%` |
| `BoardGames · Prediction Cancel` | – | Cancel Active Prediction |

The Create Prediction sub-action has a fixed outcome list, but the number of players varies. Use an **Execute C# Code** sub-action that splits `outcomes` on `|`. Check the exact `CPH` prediction method names in your Streamer.bot version's C# reference.

> To-do: once tested against a live Streamer.bot, export these actions as an import string and ship it in this folder, so streamers only paste one line.

Predictions need an Affiliate or Partner channel with Channel Points enabled. You can have one prediction running at a time, with 2–10 outcomes.
