// Jazzy Dice renderer: lounge-table board with the scorecard drawn on it, a vinyl record the five dice
// roll on (it spins while they tumble), and a "held" lane in front of it.

import * as THREE from 'three';
import { unfoldBoard } from '../../renderer/unfold.js';
import { DiceRow } from '../../renderer/dicerow.js';
import { ease } from '../../renderer/stage.js';
import { drawBoard, drawBoardBack, drawRecord, W, D, PX, RECORD, DICE_ROW, HOLD_Z } from './board.js';

const THICK = 0.16;
const DIE = 0.86;
const REC_H = 0.05;
const ROW_Y = THICK + REC_H;          // dice on the record
const HOLD_Y = THICK;                 // dice in the held lane

const rowPos = (i) => new THREE.Vector3(DICE_ROW.x + (i - 2) * DICE_ROW.gap, ROW_Y, DICE_ROW.z);
const holdPos = (i) => new THREE.Vector3(DICE_ROW.x + (i - 2) * DICE_ROW.gap, HOLD_Y, HOLD_Z);

export function createRenderer(stage, { seats }) {
  const canvas = document.createElement('canvas');
  canvas.width = W * PX;
  canvas.height = D * PX;
  const boardTex = new THREE.CanvasTexture(canvas);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  boardTex.anisotropy = 8;
  const backTex = new THREE.CanvasTexture(drawBoardBack());
  backTex.colorSpace = THREE.SRGBColorSpace;
  const recordTex = new THREE.CanvasTexture(drawRecord());
  recordTex.colorSpace = THREE.SRGBColorSpace;
  recordTex.anisotropy = 4;

  let board = null;
  let record = null;
  let row = null;

  const seatInfo = () => seats.map((s) => ({
    color: s.color,
    label: s.occupant?.type === 'human' ? s.occupant.user.name : s.occupant?.type === 'crowd' ? 'Chat' : s.occupant?.replaced ? `Bot (${s.occupant.replaced})` : `Bot`,
  }));

  function redraw(game, { decision = null, flash = null } = {}) {
    drawBoard(canvas, { state: game.state, seats: seatInfo(), decision, flash });
    boardTex.needsUpdate = true;
    stage.invalidate();
  }

  function spinRecord(ms) {
    const r0 = record.rotation.y;
    return stage.animate(ms, (k) => { record.rotation.y = r0 - k * Math.PI * 1.1; }, ease.out);
  }

  return {
    async intro(game) {
      // board on the left, clear of the HUD on the right
      stage.frame(W, { tilt: 22, fill: 1.26, center: [2.8, 0, 0.45] });
      redraw(game);
      board = await unfoldBoard(stage, { boardTex, backTex, size: W, depth: D, thickness: THICK, edgeColor: 0x2a2244 });

      record = new THREE.Mesh(
        new THREE.CylinderGeometry(RECORD.r, RECORD.r, REC_H, 72),
        [
          new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.4 }),
          new THREE.MeshStandardMaterial({ map: recordTex, roughness: 0.35, metalness: 0.1 }),
          new THREE.MeshStandardMaterial({ color: 0x0b0b10 }),
        ],
      );
      record.position.set(RECORD.x, THICK + REC_H / 2, RECORD.z);
      stage.scene.add(record);
      await stage.animate(420, (k) => {
        record.position.y = THICK + REC_H / 2 + (1 - k) * 2.5;
        record.scale.setScalar(0.85 + 0.15 * k);
      }, ease.outBack);

      row = new DiceRow(stage, { rowAt: rowPos, holdAt: holdPos, size: DIE, die: { faceColor: '#fbf6ea', pipColor: '#1d1934', onePipColor: '#c08a22' } });
      await spinRecord(700);
    },

    async present(events, game) {
      row.clearBadges();
      for (const e of events) {
        if (e.type === 'roll') {
          const spin = spinRecord(1300);
          await row.roll(e);
          await spin;
          redraw(game);
        } else if (e.type === 'jazz') {
          stage.sfx?.play('jazz', { big: true });
          await row.hop();
        } else if (e.type === 'hold') {
          stage.sfx?.play('clack', { pitch: e.held ? 1.15 : 0.9 });
          await row.setHeld(e.die, e.held);
        } else if (e.type === 'score') {
          redraw(game, { flash: { seat: e.seat, cat: e.cat } });
          if (e.jazzBonus || (e.cat === 11 && e.points === 50)) stage.sfx?.play('jazz', { big: true, pitch: e.jazzBonus ? 1.12 : 1 });
          else if (e.points > 0) stage.sfx?.play('jazz', { pitch: 0.9 + Math.min(e.points, 40) / 200 });
          else stage.sfx?.play('step', { pitch: 0.7 });
          await stage.wait(e.jazzBonus || e.points >= 30 ? 1300 : 900);
        } else if (e.type === 'upperBonus') {
          stage.sfx?.play('correct');
          await stage.wait(600);
        } else if (e.type === 'turn') {
          // the dice go back onto the record for the next player
          await row.reset();
        }
      }
      redraw(game, { decision: game.decision() });
    },

    showDecision(d, game) {
      row.clearBadges();
      redraw(game, { decision: d });
      if (d.kind === 'hold') row.showBadges(seats[d.seat].color);
    },

    dispose() {
      row?.dispose();
      board?.removeFromParent();
      record?.removeFromParent();
      boardTex.dispose();
      backTex.dispose();
      recordTex.dispose();
      stage.invalidate();
    },
  };
}
