// Poker Dice art: a battered pirate table (planks, cracks, nails, a broken corner), the bone dice faces,
// and the parchment ledger with players, doubloons and this round's hands. All 2D canvas.

import { FACES, RANKS } from './logic.js';

export const W = 16;
export const D = 9;
export const PX = 128;
export const DICE_ROW = { x: -4.2, z: -0.6, gap: 1.25 };
export const HOLD_Z = 3.15;
export const RING = { x: -4.2, z: -0.6, r: 3.6 };

const toPx = (x, z) => [(x + W / 2) * PX, (z + D / 2) * PX];
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Segoe UI", Inter, system-ui, sans-serif';
const INK = '#2b1a0c';

// Table outline (world units, x right, z toward the viewer): a bite out of the top-right corner,
// a splintered chunk missing at the bottom-left and ragged plank ends on the right.
export const OUTLINE = [
  [-8, -4.5], [3.9, -4.5], [4.3, -4.25], [4.75, -4.45], [5.2, -4.05], [5.55, -4.3], [6.1, -3.7],
  [6.55, -3.85], [7.05, -3.2], [7.6, -3.3], [8, -2.75],
  [8, -1.2], [7.88, -0.9], [8, -0.55], [8, 1.5], [7.9, 1.65], [8, 1.9], [8, 4.5],
  [-3.2, 4.5], [-3.55, 4.15], [-3.95, 4.38], [-4.4, 3.95], [-4.9, 4.25], [-5.35, 3.85], [-5.8, 4.5],
  [-8, 4.5],
];

// The ledger (parchment) on the right of the table.
const LEDGER = { x: 1010, y: 70, w: 960, h: 1010 };
const ROW = { top: LEDGER.y + 140 };
// Row height: the space between the title and the hand ranking, shared by the players (max 180 px).
const rowH = (n) => Math.min(180, (LEDGER.h - 140 - 200) / Math.max(n, 2));

// World position of a player's doubloon spot on the ledger (where a won coin flies to).
export function coinTarget(seat, count, n) {
  const px = LEDGER.x + 330 + Math.min(count, 6) * 52;
  const py = ROW.top + seat * rowH(n) + rowH(n) * 0.68;
  return [px / PX - W / 2, py / PX - D / 2];
}

