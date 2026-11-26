// Tubes & Teleporters renderer: neon board texture, hover-beacon pieces,
// beam-up teleports and slides through the tubes.

import * as THREE from 'three';
import { unfoldBoard } from '../../renderer/unfold.js';
import { Die } from '../../renderer/dice.js';
import { ease, blobShadow, badgeSprite } from '../../renderer/stage.js';
import { drawBoard, drawBoardBack, spotFor, stackScale, tubeCurve, squareCenter, COLS, ROWS } from './board.js';

const CELL = 1;
const THICK = 0.16;
const PIECE_H = 0.62;

const toWorld = ([u, v]) => new THREE.Vector3((u - COLS / 2) * CELL, THICK, (v - ROWS / 2) * CELL);

// Beacon piece: dark metal body tinted with the seat color, glowing orb and base ring.
let bodyGeo;
let orbGeo;
let ringGeo;
function makeBeacon(color) {
  if (!bodyGeo) {
    const h = PIECE_H;
    const pts = [[0, 0], [0.24, 0], [0.25, 0.05], [0.2, 0.09], [0.11, 0.16], [0.08, 0.42], [0.13, 0.48], [0.1, 0.52], [0, 0.52]]
      .map(([r, y]) => new THREE.Vector2(r * h, y * h));
    bodyGeo = new THREE.LatheGeometry(pts, 6); // hexagonal = more "tech" than round
    orbGeo = new THREE.IcosahedronGeometry(0.13 * h, 1);
    orbGeo.translate(0, 0.66 * h, 0);
    ringGeo = new THREE.TorusGeometry(0.27 * h, 0.025 * h, 6, 24);
    ringGeo.rotateX(Math.PI / 2);
    ringGeo.translate(0, 0.02, 0);
  }
  const c = new THREE.Color(color);
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
    color: c.clone().multiplyScalar(0.55), metalness: 0.6, roughness: 0.35, emissive: c, emissiveIntensity: 0.18, flatShading: true,
  }));
  const glow = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.4, roughness: 0.3 });
  const orb = new THREE.Mesh(orbGeo, glow);
  const ring = new THREE.Mesh(ringGeo, glow);
  const inner = new THREE.Group();
  inner.add(body, orb, ring);
  const shadow = blobShadow(0.3);
  shadow.position.y = 0.005;
  const g = new THREE.Group();
  g.add(shadow, inner);
  g.userData = { body: inner, shadow, color: c };
  return g;
}

