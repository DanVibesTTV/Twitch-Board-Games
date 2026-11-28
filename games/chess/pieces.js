// Neon Chess — the pieces: 3D models (games/chess/models/*.glb, made with Modly + UniRig), their
// neon colours per side, a glowing base, extra parts made in code (the Assassin's plasma blades),
// stand-ins for models that don't exist yet, and a "rig" that finds hips, legs, arms and head in
// whatever skeleton a model has, so moves can be animated in code.
//
// The models are made once: their glowing parts are painted cyan in the textures. For the
// magenta side a small shader change swaps cyan for magenta, and makes those parts glow.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from './engine.js';
import { BOARD_TOP, sideColor, glowSprite } from './plaza.js';

export const MODEL_FILE = { [PAWN]: 'runner', [KNIGHT]: 'jetpack', [BISHOP]: 'technomancer', [ROOK]: 'mech', [QUEEN]: 'assassin', [KING]: 'overlord' };
// Height of each piece on the board, in squares.
export const HEIGHT = { [PAWN]: 0.95, [KNIGHT]: 1.2, [BISHOP]: 1.3, [ROOK]: 1.22, [QUEEN]: 1.34, [KING]: 1.6 };
const MAX_WIDTH = 0.9; // nothing wider than this many squares

// ───────────────────────────── loading ─────────────────────────────

let loading = null;
// Resolves with { [type]: { scene, height, rigged } | null } — null = use the stand-in.
export function loadModels() {
  loading ??= (async () => {
    const loader = new GLTFLoader();
    const out = {};
    await Promise.all(Object.entries(MODEL_FILE).map(async ([type, file]) => {
      try {
        const gltf = await loader.loadAsync(new URL(`./models/${file}.glb`, import.meta.url).href);
        out[type] = prepareTemplate(gltf.scene);
      } catch {
        out[type] = null; // not made yet → stand-in
      }
    }));
    return out;
  })();
  return loading;
}

function prepareTemplate(scene) {
  scene.updateMatrixWorld(true);
  let rigged = false;
  scene.traverse((o) => {
    if (o.isSkinnedMesh) { rigged = true; o.frustumCulled = false; }
    if (o.isMesh) {
      o.castShadow = false;
      for (const t of ['map', 'metalnessMap', 'roughnessMap', 'normalMap']) {
        const tex = o.material?.[t];
        if (tex) tex.anisotropy = 4;
      }
    }
  });
  const box = new THREE.Box3().setFromObject(scene, true);
  return { scene, box, rigged };
}

// ───────────────────────────── neon material ─────────────────────────────

// The model's own material, with its cyan parts glowing in `color` (swapped to magenta if needed).
// uniforms.flash: extra glow for hits and highlights (per piece).
function neonMaterial(source, color, swap) {
  const m = source.clone();
  const uniforms = {
    uNeon: { value: color.clone() },
    uGlow: { value: 2.2 },
    uSwap: { value: swap ? 1 : 0 },
    uFlash: { value: new THREE.Color(0, 0, 0) },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uNeon; uniform float uGlow; uniform float uSwap; uniform vec3 uFlash;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float neonMask = 0.0;
        #ifdef USE_MAP
          vec3 nc = diffuseColor.rgb;
          neonMask = smoothstep(0.03, 0.16, min(nc.g, nc.b) - nc.r) * smoothstep(0.06, 0.3, max(nc.g, nc.b));
          vec3 swapped = vec3(nc.b, nc.r, nc.b);
          diffuseColor.rgb = mix(nc, mix(nc, swapped, uSwap), neonMask);
        #endif`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uNeon * neonMask * uGlow + uFlash;');
  };
  m.customProgramCacheKey = () => 'neon-chess-piece';
  m.userData.neon = uniforms;
  return m;
}

// ───────────────────────────── stand-ins ─────────────────────────────
// Until a model exists, a piece is built from simple shapes with the same idea: dark armour,
// a glowing visor and accents in the side's colour.

