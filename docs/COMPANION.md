# Companion app

`app/companion.mjs` is a small, dependency-free Node.js program (Node 22+) that runs on the streamer's PC. It:

- serves the overlay at `http://127.0.0.1:8765/` and a control panel at `/panel/`
- logs in to Twitch and connects the overlay to chat and predictions (`?bridge=node`)
- saves the overlay's data (viewer stats, trivia categories, question cache) in a file
- checks this repo for new versions and installs them on request

Start it with **`Start Board Games.bat`** (Windows, double-click) or `npm start` / `node app/companion.mjs [port] [--no-panel]`.

## Twitch login
The panel's **Log in with Twitch** button uses Twitch's *device code* login: a code appears, you confirm it on twitch.tv/activate, and the app gets a token. Log in with the channel you stream on. Game messages are sent to chat from that account.

Permissions requested: `user:read:chat` (read chat), `user:write:chat` (send game messages), `channel:manage:predictions` (predictions; Twitch only allows them for Affiliate/Partner channels).

The token is stored in `auth.json` in the data folder and refreshed automatically. **Log out** in the panel deletes it and revokes it at Twitch.

### Bot account (optional)
By default the game's chat messages come from the streamer's account. To have them come from a bot account instead, click **Connect bot account** in the panel (after logging in with your streaming account):

1. **Copy the link into a private/incognito window.** twitch.tv/activate uses whichever account is logged in, and in your normal browser that's usually you.
2. Log in there with the bot account and confirm the code.

The bot only gets `user:write:chat`. Chat is still read and predictions still run through the streamer's account. Make the bot a moderator (`/mod botname`) so slow mode, follower-only mode or link filters don't block it. If the bot can't post (banned, timed out, restricted), the message goes out from the streamer's account instead and the panel shows why. The bot's login is stored in `auth-bot.json`; **Disconnect bot** deletes it.

If you accidentally confirm the code with your streaming account, the app notices and asks you to try again in a private window.

### The Twitch app (client ID)
Logging in needs the client ID of an app registered at Twitch. This repo's app is **Stream Board Games - companion app**; its client ID is in `app/twitch-app.json` and shared by everyone using this repo (client IDs are not secret). That's the name streamers see on the Twitch login screen.

To register one (repo owner, or anyone who wants their own):
1. Go to https://dev.twitch.tv/console/apps → **Register Your Application**.
2. Name: e.g. `Stream Board Games - companion app` (Twitch doesn't allow "Twitch" in app names). OAuth Redirect URL: `http://localhost` (required by the form, not used). Category: *Game Integration*. **Client Type: Public**.
3. Copy the **Client ID** into `app/twitch-app.json` (repo) or the panel's **Settings → Twitch client ID** (just your PC).

## Where things are saved
| OS | Data folder |
|---|---|
| Windows | `%APPDATA%\TwitchBoardGames` |
| macOS | `~/Library/Application Support/TwitchBoardGames` |
| Linux | `~/.config/twitch-board-games` |

Override it with the `BOARDGAMES_DATA` environment variable.

- `data.json`: what the overlay saves (viewer stats etc.)
- `settings.json`: panel settings
- `auth.json`: Twitch login. **Keep it private.**
- `auth-bot.json`: the bot account's login, if connected. **Keep it private.**
- `backups/`: `data-YYYY-MM-DD.json` once a day (last 14), and `data-before-vX.json` before each update (last 5). To restore, close the app and copy a backup over `data.json`.
- `installed-files.json`: which files the last update installed (used to remove files a later release deletes)

The first time an overlay connects to the app, any stats that browser source saved in its own storage for `127.0.0.1:8765` are copied into `data.json`.

## Updates
- The app compares its version (`package.json`) with the **latest GitHub Release** of the update repo, at start and every 6 hours (switch this off in Settings). The panel shows the release notes and an **Install** button. The console prints a line too.
- **Install** downloads the release, checks it looks like this project, backs up your stats, copies the new files over the program folder, and restarts the app. The overlay in OBS reconnects by itself and reloads into the new version once it's back on the game select screen, so a running game isn't interrupted.
- Never touched: the data folder, files you added yourself, and `sounds/sounds.json` once you've edited it.
- If the folder is a **git clone** the app won't overwrite it. Use `git pull`.
- Forks: set **Settings → Update from repository** to your `owner/repo`.

### Publishing an update (maintainers)
`.github/workflows/release.yml` creates a GitHub Release (tag `vX.Y.Z`, notes generated from merged PRs) whenever `package.json`'s `version` changes on `main` and the tests pass. Bump the version in a PR when the change should reach streamers; docs-only PRs can skip the bump.

## Security notes
- The server only listens on `127.0.0.1` and only answers requests addressed to `127.0.0.1`/`localhost`.
- Every API call except the event stream needs an `X-BoardGames: 1` header. Websites can't add that header to requests to your PC without permission the app never grants, so a web page you visit can't post in your chat or trigger an update.

## Troubleshooting
- **Overlay shows "companion app not running?"**: start the app; the overlay reconnects by itself.
- **"log in to Twitch in the companion app"**: open the panel (`http://127.0.0.1:8765/panel/`) and log in.
- **Predictions fail**: Twitch only allows predictions on Affiliate/Partner channels, and only one at a time (end any manual prediction first).
- **"Port 8765 is already in use"**: the app is already running in another window, or start it on another port: `node app/companion.mjs 8766`.
