// The wheel board: an outer ring of 42 spaces with 6 category headquarters (HQ),
// 6 spokes of 5 spaces each, and the hub in the middle. Pure data + math, no DOM.
//
// Node ids: ring 0..41 (HQ k = ring 7k), spoke k step j (j = 1 next to HQ, 5 next to hub)
// = 42 + 5k + (j-1), hub = 72.

export const RING = 42;
export const SPOKE_LEN = 5;
export const HUB = RING + 6 * SPOKE_LEN; // 72
export const NODE_COUNT = HUB + 1;

export const hqRing = (k) => k * 7;
export const spokeNode = (k, j) => RING + k * SPOKE_LEN + (j - 1);
export const isHub = (n) => n === HUB;
export const isHQ = (n) => n < RING && n % 7 === 0;

// Between two HQs: 6 spaces, two of them "roll again". Offsets are added to the segment's HQ slot.
const SEGMENT = [2, 'again', 4, 1, 'again', 5];

export function nodeInfo(n) {
  if (n === HUB) return { kind: 'hub', slot: null };
  if (n < RING) {
    const k = Math.floor(n / 7);
    const p = n % 7;
    if (p === 0) return { kind: 'hq', slot: k };
    const o = SEGMENT[p - 1];
    return o === 'again' ? { kind: 'again', slot: null } : { kind: 'ring', slot: (k + o) % 6 };
  }
  const i = n - RING;
  const k = Math.floor(i / SPOKE_LEN);
  const j = (i % SPOKE_LEN) + 1;
  return { kind: 'spoke', slot: (k + j) % 6, spoke: k, step: j };
}

export function neighbors(n) {
  if (n === HUB) return Array.from({ length: 6 }, (_, k) => spokeNode(k, SPOKE_LEN));
  if (n < RING) {
    const list = [(n + 1) % RING, (n + RING - 1) % RING];
    if (isHQ(n)) list.push(spokeNode(n / 7, 1));
    return list;
  }
  const { spoke: k, step: j } = nodeInfo(n);
  return [j === 1 ? hqRing(k) : spokeNode(k, j - 1), j === SPOKE_LEN ? HUB : spokeNode(k, j + 1)];
}

// Every space reachable in exactly `steps` moves without stepping straight back.
// (On a plain space that means "keep going"; at an HQ or the hub you can turn.)
// Returns [{ node, path }] with one path per destination.
export function destinations(from, steps) {
  const found = new Map();
  const walk = (node, prev, path) => {
    if (path.length === steps) {
      if (!found.has(node)) found.set(node, [...path]);
      return;
    }
    for (const next of neighbors(node)) {
      if (next === prev) continue;
      path.push(next);
      walk(next, node, path);
      path.pop();
    }
  };
  walk(from, -1, []);
  return [...found.entries()].map(([node, path]) => ({ node, path }));
}

// Position of a node on a board of radius `R` (outer ring) with hub radius `hubR`.
// Angle 0 = up (towards the viewer's far side), clockwise.
export function nodePosition(n, R = 4.2, hubR = 0.95) {
  if (n === HUB) return [0, 0];
  let angle;
  let r;
  if (n < RING) {
    angle = (n / RING) * Math.PI * 2;
    r = R;
  } else {
    const { spoke, step } = nodeInfo(n);
    angle = (hqRing(spoke) / RING) * Math.PI * 2;
    r = R - (step * (R - hubR)) / (SPOKE_LEN + 1);
  }
  return [Math.sin(angle) * r, -Math.cos(angle) * r];
}