function standIn(type, color) {
  const g = new THREE.Group();
  const armour = new THREE.MeshStandardMaterial({ color: '#2a2e3d', metalness: 0.75, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: '#15171f', metalness: 0.6, roughness: 0.5 });
  const neon = new THREE.MeshStandardMaterial({ color: '#111', emissive: color, emissiveIntensity: 2.4 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  if (type === PAWN) { // Street Runner: hooded, visor, one cyber leg
    add(new THREE.CylinderGeometry(0.1, 0.07, 0.42, 10), dark, -0.07, 0.21, 0);
    add(new THREE.CylinderGeometry(0.07, 0.06, 0.42, 10), armour, 0.07, 0.21, 0);
    add(new THREE.BoxGeometry(0.03, 0.3, 0.03), neon, 0.07, 0.22, 0.07);
    add(new THREE.CylinderGeometry(0.2, 0.17, 0.32, 12), dark, 0, 0.58, 0);
    add(new THREE.ConeGeometry(0.2, 0.34, 14), armour, 0, 0.9, -0.02);
    add(new THREE.BoxGeometry(0.2, 0.05, 0.05), neon, 0, 0.82, 0.13);
    add(new THREE.BoxGeometry(0.14, 0.08, 0.06), dark, 0, 0.75, 0.13);
  } else if (type === KNIGHT) { // Jetpack Soldier: reverse-jointed legs, twin thrusters, crest
    for (const s of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 8), armour, s * 0.09, 0.32, 0.05, -0.5);
      add(new THREE.CylinderGeometry(0.045, 0.06, 0.26, 8), dark, s * 0.09, 0.12, 0.0, 0.45);
      add(new THREE.CylinderGeometry(0.06, 0.08, 0.32, 10), dark, s * 0.1, 0.72, -0.17);
      add(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 10), neon, s * 0.1, 0.55, -0.17);
    }
    add(new THREE.BoxGeometry(0.3, 0.34, 0.2), armour, 0, 0.66, 0);
    add(new THREE.BoxGeometry(0.22, 0.2, 0.22), dark, 0, 0.93, 0.02);
    add(new THREE.BoxGeometry(0.18, 0.04, 0.03), neon, 0, 0.94, 0.14);
    add(new THREE.BoxGeometry(0.04, 0.2, 0.3), armour, 0, 1.06, -0.02, 0.25);
  } else if (type === BISHOP) { // Technomancer: long robe, pointed hood, data-staff
    add(new THREE.ConeGeometry(0.27, 0.78, 16, 1, true), dark, 0, 0.39, 0);
    add(new THREE.TorusGeometry(0.25, 0.012, 6, 32), neon, 0, 0.06, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.14, 0.2, 0.32, 14), armour, 0, 0.72, 0);
    add(new THREE.ConeGeometry(0.15, 0.36, 14), dark, 0, 1.0, -0.02);
    add(new THREE.BoxGeometry(0.14, 0.03, 0.03), neon, 0, 0.92, 0.11);
    add(new THREE.CylinderGeometry(0.018, 0.018, 1.05, 8), armour, 0.26, 0.53, 0.06);
    add(new THREE.TorusGeometry(0.08, 0.014, 8, 24), neon, 0.26, 1.08, 0.06);
  } else if (type === ROOK) { // Bastion Mech: blocky tower, shoulder cannons
    add(new THREE.BoxGeometry(0.5, 0.5, 0.44), armour, 0, 0.62, 0);
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.1, 0.1, 0.44), armour, -0.2 + i * 0.133, 0.92, 0);
    add(new THREE.BoxGeometry(0.22, 0.06, 0.03), neon, 0, 0.7, 0.23);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.14, 0.38, 0.18), dark, s * 0.14, 0.19, 0);
      add(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 10), dark, s * 0.33, 0.86, 0.08, Math.PI / 2);
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 10), neon, s * 0.33, 0.86, 0.29, Math.PI / 2);
    }
  } else if (type === QUEEN) { // Cyber-Assassin
    add(new THREE.CylinderGeometry(0.06, 0.05, 0.5, 8), dark, -0.06, 0.25, 0);
    add(new THREE.CylinderGeometry(0.06, 0.05, 0.5, 8), dark, 0.06, 0.25, 0);
    add(new THREE.CylinderGeometry(0.13, 0.1, 0.36, 12), armour, 0, 0.68, 0);
    add(new THREE.SphereGeometry(0.1, 14, 10), dark, 0, 0.96, 0).scale.set(1, 1.25, 1);
    add(new THREE.BoxGeometry(0.12, 0.025, 0.03), neon, 0, 0.97, 0.09);
  } else { // Syndicate Overlord: cloak, crown spire
    add(new THREE.ConeGeometry(0.3, 0.86, 18, 1, true), dark, 0, 0.43, -0.02);
    add(new THREE.CylinderGeometry(0.17, 0.24, 0.4, 14), armour, 0, 0.82, 0);
    add(new THREE.SphereGeometry(0.12, 14, 10), armour, 0, 1.08, 0);
    add(new THREE.BoxGeometry(0.16, 0.03, 0.03), neon, 0, 1.08, 0.11);
    add(new THREE.ConeGeometry(0.05, 0.32, 8), armour, 0, 1.33, 0);
    for (const s of [-1, 1]) add(new THREE.SphereGeometry(0.07, 10, 8), dark, s * 0.24, 1.0, 0);
    add(new THREE.SphereGeometry(0.035, 10, 8), neon, 0, 0.82, 0.2);
  }
  return g;
}

