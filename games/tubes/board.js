// Tubes & Teleporters board: 10×10 squares plus a "launch bay" strip below
// where pawns wait before their first roll. Grid units: x = column 0..10,
// y = row 0..11 (row 0 = top = squares 91–100, row 9 = squares 1–10, row 10 = launch bay).

import { TELEPORTERS, TUBES, GOAL } from './logic.js';

export const COLS = 10;
export const ROWS = 11;

const TUBE_COLORS = ['#ff2bd6', '#ff7a1a', '#b04cff', '#ff3b6b'];
const TELE_COLORS = ['#00e5ff', '#7dff4a', '#ffe14a', '#2bffc6'];

export function squareCell(n) {
  const rowFromBottom = Math.floor((n - 1) / 10);
  const i = (n - 1) % 10;
  const col = rowFromBottom % 2 === 0 ? i : 9 - i;
  return [col, 9 - rowFromBottom];
}

export function squareCenter(n) {
  const [c, r] = squareCell(n);
  return [c + 0.5, r + 0.5];
}

export function baySlot(seatIndex, count = 8) {
  const gap = COLS / count;
  return [gap * (seatIndex + 0.5), 10.5];
}

// Point on a pawn's spot: launch bay for 0, otherwise the square (spread when crowded).
export function spotFor(position, seatIndex, stackIndex = 0, stackSize = 1, seatCount = 8) {
  if (position === 0) return baySlot(seatIndex, seatCount);
  const [u, v] = squareCenter(position);
  if (stackSize < 2) return [u, v];
  const radius = stackSize <= 3 ? 0.2 : 0.28;
  const a = (stackIndex / stackSize) * Math.PI * 2 - Math.PI / 2;
  return [u + Math.cos(a) * radius, v + Math.sin(a) * radius];
}

// Pieces shrink when many share a square so they still fit.
export const stackScale = (n) => (n <= 1 ? 1 : n <= 3 ? 0.85 : n <= 5 ? 0.7 : 0.58);

// S-shaped curve a tube follows, in grid units. Used for drawing and for the slide animation.
export function tubeCurve(from, to, samples = 48) {
  const [ax, ay] = squareCenter(from);
  const [dx, dy] = squareCenter(to);
  const vx = dx - ax;
  const vy = dy - ay;
  const len = Math.hypot(vx, vy);
  const px = -vy / len;
  const py = vx / len;
  const bend = Math.min(1.5, len * 0.32) * (from % 2 ? 1 : -1);
  const b = [ax + vx * 0.25 + px * bend, ay + vy * 0.25 + py * bend];
  const c = [ax + vx * 0.75 - px * bend, ay + vy * 0.75 - py * bend];
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const m = 1 - t;
    pts.push([
      m * m * m * ax + 3 * m * m * t * b[0] + 3 * m * t * t * c[0] + t * t * t * dx,
      m * m * m * ay + 3 * m * m * t * b[1] + 3 * m * t * t * c[1] + t * t * t * dy,
    ]);
  }
  return pts;
}

