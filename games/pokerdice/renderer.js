// Poker Dice renderer: a battered pirate table with a broken corner (real geometry, not just paint),
// bone dice with 9–A faces, a parchment ledger, and gold doubloons flying to the round's winner.

import * as THREE from 'three';
import { DiceRow } from '../../renderer/dicerow.js';
import { ease } from '../../renderer/stage.js';
import { drawTable, drawBoneFace, coinTarget, OUTLINE, W, D, PX, DICE_ROW, HOLD_Z } from './board.js';

const THICK = 0.32;
const DIE = 0.92;
const rowPos = (i) => new THREE.Vector3(DICE_ROW.x + (i - 2) * DICE_ROW.gap, THICK, DICE_ROW.z);
const holdPos = (i) => new THREE.Vector3(DICE_ROW.x + (i - 2) * DICE_ROW.gap, THICK, HOLD_Z);

// The table: the outline extruded into thick planks. Shape y = −z, then rotated flat; the top cap's
// UVs are the shape coordinates, so the texture is scaled to the 16×9 table.
function buildTable(tex) {
  const shape = new THREE.Shape(OUTLINE.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: THICK, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  tex.repeat.set(1 / W, 1 / D);
  tex.offset.set(0.5, 0.5);
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  const side = new THREE.MeshStandardMaterial({ color: 0x3b2412, roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, [top, side]);
  return mesh;
}

export function createRenderer(stage, { seats }) {
  const canvas = document.createElement('canvas');
  canvas.width = W * PX;
  canvas.height = D * PX;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  let table = null;
  let row = null;
  let lamp = null;
  const coins = [];

  const seatInfo = () => seats.map((s) => ({
    color: s.color,
    label: s.occupant?.type === 'human' ? s.occupant.user.name : s.occupant?.type === 'crowd' ? 'Chat' : 'Bot',
  }));

  // view: optional state override (e.g. last round's hands while its result is shown)
  function redraw(game, view = game.state) {
    drawTable(canvas, { state: view, seats: seatInfo() });
    tex.needsUpdate = true;
    stage.invalidate();
  }

  // A doubloon arcs from the dice to the winner's line on the ledger.
  async function flyCoin(seat, count, delay) {
    await stage.wait(delay);
    const coin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.26, 0.05, 28),
      new THREE.MeshStandardMaterial({ color: 0xf5c84c, metalness: 0.35, roughness: 0.35, emissive: 0x6a4400 }),
    );
    stage.scene.add(coin);
    coins.push(coin);
    const from = new THREE.Vector3(DICE_ROW.x, THICK + 0.5, DICE_ROW.z);
    const [tx, tz] = coinTarget(seat, count, seats.length);
    const to = new THREE.Vector3(tx, THICK + 0.03, tz);
    await stage.animate(750, (k) => {
      coin.position.lerpVectors(from, to, k);
      coin.position.y += Math.sin(k * Math.PI) * 2.2;
      coin.rotation.x = k * Math.PI * 4;
    }, ease.inOut);
    coin.rotation.x = 0;
    stage.sfx?.play('coin', { pitch: 1 + count * 0.03 });
  }

  function clearCoins() {
    for (const c of coins) { c.removeFromParent(); c.geometry.dispose(); }
    coins.length = 0;
  }

  return {
    async intro(game) {
      stage.frame(W, { tilt: 24, fill: 1.26, center: [2.8, 0, 0.4] });
      redraw(game);
      lamp = new THREE.PointLight(0xffb060, 18, 22, 1.6); // warm lantern glow
      lamp.position.set(-3, 6, 1);
      stage.scene.add(lamp);
      table = buildTable(tex);
      stage.scene.add(table);
      // the table drops onto the deck with a thud and settles
      await stage.animate(520, (k) => {
        table.position.y = (1 - k) * 5;
        table.rotation.z = (1 - k) * 0.08;
      }, (t) => t * t);
      stage.sfx?.play('thud');
      await stage.animate(260, (k) => { table.position.y = Math.sin(k * Math.PI) * 0.18; table.rotation.z = Math.sin(k * Math.PI) * -0.012; }, ease.out);
      row = new DiceRow(stage, { rowAt: rowPos, holdAt: holdPos, size: DIE, die: { drawFace: drawBoneFace, roughness: 0.7, radius: 0.24, upright: true, jitter: 0.22 } });
    },

    async present(events, game) {
      row.clearBadges();
      for (const e of events) {
        if (e.type === 'roll') {
          await row.roll(e);
          if (e.rank >= 5) { stage.sfx?.play('correct'); await row.hop(0.5); }
          redraw(game);
        } else if (e.type === 'hold') {
          stage.sfx?.play('clack', { pitch: e.held ? 1.1 : 0.85 });
          await row.setHeld(e.die, e.held);
        } else if (e.type === 'stand') {
          redraw(game);
          await stage.wait(700);
        } else if (e.type === 'turn') {
          clearCoins();
          await row.reset();
          redraw(game);
        } else if (e.type === 'roundEnd') {
          // coins counted before this round's win (the ledger is redrawn with the new total after)
          const before = e.coins.map((c, i) => (e.winners.includes(i) ? c - 1 : c));
          const view = { ...game.state, round: e.round, hands: e.hands, current: -1, rolled: false, over: false };
          redraw(game, { ...view, coins: before });
          await stage.wait(600);
          stage.sfx?.play('win');
          await Promise.all(e.winners.map((w, k) => flyCoin(w, before[w], k * 250)));
          redraw(game, { ...view, coins: e.coins });
          await stage.wait(1800);
        }
      }
      redraw(game);
    },

    showDecision(d, game) {
      row.clearBadges();
      redraw(game);
      if (d.kind === 'hold') row.showBadges(seats[d.seat].color);
    },

    dispose() {
      row?.dispose();
      clearCoins();
      table?.removeFromParent();
      table?.geometry.dispose();
      lamp?.removeFromParent();
      tex.dispose();
      stage.invalidate();
    },
  };
}