// ───────────────────────────── rig ─────────────────────────────
// Finds the useful bones by their positions in the rest pose (UniRig calls them bone_0 … bone_N):
// feet = the two lowest chain ends, hands = the two chain ends furthest to the side, head = the
// highest chain end near the middle. Legs and arms are the chains from where they branch off.

function buildRig(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  if (!bones.length) return null;
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const pos = new Map(), quat = new Map();
  for (const b of bones) {
    const m = new THREE.Matrix4().multiplyMatrices(toRoot, b.matrixWorld);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    pos.set(b, p); quat.set(b, q);
  }
  const isBone = (o) => o?.isBone;
  const leaves = bones.filter((b) => !b.children.some(isBone));
  const path = (b) => { const out = []; for (let x = b; isBone(x); x = x.parent) out.unshift(x); return out; };
  const ys = bones.map((b) => pos.get(b).y);
  const lo = Math.min(...ys), hi = Math.max(...ys), h = hi - lo || 1;
  const byY = [...leaves].sort((a, b) => pos.get(a).y - pos.get(b).y);
  const feet = byY.slice(0, 2);
  const mid = leaves.filter((b) => !feet.includes(b) && pos.get(b).y > lo + h * 0.4);
  const hands = [...mid].sort((a, b) => Math.abs(pos.get(b).x) - Math.abs(pos.get(a).x)).slice(0, 2);
  const headLeaf = mid.filter((b) => !hands.includes(b)).sort((a, b) => pos.get(b).y - pos.get(a).y - (Math.abs(pos.get(b).x) - Math.abs(pos.get(a).x)) * 2)[0];
  const branch = (a, b) => {
    const pa = path(a), pb = path(b);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    return [pa.slice(i), pb.slice(i), pa[i - 1] ?? null];
  };
  const rig = { bones, rest: new Map(bones.map((b) => [b, b.quaternion.clone()])), restWorld: quat, restPos: pos, h };
  if (feet.length === 2) {
    const [a, b, hips] = branch(feet[0], feet[1]);
    const [l, r] = pos.get(feet[0]).x > pos.get(feet[1]).x ? [a, b] : [b, a]; // +x = the model's left (it faces +z)
    rig.hips = hips;
    rig.legL = { thigh: l[0], shin: l[1], foot: l[2] };
    rig.legR = { thigh: r[0], shin: r[1], foot: r[2] };
  }
  if (hands.length === 2 && hands[0] !== hands[1]) {
    const [a, b, chest] = branch(hands[0], hands[1]);
    const arm = (chain) => {
      const k = Math.max(0, chain.findIndex((x) => Math.abs(pos.get(x).x) >= h * 0.08));
      return { upper: chain[k], fore: chain[k + 1], hand: chain[k + 2] };
    };
    const [l, r] = pos.get(hands[0]).x > pos.get(hands[1]).x ? [a, b] : [b, a];
    rig.chest = chest;
    rig.armL = arm(l);
    rig.armR = arm(r);
  }
  if (headLeaf) {
    const p = headLeaf.parent;
    rig.head = isBone(p) && pos.get(headLeaf).distanceTo(pos.get(p)) < h * 0.06 ? p : headLeaf;
    const spine = path(rig.head);
    rig.spine = spine[Math.floor(spine.length / 2)];
  }
  return rig;
}

