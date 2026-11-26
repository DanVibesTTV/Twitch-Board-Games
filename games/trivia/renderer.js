// Trivia Champ renderer: holographic wheel board, pie-shaped chrome pieces whose
// six sockets fill with glowing wedges, destination markers, neon die.

import * as THREE from 'three';
import { unfoldBoard } from '../../renderer/unfold.js';
import { Die } from '../../renderer/dice.js';
import { ease, blobShadow, badgeSprite } from '../../renderer/stage.js';
import { drawBoard, drawBoardBack, pos, BOARD_SIZE } from './board.js';
import { HUB } from './wheel.js';

const THICK = 0.16;
const PIECE_R = 0.27;

const toWorld = ([x, y], lift = 0) => new THREE.Vector3(x, THICK + lift, y);

// Pie piece: dark chrome puck, seat-colored glow ring, 6 wedge sockets.
function makePiece(seatColor, slotColors) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  const chrome = new THREE.MeshStandardMaterial({ color: 0x1b2440, metalness: 0.85, roughness: 0.25 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(PIECE_R, PIECE_R * 1.05, 0.14, 36), chrome);
  base.position.y = 0.07;
  const glow = new THREE.MeshStandardMaterial({ color: seatColor, emissive: seatColor, emissiveIntensity: 1.2 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(PIECE_R * 1.02, 0.022, 8, 40), glow);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.03;
  const top = new THREE.Mesh(new THREE.TorusGeometry(PIECE_R * 0.98, 0.014, 6, 40), glow);
  top.rotation.x = Math.PI / 2;
  top.position.y = 0.145;
  // socket dividers
  const divMat = new THREE.MeshStandardMaterial({ color: 0x0b1024, metalness: 0.6, roughness: 0.4 });
  for (let i = 0; i < 3; i++) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(PIECE_R * 1.9, 0.03, 0.02), divMat);
    d.position.y = 0.155;
    d.rotation.y = (i * Math.PI) / 3;
    inner.add(d);
  }
  // wedges (hidden until earned)
  const wedges = slotColors.map((col, i) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(PIECE_R * 0.9, PIECE_R * 0.9, 0.09, 10, 1, false, (i * Math.PI) / 3 + 0.04, Math.PI / 3 - 0.08),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.7, roughness: 0.3 }),
    );
    m.position.y = 0.19;
    m.visible = false;
    inner.add(m);
    return m;
  });
  inner.add(base, ring, top);
  const shadow = blobShadow(0.36);
  shadow.position.y = 0.005;
  g.add(shadow, inner);
  g.userData = { body: inner, shadow, wedges };
  return g;
}

