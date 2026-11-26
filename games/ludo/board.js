// Ludo board geometry (15×15 grid) and the flat board texture.
// Grid coordinates are continuous: cell (c, r) spans [c, c+1] × [r, r+1]; its center is (c+.5, r+.5).

import { START_OFFSET, LAST_TRACK, FINISH, SAFE_SQUARES } from './logic.js';

export const GRID = 15;

export const COLORS = {
  red: '#e5484d',
  green: '#2f9e64',
  yellow: '#f0b400',
  blue: '#3b74e8',
};
const LIGHT = { red: '#fbd5d6', green: '#cdebd9', yellow: '#fcebb5', blue: '#d3e0fb' };

// Main track, clockwise, starting at red's start square. Index = absolute square.
export const TRACK = [
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7],
  [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14],
  [6, 14], [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7], [0, 6],
];

const HOME_LANE = {
  red: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  green: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  yellow: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  blue: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
};
const YARD = { red: [0, 0], green: [9, 0], yellow: [9, 9], blue: [0, 9] }; // top-left cell of each 6×6 yard
const FINISH_SPOT = { red: [6.55, 7.5], green: [7.5, 6.55], yellow: [8.45, 7.5], blue: [7.5, 8.45] };
const STAR_SQUARES = [...SAFE_SQUARES].filter((sq) => !Object.values(START_OFFSET).includes(sq));

const center = ([c, r]) => [c + 0.5, r + 0.5];

export function yardSpot(color, pawn) {
  const [c, r] = YARD[color];
  return [c + 3 + (pawn % 2 ? 1.15 : -1.15), r + 3 + (pawn > 1 ? 1.15 : -1.15)];
}

// Grid position of a pawn. `stackIndex/stackSize` spread pawns sharing a square.
export function pawnSpot(color, progress, pawn, stackIndex = 0, stackSize = 1) {
  let p;
  if (progress === -1) return yardSpot(color, pawn);
  if (progress === FINISH) {
    const [u, v] = FINISH_SPOT[color];
    const o = (pawn - 1.5) * 0.28;
    const horizontal = color === 'green' || color === 'blue';
    return horizontal ? [u + o, v] : [u, v + o];
  }
  if (progress <= LAST_TRACK) p = center(TRACK[(START_OFFSET[color] + progress) % TRACK.length]);
  else p = center(HOME_LANE[color][progress - LAST_TRACK - 1]);
  if (stackSize > 1) {
    const a = (stackIndex / stackSize) * Math.PI * 2 + Math.PI / 4;
    p = [p[0] + Math.cos(a) * 0.22, p[1] + Math.sin(a) * 0.22];
  }
  return p;
}

// Draws the flat board into a canvas (used as the board texture).
export function drawBoard(size = 1024) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const k = size / GRID;
  const px = (n) => n * k;

  // base
  g.fillStyle = '#f7f1e6';
  g.fillRect(0, 0, size, size);

  const cell = ([c, r], fill, stroke = '#cbbfa8') => {
    g.fillStyle = fill;
    g.fillRect(px(c), px(r), k, k);
    g.strokeStyle = stroke;
    g.lineWidth = Math.max(1, k * 0.04);
    g.strokeRect(px(c) + 0.5, px(r) + 0.5, k - 1, k - 1);
  };

  // track + home lanes
  TRACK.forEach((sq) => cell(sq, '#fffdf8'));
  for (const [color, lane] of Object.entries(HOME_LANE)) lane.forEach((sq) => cell(sq, COLORS[color]));
  for (const [color, off] of Object.entries(START_OFFSET)) {
    cell(TRACK[off], COLORS[color]);
    arrow(g, center(TRACK[off]), k, '#fff');
  }
  for (const sq of STAR_SQUARES) star(g, center(TRACK[sq]).map(px), k * 0.33, '#b9ab90');

  // yards
  for (const [color, [c, r]] of Object.entries(YARD)) {
    g.fillStyle = COLORS[color];
    roundRect(g, px(c) + k * 0.15, px(r) + k * 0.15, k * 5.7, k * 5.7, k * 0.6);
    g.fill();
    g.fillStyle = '#fffdf8';
    roundRect(g, px(c) + k * 0.9, px(r) + k * 0.9, k * 4.2, k * 4.2, k * 0.45);
    g.fill();
    for (let i = 0; i < 4; i++) {
      const [u, v] = yardSpot(color, i);
      g.beginPath();
      g.arc(px(u), px(v), k * 0.62, 0, Math.PI * 2);
      g.fillStyle = LIGHT[color];
      g.fill();
      g.lineWidth = k * 0.08;
      g.strokeStyle = COLORS[color];
      g.stroke();
    }
  }

  // center triangles
  const mid = [px(7.5), px(7.5)];
  const tri = (a, b, color) => {
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineTo(...mid); g.closePath();
    g.fillStyle = COLORS[color]; g.fill();
  };
  tri([px(6), px(6)], [px(6), px(9)], 'red');
  tri([px(6), px(6)], [px(9), px(6)], 'green');
  tri([px(9), px(6)], [px(9), px(9)], 'yellow');
  tri([px(6), px(9)], [px(9), px(9)], 'blue');
  g.strokeStyle = '#fffdf8';
  g.lineWidth = k * 0.06;
  g.strokeRect(px(6), px(6), px(3), px(3));

  // frame
  g.strokeStyle = '#8b6b47';
  g.lineWidth = k * 0.18;
  g.strokeRect(k * 0.09, k * 0.09, size - k * 0.18, size - k * 0.18);
  return cv;
}

export function drawBoardBack(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#3a2a1c';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 6;
  for (let i = -size; i < size * 2; i += 24) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + size, size); g.stroke();
  }
  return cv;
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

function star(g, [x, y], r, fill) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

// Small arrow pointing along the track direction out of each start square.
function arrow(g, [u, v], k, fill) {
  g.save();
  g.translate(u * k, v * k);
  // red start (1,6) points right; rotate per quadrant
  const angle = u < 6 ? 0 : v < 6 ? Math.PI / 2 : u > 9 ? Math.PI : -Math.PI / 2;
  g.rotate(angle);
  g.beginPath();
  g.moveTo(k * 0.28, 0);
  g.lineTo(-k * 0.18, -k * 0.24);
  g.lineTo(-k * 0.18, k * 0.24);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.restore();
}
