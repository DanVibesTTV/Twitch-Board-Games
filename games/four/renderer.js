// Four in a Row renderer: an upright frame (two plates with holes), discs that
// drop between them, column numbers above, and a flip-up intro.

import * as THREE from 'three';
import { ease, blobShadow } from '../../renderer/stage.js';
import { COLS, ROWS } from './logic.js';

const CELL = 1;
const W = COLS * CELL + 0.7;
const H = ROWS * CELL + 0.7;
const BASE = 0.3;                 // frame sits on its feet this high
const HOLE_R = 0.4;
const DISC_R = 0.44;
const DISC_T = 0.2;
const DEPTH = 0.32;   // the frame is one solid piece this thick, with real holes cut through it
const BEVEL = 0.035;  // rounded edges on the frame and around every hole
const PLATE_Z = DEPTH / 2;
const FRAME_COLOR = '#2a5be6';

const holeX = (c) => (c - (COLS - 1) / 2) * CELL;
const holeY = (r) => BASE + 0.35 + 0.5 + r * CELL;
const TOP = BASE + H;

function discMaterials(color) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const c = new THREE.Color(color);
  const dark = `#${c.clone().multiplyScalar(0.72).getHexString()}`;
  g.fillStyle = color;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = dark;
  g.lineWidth = 7;
  g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4;
  g.beginPath(); g.arc(64, 64, 22, 0, Math.PI * 2); g.stroke();
  const shine = g.createRadialGradient(44, 40, 4, 44, 40, 60);
  shine.addColorStop(0, 'rgba(255,255,255,0.35)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = shine;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const cap = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, emissive: c, emissiveIntensity: 0 });
  const side = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.4, emissive: c, emissiveIntensity: 0 });
  return [side, cap, cap];
}

