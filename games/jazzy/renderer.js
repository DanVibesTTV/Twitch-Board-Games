// Jazzy Dice renderer: lounge-table board with the scorecard drawn on it, a vinyl record the five dice
// roll on (it spins while they tumble), and a "held" lane in front of it.

import * as THREE from 'three';
import { unfoldBoard } from '../../renderer/unfold.js';
import { Die } from '../../renderer/dice.js';
import { ease, badgeSprite } from '../../renderer/stage.js';
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
  const dice = [];
  const decor = [];

  const seatInfo = () => seats.map((s) => ({
    color: s.color,
    label: s.occupant?.type === 'human' ? s.occupant.user.name : s.occupant?.type === 'crowd' ? 'Chat' : s.occupant?.replaced ? `Bot (${s.occupant.replaced})` : `Bot`,
  }));

  function redraw(game, { decision = null, flash = null } = {}) {
    drawBoard(canvas, { state: game.state, seats: seatInfo(), decision, flash });
    boardTex.needsUpdate = true;
    stage.invalidate();
  }

  function clearDecor() {
    for (const d of decor) d.removeFromParent();
    decor.length = 0;
    stage.invalidate();
  }

  // Slide a die to its spot (row on the record, or the held lane) with a little hop.
  function moveDie(i, held, ms = 260) {
    const die = dice[i];
    const to = held ? holdPos(i) : rowPos(i);
    const from = die.group.position.clone();
    if (from.distanceTo(to) < 1e-3) return Promise.resolve();
    die.rest.copy(to);
    return stage.animate(ms, (k) => {
      die.group.position.lerpVectors(from, to, k);
      die.group.position.y += Math.sin(k * Math.PI) * 0.45;
    }, ease.inOut);
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

      for (let i = 0; i < 5; i++) {
        const die = new Die(stage, { size: DIE, faceColor: '#fbf6ea', pipColor: '#1d1934', onePipColor: '#c08a22' });
        const p = rowPos(i);
        die.place(p.x, p.y, p.z);
        dice.push(die);
      }
      await spinRecord(700);
    },

    async present(events, game) {
      clearDecor();
      for (const e of events) {
        if (e.type === 'roll') {
          stage.sfx?.play('dice', { duration: 900, dice: Math.min(3, e.rolled.length) });
          const spin = spinRecord(1300);
          await Promise.all(e.rolled.map((i, k) => stage.wait(k * 45).then(() => {
            const p = rowPos(i);
            dice[i].place(p.x, p.y, p.z);
            const from = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0, 2.6 + Math.random() * 0.8);
            return dice[i].roll(e.dice[i], { ms: 900 + Math.random() * 150, from, sound: false });
          })));
          await spin;
          redraw(game);
        } else if (e.type === 'jazz') {
          stage.sfx?.play('jazz', { big: true });
          await Promise.all(dice.map((d, i) => stage.wait(i * 60).then(() => {
            const base = d.group.position.y;
            return stage.animate(380, (k) => { d.group.position.y = base + Math.sin(k * Math.PI) * 0.7; }, ease.inOut);
          })));
        } else if (e.type === 'hold') {
          stage.sfx?.play('clack', { pitch: e.held ? 1.15 : 0.9 });
          await moveDie(e.die, e.held);
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
          await Promise.all(dice.map((_, i) => moveDie(i, false, 320)));
        }
      }
      redraw(game, { decision: game.decision() });
    },

    showDecision(d, game) {
      clearDecor();
      redraw(game, { decision: d });
      if (d.kind !== 'hold') return;
      const color = seats[d.seat].color;
      for (let i = 0; i < 5; i++) {
        const badge = badgeSprite(String(i + 1), '#1d1934', color);
        badge.scale.setScalar(0.5);
        // The camera looks down almost vertically, so a badge straight above a die covers its face.
        // Pushing it back (−z) puts it above the die on screen instead.
        badge.position.set(0, DIE * 0.6, -DIE * 1.05);
        dice[i].group.add(badge);
        decor.push(badge);
      }
    },

    dispose() {
      clearDecor();
      board?.removeFromParent();
      record?.removeFromParent();
      for (const d of dice) d.group.removeFromParent();
      boardTex.dispose();
      backTex.dispose();
      recordTex.dispose();
      stage.invalidate();
    },
  };
}