// Everything that never changes (wood, ring, cloth, parchment) is drawn once, with its random
// grain and torn edges, and reused; redraws only add the changing parts on top.
let staticLayer = null;
function staticTable(w, h) {
  if (staticLayer?.width === w && staticLayer.height === h) return staticLayer;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  planks(g, w, h);

  // dice ring: a stained, scuffed circle where the dice land
  const [cx, cy] = toPx(RING.x, RING.z);
  const r = RING.r * PX;
  const ring = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  ring.addColorStop(0, 'rgba(20, 8, 2, 0.30)');
  ring.addColorStop(0.85, 'rgba(20, 8, 2, 0.40)');
  ring.addColorStop(1, 'rgba(20, 8, 2, 0)');
  g.fillStyle = ring;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(230, 190, 120, 0.35)';
  g.lineWidth = 5;
  g.setLineDash([22, 14]);
  g.beginPath(); g.arc(cx, cy, r * 0.92, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.strokeStyle = 'rgba(240, 210, 150, 0.12)';
  g.lineWidth = 3;
  for (let a = 0; a < 8; a++) {
    const ang = (a * Math.PI) / 4;
    g.beginPath();
    g.moveTo(cx + Math.cos(ang) * r * 0.2, cy + Math.sin(ang) * r * 0.2);
    g.lineTo(cx + Math.cos(ang) * r * (a % 2 ? 0.55 : 0.8), cy + Math.sin(ang) * r * (a % 2 ? 0.55 : 0.8));
    g.stroke();
  }

  // held lane: a strip of old sailcloth
  const [lx0, lz] = toPx(DICE_ROW.x - DICE_ROW.gap * 2 - 0.65, HOLD_Z);
  const [lx1] = toPx(DICE_ROW.x + DICE_ROW.gap * 2 + 0.65, HOLD_Z);
  g.save();
  raggedRect(g, lx0, lz - 72, lx1 - lx0, 144, 9);
  const cloth = g.createLinearGradient(0, lz - 72, 0, lz + 72);
  cloth.addColorStop(0, '#cdbb92');
  cloth.addColorStop(1, '#b09a6c');
  g.fillStyle = cloth;
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = 16;
  g.fill();
  g.restore();
  g.fillStyle = 'rgba(60, 35, 15, 0.35)';
  g.font = `italic 700 40px ${SERIF}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('~ held ~', (lx0 + lx1) / 2, lz + 2);

  // parchment with torn edges and stains
  const { x, y, w: lw, h: lh } = LEDGER;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 28;
  g.shadowOffsetY = 10;
  raggedRect(g, x, y, lw, lh, 14);
  const paper = g.createRadialGradient(x + lw * 0.45, y + lh * 0.4, 80, x + lw / 2, y + lh / 2, lw * 0.75);
  paper.addColorStop(0, '#f1e3bf');
  paper.addColorStop(1, '#cdb27a');
  g.fillStyle = paper;
  g.fill();
  g.restore();
  for (const [sx, sy, sr] of [[x + lw - 150, y + lh - 130, 70], [x + 120, y + 90, 40]]) {
    g.strokeStyle = 'rgba(110, 70, 30, 0.22)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(sx, sy, sr, 0.3, Math.PI * 1.85); g.stroke();
  }
  staticLayer = cv;
  return cv;
}

// model: { state, seats: [{ color, label }] }
export function drawTable(cv, model) {
  const g = cv.getContext('2d');
  const { width: w, height: h } = cv;
  g.save();
  g.clearRect(0, 0, w, h);
  g.drawImage(staticTable(w, h), 0, 0);

  // rolls used
  const st = model.state;
  const used = st.rolled ? 3 - st.rollsLeft : 0;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(240, 215, 160, 0.9)';
  g.font = `700 32px ${SERIF}`;
  g.fillText('Rolls', 70, 92);
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(190 + i * 44, 92, 14, 0, Math.PI * 2);
    g.fillStyle = i < used ? '#e8c46a' : 'rgba(0,0,0,0.35)';
    g.fill();
    g.strokeStyle = '#e8c46a';
    g.lineWidth = 3;
    g.stroke();
  }

  ledger(g, model);
  g.restore();
}

function planks(g, w, h) {
  const rows = 8;
  const ph = h / rows;
  for (let p = 0; p < rows; p++) {
    const y = p * ph;
    const base = [[106, 66, 34], [122, 78, 40], [96, 60, 30], [114, 72, 38]][p % 4];
    const grad = g.createLinearGradient(0, y, 0, y + ph);
    grad.addColorStop(0, `rgb(${base.map((c) => c + 14).join(',')})`);
    grad.addColorStop(1, `rgb(${base.map((c) => c - 16).join(',')})`);
    g.fillStyle = grad;
    g.fillRect(0, y, w, ph);
    // grain
    for (let i = 0; i < 26; i++) {
      const gy = y + 6 + Math.random() * (ph - 12);
      g.strokeStyle = `rgba(40, 20, 6, ${0.08 + Math.random() * 0.14})`;
      g.lineWidth = 1 + Math.random() * 2.5;
      g.beginPath();
      g.moveTo(0, gy);
      for (let x = 0; x <= w; x += 64) g.lineTo(x, gy + Math.sin(x * 0.004 + i) * 6 + Math.sin(x * 0.02 + p) * 1.5);
      g.stroke();
    }
    // knots
    for (let k = 0; k < 2; k++) {
      const kx = Math.random() * w;
      const ky = y + ph * (0.3 + Math.random() * 0.4);
      for (let ring = 4; ring >= 1; ring--) {
        g.strokeStyle = `rgba(35, 16, 4, ${0.12 + ring * 0.05})`;
        g.lineWidth = 2;
        g.beginPath(); g.ellipse(kx, ky, ring * 12, ring * 5, 0, 0, Math.PI * 2); g.stroke();
      }
    }
    // gap between planks
    g.fillStyle = 'rgba(20, 8, 2, 0.85)';
    g.fillRect(0, y + ph - 4, w, 5);
    // plank joints and nails
    const joint = 300 + ((p * 577) % 900);
    g.fillRect(joint, y, 4, ph);
    for (const nx of [joint - 26, joint + 30, 40, w - 44]) {
      for (const ny of [y + 22, y + ph - 26]) {
        g.beginPath(); g.arc(nx, ny, 7, 0, Math.PI * 2);
        g.fillStyle = '#2a2420'; g.fill();
        g.beginPath(); g.arc(nx - 2, ny - 2, 2.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(200, 190, 170, 0.5)'; g.fill();
        g.fillStyle = 'rgba(20, 8, 2, 0.85)';
      }
    }
  }
  // cracks
  for (const [x0, y0, len, dir] of [[1700, 30, 380, 1.9], [180, 1100, 300, -1.2], [880, 560, 230, 0.5]]) {
    g.strokeStyle = 'rgba(15, 6, 1, 0.8)';
    g.lineWidth = 4;
    g.beginPath();
    let x = x0; let y = y0;
    g.moveTo(x, y);
    for (let s = 0; s < 9; s++) {
      x += Math.cos(dir + (Math.random() - 0.5) * 0.9) * (len / 9);
      y += Math.sin(dir + (Math.random() - 0.5) * 0.9) * (len / 9);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // darker, scorched edge (the outline is cut out of this)
  const edge = g.createRadialGradient(w / 2, h / 2, h * 0.45, w / 2, h / 2, w * 0.62);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(10, 4, 0, 0.55)');
  g.fillStyle = edge;
  g.fillRect(0, 0, w, h);
}

function ledger(g, { state: st, seats }) {
  const { x, y, w, h } = LEDGER;
  g.fillStyle = INK;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `italic 700 58px ${SERIF}`;
  g.fillText('Poker Dice', x + 46, y + 66);
  g.textAlign = 'right';
  g.font = `600 30px ${SERIF}`;
  g.fillStyle = '#5a3e1e';
  g.fillText(st.over ? 'Final tally' : `Round ${st.round} · first to ${st.rules.target}`, x + w - 90, y + 70);

  const n = seats.length;
  const lead = leaderIndex(st);
  const rh = rowH(n);
  const big = rh >= 150;
  for (let i = 0; i < n; i++) {
    const ry = ROW.top + i * rh;
    const current = !st.over && i === st.current;
    if (current) {
      roundRect(g, x + 26, ry - 4, w - 52, rh - 12, 16);
      g.fillStyle = hexA(seats[i].color, 0.22);
      g.fill();
    }
    // name pill
    roundRect(g, x + 44, ry + 10, 260, 54, 27);
    g.fillStyle = seats[i].color;
    g.fill();
    g.fillStyle = '#1b1208';
    g.textAlign = 'center';
    g.font = `700 30px ${SANS}`;
    g.fillText(fit(g, seats[i].label, 230), x + 174, ry + 38);
    // doubloons
    const coinY = ry + rh * 0.68;
    for (let c = 0; c < Math.min(st.coins[i], 7); c++) doubloon(g, x + 330 + c * 52, coinY, 22);
    if (st.coins[i] > 7) { g.fillStyle = INK; g.font = `700 28px ${SANS}`; g.textAlign = 'left'; g.fillText(`×${st.coins[i]}`, x + 330 + 7 * 52, coinY); }
    if (!st.coins[i]) { g.fillStyle = 'rgba(90, 62, 30, 0.45)'; g.font = `italic 500 24px ${SERIF}`; g.textAlign = 'left'; g.fillText('no doubloons yet', x + 312, coinY); }
    // this round's hand
    const hand = st.hands[i];
    g.textAlign = 'left';
    const hx = x + 330;
    const hy = ry + 38;
    if (hand) {
      g.fillStyle = INK;
      g.font = `700 ${big ? 44 : 36}px ${SERIF}`;
      const diceText = hand.dice.map((d) => FACES[d - 1]).join(' ');
      g.fillText(diceText, hx, hy);
      const dw = g.measureText(diceText).width;
      g.font = `italic 700 ${big ? 30 : 26}px ${SERIF}`;
      g.fillStyle = i === lead ? '#8a1c12' : '#5a3e1e';
      g.fillText(fit(g, `${hand.name}${i === lead && !st.over ? '  ⟵ best' : ''}`, w - (hx - x) - dw - 70), hx + dw + 24, hy + 2);
    } else {
      g.fillStyle = 'rgba(90, 62, 30, 0.7)';
      g.font = `italic 600 ${big ? 32 : 28}px ${SERIF}`;
      g.fillText(current ? (st.rolled ? `rolling…  ${st.dice.map((d) => FACES[d - 1]).join(' ')}` : 'up next…') : 'waiting', hx, hy);
    }
    if (i < n - 1) {
      g.strokeStyle = 'rgba(90, 62, 30, 0.3)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x + 44, ry + rh - 8); g.lineTo(x + w - 44, ry + rh - 8); g.stroke();
    }
  }

  // hand ranking, best first
  const ky = y + h - 150;
  g.strokeStyle = 'rgba(90, 62, 30, 0.45)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(x + 44, ky - 30); g.lineTo(x + w - 44, ky - 30); g.stroke();
  g.fillStyle = '#5a3e1e';
  g.font = `600 24px ${SERIF}`;
  g.textAlign = 'left';
  const order = [...RANKS].reverse();
  const cols = 4;
  order.forEach((name, i) => {
    const cx = x + 48 + (i % cols) * ((w - 96) / cols);
    const cy = ky + Math.floor(i / cols) * 44;
    g.fillText(`${i + 1}. ${name}`, cx, cy);
  });
  g.font = `italic 500 21px ${SERIF}`;
  g.fillStyle = 'rgba(90, 62, 30, 0.8)';
  g.fillText('9 · 10 · J · Q · K · A (skull)', x + 48, ky + 98);
}

function leaderIndex(st) {
  let best = -1;
  st.hands.forEach((h, i) => {
    if (!h) return;
    if (best < 0 || cmpScore(h.score, st.hands[best].score) > 0) best = i;
  });
  return best;
}
function cmpScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

function doubloon(g, x, y, r) {
  const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r);
  grad.addColorStop(0, '#fff1a8');
  grad.addColorStop(1, '#c08a1a');
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = grad; g.fill();
  g.strokeStyle = '#7a5208'; g.lineWidth = 2.5; g.stroke();
  g.beginPath(); g.arc(x, y, r * 0.62, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(122, 82, 8, 0.6)'; g.lineWidth = 1.5; g.stroke();
}

// ---------------- bone dice faces ----------------

// Paints one face of a bone die: off-white bone with speckles and scratches, the value carved in.
export function drawBoneFace(g, value, px) {
  const bone = g.createRadialGradient(px * 0.4, px * 0.35, px * 0.05, px / 2, px / 2, px * 0.75);
  bone.addColorStop(0, '#f4ecd6');
  bone.addColorStop(1, '#cbbb93');
  g.fillStyle = bone;
  g.fillRect(0, 0, px, px);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(90, 70, 40, ${Math.random() * 0.25})`;
    g.beginPath(); g.arc(Math.random() * px, Math.random() * px, Math.random() * 2.2, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 4; i++) {
    g.strokeStyle = `rgba(110, 85, 50, ${0.15 + Math.random() * 0.2})`;
    g.lineWidth = 1;
    const sx = Math.random() * px;
    const sy = Math.random() * px;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + (Math.random() - 0.5) * px * 0.4, sy + (Math.random() - 0.5) * px * 0.4); g.stroke();
  }
  const face = FACES[value - 1];
  const carve = (draw) => {
    // light edge below/right, dark carving on top: reads as engraved
    g.save(); g.translate(2.5, 3); g.fillStyle = 'rgba(255, 250, 235, 0.7)'; g.strokeStyle = g.fillStyle; draw(); g.restore();
    g.fillStyle = value >= 3 && value <= 5 ? '#7d1a10' : '#2a1608';
    g.strokeStyle = g.fillStyle;
    draw();
  };
  if (face === 'A') {
    carve(() => skull(g, px));
    g.font = `700 ${px * 0.16}px ${SERIF}`;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = '#2a1608';
    g.fillText('A', px * 0.09, px * 0.07);
    return;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${face === '10' ? px * 0.48 : px * 0.6}px ${SERIF}`;
  carve(() => g.fillText(face, px / 2, px * 0.54));
}

function skull(g, px) {
  const c = px / 2;
  const s = px / 256;
  g.lineCap = 'round';
  // crossbones
  g.lineWidth = 16 * s;
  for (const [a, b] of [[[c - 78 * s, c + 28 * s], [c + 78 * s, c + 104 * s]], [[c + 78 * s, c + 28 * s], [c - 78 * s, c + 104 * s]]]) {
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
    for (const [px2, py2] of [a, b]) {
      g.beginPath(); g.arc(px2 - 6 * s, py2, 9 * s, 0, Math.PI * 2); g.arc(px2 + 6 * s, py2, 9 * s, 0, Math.PI * 2); g.fill();
    }
  }
  // skull
  g.beginPath();
  g.ellipse(c, c - 22 * s, 62 * s, 58 * s, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(c - 36 * s, c + 10 * s, 72 * s, 40 * s);
  // eyes and nose cut out with the bone colour
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath(); g.ellipse(c - 25 * s, c - 18 * s, 17 * s, 19 * s, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(c + 25 * s, c - 18 * s, 17 * s, 19 * s, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(c, c + 2 * s); g.lineTo(c - 9 * s, c + 20 * s); g.lineTo(c + 9 * s, c + 20 * s); g.closePath(); g.fill();
  for (let t = -2; t <= 2; t++) g.fillRect(c + t * 14 * s - 3 * s, c + 34 * s, 6 * s, 16 * s);
  g.restore();
}

// ---------------- helpers ----------------

// Rectangle with slightly irregular (torn / frayed) edges.
function raggedRect(g, x, y, w, h, jag) {
  const pts = [];
  const step = 34;
  for (let i = 0; i <= w; i += step) pts.push([x + i, y + (Math.random() - 0.5) * jag]);
  for (let i = 0; i <= h; i += step) pts.push([x + w + (Math.random() - 0.5) * jag, y + i]);
  for (let i = w; i >= 0; i -= step) pts.push([x + i, y + h + (Math.random() - 0.5) * jag]);
  for (let i = h; i >= 0; i -= step) pts.push([x + (Math.random() - 0.5) * jag, y + i]);
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.closePath();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fit(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
