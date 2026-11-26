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
| `players` | `{ "min": 2, "max": 4 }` |
| `seats` | `[{ "id": "red", "name": "Red", "color": "#e5484d" }, …]`. Viewers type `!join <id>` |
| `needs` | `[]`, or any of `"hiddenInfo"`, `"sendChat"`, `"predictions"`. The game is greyed out if the bridge can't provide them |
| `commands` | help lines shown in the lobby |
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
}
```

**Everything is a decision.** Rolling dice is a decision with one option (`alias: 'roll'`). The game rolls inside `apply()`. Keep option lists short (ideally 9 or fewer). If a turn has many possibilities, split it into steps, for example "pick a piece" and then "pick a target".

`events` are for the renderer only (for example `{type:'move', …}`). The core passes them through untouched.

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

Shared helpers: `renderer/unfold.js` (folding board intro), `renderer/dice.js` (rounded die that lands on a given value), `renderer/pieces.js` (lathe pawn and blob shadow), `renderer/stage.js` (`blobShadow`, `badgeSprite`, easing).

## Testing

Logic runs in Node: `npm test`. See `tests/ludo.test.mjs`. A good first test is "bots finish 200 seeded games".
