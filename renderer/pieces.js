// Simple low-poly 3D pieces shared by games.

import * as THREE from 'three';
import { blobShadow } from './stage.js';

let pawnGeo;
// Classic pawn: base, waist, collar, head — one lathe, ~600 triangles.
export function pawnGeometry(height = 0.62) {
  if (pawnGeo) return pawnGeo;
  const h = height;
  const pts = [
    [0.0, 0], [0.30, 0], [0.31, 0.04], [0.27, 0.09], [0.22, 0.12],
    [0.15, 0.22], [0.11, 0.38], [0.10, 0.50], [0.17, 0.54], [0.17, 0.57], [0.10, 0.60],
  ].map(([r, y]) => new THREE.Vector2(r * h / 0.62 * 0.95, y * h / 0.62 * 0.85));
  const lathe = new THREE.LatheGeometry(pts, 20);
  const head = new THREE.SphereGeometry(0.15 * h / 0.62, 16, 12);
  head.translate(0, 0.70 * h / 0.62 * 0.85, 0);
  pawnGeo = mergeSimple([lathe, head]);
  return pawnGeo;
}

// Tiny merge (positions/normals/uvs) so a pawn is a single draw call.
function mergeSimple(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const arrays = parts.map((g) => g.getAttribute(name).array);
    const total = arrays.reduce((a, b) => a + b.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(out, parts[0].getAttribute(name).itemSize));
  }
  merged.computeBoundingSphere();
  return merged;
}

const matCache = new Map();
export function pieceMaterial(color) {
  if (!matCache.has(color)) {
    matCache.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05 }));
  }
  return matCache.get(color);
}

export function makePawn(color, height) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(pawnGeometry(height), pieceMaterial(color));
  const shadow = blobShadow(0.36);
  shadow.position.y = 0.005;
  g.add(shadow, body);
  g.userData = { body, shadow };
  return g;
}
