// Trivia Champ board texture: a holographic wheel on a dark sci-fi plate.

import { RING, HUB, NODE_COUNT, nodeInfo, nodePosition, hqRing } from './wheel.js';

export const BOARD_SIZE = 10;
export const R = 4.0;     // outer ring radius (board units)
export const HUB_R = 0.95;

export const pos = (n) => nodePosition(n, R, HUB_R);

export function drawBoard(slots, size = 1024) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const k = size / BOARD_SIZE;
  const c = size / 2;
  const P = (x, y) => [c + x * k, c + y * k];

  // plate
  const bg = g.createRadialGradient(c, c, 0, c, c, size * 0.75);
  bg.addColorStop(0, '#101a3d');
  bg.addColorStop(1, '#04060f');
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);

  // hex grid
  g.strokeStyle = 'rgba(80, 200, 255, 0.07)';
  g.lineWidth = 1;
  const hs = k * 0.32;
  for (let row = -1; row < size / (hs * 1.5) + 1; row++) {
    for (let col = -1; col < size / (hs * Math.sqrt(3)) + 1; col++) {
      const x = col * hs * Math.sqrt(3) + (row % 2 ? (hs * Math.sqrt(3)) / 2 : 0);
      const y = row * hs * 1.5;
      hexPath(g, x, y, hs, Math.PI / 6);
      g.stroke();
    }
  }

  // corner brackets
  g.strokeStyle = 'rgba(120, 220, 255, 0.55)';
  g.lineWidth = k * 0.05;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x = c + sx * k * 4.75;
    const y = c + sy * k * 4.75;
    g.beginPath();
    g.moveTo(x, y - sy * k * 0.6); g.lineTo(x, y); g.lineTo(x - sx * k * 0.6, y);
    g.stroke();
  }

  // outer decorative rings (labels sit between the track and these)
  ring(g, c, k * 4.9, 'rgba(160, 120, 255, 0.45)', k * 0.022, [k * 0.1, k * 0.06]);
  ring(g, c, k * 4.97, 'rgba(60, 220, 255, 0.3)', k * 0.012);

  // tracks (ring band + spoke bands)
  g.save();
  g.lineCap = 'round';
  for (let s = 0; s < 6; s++) {
    const [x0, y0] = P(...pos(hqRing(s)));
    g.strokeStyle = 'rgba(8, 14, 36, 0.95)';
    g.lineWidth = k * 0.62;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(c, c); g.stroke();
    g.strokeStyle = 'rgba(80, 200, 255, 0.35)';
    g.lineWidth = k * 0.03;
    for (const off of [-0.3, 0.3]) {
      const a = (hqRing(s) / RING) * Math.PI * 2;
      const ox = Math.cos(a) * off * k;
      const oy = Math.sin(a) * off * k;
      g.beginPath(); g.moveTo(x0 + ox, y0 + oy); g.lineTo(c + ox, c + oy); g.stroke();
    }
  }
  g.restore();
  ring(g, c, k * R, 'rgba(8, 14, 36, 0.95)', k * 0.74);
  ring(g, c, k * (R - 0.37), 'rgba(80, 200, 255, 0.4)', k * 0.03);
  ring(g, c, k * (R + 0.37), 'rgba(80, 200, 255, 0.4)', k * 0.03);

  // spaces
  for (let n = 0; n < NODE_COUNT; n++) {
    if (n === HUB) continue;
    const info = nodeInfo(n);
    const [x, y] = P(...pos(n));
    if (info.kind === 'hq') continue; // drawn last, on top
    if (n < RING) {
      const a = (n / RING) * Math.PI * 2;
      const w = ((Math.PI * 2) / RING) * 0.84;
      sector(g, c, k * (R - 0.32), k * (R + 0.32), a - w / 2, a + w / 2);
    } else {
      roundedSquare(g, x, y, k * 0.25, (nodeInfo(n).spoke / 6) * Math.PI * 2);
    }
    if (info.kind === 'again') {
      g.fillStyle = 'rgba(20, 28, 60, 0.95)';
      g.fill();
      g.strokeStyle = 'rgba(230, 240, 255, 0.85)';
      g.lineWidth = k * 0.03;
      g.stroke();
      againIcon(g, x, y, k * 0.15);
    } else {
      const col = slots[info.slot].color;
      const grd = g.createRadialGradient(x, y, 0, x, y, k * 0.4);
      grd.addColorStop(0, hexA(col, 0.95));
      grd.addColorStop(1, hexA(col, 0.45));
      g.fillStyle = grd;
      g.fill();
      g.save();
      g.shadowColor = col;
      g.shadowBlur = k * 0.18;
      g.strokeStyle = hexA('#ffffff', 0.7);
      g.lineWidth = k * 0.025;
      g.stroke();
      g.restore();
    }
  }

  // hub
  for (let s = 0; s < 6; s++) {
    const a0 = (s / 6) * Math.PI * 2 - Math.PI / 6;
    const a1 = a0 + Math.PI / 3;
    g.beginPath();
    g.moveTo(c, c);
    g.lineTo(c + Math.sin(a0) * k * HUB_R, c - Math.cos(a0) * k * HUB_R);
    g.lineTo(c + Math.sin(a1) * k * HUB_R, c - Math.cos(a1) * k * HUB_R);
    g.closePath();
    g.fillStyle = hexA(slots[s].color, 0.85);
    g.fill();
  }
  g.save();
  g.shadowColor = '#7fe8ff';
  g.shadowBlur = k * 0.35;
  hexPath(g, c, c, k * HUB_R, Math.PI / 6); // corners line up with the colored triangles
  g.strokeStyle = '#bff4ff';
  g.lineWidth = k * 0.05;
  g.stroke();
  g.restore();
  g.beginPath();
  g.arc(c, c, k * 0.42, 0, Math.PI * 2);
  g.fillStyle = '#060a1c';
  g.fill();
  g.strokeStyle = 'rgba(190, 240, 255, 0.8)';
  g.lineWidth = k * 0.03;
  g.stroke();
  neonText(g, 'HUB', c, c, k * 0.22, '#9ff0ff');

  // HQs + category labels
  for (let s = 0; s < 6; s++) {
    const n = hqRing(s);
    const [x, y] = P(...pos(n));
    const col = slots[s].color;
    g.save();
    g.shadowColor = col;
    g.shadowBlur = k * 0.45;
    hexPath(g, x, y, k * 0.46, 0);
    const grd = g.createRadialGradient(x, y, 0, x, y, k * 0.46);
    grd.addColorStop(0, hexA('#ffffff', 0.95));
    grd.addColorStop(0.35, col);
    grd.addColorStop(1, hexA(col, 0.7));
    g.fillStyle = grd;
    g.fill();
    g.restore();
    hexPath(g, x, y, k * 0.46, 0);
    g.strokeStyle = '#ffffff';
    g.lineWidth = k * 0.04;
    g.stroke();
    // wedge icon
    g.beginPath();
    g.moveTo(x, y + k * 0.05);
    g.arc(x, y + k * 0.05, k * 0.22, -Math.PI / 2 - Math.PI / 6, -Math.PI / 2 + Math.PI / 6);
    g.closePath();
    g.fillStyle = 'rgba(6, 10, 28, 0.85)';
    g.fill();
    // label outside the ring, along the circle
    const a = (n / RING) * Math.PI * 2;
    g.save();
    g.translate(c + Math.sin(a) * k * 4.66, c - Math.cos(a) * k * 4.66);
    let rot = a;
    if (a > Math.PI / 2 && a < (Math.PI * 3) / 2) rot += Math.PI; // keep text upright
    g.rotate(rot);
    g.font = `800 ${k * 0.16}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = col;
    g.shadowColor = col;
    g.shadowBlur = k * 0.15;
    g.fillText(slots[s].name.toUpperCase(), 0, 0);
    g.restore();
  }

  // scanlines
  g.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < size; y += 4) g.fillRect(0, y, size, 1);
  return cv;
}

export function drawBoardBack(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#060a1c';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(80, 200, 255, 0.3)';
  g.lineWidth = 2;
  for (let i = 0; i < size; i += 24) {
    hexPath(g, i, (i * 1.7) % size, 14, 0);
    g.stroke();
  }
  return cv;
}

// ───────── helpers ─────────

function hexPath(g, x, y, r, rot) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + (i * Math.PI) / 3;
    const px = x + Math.sin(a) * r;
    const py = y - Math.cos(a) * r;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

function ring(g, c, r, color, width, dash) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = width;
  if (dash) g.setLineDash(dash);
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.stroke();
  g.restore();
}

// annular sector; angles measured clockwise from "up"
function sector(g, c, r0, r1, a0, a1) {
  const toCanvas = (a) => a - Math.PI / 2;
  g.beginPath();
  g.arc(c, c, r1, toCanvas(a0), toCanvas(a1));
  g.arc(c, c, r0, toCanvas(a1), toCanvas(a0), true);
  g.closePath();
}

function roundedSquare(g, x, y, r, rot) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  const s = r;
  const rr = r * 0.35;
  g.beginPath();
  g.moveTo(-s + rr, -s);
  g.arcTo(s, -s, s, s, rr);
  g.arcTo(s, s, -s, s, rr);
  g.arcTo(-s, s, -s, -s, rr);
  g.arcTo(-s, -s, s, -s, rr);
  g.closePath();
  g.restore();
}

function againIcon(g, x, y, r) {
  g.save();
  g.strokeStyle = '#ffffff';
  g.lineWidth = r * 0.28;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(x, y, r, -Math.PI * 0.15, Math.PI * 1.45);
  g.stroke();
  const ax = x + Math.cos(-Math.PI * 0.15) * r;
  const ay = y + Math.sin(-Math.PI * 0.15) * r;
  g.beginPath();
  g.moveTo(ax - r * 0.45, ay - r * 0.1);
  g.lineTo(ax, ay);
  g.lineTo(ax + r * 0.12, ay - r * 0.5);
  g.stroke();
  g.restore();
}

function neonText(g, text, x, y, size, color) {
  g.save();
  g.font = `900 ${size}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = size * 0.8;
  g.fillStyle = '#ffffff';
  g.fillText(text, x, y);
  g.restore();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
