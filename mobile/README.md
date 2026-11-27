# Stream Board Games — Android app (test builds)

The phone app is the same overlay and the same games, wrapped by [Capacitor](https://capacitorjs.com).
Inside the app the **local bridge** (`bridges/local.js`) is the default: you play by tapping, and
empty seats are filled by bots. There is no chat and no Twitch connection.

## Get a test APK

1. Open the **Actions** tab → **Build Android APK** → the latest run (every PR/push that touches
   the games or `mobile/` builds one; "Run workflow" builds one by hand).
2. Download the `stream-board-games-apk` artifact and unzip it.
3. Copy the `.apk` to the phone and open it. Android asks once to allow installs from that app
   (browser / file manager).

Test builds are signed with the fixed test key in `test-signing/`, so a newer test build installs
over an older one. (Builds made before that key existed were signed with a random key per run:
uninstall that version once.) Before APKs are shared with other people we create a real signing
key once and keep it as a GitHub secret (losing it means users must uninstall).

## Try it in a browser

`node tools/serve.mjs` in the repo root, then open
`http://127.0.0.1:8765/?bridge=local` (use the browser's device toolbar for a phone-sized,
landscape viewport). `?touch=1` turns on tap-to-play with any other bridge, e.g. `?bridge=dev&touch=1`.

## Build locally (optional)

Needs Node 22+, JDK 21 and the Android SDK (Android Studio).

```sh
cd mobile
npm install
npm run android:init     # once: generates mobile/android and patches it
npm run apk              # → android/app/build/outputs/apk/debug/app-debug.apk
```

`mobile/www` and `mobile/android` are generated and not committed.

## What's in it / what's next

- Touch HUD: tap a game, pick mode and player count, **Play**; tap your move or answer.
  The ✕ button goes back to game select.
- Landscape only; the 3D board gets the space left of the side panel on any aspect ratio;
  safe areas (notches, rounded corners, system bars) via Capacitor's SystemBars plugin.
- On-screen keyboard: the window resizes, but the board keeps its size while you type
  (`renderer/stage.js`). No text fields exist yet — this matters once join codes arrive.
- Three.js is bundled, so bot games work offline. Trivia Champ uses Open Trivia DB when online
  and its built-in questions otherwise.
- Not yet: tapping pieces on the board (moves are picked in the side panel), same-WiFi
  multiplayer, over-the-air game updates, a high-resolution app icon.
