// Texas Hold 'em add-on entry. The core imports this lazily when the game is picked.
// Hidden information: the manifest says "hidden": true, so the renderer only gets viewFor(seat).
export { createGame, privateSummary } from './logic.js';
export { createRenderer } from './renderer.js';