export function drawBoard(seatColors, width = 1024) {
  const k = width / COLS;
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = Math.round(k * ROWS);
  const g = cv.getContext('2d');
  const px = (n) => n * k;

  // background
  const bg = g.createLinearGradient(0, 0, cv.width, cv.height);
  bg.addColorStop(0, '#0d0626');
  bg.addColorStop(1, '#071a2e');
  g.fillStyle = bg;
  g.fillRect(0, 0, cv.width, cv.height);

  // squares
  for (let n = 1; n <= GOAL; n++) {
    const [c, r] = squareCell(n);
    const hue = 290 - (n / GOAL) * 250; // magenta → cyan → green across the board
    g.fillStyle = (c + r) % 2 ? '#161338' : '#1d1047';
    g.fillRect(px(c), px(r), k, k);
    g.strokeStyle = `hsla(${hue}, 100%, 60%, 0.35)`;
    g.lineWidth = k * 0.025;
    g.strokeRect(px(c) + k * 0.04, px(r) + k * 0.04, k * 0.92, k * 0.92);
    g.save();
    g.font = `700 ${k * 0.24}px "JetBrains Mono", "Consolas", monospace`;
    g.fillStyle = `hsl(${hue}, 100%, 70%)`;
    g.shadowColor = `hsl(${hue}, 100%, 60%)`;
    g.shadowBlur = k * 0.12;
    g.fillText(String(n), px(c) + k * 0.1, px(r) + k * 0.3);
    g.restore();
  }

  // goal & start squares
  const goal = squareCell(GOAL);
  glowRect(g, px(goal[0]), px(goal[1]), k, k, '#ffe14a', k);
  neonText(g, 'GOAL', px(goal[0] + 0.5), px(goal[1] + 0.68), k * 0.26, '#ffe14a');
  const start = squareCell(1);
  neonText(g, 'START', px(start[0] + 0.5), px(start[1] + 0.68), k * 0.2, '#00e5ff');

  // teleporters: dashed beam with chevrons, pads at both ends
  Object.entries(TELEPORTERS).forEach(([from, to], i) => {
    const color = TELE_COLORS[i % TELE_COLORS.length];
    const a = squareCenter(+from).map(px);
    const b = squareCenter(to).map(px);
    g.save();
    g.strokeStyle = color;
    g.shadowColor = color;
    g.shadowBlur = k * 0.25;
    g.lineWidth = k * 0.07;
    g.setLineDash([k * 0.14, k * 0.1]);
    g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
    g.setLineDash([]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = k * 0.7; d < dist - k * 0.5; d += k * 0.75) {
      chevron(g, a[0] + Math.cos(ang) * d, a[1] + Math.sin(ang) * d, ang, k * 0.16, color);
    }
    g.restore();
    pad(g, a, k * 0.36, color, true);
    pad(g, b, k * 0.26, color, false);
  });

  // tubes: glassy glowing pipes with ribs, a dark mouth at the top end
  Object.entries(TUBES).forEach(([from, to], i) => {
    const color = TUBE_COLORS[i % TUBE_COLORS.length];
    const pts = tubeCurve(+from, to).map(([u, v]) => [px(u), px(v)]);
    const path = (dx = 0, dy = 0) => {
      g.beginPath();
      pts.forEach(([x, y], j) => (j ? g.lineTo(x + dx, y + dy) : g.moveTo(x + dx, y + dy)));
    };
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = k * 0.5; path(k * 0.05, k * 0.07); g.stroke();
    g.shadowColor = color; g.shadowBlur = k * 0.35;
    g.strokeStyle = color; g.globalAlpha = 0.45; g.lineWidth = k * 0.44; path(); g.stroke();
    g.shadowBlur = 0;
    g.globalAlpha = 0.75; g.lineWidth = k * 0.3; path(); g.stroke();
    g.globalAlpha = 0.6; g.strokeStyle = '#ffffff'; g.lineWidth = k * 0.06; path(-k * 0.07, -k * 0.07); g.stroke();
    // ribs
    g.globalAlpha = 0.9; g.strokeStyle = lighten(color); g.lineWidth = k * 0.045;
    let acc = 0;
    for (let j = 1; j < pts.length; j++) {
      const [x0, y0] = pts[j - 1];
      const [x1, y1] = pts[j];
      acc += Math.hypot(x1 - x0, y1 - y0);
      if (acc < k * 0.42) continue;
      acc = 0;
      const ang = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
      g.beginPath();
      g.moveTo(x1 - Math.cos(ang) * k * 0.22, y1 - Math.sin(ang) * k * 0.22);
      g.lineTo(x1 + Math.cos(ang) * k * 0.22, y1 + Math.sin(ang) * k * 0.22);
      g.stroke();
    }
    g.restore();
    // mouth (entrance) and exit ring
    const [hx, hy] = pts[0];
    g.save();
    g.shadowColor = color; g.shadowBlur = k * 0.3;
    g.fillStyle = '#05020f';
    g.beginPath(); g.arc(hx, hy, k * 0.27, 0, Math.PI * 2); g.fill();
    g.strokeStyle = color; g.lineWidth = k * 0.07; g.stroke();
    const [tx, ty] = pts[pts.length - 1];
    g.beginPath(); g.arc(tx, ty, k * 0.2, 0, Math.PI * 2);
    g.lineWidth = k * 0.05; g.stroke();
    g.restore();
  });

  // launch bay
  const by = px(10);
  const bay = g.createLinearGradient(0, by, 0, cv.height);
  bay.addColorStop(0, '#1a0b3d');
  bay.addColorStop(1, '#0a0420');
  g.fillStyle = bay;
  g.fillRect(0, by, cv.width, k);
  g.strokeStyle = '#ff2bd6';
  g.shadowColor = '#ff2bd6';
  g.shadowBlur = k * 0.2;
  g.lineWidth = k * 0.04;
  g.beginPath(); g.moveTo(0, by); g.lineTo(cv.width, by); g.stroke();
  g.shadowBlur = 0;
  seatColors.forEach((color, i) => {
    const [u, v] = baySlot(i, seatColors.length);
    pad(g, [px(u), px(v)], k * 0.3, color, false);
  });
  neonText(g, 'LAUNCH BAY', px(COLS / 2), by + k * 0.16, k * 0.12, '#ff9df0');

  // scanlines + neon frame
  g.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < cv.height; y += 4) g.fillRect(0, y, cv.width, 1);
  const frame = g.createLinearGradient(0, 0, cv.width, cv.height);
  frame.addColorStop(0, '#ff2bd6');
  frame.addColorStop(0.5, '#7a5cff');
  frame.addColorStop(1, '#00e5ff');
  g.strokeStyle = frame;
  g.lineWidth = k * 0.09;
  g.shadowColor = '#7a5cff';
  g.shadowBlur = k * 0.2;
  g.strokeRect(k * 0.045, k * 0.045, cv.width - k * 0.09, cv.height - k * 0.09);
  return cv;
}

