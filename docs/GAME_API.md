# Writing a game add-on

A game is a folder in `games/<id>/` plus one line in `games/index.json`. The core does everything else: lobby, seats, turn timers, AFK bots, crowd votes, predictions and chat.

```
games/
  index.json            ["ludo", "yourgame"]
  yourgame/
    manifest.json
    index.js            export { createGame } and { createRenderer }
    logic.js            rules (no DOM, no Three.js — runs in Node tests)
    renderer.js         Three.js visuals
    thumbnail.svg
```

## manifest.json

| field | meaning |
|---|---|
| `id`, `name`, `tagline`, `version` | shown in the game browser |
| `coreVersion` | core version the game targets; a different major version means the game is skipped |
| `players` | `{ "min": 2, "max": 8, "botFillTo": 4 }`. `botFillTo` (optional) = how many seats bots fill up to by default; mods change it with `!bg bots <n>` |
| `seats` | `[{ "id": "red", "name": "Red", "color": "#e5484d" }, …]`. Viewers type `!join <id>` |
| `needs` | `[]`, or any of `"hiddenInfo"`, `"sendChat"`, `"predictions"`. The game is greyed out if the bridge can't provide them |
| `commands` | help lines shown in the lobby |
| `modes` | optional ways to play, e.g. `[{ "id": "streamer", "name": "Duel the Streamer", "description": "…", "seats": { "red": "host" }, "entry": "draw" }]`. Seat roles: `host` (reserved for the broadcaster) and `crowd` (chat votes). `entry: "draw"` = viewers `!join` a pool and open seats are drawn at random when the lobby closes. The first mode is the default; mods pick one with `!bg play <game> <mode>` or `!bg mode <mode>`. |
| `defaultRules` | passed to `createGame` as `rules` |

## Logic: `createGame({ seats, rng, rules })`

`seats` is the list of seat ids in turn order (only the seats in play). Always use `rng` (`rng.int(1, 6)`, `rng.next()`, `rng.pick(arr)`), never `Math.random`, so games can be replayed from their seed.

Return an object with:

```js
{
  state,                 // anything serializable; the renderer reads it
  decision(),            // what happens next, or null when the game is over:
                         //   { seat, kind, prompt, options: [{ label, alias?, data? }] }
                         //   seat = index into `seats`. Chat picks with !1..!n, or !<alias>.
  apply(optionIndex),    // perform it → { events: [...], log: ["text", …] }
  botChoice(),           // index the bot (and AFK fallback) would pick
  ranking(),             // seat indices, winner first
  isDraw(),              // optional: true when the game ended without a winner (prediction gets refunded)
}
```

Options can be `disabled: true` (for example a full column). They stay in the list, so `!3` always means option 3; the core rejects disabled picks and the HUD greys them out. With 6 or more options the HUD shows a compact number grid.

**Everything is a decision.** Rolling dice is a decision with one option (`alias: 'roll'`). The game rolls inside `apply()`. Keep option lists short (ideally 9 or fewer). If a turn has many possibilities, split it into steps, for example "pick a piece" and then "pick a target".

`events` are for the renderer only (for example `{type:'move', …}`). The core passes them through untouched.

### Optional extras

| Export / field | What it does |
|---|---|
| `preload({ manifest, mode })` | called when the lobby opens; start loading data here (Trivia Champ fetches questions) |
| `async prepare({ manifest, mode, rules })` | awaited before `createGame` (max 15 s); whatever it returns arrives as `createGame({ ctx })` |
| `adminCommand(sub, arg, { say, prefix, refresh })` | handle your own `!bg <sub>` commands in the lobby; return `true` if handled, call `refresh()` to redraw the lobby |
| `lobbyInfo()` | `{ chips: [{ color, label, ready }], note }` shown in the lobby panel |
| `game.timeoutChoice()` | what a timeout means for the current decision (e.g. `'timeout'` = wrong answer); return `undefined` to let the bot move |
| `decision.seconds` | time limit for this decision instead of the default turn time |
| `decision.question` | `{ text, category, color, difficulty, final, hq, source }`: the HUD shows a big question card; an `{ type: 'answer', correctIndex, chosen, correct, timeout }` event reveals the result |
| `mode.rules` (manifest) | rules merged over `defaultRules` for that mode |

The HUD also receives each move's events (`session.on('gameEvents')`), so games can drive HUD effects like the answer reveal.

## Renderer: `createRenderer(stage, { seats })`

`stage` is the shared `Stage` (`stage.scene`, `stage.animate(ms, t => …)`, `stage.wait(ms)`, `stage.frame(size, opts)`, `stage.invalidate()`). Return:

```js
{
  async intro(game),           // board unfold etc. (renderer/unfold.js does the folding board)
  async present(events, game), // animate events; resolve when done (the core waits)
  showDecision(decision, game),// e.g. number badges over choosable pieces (badgeSprite from stage.js)
  dispose(),
}
```

Rendering is on demand: the loop only runs during `stage.animate()` calls or after `stage.invalidate()`. Avoid endless idle animations. Each one keeps the GPU busy for the whole stream.

Shared helpers:
- `renderer/unfold.js`: folding board intro (square or rectangular via `size`/`depth`, `edgeColor`).
- `renderer/dice.js`: rounded die that lands on a given value and plays the dice sound. Style it with `faceColor`, `pipColor`, `onePipColor`, `glow`.
- `renderer/pieces.js`: lathe pawn and blob shadow.
- `renderer/stage.js`: `blobShadow`, `badgeSprite`, easing.
- `stage.sfx.play(name, opts)`: shared sounds, `dice`, `step`, `punch`, `whoosh`, `zap`, `teleport`, `slide`, `win` (see `renderer/audio.js`; add new synths to `SYNTHS` and a level to `LEVELS`).

## Testing

Logic runs in Node: `npm test`. See `tests/ludo.test.mjs`. A good first test is "bots finish 200 seeded games".
