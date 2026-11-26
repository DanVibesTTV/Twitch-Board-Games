// A simple rounded 3D die. The game logic decides the value first;
// roll() animates a tumble that lands exactly on that face.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ease, blobShadow } from './stage.js';

// BoxGeometry face order: +x, −x, +y, −y, +z, −z  (opposite faces sum to 7)
const FACE_VALUES = [3, 4, 1, 6, 2, 5];
const FACE_NORMALS = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

function faceTexture(value, pipColor) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#fbf8f1';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = value === 1 ? '#d3313a' : pipColor;
  for (const [x, y] of PIPS[value]) {
    g.beginPath();
    g.arc(64 + x * 32, 64 + y * 32, value === 1 ? 17 : 12, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Die {
  constructor(stage, { size = 0.9, pipColor = '#1d1a26' } = {}) {
    this.stage = stage;
    this.size = size;
    const mats = FACE_VALUES.map((v) => new THREE.MeshStandardMaterial({ map: faceTexture(v, pipColor), roughness: 0.45 }));
    this.mesh = new THREE.Mesh(new RoundedBoxGeometry(size, size, size, 3, size * 0.16), mats);
    this.shadow = blobShadow(size * 0.85);
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.shadow);
    this.shadow.position.y = 0.01;
    this.rest = new THREE.Vector3();
    this.group.visible = false;
    stage.scene.add(this.group);
  }

  place(x, y, z) {
    this.rest.set(x, y, z);
    this.group.position.copy(this.rest);
    this.mesh.position.y = this.size / 2;
  }

  show(visible = true) {
    this.group.visible = visible;
    this.stage.invalidate();
  }

  // Quaternion with `value` on top and a random yaw.
  #targetFor(value) {
    const i = FACE_VALUES.indexOf(value);
    const q = new THREE.Quaternion().setFromUnitVectors(FACE_NORMALS[i], new THREE.Vector3(0, 1, 0));
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    return yaw.multiply(q);
  }

  async roll(value, { ms = 900, from = new THREE.Vector3(-3, 0, 3) } = {}) {
    this.show(true);
    this.stage.sfx?.play('dice', { duration: ms }); // rattle is timed to the three bounces below
    const target = this.#targetFor(value);
    const axis = new THREE.Vector3(Math.random() - 0.5, 0.4, Math.random() - 0.5).normalize();
    const spin = Math.PI * 2 * (2 + Math.random() * 1.5);
    const tmp = new THREE.Quaternion();
    const start = this.rest.clone().add(from);
    const h = this.size / 2;
    await this.stage.animate(ms, (t) => {
      // tumble: spin decays to zero exactly at t = 1, so we land on `target`
      const k = ease.out(t);
      tmp.setFromAxisAngle(axis, spin * (1 - k));
      this.mesh.quaternion.copy(tmp).multiply(target);
      // slide in with three shrinking bounces
      this.group.position.lerpVectors(start, this.rest, k);
      const bounce = Math.abs(Math.sin(t * Math.PI * 3)) * (1 - t) * 1.6;
      this.mesh.position.y = h + bounce;
      this.shadow.scale.setScalar(1 - bounce * 0.25);
    }, ease.linear);
  }
}