export function drawBoardBack(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#0b0620';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(255, 43, 214, 0.35)';
  g.lineWidth = 2;
  for (let i = 0; i <= size; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, size); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(size, i); g.stroke();
  }
  return cv;
}

function pad(g, [x, y], r, color, filled) {
  g.save();
  g.shadowColor = color;
  g.shadowBlur = r * 0.8;
  g.strokeStyle = color;
  g.lineWidth = r * 0.16;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.lineWidth = r * 0.08;
  g.globalAlpha = 0.7;
  g.beginPath(); g.arc(x, y, r * 0.66, 0, Math.PI * 2); g.stroke();
  if (filled) {
    g.globalAlpha = 0.3;
    g.fillStyle = color;
    hexagon(g, x, y, r * 0.5);
    g.fill();
  }
  g.restore();
}

function hexagon(g, x, y, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
}

function chevron(g, x, y, ang, s, color) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.strokeStyle = color;
  g.lineWidth = s * 0.45;
  g.globalAlpha = 1;
  g.beginPath(); g.moveTo(-s * 0.5, -s); g.lineTo(s * 0.5, 0); g.lineTo(-s * 0.5, s); g.stroke();
  g.restore();
}

function glowRect(g, x, y, w, h, color, k) {
  g.save();
  g.fillStyle = color;
  g.globalAlpha = 0.18;
  g.fillRect(x, y, w, h);
  g.globalAlpha = 1;
  g.strokeStyle = color;
  g.shadowColor = color;
  g.shadowBlur = k * 0.3;
  g.lineWidth = k * 0.06;
  g.strokeRect(x + k * 0.06, y + k * 0.06, w - k * 0.12, h - k * 0.12);
  g.restore();
}

function neonText(g, text, x, y, size, color) {
  g.save();
  g.font = `800 ${size}px "JetBrains Mono", "Consolas", monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.shadowColor = color;
  g.shadowBlur = size * 0.8;
  g.fillText(text, x, y);
  g.fillStyle = color;
  g.globalAlpha = 0.6;
  g.fillText(text, x, y);
  g.restore();
}

function lighten(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v) => Math.round(v + (255 - v) * 0.45);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
