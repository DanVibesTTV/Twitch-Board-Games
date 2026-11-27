// Seeded RNG (mulberry32). Game logic only ever uses this, so a game
// can be replayed from its seed + the list of decisions.
export function createRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    // The internal state, so another device can continue exactly here (LAN play keeps every
    // phone's copy of the game in step, even when bots on the host draw random numbers).
    getState: () => a,
    setState: (s) => { a = s >>> 0; },
    int: (min, max) => min + Math.floor(next() * (max - min + 1)), // inclusive
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
