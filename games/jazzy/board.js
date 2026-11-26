// Jazzy Dice board art: a 16×9 lounge table (canvas texture) with the hold lane and the scorecard,
// plus the vinyl record the dice roll on. All 2D canvas, redrawn when the scorecard changes.

import { CATEGORIES, totals, UPPER_BONUS_AT } from './logic.js';

export const W = 16;                 // board width (world units)
export const D = 9;                  // board depth
export const PX = 128;               // canvas pixels per unit
export const RECORD = { x: -4.3, z: -0.75, r: 3.3 };
export const DICE_ROW = { x: RECORD.x, z: RECORD.z, gap: 1.2 };
export const HOLD_Z = 3.45;

const NAVY = '#15122b';
const INK = '#1d1934';
const GOLD = '#d9a73e';
const GOLD_LIGHT = '#f6d68a';
const IVORY = '#f8f1e2';
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Segoe UI", Inter, system-ui, sans-serif';

const toPx = (x, z) => [(x + W / 2) * PX, (z + D / 2) * PX];

// The scorecard sits on the right of the board.
const CARD = { x: 1010, y: 54, w: 990, h: 1044 };
const ROWS = [
  { kind: 'head' },
  ...CATEGORIES.slice(0, 6).map((_, i) => ({ kind: 'cat', cat: i })),
  { kind: 'bonus' },
  ...CATEGORIES.slice(6).map((_, i) => ({ kind: 'cat', cat: i + 6 })),
  { kind: 'jazzBonus' },
  { kind: 'total' },
];

// model: { state, seats: [{ color, label }], decision, flash: { seat, cat } | null }
export function drawBoard(cv, model) {
  const g = cv.getContext('2d');
  const { width: w, height: h } = cv;
  g.save();
  g.clearRect(0, 0, w, h);

  // felt-like navy with a warm spotlight on the record
  g.fillStyle = NAVY;
  g.fillRect(0, 0, w, h);
  const [rx, rz] = toPx(RECORD.x, RECORD.z);
  const spot = g.createRadialGradient(rx, rz, 50, rx, rz, 760);
  spot.addColorStop(0, 'rgba(120, 90, 200, 0.28)');
  spot.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = spot;
  g.fillRect(0, 0, w, h);
  decoFrame(g, w, h);

  // rolls left
  const st = model.state;
  g.fillStyle = GOLD_LIGHT;
  g.font = `600 30px ${SANS}`;
  g.textBaseline = 'middle';
  g.fillText('ROLLS', 70, 92);
  for (let i = 0; i < 3; i++) {
    const used = !st.rolled ? 0 : 3 - st.rollsLeft;
    g.beginPath();
    g.arc(200 + i * 40, 92, 13, 0, Math.PI * 2);
    if (i < used) { g.fillStyle = GOLD; g.fill(); }
    g.strokeStyle = GOLD;
    g.lineWidth = 3;
    g.stroke();
  }

  // hold lane under the record
  const [lx0, lz] = toPx(DICE_ROW.x - DICE_ROW.gap * 2 - 0.62, HOLD_Z);
  const [lx1] = toPx(DICE_ROW.x + DICE_ROW.gap * 2 + 0.62, HOLD_Z);
  roundRect(g, lx0, lz - 66, lx1 - lx0, 132, 30);
  g.fillStyle = 'rgba(217, 167, 62, 0.08)';
  g.fill();
  g.setLineDash([14, 10]);
  g.strokeStyle = 'rgba(246, 214, 138, 0.65)';
  g.lineWidth = 3;
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(246, 214, 138, 0.35)';
  g.font = `700 34px ${SANS}`;
  g.textAlign = 'center';
  g.fillText('H E L D', (lx0 + lx1) / 2, lz + 2);
  g.textAlign = 'left';

  drawScorecard(g, model);
  g.restore();
}

