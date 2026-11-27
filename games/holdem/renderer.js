// Texas Hold 'em renderer: an oval felt table with a wooden rail, real 3D cards, chips and bets
// written on the felt. It only ever sees `game.state` = one screen's view (see logic.js viewFor):
// its own two cards face up, everyone else's face down until a showdown. The player of this screen
// sits at the bottom; on the stream (no player) seat 1 does.

import * as THREE from 'three';
import { ease } from '../../renderer/stage.js';
import { RANKS, SUITS, isRed } from './cards.js';

const W = 16, D = 9, PX = 150;           // table area (world units) and felt texture resolution
const RX = 7.3, RZ = 3.95;               // oval of the rail
const THICK = 0.3, BEVEL = 0.06;          // the bevel raises the felt surface to THICK + BEVEL
const CW = 0.9, CH = 1.26, CT = 0.02;    // card size
const TOP = THICK + BEVEL + CT / 2 + 0.004;

// ── textures ──

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const faceCache = new Map();
function cardTexture(card) {
  if (faceCache.has(card)) return faceCache.get(card);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 358;
  const x = c.getContext('2d');
  if (card < 0) {
    // back: deep red with a gold border and a diamond lattice
    roundRect(x, 2, 2, 252, 354, 22); x.fillStyle = '#f4efe6'; x.fill();
    roundRect(x, 14, 14, 228, 330, 14); x.fillStyle = '#8c1d2c'; x.fill();
    x.strokeStyle = 'rgba(255, 214, 140, .35)'; x.lineWidth = 3;
    for (let k = -360; k < 360; k += 26) {
      x.beginPath(); x.moveTo(14 + k, 14); x.lineTo(14 + k + 330, 344); x.stroke();
      x.beginPath(); x.moveTo(242 - k, 14); x.lineTo(242 - k - 330, 344); x.stroke();
    }
    x.strokeStyle = '#e9c46a'; x.lineWidth = 6; roundRect(x, 24, 24, 208, 310, 10); x.stroke();
  } else {
    roundRect(x, 2, 2, 252, 354, 22); x.fillStyle = '#fbfaf6'; x.fill();
    x.strokeStyle = '#cfc8b8'; x.lineWidth = 3; x.stroke();
    const color = isRed(card) ? '#d02a32' : '#1d1a26';
    const rank = RANKS[card % 13];
    const suit = SUITS[Math.floor(card / 13)];
    x.fillStyle = color;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = `bold ${rank === '10' ? 84 : 96}px Georgia, serif`;
    x.fillText(rank, 62, 66);
    x.font = '70px serif';
    x.fillText(suit, 62, 146);
    x.font = '170px serif';
    x.fillText(suit, 160, 240);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  faceCache.set(card, tex);
  return tex;
}

const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf2eee4, roughness: 0.6 });
const cardGeo = new THREE.BoxGeometry(CW, CT, CH);

// A card shows `face` on top (−1 = its back). Box faces: +x, −x, +y (top), −y (bottom), +z, −z.
function makeCard(face) {
  const top = new THREE.MeshStandardMaterial({ map: cardTexture(face), roughness: 0.5 });
  const bottom = new THREE.MeshStandardMaterial({ map: cardTexture(-1), roughness: 0.5 });
  const mesh = new THREE.Mesh(cardGeo, [edgeMat, edgeMat, top, bottom, edgeMat, edgeMat]);
  mesh.userData.face = face;
  return mesh;
}

function setFace(mesh, face) {
  if (mesh.userData.face === face) return;
  mesh.material[2].map = cardTexture(face);
  mesh.material[2].needsUpdate = true;
  mesh.userData.face = face;
}

function disposeCard(mesh) {
  mesh.removeFromParent();
  mesh.material[2].dispose();
  mesh.material[3].dispose();
}

// ── table geometry ──

function buildTable(tex) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, RX + 0.35, RZ + 0.35, 0, Math.PI * 2, false, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: THICK, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: 0.08, bevelSegments: 3, curveSegments: 72 });
  geo.rotateX(-Math.PI / 2);
  tex.repeat.set(1 / W, 1 / D);
  tex.offset.set(0.5, 0.5);
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 });
  const side = new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.55 });
  return new THREE.Mesh(geo, [top, side]);
}

// Where seat i sits on the oval (the screen's own player at the bottom). f = how far out (0–1).
function seatPoint(i, n, bottom, f = 1) {
  const k = (i - bottom + n) % n;
  const a = Math.PI / 2 + (k / n) * Math.PI * 2;
  return [Math.cos(a) * RX * f, Math.sin(a) * RZ * f];
}

