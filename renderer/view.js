// Connects the Session to the current game's renderer.
export function createView(stage) {
  let r = null;
  let game = null;
  return {
    async mount(module, g, seats) {
      game = g;
      r = module.createRenderer(stage, { seats });
      await r.intro(g);
    },
    async present(events, g) { await r?.present(events, g); },
    // Tap targets belong to one decision: cleared before the renderer shows the next one.
    // g: what the renderer may see now (hidden games: this screen's view, fresh every time).
    decision(d, _seat, g = game) { stage.setTapTargets?.([]); r?.showDecision(d, g); },
    unmount() { stage.setTapTargets?.([]); r?.dispose(); r = null; game = null; },
  };
}