function drawScorecard(g, { state: st, seats, decision, flash }) {
  const n = seats.length;
  const { x, y, w, h } = CARD;
  // card
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 30;
  g.shadowOffsetY = 10;
  roundRect(g, x, y, w, h, 26);
  g.fillStyle = IVORY;
  g.fill();
  g.restore();
  roundRect(g, x + 12, y + 12, w - 24, h - 24, 18);
  g.strokeStyle = GOLD;
  g.lineWidth = 3;
  g.stroke();

  // title
  g.textBaseline = 'middle';
  g.fillStyle = INK;
  g.font = `italic 700 52px ${SERIF}`;
  g.textAlign = 'left';
  g.fillText('Jazzy Dice', x + 40, y + 62);
  g.font = `600 28px ${SANS}`;
  g.textAlign = 'right';
  g.fillStyle = '#6b6488';
  g.fillText(st.over ? 'Final score' : `Round ${Math.min(st.round, st.rules.rounds)} / ${st.rules.rounds}`, x + w - 40, y + 64);

  const top = y + 112;
  const rowH = (h - 112 - 30) / ROWS.length;
  const labelW = 400;
  const colW = (w - 60 - labelW) / n;
  const colX = (i) => x + 30 + labelW + i * colW;
  const scoring = decision?.kind === 'score' ? decision : null;

  // current player's column
  if (!st.over) {
    roundRect(g, colX(st.current) + 4, top + 4, colW - 8, rowH * ROWS.length - 8, 14);
    g.fillStyle = hexA(seats[st.current].color, 0.16);
    g.fill();
  }

  ROWS.forEach((row, r) => {
    const ry = top + r * rowH;
    const cy = ry + rowH / 2;
    // separators: gold lines around the bonus rows and before the total
    if (r > 0) {
      g.strokeStyle = row.kind === 'bonus' || row.kind === 'total' || ROWS[r - 1].kind === 'bonus' ? GOLD : 'rgba(29,25,52,0.12)';
      g.lineWidth = row.kind === 'total' ? 3 : 1.5;
      g.beginPath();
      g.moveTo(x + 30, ry);
      g.lineTo(x + w - 30, ry);
      g.stroke();
    }
    g.textAlign = 'left';
    if (row.kind === 'head') {
      seats.forEach((s, i) => {
        const cx = colX(i) + colW / 2;
        roundRect(g, colX(i) + 10, ry + 8, colW - 20, rowH - 14, (rowH - 14) / 2);
        g.fillStyle = s.color;
        g.fill();
        g.fillStyle = INK;
        g.textAlign = 'center';
        g.font = `700 ${n > 3 ? 24 : 27}px ${SANS}`;
        g.fillText(fit(g, s.label, colW - 36), cx, cy + 1);
      });
      return;
    }
    // label
    let label;
    let sub = '';
    if (row.kind === 'cat') {
      const c = CATEGORIES[row.cat];
      label = c.id === 'jazz' ? 'JAZZ' : c.name;
      if (c.id === 'jazz') sub = 'five alike';
      if (c.id === 'house') sub = '25';
      if (c.id === 'small') sub = '30';
      if (c.id === 'large') sub = '40';
    } else if (row.kind === 'bonus') {
      label = 'Upper bonus';
      sub = st.rules.upperBonus ? `${UPPER_BONUS_AT}+ → 35` : 'off';
    } else if (row.kind === 'jazzBonus') {
      label = 'Jazz bonus';
      sub = '+100 each';
    } else {
      label = 'TOTAL';
    }
    const opt = row.kind === 'cat' && scoring ? scoring.options[row.cat] : null;
    const badge = opt && !opt.disabled;
    if (badge) {
      g.beginPath();
      g.arc(x + 62, cy, rowH * 0.36, 0, Math.PI * 2);
      g.fillStyle = seats[st.current].color;
      g.fill();
      g.fillStyle = INK;
      g.textAlign = 'center';
      g.font = `800 ${Math.round(rowH * 0.46)}px ${SANS}`;
      g.fillText(String(row.cat + 1), x + 62, cy + 1);
      g.textAlign = 'left';
    }
    g.fillStyle = row.kind === 'total' ? INK : row.kind === 'cat' ? INK : '#5d5678';
    g.font = row.kind === 'total' ? `800 32px ${SANS}` : row.kind === 'cat' && CATEGORIES[row.cat].id === 'jazz' ? `italic 800 31px ${SERIF}` : `600 28px ${SANS}`;
    const lx = x + 100;
    g.fillText(label, lx, cy + 1);
    if (sub) {
      const lw = g.measureText(label).width;
      g.font = `500 21px ${SANS}`;
      g.fillStyle = '#8a83a6';
      g.fillText(sub, lx + lw + 12, cy + 2);
    }

    // values per player
    seats.forEach((_, i) => {
      const cx = colX(i) + colW / 2;
      const t = totals(st.cards[i], st.jazzBonus[i], st.rules);
      g.textAlign = 'center';
      let text = '';
      let color = INK;
      let font = `700 32px ${SANS}`;
      if (row.kind === 'cat') {
        const v = st.cards[i][row.cat];
        if (v !== null) { text = String(v); color = v === 0 ? '#a49dbb' : INK; }
        else if (opt && i === st.current) {
          // what this box would score now
          if (!opt.disabled) {
            const p = opt.data.points;
            roundRect(g, cx - 40, cy - rowH * 0.36, 80, rowH * 0.72, 12);
            g.fillStyle = p > 0 ? hexA(seats[i].color, 0.85) : 'rgba(29,25,52,0.10)';
            g.fill();
            text = String(p);
            color = INK;
            font = `italic 800 30px ${SANS}`;
          }
        }
      } else if (row.kind === 'bonus') {
        if (!st.rules.upperBonus) text = '';
        else if (t.bonus) text = String(t.bonus);
        else { text = `${t.upper}/${UPPER_BONUS_AT}`; color = '#8a83a6'; font = `600 24px ${SANS}`; }
      } else if (row.kind === 'jazzBonus') {
        text = t.jazzBonus ? String(t.jazzBonus) : '';
      } else if (row.kind === 'total') {
        text = String(t.total);
        font = `800 38px ${SANS}`;
      }
      if (flash && flash.seat === i && row.kind === 'cat' && flash.cat === row.cat) {
        roundRect(g, cx - 46, cy - rowH * 0.42, 92, rowH * 0.84, 14);
        g.fillStyle = 'rgba(217,167,62,0.35)';
        g.fill();
        g.strokeStyle = GOLD;
        g.lineWidth = 3;
        g.stroke();
      }
      g.fillStyle = color;
      g.font = font;
      g.fillText(text, cx, cy + 1);
    });
  });
}

