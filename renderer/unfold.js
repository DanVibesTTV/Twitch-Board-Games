// Folding-board intro: the board arrives folded in quarters (like a real
// board game box), drops in, opens like a book, then unfolds the bottom half.
// Afterwards the 4 hinged panels are swapped for one static mesh.
//
// Layout (board in the XZ plane, top face = +Y, image top = −Z):
//   leftHalf  ─ TL panel (fixed)        rightHalf (hinge x=0, folded rot.z = π)
//            └ BL pivot (hinge z=0,      ├ TR panel
//              folded rot.x = −π)        └ BR pivot (hinge z=0, folded rot.x = −π)
// Hinges sit at the height of the stack they fold onto, so folded panels
// stack without z-fighting and lie perfectly flat once open.

import * as THREE from 'three';
import { ease } from './stage.js';

function panelMaterials(boardTex, backMat, edgeMat, offsetU, offsetV) {
  const t = boardTex.clone();
  t.needsUpdate = true;
  t.repeat.set(0.5, 0.5);
  t.offset.set(offsetU, offsetV);
  const top = new THREE.MeshStandardMaterial({ map: t, roughness: 0.75 });
  // BoxGeometry groups: +x, −x, +y, −y, +z, −z
  return [edgeMat, edgeMat, top, backMat, edgeMat, edgeMat];
}

export function buildBoardMesh(boardTex, backTex, size, thickness) {
  const edge = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.8 });
  const back = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.9 });
  const top = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.75 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, thickness, size), [edge, edge, top, back, edge, edge]);
  mesh.position.y = thickness / 2;
  return mesh;
}

export async function unfoldBoard(stage, { boardTex, backTex, size = 10, thickness = 0.16, speed = 1 }) {
  const t = thickness;
  const q = size / 2;
  const edge = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.8 });
  const back = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.9 });
  const geo = new THREE.BoxGeometry(q, t, q);

  const panel = (u, v) => new THREE.Mesh(geo, panelMaterials(boardTex, back, edge, u, v));
  const TL = panel(0, 0.5);
  const TR = panel(0.5, 0.5);
  const BL = panel(0, 0);
  const BR = panel(0.5, 0);

  const root = new THREE.Group();
  const leftHalf = new THREE.Group();
  root.add(leftHalf);
  TL.position.set(-q / 2, t / 2, -q / 2);
  leftHalf.add(TL);

  const blPivot = new THREE.Group();
  blPivot.position.set(0, t, 0);
  BL.position.set(-q / 2, -t / 2, q / 2);
  blPivot.add(BL);
  leftHalf.add(blPivot);

  const rightHalf = new THREE.Group();
  rightHalf.position.set(0, 2 * t, 0);
  root.add(rightHalf);
  TR.position.set(q / 2, -2 * t + t / 2, -q / 2);
  rightHalf.add(TR);
  const brPivot = new THREE.Group();
  brPivot.position.set(0, -t, 0);
  BR.position.set(q / 2, -t / 2, q / 2);
  brPivot.add(BR);
  rightHalf.add(brPivot);

  // folded state
  blPivot.rotation.x = -Math.PI;
  brPivot.rotation.x = -Math.PI;
  rightHalf.rotation.z = Math.PI;
  stage.scene.add(root);

  const d = (ms) => ms / speed;

  // 1. drop in from above with a little spin (the folded block is the top-left quarter)
  await stage.animate(d(650), (k) => {
    root.position.set(0, (1 - k) * 6, -(1 - k) * 2);
    root.rotation.y = (1 - k) * 0.6;
  }, ease.out);
  // 2. open like a book
  await stage.animate(d(700), (k) => { rightHalf.rotation.z = Math.PI * (1 - k); });
  // 3. unfold the bottom half towards the viewer
  await stage.animate(d(700), (k) => {
    blPivot.rotation.x = -Math.PI * (1 - k);
    brPivot.rotation.x = -Math.PI * (1 - k);
  });

  // 4. swap for a single static mesh (1 draw call less ×4, no seams)
  stage.scene.remove(root);
  geo.dispose();
  const board = buildBoardMesh(boardTex, backTex, size, thickness);
  stage.scene.add(board);
  stage.invalidate();
  return board;
}
