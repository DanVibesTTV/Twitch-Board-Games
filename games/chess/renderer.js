// Neon Chess renderer: the plaza and board, the pieces, numbered markers for each decision, a
// holo panel with both clocks, and the choreography — walking, stomping, jet jumps, dashes, and
// a battle on every capture (each attacker has its own attack, the captured piece shatters).
//
// Camera: from Cyan's left, so both armies are seen side-on (Cyan on the left, Magenta on the
// right, facing each other), a bit like the old Battle Chess.

import * as THREE from 'three';
import { ease, badgeSprite } from '../../renderer/stage.js';
import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, typeOf, colorOf } from './engine.js';
import { buildBoard, buildPlaza, holoPanel, squarePos, sideColor, BOARD_TOP, S, CYAN, MAGENTA } from './plaza.js';
import { loadModels, createPiece, disposePiece, pose, HEIGHT } from './pieces.js';
import * as fx from './fx.js';
import { PIECE_NAMES } from './logic.js';

const FACING = [Math.atan2(1, 0.55), Math.atan2(-1, 0.55)]; // each side faces the other, turned a little to the camera
const WHITE = new THREE.Color('#ffffff');
const RED = new THREE.Color('#ff3355');
const lin = (t) => t;

export function createRenderer(stage, { seats }) {
  const scene = stage.scene;
  const root = new THREE.Group();
  const markers = new THREE.Group();   // numbered badges and target squares (one decision)
  const traces = new THREE.Group();    // last move and check highlight
  root.add(markers, traces);
  const pieces = new Map();            // square → piece
  const ownLights = [];
  const dimmed = [];
  let models = null;
  let board = null, plaza = null;
  let panel = null;
  let state = null;
  let turnStart = 0;                   // when the current decision began (clock display)
  let ticker = null;
  let shownSecs = '';
  let disposed = false;

  const label = (i) => {
    const o = seats[i]?.occupant;
    return o?.type === 'human' ? o.user.name : o?.type === 'crowd' ? 'Chat' : `${seats[i]?.name ?? ''}${o?.type === 'bot' ? ' 🤖' : ''}`;
  };
  const sfx = (name, opts) => stage.sfx?.play(name, opts);

  // ── lights: a night scene ──
  function setupLights() {
    scene.traverse((o) => { if (o.isLight && !ownLights.includes(o)) { dimmed.push([o, o.intensity]); o.intensity *= 0.3; } });
    const hemi = new THREE.HemisphereLight(0xa0b0ff, 0x1a0c28, 1.7);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(2, 10, 8);
    const left = new THREE.DirectionalLight(CYAN, 2.2);
    left.position.set(-9, 4, 3);
    const right = new THREE.DirectionalLight(MAGENTA, 2.2);
    right.position.set(9, 4, 3);
    const back = new THREE.DirectionalLight(0x9c7bff, 0.8);
    back.position.set(0, 5, -10);
    ownLights.push(hemi, key, left, right, back);
    for (const l of ownLights) scene.add(l);
  }

  // ── pieces ──
  function place(piece, sq) {
    piece.group.position.copy(squarePos(sq));
    piece.group.rotation.y = FACING[piece.seat];
    piece.square = sq;
  }

  function sync(s) {
    const b = s.P.b;
    for (const [sq, p] of pieces) {
      const pc = b[sq];
      if (!pc || typeOf(pc) !== p.type || colorOf(pc) !== p.seat) { disposePiece(p); pieces.delete(sq); }
      else if (p.square !== sq || p.group.position.distanceTo(squarePos(sq)) > 0.01) place(p, sq);
    }
    for (let sq = 0; sq < 64; sq++) {
      const pc = b[sq];
      if (!pc || pieces.has(sq)) continue;
      const p = createPiece(typeOf(pc), colorOf(pc), models);
      place(p, sq);
      root.add(p.group);
      pieces.set(sq, p);
    }
  }

  // ── holo panel: both clocks (or the move count), whose turn, captures ──
  const fmt = (ms) => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  function drawPanel() {
    if (!panel || !state) return;
    const { ctx: g, canvas: c } = panel;
    const s = state;
    const turn = s.over ? -1 : s.P.turn;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(6, 6, 16, 0.78)';
    g.fillRect(0, 0, c.width, c.height);
    const half = c.width / 2;
    for (const seat of [0, 1]) {
      const x0 = seat * half;
      const col = seat === 0 ? '#19e6ff' : '#ff2bd6';
      const active = seat === turn;
      g.strokeStyle = col; g.lineWidth = active ? 6 : 2; g.shadowColor = col; g.shadowBlur = active ? 18 : 0;
      g.strokeRect(x0 + 8, 8, half - 16, c.height - 16);
      g.shadowBlur = 0;
      g.fillStyle = col;
      g.font = '700 26px "Inter", "Segoe UI", system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const name = label(seat);
      g.fillText(name.length > 16 ? `${name.slice(0, 15)}…` : name, x0 + half / 2, c.height * 0.24);
      g.fillStyle = '#ffffff';
      g.font = '800 64px "Inter", "Segoe UI", system-ui, sans-serif';
      let big;
      if (s.clock) big = fmt(s.clock[seat] - (active && turnStart ? Date.now() - turnStart : 0));
      else big = active ? 'to move' : '';
      if (!s.clock) g.font = '700 38px "Inter", "Segoe UI", system-ui, sans-serif';
      g.fillText(big, x0 + half / 2, c.height * 0.55);
      g.font = '600 22px "Inter", "Segoe UI", system-ui, sans-serif';
      g.fillStyle = 'rgba(220, 230, 255, 0.75)';
      const taken = s.captured[seat].length;
      g.fillText(taken ? `took ${taken} piece${taken === 1 ? '' : 's'}` : ' ', x0 + half / 2, c.height * 0.82);
    }
    panel.refresh();
    stage.invalidate();
  }
  function startTicker() {
    clearInterval(ticker);
    if (!state?.clock) return;
    ticker = setInterval(() => {
      if (disposed || !state || state.over) return;
      const secs = fmt(state.clock[state.P.turn] - (Date.now() - turnStart));
      if (secs !== shownSecs) { shownSecs = secs; drawPanel(); }
    }, 250);
  }

  // ── markers for the current decision ──
  function clearMarkers() {
    for (const m of [...markers.children]) { m.removeFromParent(); if (!m.isSprite) { m.geometry?.dispose(); m.material?.dispose(); } }
    stage.setTapTargets?.([]);
  }
  function tile(sq, color, opacity = 0.35) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(S * 0.94, S * 0.94), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(squarePos(sq, BOARD_TOP + 0.006));
    return m;
  }
  function drawTraces() {
    for (const m of [...traces.children]) { m.removeFromParent(); m.geometry?.dispose(); m.material?.dispose(); }
    if (!state) return;
    if (state.lastMove) for (const sq of [state.lastMove.from, state.lastMove.to]) traces.add(tile(sq, new THREE.Color('#8a7bff'), 0.16));
    if (state.check && !state.over) traces.add(tile(state.P.b.indexOf(state.P.turn * 8 + KING), RED, 0.4));
  }
  const badgeColor = (seat) => (seat === 0 ? '#0e7f92' : '#8e1679');

  // ── motion helpers ──
  const posOf = (p) => p.group.position.clone();
  const faceTowards = (p, target) => Math.atan2(target.x - p.group.position.x, target.z - p.group.position.z);
  async function turnTo(p, angle, ms = 160) {
    const a0 = p.group.rotation.y;
    let d = angle - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) < 0.02) return;
    await stage.animate(ms, (t) => { p.group.rotation.y = a0 + d * t; });
  }

  // Moves a piece to `end` in its own style. stop: world units to stop short (melee attacks).
  async function travel(p, end, { stop = 0, keepFacing = false } = {}) {
    const start = posOf(p);
    const flat = end.clone().sub(start); flat.y = 0;
    const dist = flat.length();
    if (dist < 0.01) return;
    const goal = start.clone().addScaledVector(flat.normalize(), Math.max(0, dist - stop));
    goal.y = start.y;
    const len = start.distanceTo(goal);
    await turnTo(p, faceTowards(p, end));
    const t = p.type;
    const at = (k) => p.group.position.lerpVectors(start, goal, k);
    if (t === KNIGHT) {
      const jets = fx.thrusters(p.body, p.color);
      pose(p, { crouch: 0.35 });
      await stage.wait(120);
      sfx('whoosh');
      await stage.animate(700 + len * 60, (k) => {
        at(k);
        p.body.position.y = Math.sin(k * Math.PI) * (0.9 + len * 0.12);
        p.body.rotation.x = Math.sin(k * Math.PI) * 0.25;
        jets.update(Math.sin(k * Math.PI) * 0.6 + 0.4);
        pose(p, { crouch: k < 0.15 ? 0.35 * (1 - k / 0.15) : k > 0.85 ? 0.3 * ((k - 0.85) / 0.15) : 0, armL: 0.4, armR: 0.4 });
      }, ease.inOut);
      sfx('thud', { gain: 0.6 });
      jets.remove();
      p.body.rotation.x = 0;
      await stage.animate(140, (k) => pose(p, { crouch: 0.3 * (1 - k) }));
    } else if (t === ROOK) {
      const steps = Math.max(1, Math.round(len / S));
      await stage.animate(420 * steps + 200, (k) => {
        at(k);
        const w = k * steps;
        p.body.position.y = Math.abs(Math.sin(w * Math.PI)) * 0.13;
        p.body.rotation.z = Math.sin(w * Math.PI) * 0.06;
        pose(p, { stride: w * Math.PI, amp: 0.35 });
      }, lin);
      p.body.rotation.z = 0; p.body.position.y = 0;
      sfx('thud', { gain: 0.5 });
    } else if (t === BISHOP) {
      await stage.animate(500 + len * 260, (k) => {
        at(k);
        p.body.position.y = Math.sin(k * Math.PI) * 0.16;
        p.body.rotation.x = Math.sin(k * Math.PI) * 0.12;
      });
      p.body.rotation.x = 0; p.body.position.y = 0;
    } else if (t === QUEEN) {
      const tr = fx.trail(root, p.color);
      let n = 0;
      sfx('whoosh', { pitch: 1.3 });
      await stage.animate(260 + len * 85, (k) => {
        at(k);
        p.body.rotation.x = 0.35 * Math.sin(k * Math.PI);
        if (Math.floor(k * 10) > n) { n = Math.floor(k * 10); tr.push(p.group.position.clone().add(new THREE.Vector3(0, 0.5, 0))); }
        pose(p, { stride: k * 14, amp: 0.5, lean: 0.3 });
      }, ease.inOut);
      p.body.rotation.x = 0;
      stage.animate(300, (k) => tr.fade(k)).then(() => tr.remove());
    } else if (t === KING) {
      const steps = Math.max(1, Math.round(len / S));
      await stage.animate(700 + 520 * steps, (k) => {
        at(k);
        pose(p, { stride: k * steps * Math.PI * 2, amp: 0.18 });
        p.body.position.y = Math.abs(Math.sin(k * steps * Math.PI * 2)) * 0.02;
      });
    } else { // PAWN: a quick run
      const steps = Math.max(1, Math.round(len / S));
      sfx('step');
      await stage.animate(380 + 300 * steps, (k) => {
        at(k);
        pose(p, { stride: k * steps * Math.PI * 2.5, amp: 0.65, lean: 0.12 });
        p.body.position.y = Math.abs(Math.sin(k * steps * Math.PI * 2.5)) * 0.04;
      });
    }
    p.body.position.y = 0;
    pose(p, {});
    if (!keepFacing) await turnTo(p, FACING[p.seat]);
  }

  // The captured piece reacts and breaks apart.
  async function destroy(victim, color) {
    victim.setFlash(WHITE, 1.6);
    sfx('teleport', { pitch: 0.7 });
    await stage.animate(120, (k) => { victim.body.rotation.x = -0.3 * k; });
    const at = posOf(victim);
    victim.group.visible = false;
    await fx.shatter(stage, root, at, victim.color.clone().lerp(color, 0.3), { height: 0.8 });
    disposePiece(victim);
  }

  // Battle camera: moves in on the fight, then back to the whole board.
  async function closeUp(focus, fn) {
    const cam = stage.camera;
    const p0 = cam.position.clone(), t0 = stage.target.clone();
    const p1 = focus.clone().add(p0.clone().sub(t0).multiplyScalar(0.48));
    p1.y = Math.max(p1.y, focus.y + 2.4);
    const look = new THREE.Vector3();
    await stage.animate(500, (k) => { cam.position.lerpVectors(p0, p1, k); look.lerpVectors(t0, focus, k); cam.lookAt(look); });
    try { await fn(); } finally {
      await stage.animate(550, (k) => { cam.position.lerpVectors(p1, p0, k); look.lerpVectors(focus, t0, k); cam.lookAt(look); });
      if (stage.frameArgs) stage.frame(...stage.frameArgs);
    }
  }

  // Battle Chess: every attacker has its own way of taking a piece.
  async function battle(att, victim, toSq) {
    const focus = posOf(att).lerp(posOf(victim), 0.5).add(new THREE.Vector3(0, 0.5, 0));
    await closeUp(focus, () => fight(att, victim, toSq));
  }

  async function fight(att, victim, toSq) {
    const target = squarePos(toSq);
    const vAt = posOf(victim);
    const mid = vAt.clone().add(new THREE.Vector3(0, 0.45, 0));
    const c = att.color;
    if (att.type === ROOK) {               // Bastion Mech: shoulder cannons
      await turnTo(att, faceTowards(att, vAt));
      const a = att.group.rotation.y;
      const side = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(0.3);
      for (const s of [1, -1]) {
        const muzzle = posOf(att).add(new THREE.Vector3(0, 0.8, 0)).addScaledVector(side, s);
        sfx('punch', { pitch: 0.7 });
        await stage.animate(90, (k) => { att.body.position.z = -0.06 * Math.sin(k * Math.PI); });
        await fx.bolt(stage, root, muzzle, mid, c, { ms: 220, arc: 0.15 });
      }
      sfx('thud');
      fx.shockwave(stage, root, vAt, c, { radius: 1.1 });
      await destroy(victim, c);
      await travel(att, target);
    } else if (att.type === BISHOP) {      // Technomancer: arc lightning from the staff
      await turnTo(att, faceTowards(att, vAt));
      const a = att.group.rotation.y;
      const staff = posOf(att).add(new THREE.Vector3(Math.cos(a) * 0.25, 1.05, -Math.sin(a) * 0.25));
      sfx('zap');
      pose(att, { armFwdR: 0.9 });
      victim.setFlash(c, 1.2);
      await fx.lightning(stage, root, staff, mid, c, { ms: 700 });
      pose(att, {});
      await destroy(victim, c);
      await travel(att, target);
    } else if (att.type === KNIGHT) {      // Jetpack Soldier: lands right on top of it
      await travel(att, target, { keepFacing: true });
      fx.shockwave(stage, root, target, c, { radius: 1.4 });
      await destroy(victim, c);
      await turnTo(att, FACING[att.seat]);
    } else if (att.type === QUEEN) {       // Cyber-Assassin: dashes through with both blades
      await travel(att, target, { stop: S * 0.55, keepFacing: true });
      sfx('whoosh', { pitch: 1.6 });
      pose(att, { armL: 1.0, armR: 1.0, armFwdL: 0.6, armFwdR: 0.6 });
      await fx.slash(stage, root, mid, c, { facing: att.group.rotation.y });
      pose(att, {});
      const fall = destroy(victim, c);
      await travel(att, target, { keepFacing: true });
      await fall;
      await turnTo(att, FACING[att.seat]);
    } else if (att.type === KING) {        // Syndicate Overlord: visor laser
      await turnTo(att, faceTowards(att, vAt));
      const eye = posOf(att).add(new THREE.Vector3(0, 1.0, 0));
      sfx('zap', { pitch: 0.6 });
      await fx.beam(stage, root, eye, mid, c, { ms: 600 });
      await destroy(victim, c);
      await travel(att, target);
    } else {                               // Street Runner: a running strike
      await travel(att, target, { stop: S * 0.5, keepFacing: true });
      sfx('punch');
      await stage.animate(220, (k) => {
        att.body.position.z = Math.sin(k * Math.PI) * 0.18;
        pose(att, { armFwdR: Math.sin(k * Math.PI) * 1.3, lean: 0.2 });
      });
      fx.sparks(stage, root, mid, c);
      await destroy(victim, c);
      await travel(att, target);
    }
  }

  async function promote(p, newType, sq) {
    sfx('teleport');
    const column = fx.lightColumn(stage, root, squarePos(sq), p.color, { ms: 900 });
    await stage.animate(350, (k) => { p.group.scale.setScalar(1 - k); });
    disposePiece(p);
    const np = createPiece(newType, p.seat, models);
    place(np, sq);
    np.group.scale.setScalar(0.01);
    root.add(np.group);
    pieces.set(sq, np);
    await stage.animate(400, (k) => { np.group.scale.setScalar(Math.max(0.01, k)); }, ease.outBack);
    await column;
  }

  async function moveEvent(e) {
    const p = pieces.get(e.from);
    if (!p) return;
    const victim = e.captured ? pieces.get(e.capturedAt) : null;
    pieces.delete(e.from);
    if (victim) pieces.delete(e.capturedAt);
    if (e.castle) {
      const rook = pieces.get(e.castle.from);
      pieces.delete(e.castle.from);
      const kingGo = travel(p, squarePos(e.to));
      if (rook) {
        await stage.wait(250);
        await travel(rook, squarePos(e.castle.to));
        rook.square = e.castle.to;
        pieces.set(e.castle.to, rook);
      }
      await kingGo;
    } else if (victim) await battle(p, victim, e.to);
    else await travel(p, squarePos(e.to));
    p.square = e.to;
    pieces.set(e.to, p);
    if (e.promo) await promote(p, e.promo, e.to);
  }

  async function checkEvent(e) {
    const king = pieces.get(e.at);
    if (!king) return;
    sfx('wrong', { gain: 0.5 });
    const guard = fx.shield(stage, root, posOf(king), king.color);
    await stage.animate(500, (k) => pose(king, { armL: Math.sin(k * Math.PI) * 0.9, armR: Math.sin(k * Math.PI) * 0.9 }));
    await guard;
    pose(king, {});
  }

  async function endEvent(e, s) {
    if (e.type === 'win') {
      const loser = 1 - e.seat;
      const kingSq = s.P.b.indexOf(loser * 8 + KING);
      const king = pieces.get(kingSq);
      sfx('win');
      const winners = [...pieces.values()].filter((p) => p.seat === e.seat);
      const glow = stage.animate(1600, (k) => { for (const p of winners) p.setFlash(p.color, Math.sin(k * Math.PI * 4) ** 2 * 1.2); });
      if (king && e.result === 'checkmate') { await stage.wait(300); pieces.delete(kingSq); await destroy(king, sideColor(e.seat)); }
      else if (king) await stage.animate(600, (k) => { king.body.rotation.x = -0.5 * k; king.setFlash(WHITE, 0); });
      await glow;
      for (const p of winners) p.setFlash(p.color, 0);
    } else {
      sfx('coin');
      const kings = [...pieces.values()].filter((p) => p.type === KING);
      await stage.animate(1200, (k) => { for (const p of kings) p.setFlash(WHITE, Math.sin(k * Math.PI * 3) ** 2 * 0.8); });
      for (const p of kings) p.setFlash(WHITE, 0);
    }
  }

  return {
    async intro(game) {
      state = game.state;
      stage.frame(10.6, { tilt: 56, fill: 1.0, center: [1.35, 0.2, 0.35] });
      setupLights();
      plaza = buildPlaza();
      board = buildBoard();
      root.add(plaza, board);
      scene.add(root);
      panel = holoPanel(4.2, 1.24);
      panel.mesh.position.set(0, 1.55, -5.75);
      panel.mesh.rotation.x = -0.12;
      root.add(panel.mesh);
      drawPanel();
      const loadingModels = loadModels();
      await stage.animate(600, (k) => { board.position.y = (1 - k) * -1; board.scale.setScalar(0.8 + 0.2 * k); }, ease.outBack);
      models = await loadingModels;
      if (disposed) return;
      sync(state);
      // pieces appear rank by rank, from the back ranks inwards
      const list = [...pieces.values()];
      for (const p of list) p.group.scale.setScalar(0.01);
      sfx('teleport', { gain: 0.6 });
      await stage.animate(1100, (k) => {
        for (const p of list) {
          const r = p.square >> 3;
          const delay = (p.seat === 0 ? r : 7 - r) * 0.12;
          const local = Math.min(1, Math.max(0, (k - delay) / 0.5));
          p.group.scale.setScalar(Math.max(0.01, ease.outBack ? ease.outBack(local) : local));
        }
      }, lin);
      for (const p of list) p.group.scale.setScalar(1);
      drawTraces();
    },

    async present(events, game) {
      clearMarkers();
      state = game.state;
      turnStart = 0;
      drawPanel();
      for (const e of events) {
        if (e.type === 'select') {
          const p = pieces.get(e.at);
          if (p) await stage.animate(220, (k) => { p.body.position.y = Math.sin(k * Math.PI) * 0.12; });
        } else if (e.type === 'move') {
          for (const m of [...traces.children]) { m.removeFromParent(); m.geometry?.dispose(); m.material?.dispose(); }
          await moveEvent(e);
        } else if (e.type === 'check') {
          await checkEvent(e);
        } else if (e.type === 'win' || e.type === 'draw') {
          await endEvent(e, game.state);
        }
      }
      if (!game.state.over) sync(game.state);
      drawTraces();
      drawPanel();
    },

    showDecision(d, game) {
      clearMarkers();
      state = game.state;
      if (!pieces.size) sync(state);
      turnStart = Date.now();
      shownSecs = '';
      drawPanel();
      startTicker();
      drawTraces();
      if (seats[d.seat]?.occupant?.type === 'bot') { stage.invalidate(); return; } // no numbers while a bot thinks
      const targets = [];
      const bg = badgeColor(d.seat);
      d.options.forEach((o, i) => {
        if (o.hidden) return;
        if (o.data.kind === 'piece') {
          const p = pieces.get(o.data.from);
          if (!p) return;
          const badge = badgeSprite(String(i + 1), '#ffffff', bg);
          badge.scale.setScalar(0.42);
          badge.position.copy(p.group.position).add(new THREE.Vector3(0, HEIGHT[p.type] + 0.28, 0));
          markers.add(badge);
          targets.push({ option: i, objects: [p.group, badge] });
        } else if (o.data.kind === 'target') {
          const capture = !!state.P.b[o.data.to];
          const t = tile(o.data.to, capture ? RED : sideColor(d.seat), capture ? 0.45 : 0.32);
          markers.add(t);
          const badge = badgeSprite(String(i + 1), '#ffffff', capture ? '#a3122b' : bg);
          badge.scale.setScalar(0.36);
          badge.position.copy(squarePos(o.data.to, BOARD_TOP + (capture ? HEIGHT[typeOf(state.P.b[o.data.to])] + 0.3 : 0.35)));
          markers.add(badge);
          targets.push({ option: i, objects: [t, badge] });
        } else if (o.data.kind === 'back' && d.selected >= 0) {
          const p = pieces.get(d.selected);
          if (p) targets.push({ option: i, objects: [p.group] });
        }
      });
      if (d.step === 'target' && d.selected >= 0) {
        const sel = tile(d.selected, sideColor(d.seat), 0.6);
        markers.add(sel);
      }
      stage.setTapTargets?.(targets);
      stage.invalidate();
    },

    dispose() {
      disposed = true;
      clearInterval(ticker);
      clearMarkers();
      for (const p of pieces.values()) disposePiece(p);
      pieces.clear();
      root.removeFromParent();
      root.traverse((o) => { o.geometry?.dispose?.(); for (const m of [o.material ?? []].flat()) { m.map?.dispose?.(); m.dispose?.(); } });
      for (const l of ownLights) l.removeFromParent();
      for (const [l, i] of dimmed) l.intensity = i;
      stage.invalidate();
    },
  };
}

export { PIECE_NAMES };
