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
const PLATE_Z = 0.14; // plates close together, so you never look through a hole onto the back plate
const FRAME_COLOR = '#1f4fd1';

const holeX = (c) => (c - (COLS - 1) / 2) * CELL;
const holeY = (r) => BASE + 0.35 + 0.5 + r * CELL;
const TOP = BASE + H;

function frameTexture() {
  const k = 128;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * k);
  cv.height = Math.round(H * k);
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, cv.width, cv.height);
  grd.addColorStop(0, '#3d6cf0');
  grd.addColorStop(1, '#1a3fae');
  g.fillStyle = grd;
  g.fillRect(0, 0, cv.width, cv.height);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const x = (0.35 + 0.5 + c) * k;
      const y = cv.height - (0.35 + 0.5 + r) * k;
      // bevel ring: dark lower-right, light upper-left
      const ring = g.createLinearGradient(x - 0.5 * k, y - 0.5 * k, x + 0.5 * k, y + 0.5 * k);
      ring.addColorStop(0, 'rgba(255,255,255,0.45)');
      ring.addColorStop(1, 'rgba(0,0,40,0.55)');
      g.fillStyle = ring;
      g.beginPath(); g.arc(x, y, (HOLE_R + 0.06) * k, 0, Math.PI * 2); g.fill();
    }
  }
  g.globalCompositeOperation = 'destination-out';
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      g.beginPath();
      g.arc((0.35 + 0.5 + c) * k, cv.height - (0.35 + 0.5 + r) * k, HOLE_R * k, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

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
  const group = new THREE.Group(); // pivot at the bottom-front edge for the flip-up
  const discGeo = new THREE.CylinderGeometry(DISC_R, DISC_R, DISC_T, 36);
  discGeo.rotateX(Math.PI / 2);
  const mats = colors.map(discMaterials);
  const frameTex = frameTexture();
  let labelCanvas = labelTexture(new Array(COLS).fill('idle'), '#fff');
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;

  // Front key light just for this upright board (the shared lights mostly hit from above).
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
  keyLight.position.set(-4, 7, 12);
  const fillLight = new THREE.DirectionalLight(0xbfd4ff, 0.45);
  fillLight.position.set(6, 2, 8);

  function buildFrame() {
    const plateGeo = new THREE.PlaneGeometry(W, H);
    const front = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({
      map: frameTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.32, metalness: 0.05,
    }));
    front.position.set(0, BASE + H / 2, PLATE_Z);
    // The back plate is only seen through the holes: darker, so it reads as the inside of the frame.
    const back = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({
      map: frameTex, color: 0x4a5a90, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6,
    }));
    back.position.set(0, BASE + H / 2, -PLATE_Z);
    group.add(front, back);
    const edgeMat = new THREE.MeshStandardMaterial({ color: FRAME_COLOR, roughness: 0.5 });
    const side = new THREE.BoxGeometry(0.14, H, PLATE_Z * 2 + 0.04);
    for (const x of [-W / 2, W / 2]) {
      const m = new THREE.Mesh(side, edgeMat);
      m.position.set(x, BASE + H / 2, 0);
      group.add(m);
    }
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(W + 0.14, 0.14, PLATE_Z * 2 + 0.04), edgeMat);
    bottom.position.set(0, BASE + 0.07, 0);
    group.add(bottom);
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
    },

    dispose() {
      group.removeFromParent();
      keyLight.removeFromParent();
      fillLight.removeFromParent();
      discGeo.dispose();
      frameTex.dispose();
      labelTex.dispose();
      stage.invalidate();
    },
  };
}