export function createRenderer(stage, { seats }) {
  const n = seats.length;
  const pieces = [];
  const decor = [];
  let board = null;
  let die = null;

  const boardTex = new THREE.CanvasTexture(drawBoard(seats.map((s) => s.color), 1024));
  boardTex.colorSpace = THREE.SRGBColorSpace;
  boardTex.anisotropy = 4;
  const backTex = new THREE.CanvasTexture(drawBoardBack());
  backTex.colorSpace = THREE.SRGBColorSpace;

  // Target position + scale for every piece, spreading pieces that share a square.
  function layout(state) {
    const bySquare = new Map();
    state.pos.forEach((p, seat) => {
      if (p === 0) return;
      if (!bySquare.has(p)) bySquare.set(p, []);
      bySquare.get(p).push(seat);
    });
    return state.pos.map((p, seat) => {
      const group = bySquare.get(p) ?? [seat];
      const idx = group.indexOf(seat);
      return { at: toWorld(spotFor(p, seat, idx, group.length, n)), scale: p === 0 ? 1 : stackScale(group.length) };
    });
  }

  async function settle(state, ms = 220) {
    const targets = layout(state);
    const from = pieces.map((p) => ({ at: p.position.clone(), scale: p.scale.x }));
    await stage.animate(ms, (k) => pieces.forEach((p, i) => {
      p.position.lerpVectors(from[i].at, targets[i].at, k);
      p.scale.setScalar(from[i].scale + (targets[i].scale - from[i].scale) * k);
    }), ease.out);
  }

  function hop(piece, to, ms, height = 0.4) {
    const from = piece.position.clone();
    return stage.animate(ms, (k) => {
      piece.position.lerpVectors(from, to, k);
      piece.userData.body.position.y = Math.sin(k * Math.PI) * height;
      piece.userData.shadow.scale.setScalar(1 - Math.sin(k * Math.PI) * 0.3);
    }, ease.inOut);
  }

  // Vertical light column used for teleports.
  function beam(at, color) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 3, 20, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.position.copy(at).add(new THREE.Vector3(0, 1.5, 0));
    stage.scene.add(m);
    return m;
  }

  async function teleport(piece, from, to) {
    const color = piece.userData.color;
    const a = toWorld(squareCenter(from));
    const b = toWorld(squareCenter(to));
    const beamA = beam(a, color);
    const beamB = beam(b, color);
    stage.sfx?.play('teleport');
    const s0 = piece.scale.x;
    // dematerialize: beam fades in, piece stretches thin and rises
    await stage.animate(420, (k) => {
      beamA.material.opacity = 0.55 * k;
      piece.scale.set(s0 * (1 - 0.85 * k), s0 * (1 + 1.5 * k), s0 * (1 - 0.85 * k));
      piece.userData.body.position.y = k * 1.2;
    }, ease.inOut);
    piece.position.copy(b);
    // rematerialize at the destination
    await stage.animate(420, (k) => {
      beamA.material.opacity = 0.55 * (1 - k);
      beamB.material.opacity = 0.55 * (1 - Math.abs(0.5 - k) * 2) + 0.2 * (1 - k);
      piece.scale.set(s0 * (0.15 + 0.85 * k), s0 * (2.5 - 1.5 * k), s0 * (0.15 + 0.85 * k));
      piece.userData.body.position.y = (1 - k) * 1.2;
    }, ease.out);
    for (const m of [beamA, beamB]) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); }
    piece.scale.setScalar(s0);
    piece.userData.body.position.y = 0;
  }

  async function slide(piece, from, to) {
    const pts = tubeCurve(from, to).map(toWorld);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    const ms = Math.min(1700, Math.max(750, len * 150));
    stage.sfx?.play('slide', { duration: ms });
    const s0 = piece.scale.x;
    const tmp = new THREE.Vector3();
    await stage.animate(ms, (k) => {
      const f = Math.min(1, Math.max(0, k)) * (pts.length - 1);
      const i = Math.max(0, Math.min(pts.length - 2, Math.floor(f)));
      tmp.lerpVectors(pts[i], pts[i + 1], f - i);
      piece.position.copy(tmp);
      // squeeze while inside the tube, spin a little
      const inside = Math.sin(k * Math.PI);
      piece.scale.setScalar(s0 * (1 - 0.35 * inside));
      piece.userData.body.position.y = 0.12 * inside;
      piece.rotation.y = k * Math.PI * 4;
    }, ease.inOut);
    piece.rotation.y = 0;
    piece.scale.setScalar(s0);
    piece.userData.body.position.y = 0;
  }

  function clearDecor() {
    for (const d of decor) d.removeFromParent();
    decor.length = 0;
    stage.invalidate();
  }

  return {
    async intro(game) {
      stage.frame(ROWS, { tilt: 34, fill: 0.92, center: [2.4, 0, 0.35] });
      board = await unfoldBoard(stage, { boardTex, backTex, size: COLS, depth: ROWS, thickness: THICK, edgeColor: 0x2a1458 });

      die = new Die(stage, { size: 0.95, faceColor: '#140a30', pipColor: '#00e5ff', onePipColor: '#ff2bd6', glow: true });
      die.place(COLS / 2 + 1.2, 0, ROWS / 2 - 1.4);

      const targets = layout(game.state);
      await Promise.all(game.state.pos.map((_, seat) => {
        const p = makeBeacon(seats[seat].color);
        p.position.copy(targets[seat].at).add(new THREE.Vector3(0, 4, 0));
        stage.scene.add(p);
        pieces[seat] = p;
        return stage.wait(seat * 110).then(() => {
          const from = p.position.clone();
          stage.sfx?.play('zap', { pitch: 0.8 + seat * 0.08 });
          return stage.animate(380, (k) => p.position.lerpVectors(from, targets[seat].at, k), ease.outBack);
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
          await stage.wait(200);
        } else if (e.type === 'move') {
          piece.scale.setScalar(1);
          for (const [i, sq] of e.path.entries()) {
            const backwards = i > 0 && sq < e.path[i - 1];
            await hop(piece, toWorld(spotFor(sq, e.seat)), e.from === 0 && i === 0 ? 320 : 170);
            stage.sfx?.play('zap', { pitch: backwards ? 1.1 - i * 0.06 : 1 + i * 0.07 });
          }
        } else if (e.type === 'teleport') {
          await stage.wait(120);
          await teleport(piece, e.from, e.to);
        } else if (e.type === 'tube') {
          await stage.wait(120);
          await slide(piece, e.from, e.to);
        } else if (e.type === 'finished') {
          stage.sfx?.play('win');
          for (let i = 0; i < 3; i++) await hop(piece, piece.position.clone(), 260, 0.7);
        }
      }
      await settle(game.state);
    },

    // Mark whose turn it is: a small "GO" badge above their piece (8 pieces can look alike).
    showDecision(d) {
      clearDecor();
      const piece = pieces[d.seat];
      if (!piece) return;
      const badge = badgeSprite('GO', '#ffffff', seats[d.seat].color);
      badge.scale.setScalar(0.5);
      badge.position.set(0, PIECE_H + 0.5, 0);
      piece.add(badge);
      decor.push(badge);
      stage.invalidate();
    },

    dispose() {
      clearDecor();
      for (const p of pieces) p.removeFromParent();
      board?.removeFromParent();
      die?.group.removeFromParent();
      boardTex.dispose();
      backTex.dispose();
      stage.invalidate();
    },
  };
}