const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), invQ = new THREE.Quaternion();

// Turns `bone` by `angle` around a model-space axis ('x' = sideways, 'y' = up, 'z' = forward),
// on top of its rest pose. Several calls on the same bone in one frame add up.
function turn(rig, bone, axis, angle, poseMap) {
  if (!bone || !angle) return;
  invQ.copy(rig.restWorld.get(bone)).invert();
  tmpV.copy(AXIS[axis]).applyQuaternion(invQ);
  tmpQ.setFromAxisAngle(tmpV, angle);
  const q = poseMap.get(bone) ?? rig.rest.get(bone).clone();
  q.multiply(tmpQ);
  poseMap.set(bone, q);
}

// Applies a pose: { stride (−1…1 phase of a walk), amp, crouch, lean, armL, armR (raise angles),
// armFwdL/R, head (turn), spineTwist }. Missing values = rest.
export function pose(piece, p = {}) {
  const rig = piece.rig;
  if (!rig) return;
  const map = new Map();
  const amp = p.amp ?? 0;
  if (amp && rig.legL) {
    const s = Math.sin(p.stride ?? 0);
    turn(rig, rig.legL.thigh, 'x', -s * amp, map);
    turn(rig, rig.legR.thigh, 'x', s * amp, map);
    turn(rig, rig.legL.shin, 'x', Math.max(0, s) * amp * 1.3, map);
    turn(rig, rig.legR.shin, 'x', Math.max(0, -s) * amp * 1.3, map);
    if (rig.armL) {
      turn(rig, rig.armL.upper, 'x', s * amp * 0.8, map);
      turn(rig, rig.armR.upper, 'x', -s * amp * 0.8, map);
    }
  }
  if (p.crouch && rig.legL) {
    for (const leg of [rig.legL, rig.legR]) { turn(rig, leg.thigh, 'x', -p.crouch, map); turn(rig, leg.shin, 'x', p.crouch * 2, map); turn(rig, leg.foot, 'x', -p.crouch, map); }
  }
  if (p.lean) turn(rig, rig.spine, 'x', p.lean, map);
  if (p.spineTwist) turn(rig, rig.spine, 'y', p.spineTwist, map);
  if (p.head) turn(rig, rig.head, 'y', p.head, map);
  if (rig.armL) {
    // raise sideways (around the forward axis) and forward (around the sideways axis)
    if (p.armL) turn(rig, rig.armL.upper, 'z', -p.armL, map);
    if (p.armR) turn(rig, rig.armR.upper, 'z', p.armR, map);
    if (p.armFwdL) turn(rig, rig.armL.upper, 'x', -p.armFwdL, map);
    if (p.armFwdR) turn(rig, rig.armR.upper, 'x', -p.armFwdR, map);
    if (p.elbow) { turn(rig, rig.armL.fore, 'x', -p.elbow, map); turn(rig, rig.armR.fore, 'x', -p.elbow, map); }
  }
  for (const b of rig.bones) b.quaternion.copy(map.get(b) ?? rig.rest.get(b));
}

// ───────────────────────────── pieces ─────────────────────────────