export function createRenderer(stage, { seats }) {
  const pieces = [];
  const decor = [];
  let board = null;
  let die = null;
  let slotColors = null;
  let boardTex = null;
  const backTex = new THREE.CanvasTexture(drawBoardBack());
  backTex.colorSpace = THREE.SRGBColorSpace;

  // Where each piece stands; pieces sharing a space spread out and shrink.
  function layout(state) {
    const groups = new Map();
    state.pos.forEach((n, seat) => {
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(seat);
    });
    return state.pos.map((n, seat) => {
      const list = groups.get(n);
      const [x, y] = pos(n);
      if (list.length === 1) return { at: toWorld([x, y]), scale: 1 };
      const i = list.indexOf(seat);
      const radius = n === HUB ? 0.42 : 0.2;
      const a = (i / list.length) * Math.PI * 2;
      return { at: toWorld([x + Math.cos(a) * radius, y + Math.sin(a) * radius]), scale: n === HUB ? 0.85 : list.length > 3 ? 0.55 : 0.7 };
    });
  }

  async function settle(state, ms = 220) {
    const t = layout(state);
    const from = pieces.map((p) => ({ at: p.position.clone(), s: p.scale.x }));
    await stage.animate(ms, (k) => pieces.forEach((p, i) => {
      p.position.lerpVectors(from[i].at, t[i].at, k);
      p.scale.setScalar(from[i].s + (t[i].scale - from[i].s) * k);
    }), ease.out);
  }

  function hop(piece, to, ms, height = 0.35) {
    const from = piece.position.clone();
    return stage.animate(ms, (k) => {
      piece.position.lerpVectors(from, to, k);
      piece.userData.body.position.y = Math.sin(k * Math.PI) * height;
      piece.userData.shadow.scale.setScalar(1 - Math.sin(k * Math.PI) * 0.3);
    }, ease.inOut);
  }

  async function popWedge(piece, slot) {
    const w = piece.userData.wedges[slot];
    w.visible = true;
    stage.sfx?.play('wedge');
    await stage.animate(650, (k) => {
      const s = ease.outBack(k);
      w.scale.setScalar(Math.max(0.01, s));
      w.position.y = 0.19 + (1 - k) * 0.8;
      piece.userData.body.rotation.y = k * Math.PI * 2;
    }, ease.linear);
    piece.userData.body.rotation.y = 0;
  }

  function clearDecor() {
    for (const d of decor) d.removeFromParent();
    decor.length = 0;
    stage.invalidate();
  }

  return {
    async intro(game) {
      const slots = game.state.slots;
      slotColors = slots.map((s) => s.color);
      boardTex = new THREE.CanvasTexture(drawBoard(slots, 1024));
      boardTex.colorSpace = THREE.SRGBColorSpace;
      boardTex.anisotropy = 4;
      stage.frame(BOARD_SIZE, { tilt: 32, fill: 0.92, center: [2.3, 0, 0.35] });
      board = await unfoldBoard(stage, { boardTex, backTex, size: BOARD_SIZE, thickness: THICK, edgeColor: 0x0d1430 });

      die = new Die(stage, { size: 0.9, faceColor: '#0b1230', pipColor: '#7fe8ff', onePipColor: '#ff4fb4', glow: true });
      die.place(BOARD_SIZE / 2 + 1.2, 0, BOARD_SIZE / 2 - 1.4);

      const targets = layout(game.state);
      await Promise.all(seats.map((seat, i) => {
        const p = makePiece(seat.color, slotColors);
        p.position.copy(targets[i].at).add(new THREE.Vector3(0, 4, 0));
        p.scale.setScalar(targets[i].scale);
        stage.scene.add(p);
        pieces[i] = p;
        return stage.wait(i * 120).then(() => {
          const from = p.position.clone();
          stage.sfx?.play('zap', { pitch: 0.8 + i * 0.1 });
          return stage.animate(380, (k) => p.position.lerpVectors(from, targets[i].at, k), ease.outBack);
        });
      }));
      die.show(true);
    },

    async present(events, game) {
      clearDecor();
      for (const e of events) {
        const piece = pieces[e.seat];
        if (e.type === 'roll') {
          await die.roll(e.value);
          await stage.wait(150);
        } else if (e.type === 'move') {
          piece.scale.setScalar(1);
          for (const [i, n] of e.path.entries()) {
            await hop(piece, toWorld(pos(n)), 170);
            stage.sfx?.play('zap', { pitch: 1 + i * 0.07 });
          }
        } else if (e.type === 'rollAgain') {
          stage.sfx?.play('zap', { pitch: 1.6 });
          await stage.animate(500, (k) => { piece.userData.body.rotation.y = k * Math.PI * 2; }, ease.inOut);
          piece.userData.body.rotation.y = 0;
        } else if (e.type === 'answer') {
          stage.sfx?.play(e.correct ? 'correct' : 'wrong');
          await stage.wait(2600); // the HUD shows the right answer meanwhile
        } else if (e.type === 'wedge') {
          await popWedge(piece, e.slot);
        } else if (e.type === 'win') {
          stage.sfx?.play('win');
          for (let i = 0; i < 3; i++) await hop(piece, piece.position.clone(), 260, 0.7);
        }
      }
      await settle(game.state);
    },

    showDecision(d, game) {
      clearDecor();
      if (d.kind === 'choose' && game.state.phase === 'move') {
        const color = seats[d.seat].color;
        d.options.forEach((opt, i) => {
          const at = toWorld(pos(opt.data.node));
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.2, 0.3, 32),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.copy(at).add(new THREE.Vector3(0, 0.012, 0));
          const badge = badgeSprite(String(i + 1), '#ffffff', color === '#eef2ff' ? '#334' : color);
          badge.scale.setScalar(0.42);
          badge.position.copy(at).add(new THREE.Vector3(0, 0.5, 0));
          stage.scene.add(ring, badge);
          decor.push(ring, badge);
        });
      } else {
        // who acts: the player, or (final category) the opponent who picks
        const piece = pieces[d.seat];
        if (piece) {
          const label = game.state.phase === 'finalPick' ? '?' : 'GO';
          const badge = badgeSprite(label, '#ffffff', seats[d.seat].color === '#eef2ff' ? '#334' : seats[d.seat].color);
          badge.scale.setScalar(0.45);
          badge.position.set(0, 0.75, 0);
          piece.add(badge);
          decor.push(badge);
        }
      }
      stage.invalidate();
    },

    dispose() {
      clearDecor();
      for (const p of pieces) p.removeFromParent();
      board?.removeFromParent();
      die?.group.removeFromParent();
      boardTex?.dispose();
      backTex.dispose();
      stage.invalidate();
    },
  };
}