export function createRenderer(stage, { seats }) {
  const n = seats.length;
  const canvas = document.createElement('canvas');
  canvas.width = W * PX;
  canvas.height = D * PX;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  let table = null;
  let lamp = null;
  const board = [];            // community card meshes
  const hole = new Map();      // seat → [mesh, mesh]
  let shownHand = 0;           // hand number whose hole cards are on the table
  let banner = null;           // { lines, winners } while a result is shown

  const label = (i) => {
    const o = seats[i]?.occupant;
    return o?.type === 'human' ? o.user.name : o?.type === 'crowd' ? 'Chat' : `${seats[i]?.name ?? `Seat ${i + 1}`}${o?.type === 'bot' ? ' 🤖' : ''}`;
  };
  const bottomOf = (view) => (view.you ?? null) === null ? 0 : view.you;

  // Felt: rail, seat plates (name, chips, bet, dealer button), pot, blinds, result banner.
  function drawFelt(view, toAct = view.toAct) {
    const x = canvas.getContext('2d');
    const P = (wx, wz) => [(wx + W / 2) * PX, (wz + D / 2) * PX];
    x.clearRect(0, 0, canvas.width, canvas.height);
    const [cx, cy] = P(0, 0);
    // wooden rail + felt
    x.fillStyle = '#5a3418';
    x.beginPath(); x.ellipse(cx, cy, (RX + 0.35) * PX, (RZ + 0.35) * PX, 0, 0, Math.PI * 2); x.fill();
    const g = x.createRadialGradient(cx, cy, 20, cx, cy, RX * PX);
    g.addColorStop(0, '#1f7a4d'); g.addColorStop(1, '#0f4d30');
    x.fillStyle = g;
    x.beginPath(); x.ellipse(cx, cy, (RX - 0.2) * PX, (RZ - 0.2) * PX, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(255, 230, 160, .25)'; x.lineWidth = 5;
    x.beginPath(); x.ellipse(cx, cy, (RX - 1.0) * PX, (RZ - 0.85) * PX, 0, 0, Math.PI * 2); x.stroke();
    // board slots
    x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = 4;
    for (let k = 0; k < 5; k++) {
      const [sx, sy] = P(boardX(k) - CW / 2, -0.55 - CH / 2);
      roundRect(x, sx, sy, CW * PX, CH * PX, 10); x.stroke();
    }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    // pot + blinds
    const [px, py] = P(0, 0.42);
    if (!banner) { // while a result is shown, the banner takes this spot
      x.fillStyle = '#ffd36b'; x.font = `bold ${0.5 * PX}px system-ui, sans-serif`;
      x.fillText(`Pot ${view.pot}`, px, py);
      x.fillStyle = 'rgba(255,255,255,.75)'; x.font = `${0.3 * PX}px system-ui, sans-serif`;
      x.fillText(`Hand ${view.hand} · Blinds ${view.sb}/${view.bb}`, px, py + 0.48 * PX);
    }
    // seats
    const bottom = bottomOf(view);
    view.players.forEach((p, i) => {
      const [wx, wz] = seatPoint(i, n, bottom, 0.86);
      const [sx, sy] = P(wx, wz);
      const w = 2.5 * PX, h = 0.95 * PX;
      const active = i === toAct;
      const win = banner?.winners?.includes(i);
      x.globalAlpha = p.out ? 0.35 : p.folded ? 0.6 : 1;
      if (active || win) {
        x.shadowColor = win ? '#ffd36b' : '#ffffff'; x.shadowBlur = 0.35 * PX;
      }
      roundRect(x, sx - w / 2, sy - h / 2, w, h, 0.18 * PX);
      x.fillStyle = 'rgba(16, 14, 22, .88)'; x.fill();
      x.shadowBlur = 0;
      x.lineWidth = active || win ? 8 : 5;
      x.strokeStyle = win ? '#ffd36b' : seats[i]?.color ?? '#fff'; x.stroke();
      x.fillStyle = '#fff'; x.font = `bold ${0.34 * PX}px system-ui, sans-serif`;
      x.fillText(label(i).slice(0, 13), sx, sy - 0.19 * PX);
      x.fillStyle = p.out ? '#bbb' : '#ffd36b'; x.font = `bold ${0.3 * PX}px system-ui, sans-serif`;
      x.fillText(p.out ? 'out' : p.allIn ? `ALL-IN · ${p.total}` : p.folded ? 'folded' : `${p.chips}`, sx, sy + 0.22 * PX);
      x.globalAlpha = 1;
      // bet in front of the seat
      if (p.bet > 0 && !p.out) {
        const [bx, bz] = seatPoint(i, n, bottom, 0.52);
        const [qx, qy] = P(bx, bz);
        x.fillStyle = '#e8b33a'; x.beginPath(); x.arc(qx - 0.34 * PX, qy, 0.17 * PX, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#fff'; x.lineWidth = 4; x.stroke();
        x.fillStyle = '#fff'; x.font = `bold ${0.32 * PX}px system-ui, sans-serif`; x.textAlign = 'left';
        x.fillText(String(p.bet), qx - 0.1 * PX, qy);
        x.textAlign = 'center';
      }
      // dealer button
      if (i === view.dealer && !p.out) {
        const [dx, dz] = seatPoint(i, n, bottom, 0.66);
        const [qx, qy] = P(dx + 0.55, dz);
        x.fillStyle = '#fbfaf6'; x.beginPath(); x.arc(qx, qy, 0.17 * PX, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#1d1a26'; x.font = `bold ${0.2 * PX}px system-ui, sans-serif`; x.fillText('D', qx, qy + 1);
      }
    });
    // result banner across the middle
    if (banner) {
      const [bx, by] = P(0, 0.5);
      x.font = `bold ${0.36 * PX}px system-ui, sans-serif`;
      const wdt = Math.max(...banner.lines.map((l) => x.measureText(l).width)) + 0.6 * PX;
      roundRect(x, bx - wdt / 2, by - 0.32 * PX, wdt, (0.46 * banner.lines.length + 0.2) * PX, 0.2 * PX);
      x.fillStyle = 'rgba(16,14,22,.9)'; x.fill();
      x.strokeStyle = '#ffd36b'; x.lineWidth = 5; x.stroke();
      x.fillStyle = '#ffd36b';
      banner.lines.forEach((l, k) => x.fillText(l, bx, by + k * 0.46 * PX));
    }
    tex.needsUpdate = true;
    stage.invalidate();
  }

  const boardX = (k) => (k - 2) * (CW + 0.16);
  const boardPos = (k) => new THREE.Vector3(boardX(k), TOP, -0.55);
  // hole cards: a little fan in front of each seat; this screen's own cards are bigger
  function holePos(i, k, view) {
    const bottom = bottomOf(view);
    const mine = view.you !== null && i === view.you;
    const [x, z] = seatPoint(i, n, bottom, mine ? 0.6 : 0.62);
    const spread = mine ? 0.62 : 0.42;
    return { pos: new THREE.Vector3(x + (k - 0.5) * spread, TOP + k * 0.004, z + (mine ? -0.15 : 0)), scale: mine ? 1.2 : 0.8, rot: (k - 0.5) * (mine ? 0.12 : 0.18) };
  }
  const deckPos = () => new THREE.Vector3(0, TOP + 0.4, 0.2);

  async function flyCard(mesh, to, { ms = 260, scale = 1, rot = 0, flip = false } = {}) {
    const from = mesh.position.clone();
    const s0 = mesh.scale.x;
    const r0 = mesh.rotation.y;
    const z0 = mesh.rotation.z;
    await stage.animate(ms, (k) => {
      mesh.position.lerpVectors(from, to, k);
      mesh.position.y += Math.sin(k * Math.PI) * 0.6;
      mesh.scale.setScalar(s0 + (scale - s0) * k);
      mesh.rotation.y = r0 + (rot - r0) * k;
      if (flip) mesh.rotation.z = z0 * (1 - k);
    }, ease.out);
  }

  function clearCards() {
    for (const m of board) disposeCard(m);
    board.length = 0;
    for (const pair of hole.values()) for (const m of pair) disposeCard(m);
    hole.clear();
  }

  // Deals two cards to everyone in the hand (faces from the view: own cards, backs for others).
  async function deal(view) {
    clearCards();
    banner = null;
    shownHand = view.hand;
    drawFelt(view, -1);
    const live = view.players.map((p, i) => (p.cards.length ? i : -1)).filter((i) => i >= 0);
    const start = live.indexOf(live.find((i) => i > view.dealer) ?? live[0]);
    for (let round = 0; round < 2; round++) {
      for (let k = 0; k < live.length; k++) {
        const i = live[(start + k) % live.length];
        const face = view.players[i].cards[round] ?? -1;
        const m = makeCard(face);
        m.position.copy(deckPos());
        m.rotation.z = face >= 0 ? Math.PI : 0; // face-down while flying, flips over at your seat
        stage.scene.add(m);
        if (!hole.has(i)) hole.set(i, []);
        hole.get(i).push(m);
        const h = holePos(i, round, view);
        stage.sfx?.play('clack', { pitch: 1.5 + Math.random() * 0.2, gain: 0.5 });
        await flyCard(m, h.pos, { ms: 170, scale: h.scale, rot: h.rot, flip: face >= 0 });
      }
    }
  }

  // Puts the table in line with a view without animation (after a sequence, or a missed event).
  function sync(view) {
    if (view.hand !== shownHand) return; // a new hand is dealt by deal()
    view.players.forEach((p, i) => {
      const pair = hole.get(i);
      if (!pair) return;
      if (!p.cards.length || p.out || p.folded) { for (const m of pair) disposeCard(m); hole.delete(i); return; }
      pair.forEach((m, k) => setFace(m, p.cards[k]));
    });
    while (board.length < view.board.length) {
      const m = makeCard(view.board[board.length]);
      m.position.copy(boardPos(board.length));
      stage.scene.add(m);
      board.push(m);
    }
  }

  async function addBoard(cards) {
    for (const c of cards) {
      const k = board.length;
      const m = makeCard(c);
      m.position.copy(deckPos());
      m.rotation.z = Math.PI;
      stage.scene.add(m);
      board.push(m);
      stage.sfx?.play('clack', { pitch: 1.2 });
      await flyCard(m, boardPos(k), { ms: 300, flip: true });
    }
  }

  async function foldOut(i) {
    const pair = hole.get(i);
    if (!pair) return;
    hole.delete(i);
    stage.sfx?.play('whoosh', { duration: 300, gain: 0.4 });
    await Promise.all(pair.map((m) => flyCard(m, new THREE.Vector3(0, TOP, -0.55), { ms: 320, scale: 0.5 })));
    for (const m of pair) disposeCard(m);
  }

  async function reveal(shown) {
    for (const s of shown) {
      let pair = hole.get(s.seat);
      if (!pair) continue;
      pair.forEach((m, k) => setFace(m, s.cards[k]));
    }
    stage.sfx?.play('clack', { pitch: 0.9 });
    stage.invalidate();
  }

  const name = (i) => label(i);

  return {
    async intro(game) {
      const view = game.state;
      stage.frame(15.6, { tilt: 30, fill: 1.0, center: [2.4, 0, 0.35] });
      lamp = new THREE.PointLight(0xfff0d0, 14, 24, 1.4);
      lamp.position.set(0, 7, 1);
      stage.scene.add(lamp);
      drawFelt(view, -1);
      table = buildTable(tex);
      stage.scene.add(table);
      await stage.animate(500, (k) => { table.position.y = (1 - k) * -1.5; table.scale.setScalar(0.85 + 0.15 * k); }, ease.outBack);
      await deal(view);
      drawFelt(view);
    },

    async present(events, game) {
      const view = game.state;
      for (const e of events) {
        if (e.type === 'bet') {
          stage.sfx?.play(e.action === 'check' ? 'clack' : 'coin', { pitch: e.action === 'allin' ? 0.8 : 1.05 });
          if (e.action === 'allin') await stage.wait(250);
        } else if (e.type === 'fold') {
          await foldOut(e.seat);
        } else if (e.type === 'board') {
          await addBoard(e.cards);
        } else if (e.type === 'showdown') {
          await reveal(e.shown);
          banner = {
            winners: [...new Set(e.pots.flatMap((p) => p.winners))],
            lines: e.pots.map((p) => `${p.winners.map(name).join(' & ')} ${p.winners.length > 1 ? 'split' : 'win' + (p.winners.length === 1 ? 's' : '')} ${p.amount} · ${p.hand}`),
          };
          drawFelt({ ...view, toAct: -1 }, -1);
          stage.sfx?.play('win');
          await stage.wait(2800);
        } else if (e.type === 'win') {
          banner = { winners: e.pots[0].winners, lines: [`${name(e.pots[0].winners[0])} wins ${e.pots[0].amount}`] };
          drawFelt({ ...view, toAct: -1 }, -1);
          stage.sfx?.play('coin', { pitch: 1.3 });
          await stage.wait(1300);
        } else if (e.type === 'out') {
          stage.sfx?.play('wrong', { gain: 0.5 });
          await stage.wait(400);
        } else if (e.type === 'hand') {
          banner = null;
          if (view.hand === e.hand) await deal(view); // the final view belongs to this new hand
        } else if (e.type === 'gameover') {
          stage.sfx?.play('win');
        }
      }
      if (!events.some((e) => e.type === 'showdown' || e.type === 'win') || events.some((e) => e.type === 'hand')) banner = null;
      sync(view);
      drawFelt(view);
    },

    showDecision(d, game) {
      sync(game.state);
      drawFelt(game.state, d.seat);
    },

    dispose() {
      clearCards();
      table?.removeFromParent();
      table?.geometry.dispose();
      lamp?.removeFromParent();
      tex.dispose();
      stage.invalidate();
    },
  };
}
