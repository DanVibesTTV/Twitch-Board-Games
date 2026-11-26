// Five dice in a row with a "held" spot for each, for roll-and-hold games (Jazzy Dice, Poker Dice).
// The game decides values; this animates rolls, holds and the number badges.

import * as THREE from 'three';
import { Die } from './dice.js';
import { ease, badgeSprite } from './stage.js';

export class DiceRow {
  // rowAt(i) / holdAt(i): world positions (THREE.Vector3) for die i; die: options for each Die.
  constructor(stage, { rowAt, holdAt, size = 0.86, die = {}, count = 5 }) {
    Object.assign(this, { stage, rowAt, holdAt, size });
    this.dice = [];
    this.badges = [];
    for (let i = 0; i < count; i++) {
      const d = new Die(stage, { size, ...die });
      const p = rowAt(i);
      d.place(p.x, p.y, p.z);
      this.dice.push(d);
    }
  }

  // e: { dice, rolled } (a roll event). One rattle for the whole throw; the dice land a bit apart.
  async roll(e, { from = () => new THREE.Vector3((Math.random() - 0.5) * 1.2, 0, 2.6 + Math.random() * 0.8), ms = 900 } = {}) {
    this.stage.sfx?.play('dice', { duration: ms, dice: Math.min(3, e.rolled.length) });
    await Promise.all(e.rolled.map((i, k) => this.stage.wait(k * 45).then(() => {
      const p = this.rowAt(i);
      this.dice[i].place(p.x, p.y, p.z);
      return this.dice[i].roll(e.dice[i], { ms: ms + Math.random() * 150, from: from(i), sound: false });
    })));
  }

  // Slides die i to its held spot (or back to the row) with a little hop.
  setHeld(i, held, ms = 260) {
    const die = this.dice[i];
    const to = held ? this.holdAt(i) : this.rowAt(i);
    const from = die.group.position.clone();
    if (from.distanceTo(to) < 1e-3) return Promise.resolve();
    die.rest.copy(to);
    return this.stage.animate(ms, (k) => {
      die.group.position.lerpVectors(from, to, k);
      die.group.position.y += Math.sin(k * Math.PI) * 0.45;
    }, ease.inOut);
  }

  reset(ms = 320) {
    return Promise.all(this.dice.map((_, i) => this.setHeld(i, false, ms)));
  }

  // Everyone jumps (a big hand).
  hop(height = 0.7) {
    return Promise.all(this.dice.map((d, i) => this.stage.wait(i * 60).then(() => {
      const base = d.group.position.y;
      return this.stage.animate(380, (k) => { d.group.position.y = base + Math.sin(k * Math.PI) * height; }, ease.inOut);
    })));
  }

  // Number badges 1–5. The cameras look down steeply, so the badge sits behind the die (−z),
  // which puts it above the die on screen instead of over its face.
  showBadges(bg, fg = '#1d1934') {
    this.clearBadges();
    this.dice.forEach((d, i) => {
      const badge = badgeSprite(String(i + 1), fg, bg);
      badge.scale.setScalar(0.5);
      badge.position.set(0, this.size * 0.6, -this.size * 1.05);
      d.group.add(badge);
      this.badges.push(badge);
    });
    this.stage.invalidate();
  }

  clearBadges() {
    for (const b of this.badges) b.removeFromParent();
    this.badges.length = 0;
    this.stage.invalidate();
  }

  dispose() {
    this.clearBadges();
    for (const d of this.dice) d.group.removeFromParent();
  }
}
