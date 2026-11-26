// Ludo renderer: flat board texture, unfold intro, 3D pawns and die.

import * as THREE from 'three';
import { unfoldBoard } from '../../renderer/unfold.js';
import { Die } from '../../renderer/dice.js';
import { makePawn } from '../../renderer/pieces.js';
import { ease, badgeSprite } from '../../renderer/stage.js';
import { drawBoard, drawBoardBack, pawnSpot, COLORS, GRID } from './board.js';

const SIZE = 10;
const THICK = 0.16;
const CELL = SIZE / GRID;
const PAWN_H = CELL * 0.95;

const toWorld = ([u, v]) => new THREE.Vector3((u - GRID / 2) * CELL, THICK, (v - GRID / 2) * CELL);

export function createRenderer(stage, { seats }) {
  const colors = seats.map((s) => s.id);
  const pawns = [];      // pawns[seat][i] → THREE.Group
  const decor = [];      // badges/rings currently shown
  let board = null;
  let die = null;

  const boardTex = new THREE.CanvasTexture(drawBoard(1024));
  boardTex.colorSpace = THREE.SRGBColorSpace;
  boardTex.anisotropy = 4;
  const backTex = new THREE.CanvasTexture(drawBoardBack());
  backTex.colorSpace = THREE.SRGBColorSpace;

  // Where every pawn should stand, spreading pawns that share a square.
  function layout(state) {
    const spots = state.pawns.map((arr, seat) => arr.map((p, i) => pawnSpot(colors[seat], p, i)));
    const groups = new Map();
    state.pawns.forEach((arr, seat) => arr.forEach((p, i) => {
      if (p === -1 || p === 56) return;
      const [u, v] = spots[seat][i];
      const key = `${u.toFixed(2)},${v.toFixed(2)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([seat, i]);
    }));
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.forEach(([seat, i], k) => {
        spots[seat][i] = pawnSpot(colors[seat], state.pawns[seat][i], i, k, list.length);
      });
    }
    return spots.map((arr) => arr.map(toWorld));
  }

  async function settle(state, ms = 180) {
    const targets = layout(state);
    const starts = pawns.map((arr) => arr.map((p) => p.position.clone()));
    await stage.animate(ms, (k) => {
      pawns.forEach((arr, s) => arr.forEach((p, i) => p.position.lerpVectors(starts[s][i], targets[s][i], k)));
    }, ease.out);
  }

  function hop(pawn, to, ms, height = 0.45) {
    const from = pawn.position.clone();
    return stage.animate(ms, (k) => {
      pawn.position.lerpVectors(from, to, k);
      pawn.userData.body.position.y = Math.sin(k * Math.PI) * height;
      pawn.userData.shadow.scale.setScalar(1 - Math.sin(k * Math.PI) * 0.3);
    }, ease.inOut);
  }

  function clearDecor() {
    for (const d of decor) d.removeFromParent();
    decor.length = 0;
    stage.invalidate();
  }

  return {
    async intro(game) {
      stage.frame(SIZE, { tilt: 36, fill: 0.9, center: [2.2, 0, 0.3] });
      board = await unfoldBoard(stage, { boardTex, backTex, size: SIZE, thickness: THICK });

      die = new Die(stage, { size: CELL * 1.15 });
      die.place(SIZE / 2 + 1.1, 0, SIZE / 2 - 1.2);

      // pawns drop into their yards one color at a time
      const targets = layout(game.state);
      const drops = [];
      game.state.pawns.forEach((arr, seat) => {
        pawns[seat] = arr.map((_, i) => {
          const p = makePawn(COLORS[colors[seat]], PAWN_H);
          p.position.copy(targets[seat][i]).add(new THREE.Vector3(0, 4, 0));
          stage.scene.add(p);
          return p;
        });
        pawns[seat].forEach((p, i) => {
          drops.push(stage.wait(seat * 160 + i * 60).then(() => {
            const from = p.position.clone();
            return stage.animate(380, (k) => p.position.lerpVectors(from, targets[seat][i], k), ease.outBack);
          }));
        });
      });
      await Promise.all(drops);
      die.show(true);
    },

    async present(events, game) {
      clearDecor();
      for (const e of events) {
        if (e.type === 'roll') {
          await die.roll(e.value);
          await stage.wait(250);
        } else if (e.type === 'pass') {
          await stage.wait(450);
        } else if (e.type === 'move') {
          const p = pawns[e.seat][e.pawn];
          const color = colors[e.seat];
          for (const [i, step] of e.path.entries()) {
            await hop(p, toWorld(pawnSpot(color, step, e.pawn)), e.from === -1 ? 380 : 150, e.from === -1 ? 0.9 : 0.4);
            stage.sfx?.play('step', { pitch: 1 + i * 0.045 }); // tap on landing, rising along the move
          }
        } else if (e.type === 'capture') {
          const p = pawns[e.seat][e.pawn];
          stage.sfx?.play('punch');
          await stage.wait(90); // let the hit land before the pawn flies
          stage.sfx?.play('whoosh', { duration: 650 });
          await hop(p, toWorld(pawnSpot(colors[e.seat], -1, e.pawn)), 650, 2.2);
          stage.sfx?.play('step', { pitch: 0.8 });
        } else if (e.type === 'finished') {
          await Promise.all(pawns[e.seat].map((p, i) => stage.wait(i * 70).then(() => hop(p, p.position.clone(), 320, 0.6))));
        }
      }
      await settle(game.state);
    },

    showDecision(d, game) {
      clearDecor();
      if (d.kind !== 'choose') return;
      d.options.forEach((opt, i) => {
        const m = opt.data;
        const pawn = pawns[d.seat][m.pawn];
        const badge = badgeSprite(String(i + 1), '#ffffff', COLORS[colors[d.seat]]);
        badge.scale.setScalar(0.55);
        badge.position.set(0, PAWN_H + 0.45, 0);
        pawn.add(badge);
        decor.push(badge);

        const target = toWorld(pawnSpot(colors[d.seat], m.to, m.pawn));
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(CELL * 0.28, CELL * 0.4, 24),
          new THREE.MeshBasicMaterial({ color: COLORS[colors[d.seat]], transparent: true, opacity: 0.85, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(target).add(new THREE.Vector3(0, 0.012, 0));
        const label = badgeSprite(String(i + 1), COLORS[colors[d.seat]], '#ffffff');
        label.scale.setScalar(0.32);
        label.position.copy(target).add(new THREE.Vector3(0, 0.28, 0));
        stage.scene.add(ring, label);
        decor.push(ring, label);
      });
      stage.invalidate();
    },

    clearDecision: clearDecor,

    dispose() {
      clearDecor();
      for (const arr of pawns) for (const p of arr) p.removeFromParent();
      board?.removeFromParent();
      die?.group.removeFromParent();
      boardTex.dispose();
      backTex.dispose();
      stage.invalidate();
    },
  };
}