function labelTexture(states, color) {
  const k = 128;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * k);
  cv.height = Math.round(0.7 * k);
  const g = cv.getContext('2d');
  g.font = `800 ${0.42 * k}px "Inter", "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let c = 0; c < COLS; c++) {
    const x = (0.35 + 0.5 + c) * k;
    const y = cv.height / 2;
    const st = states[c]; // 'on' | 'off' | 'idle'
    if (st === 'on') {
      g.fillStyle = color;
      g.beginPath(); g.arc(x, y, 0.3 * k, 0, Math.PI * 2); g.fill();
      g.lineWidth = 0.05 * k;
      g.strokeStyle = '#ffffff';
      g.stroke();
    }
    g.fillStyle = st === 'off' ? 'rgba(255,255,255,0.2)' : '#ffffff';
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 0.08 * k;
    g.fillText(String(c + 1), x, y + 0.02 * k);
    g.shadowBlur = 0;
  }
  return cv;
}

export function createRenderer(stage, { seats }) {
  const colors = seats.map((s) => s.color);
  const discs = new Map(); // "c,r" → mesh
  const columnHits = [];   // invisible tap areas, one per column
  const group = new THREE.Group(); // pivot at the bottom-front edge for the flip-up
  const discGeo = new THREE.CylinderGeometry(DISC_R, DISC_R, DISC_T, 36);
  discGeo.rotateX(Math.PI / 2);
  const mats = colors.map(discMaterials);
  let labelCanvas = labelTexture(new Array(COLS).fill('idle'), '#fff');
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;

  // Front key light just for this upright board (the shared lights mostly hit from above).
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
  keyLight.position.set(-4, 7, 12);
  const fillLight = new THREE.DirectionalLight(0xbfd4ff, 0.45);
  fillLight.position.set(6, 2, 8);

  // One solid frame: a rectangle with 42 round holes, extruded and bevelled. Real geometry instead
  // of two flat plates, so holes have inner walls and nothing can show through them but discs.
  function buildFrame() {
    const shape = new THREE.Shape();
    const x0 = -W / 2 + BEVEL;
    const x1 = W / 2 - BEVEL;
    const y0 = BASE + BEVEL;
    const y1 = BASE + H - BEVEL;
    shape.moveTo(x0, y0);
    shape.lineTo(x1, y0);
    shape.lineTo(x1, y1);
    shape.lineTo(x0, y1);
    shape.lineTo(x0, y0);
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const hole = new THREE.Path();
        // the bevel grows the outline and shrinks the holes, so cut them a bit bigger
        hole.absarc(holeX(c), holeY(r), HOLE_R + BEVEL, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    }
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH - BEVEL * 2,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: BEVEL,
      bevelSegments: 2,
      curveSegments: 28,
    });
    geo.translate(0, 0, -(DEPTH - BEVEL * 2) / 2);
    const edgeMat = new THREE.MeshStandardMaterial({ color: FRAME_COLOR, roughness: 0.32, metalness: 0.05 });
    const frame = new THREE.Mesh(geo, edgeMat);
    group.add(frame);
    const footGeo = new THREE.BoxGeometry(0.5, BASE + 0.1, 2.0);
    for (const x of [-W / 2 - 0.05, W / 2 + 0.05]) {
      const f = new THREE.Mesh(footGeo, edgeMat);
      f.position.set(x, (BASE + 0.1) / 2, 0);
      group.add(f);
    }
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(W, 0.7),
      new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false }),
    );
    label.position.set(0, TOP + 0.5, PLATE_Z);
    group.add(label);
    // Invisible hit areas, one per column (label row included), for tapping a column on a phone.
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    const hitGeo = new THREE.BoxGeometry(CELL, TOP + 1 - BASE, DEPTH + 0.4);
    for (let c = 0; c < COLS; c++) {
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.set(holeX(c), (BASE + TOP + 1) / 2, 0);
      group.add(hit);
      columnHits.push(hit);
    }
    const shadow = blobShadow(1);
    shadow.scale.set(W * 0.75, 1.5, 1);
    shadow.position.y = 0.005;
    group.add(shadow);
  }

  function setLabels(states, color) {
    labelCanvas = labelTexture(states, color);
    labelTex.image = labelCanvas;
    labelTex.needsUpdate = true;
    stage.invalidate();
  }

  async function drop(seat, col, row) {
    const disc = new THREE.Mesh(discGeo, mats[seat].map((m) => m.clone()));
    const x = holeX(col);
    const startY = TOP + 0.9;
    const endY = holeY(row);
    disc.position.set(x, startY, 0);
    group.add(disc);
    discs.set(`${col},${row}`, disc);
    const fall = Math.sqrt(startY - endY);
    const ms = 160 + fall * 170;
    await stage.animate(ms, (k) => { disc.position.y = startY - (startY - endY) * k * k; }, ease.linear); // gravity
    stage.sfx?.play('clack');
    // two little bounces
    for (const h of [0.22, 0.07]) {
      await stage.animate(90 + h * 400, (k) => { disc.position.y = endY + Math.sin(k * Math.PI) * h; }, ease.linear);
      if (h > 0.1) stage.sfx?.play('clack', { gain: 0.35 });
    }
    disc.position.y = endY;
  }

  async function celebrate(line) {
    stage.sfx?.play('win');
    const meshes = line.map(([c, r]) => discs.get(`${c},${r}`)).filter(Boolean);
    for (let i = 0; i < 3; i++) {
      await stage.animate(420, (k) => {
        const pulse = Math.sin(k * Math.PI);
        for (const m of meshes) {
          m.scale.setScalar(1 + pulse * 0.18);
          for (const mat of m.material) mat.emissiveIntensity = pulse * 0.6;
        }
      }, ease.linear);
    }
    for (const m of meshes) for (const mat of m.material) mat.emissiveIntensity = 0.35; // keep a glow
    stage.invalidate();
  }

  return {
    async intro() {
      const height = TOP + 0.95; // feet to the top of the column numbers
      stage.view({ width: W + 1, height, center: [0, height / 2, 0], fov: 24, elevation: 5, fill: 0.86, shiftX: -0.15 });
      stage.scene.add(keyLight, fillLight);
      buildFrame();
      group.rotation.x = -Math.PI / 2; // lying flat behind the hinge
      stage.scene.add(group);
      await stage.animate(900, (k) => { group.rotation.x = -Math.PI / 2 * (1 - k); }, ease.outBack);
      stage.sfx?.play('clack', { gain: 0.8, pitch: 0.6 });
      await stage.wait(150);
    },

    async present(events) {
      for (const e of events) {
        if (e.type === 'drop') await drop(e.seat, e.col, e.row);
        else if (e.type === 'win') await celebrate(e.line);
        else if (e.type === 'draw') {
          await stage.animate(500, (k) => { group.position.x = Math.sin(k * Math.PI * 6) * 0.08 * (1 - k); }, ease.linear);
          group.position.x = 0;
        }
      }
      setLabels(new Array(COLS).fill('idle'), '#fff');
    },

    // Light up the playable column numbers in the current player's color.
    showDecision(d) {
      setLabels(d.options.map((o) => (o.disabled ? 'off' : 'on')), colors[d.seat]);
      stage.setTapTargets?.(d.options.map((o, c) => (o.disabled ? null : { option: c, objects: [columnHits[c]] })).filter(Boolean));
    },

    dispose() {
      group.removeFromParent();
      keyLight.removeFromParent();
      fillLight.removeFromParent();
      discGeo.dispose();
      labelTex.dispose();
      stage.invalidate();
    },
  };
}