// Art-deco frame: double gold line with stepped corners.
function decoFrame(g, w, h) {
  g.strokeStyle = GOLD;
  g.lineWidth = 4;
  g.strokeRect(22, 22, w - 44, h - 44);
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(217,167,62,0.6)';
  g.strokeRect(36, 36, w - 72, h - 72);
  for (const [cx, cy, sx, sy] of [[22, 22, 1, 1], [w - 22, 22, -1, 1], [22, h - 22, 1, -1], [w - 22, h - 22, -1, -1]]) {
    g.beginPath();
    for (let i = 1; i <= 3; i++) {
      g.moveTo(cx + sx * i * 14, cy);
      g.lineTo(cx, cy + sy * i * 14);
    }
    g.lineWidth = 2.5;
    g.strokeStyle = GOLD;
    g.stroke();
  }
}

export function drawBoardBack(size = 512) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = NAVY;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(217,167,62,0.35)';
  g.lineWidth = 2;
  for (let i = -size; i < size * 2; i += 36) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + size, size); g.stroke();
    g.beginPath(); g.moveTo(i + size, 0); g.lineTo(i, size); g.stroke();
  }
  return cv;
}

// Vinyl record top: grooves, a sheen and a gold label.
export function drawRecord(size = 1024) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const c = size / 2;
  const disc = g.createRadialGradient(c, c, size * 0.1, c, c, c);
  disc.addColorStop(0, '#26262e');
  disc.addColorStop(1, '#0b0b10');
  g.fillStyle = disc;
  g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.fill();
  for (let r = c * 0.36; r < c * 0.97; r += 5) {
    g.strokeStyle = `rgba(255,255,255,${0.025 + 0.02 * Math.sin(r * 0.21)})`;
    g.lineWidth = 1;
    g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();
  }
  // light sheen: two soft wedges
  for (const a of [-0.9, Math.PI - 0.9]) {
    const grad = g.createRadialGradient(c, c, c * 0.3, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(c, c); g.arc(c, c, c * 0.97, a, a + 0.5); g.closePath(); g.fill();
  }
  // label
  const lr = c * 0.32;
  const lab = g.createRadialGradient(c - lr * 0.3, c - lr * 0.3, 10, c, c, lr);
  lab.addColorStop(0, GOLD_LIGHT);
  lab.addColorStop(1, '#c08a22');
  g.fillStyle = lab;
  g.beginPath(); g.arc(c, c, lr, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(29,25,52,0.5)';
  g.lineWidth = 3;
  g.beginPath(); g.arc(c, c, lr * 0.88, 0, Math.PI * 2); g.stroke();
  g.fillStyle = INK;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `italic 700 ${Math.round(lr * 0.36)}px ${SERIF}`;
  g.fillText('Jazzy', c, c - lr * 0.36);
  g.fillText('Dice', c, c + lr * 0.4);
  g.font = `600 ${Math.round(lr * 0.13)}px ${SANS}`;
  g.fillText('33⅓ RPM · SIDE A', c, c + lr * 0.05);
  g.beginPath(); g.arc(c, c, lr * 0.06, 0, Math.PI * 2); g.fillStyle = '#0b0b10'; g.fill();
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