// One piece on the board: a Group whose origin is the middle of the square at board height,
// facing +z until the renderer turns it. { group, body, type, seat, rig, setFlash(color, k) }
export function createPiece(type, seat, models) {
  const color = sideColor(seat);
  const tpl = models[type];
  const group = new THREE.Group();
  const body = new THREE.Group(); // moves for hops and leans; group stays on the square
  group.add(body);
  let model, rig = null, flashUniforms = [];
  let height;
  if (tpl) {
    model = tpl.rigged ? SkeletonUtils.clone(tpl.scene) : tpl.scene.clone(true);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.sharedGeometry = true; // belongs to the loaded model, used by every copy
      o.material = Array.isArray(o.material) ? o.material.map((m) => neonMaterial(m, color, seat === 1)) : neonMaterial(o.material, color, seat === 1);
      for (const m of [o.material].flat()) flashUniforms.push(m.userData.neon.uFlash);
      if (o.isSkinnedMesh) o.frustumCulled = false;
    });
    const size = tpl.box.getSize(new THREE.Vector3());
    height = size.y;
    const k = Math.min(HEIGHT[type] / size.y, MAX_WIDTH / Math.max(size.x, size.z));
    model.scale.setScalar(k);
    const c = tpl.box.getCenter(new THREE.Vector3());
    model.position.set(-c.x * k, -tpl.box.min.y * k, -c.z * k);
    body.add(model);
    if (tpl.rigged) rig = buildRig(model);
  } else {
    model = standIn(type, color);
    model.scale.setScalar(HEIGHT[type] / 1.2 * (type === KING ? 1 : 1.12));
    body.add(model);
    model.traverse((o) => { if (o.isMesh && o.material.emissive) { o.material = o.material.clone(); flashUniforms.push(null); } });
  }
  void height;

  // glowing base ring
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.018, 6, 40), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.012;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.33, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.008;
  group.add(ring, disc);

  const piece = { type, seat, group, body, model, rig, ring, attachments: [], color };

  // The Assassin's plasma blades: made in code, held in each hand, pointing down along the legs.
  if (type === QUEEN && rig?.armL) piece.blades = [rig.armL, rig.armR].map((arm) => attachBlade(piece, arm.hand ?? arm.fore, color));

  piece.setFlash = (c, k = 1) => {
    for (const u of flashUniforms) if (u) u.value.copy(c).multiplyScalar(k);
    if (!flashUniforms.some(Boolean)) model.traverse((o) => { if (o.isMesh && o.material.emissive) o.material.emissiveIntensity = 2.4 + k * 2; });
  };
  piece.setOpacity = (a) => {
    group.traverse((o) => {
      if (!o.material) return;
      for (const m of [o.material].flat()) { m.transparent = a < 1 || m === ringMat || m.opacity < 1; m.opacity = Math.min(m.userData.baseOpacity ??= m.opacity, a); }
    });
  };
  return piece;
}

// A blade fixed to a hand bone: placed in model space at rest, then parented to the bone.
function attachBlade(piece, bone, color) {
  if (!bone) return null;
  const len = 0.42;
  const geo = new THREE.BoxGeometry(0.035, len, 0.012);
  geo.translate(0, -len / 2, 0);
  const blade = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color('#ffffff'), 0.35), transparent: true, opacity: 0.95 }));
  const glow = new THREE.Mesh(new THREE.BoxGeometry(0.09, len, 0.04).translate(0, -len / 2, 0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  blade.add(glow);
  // world placement at rest: at the hand, pointing down and slightly forward
  piece.group.updateMatrixWorld(true);
  const handWorld = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
  const holder = new THREE.Object3D();
  holder.position.copy(handWorld);
  holder.lookAt(handWorld.clone().add(new THREE.Vector3(0, 0, 1)));
  holder.rotateX(0.25); // tilt the tip a little forward
  holder.add(blade);
  holder.updateMatrixWorld(true);
  bone.attach(holder);
  return blade;
}

export function disposePiece(piece) {
  piece.group.removeFromParent();
  piece.group.traverse((o) => {
    if (o.isMesh && !o.userData.sharedGeometry) o.geometry?.dispose?.();
    for (const m of [o.material ?? []].flat()) if (!m.map || m.userData.neon) m.dispose?.();
  });
}

export { glowSprite, BOARD_TOP };
