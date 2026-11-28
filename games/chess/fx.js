// Neon Chess — battle effects. Each function adds its objects to `scene`, animates them with
// stage.animate (rendering only while something moves) and removes them afterwards.
// Colours come in as THREE.Color (the attacker's side).

import * as THREE from 'three';
import { ease } from '../../renderer/stage.js';
import { glowSprite } from './plaza.js';

const WHITE = new THREE.Color('#ffffff');
const add = (scene, ...objs) => { for (const o of objs) scene.add(o); };
const drop = (...objs) => { for (const o of objs) { o.removeFromParent(); o.traverse?.((x) => { x.geometry?.dispose?.(); if (x.material && !x.isSprite) x.material.dispose?.(); }); } };

// A bright bolt flying from a to b (cannon shell, laser pulse). Resolves when it arrives.
export async function bolt(stage, scene, a, b, color, { ms = 260, size = 0.28, arc = 0 } = {}) {
  const core = glowSprite(WHITE, size * 0.6, 1);
  const halo = glowSprite(color, size * 1.6, 0.9);
  add(scene, core, halo);
  const p = new THREE.Vector3();
  await stage.animate(ms, (t) => {
    p.lerpVectors(a, b, t);
    p.y += Math.sin(t * Math.PI) * arc;
    core.position.copy(p); halo.position.copy(p);
  }, ease.linear ?? ((t) => t));
  drop(core, halo);
}

// A straight beam (Overlord's visor laser): grows from a to b, holds, fades.
export async function beam(stage, scene, a, b, color, { ms = 520, width = 0.05 } = {}) {
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(width, width, 1, 8, 1, true);
  geo.translate(0, 0.5, 0);
  geo.rotateX(Math.PI / 2);
  const inner = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: WHITE, transparent: true, depthWrite: false }));
  const outer = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  outer.scale.set(3, 3, 1);
  const g = new THREE.Group();
  g.add(inner, outer);
  g.position.copy(a);
  g.lookAt(b);
  const flare = glowSprite(color, 0.8, 1);
  flare.position.copy(b);
  add(scene, g, flare);
  await stage.animate(ms, (t) => {
    const grow = Math.min(1, t * 4);
    g.scale.z = len * grow;
    const fade = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    inner.material.opacity = fade; outer.material.opacity = 0.5 * fade;
    flare.material.opacity = grow * fade;
    flare.scale.setScalar(0.6 + 0.4 * Math.sin(t * 40));
  });
  drop(g, flare);
}

// Arc lightning (Technomancer): a jagged bolt from a to b, re-shaped many times a second.
// Built from thin glowing segments (WebGL lines are only one pixel wide).
export async function lightning(stage, scene, a, b, color, { ms = 700, rnd = Math.random } = {}) {
  const N = 12;
  const unit = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const coreMat = new THREE.MeshBasicMaterial({ color: WHITE, transparent: true, depthWrite: false });
  const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const segs = [...Array(N - 1)].map(() => {
    const core = new THREE.Mesh(unit, coreMat);
    const glow = new THREE.Mesh(unit, glowMat);
    return { core, glow };
  });
  const flare = glowSprite(color, 1.0, 1);
  flare.position.copy(b);
  const src = glowSprite(color, 0.6, 1);
  src.position.copy(a);
  add(scene, flare, src);
  for (const sg of segs) scene.add(sg.core, sg.glow);
  const pts = [...Array(N)].map(() => new THREE.Vector3());
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  let last = -1;
  await stage.animate(ms, (t) => {
    const step = Math.floor(t * 20);
    if (step !== last) {
      last = step;
      pts.forEach((p, i) => {
        const k = i / (N - 1);
        p.lerpVectors(a, b, k);
        const wob = Math.sin(k * Math.PI) * 0.22;
        if (i && i < N - 1) { p.x += (rnd() - 0.5) * wob; p.y += (rnd() - 0.5) * wob; p.z += (rnd() - 0.5) * wob; }
      });
      segs.forEach((sg, i) => {
        const p0 = pts[i], p1 = pts[i + 1];
        dir.subVectors(p1, p0);
        const len = dir.length();
        for (const [m, r] of [[sg.core, 0.012], [sg.glow, 0.045]]) {
          m.position.lerpVectors(p0, p1, 0.5);
          m.quaternion.setFromUnitVectors(up, dir.clone().normalize());
          m.scale.set(r, len, r);
        }
      });
    }
    const fade = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
    coreMat.opacity = fade; glowMat.opacity = 0.55 * fade;
    flare.material.opacity = fade; src.material.opacity = fade;
    flare.scale.setScalar(0.8 + 0.3 * Math.sin(t * 50));
  }, (t) => t);
  for (const sg of segs) { sg.core.removeFromParent(); sg.glow.removeFromParent(); }
  unit.dispose(); coreMat.dispose(); glowMat.dispose();
  drop(flare, src);
}

// Blade slashes (Cyber-Assassin): two crossing glowing arcs at `at`.
export async function slash(stage, scene, at, color, { ms = 420, facing = 0 } = {}) {
  const arcs = [0.7, -0.7].map((tilt) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.37, 24, 1, -0.9, 1.8), new THREE.MeshBasicMaterial({ color: color.clone().lerp(WHITE, 0.4), transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(at);
    m.rotation.set(0, facing + Math.PI / 2, tilt);
    return m;
  });
  add(scene, ...arcs);
  await stage.animate(ms, (t) => {
    arcs.forEach((m, i) => {
      const k = Math.min(1, Math.max(0, t * 2 - i * 0.35));
      m.scale.setScalar(0.4 + k * 0.9);
      m.material.opacity = k < 1 ? k : 1 - (t - 0.6) / 0.4;
    });
  });
  drop(...arcs);
}

// A ring of light expanding over the board (landings, explosions).
export async function shockwave(stage, scene, at, color, { ms = 500, radius = 1.2 } = {}) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(at);
  ring.position.y += 0.02;
  add(scene, ring);
  await stage.animate(ms, (t) => {
    ring.scale.setScalar(0.1 + t * radius);
    ring.material.opacity = 1 - t;
  }, (t) => 1 - (1 - t) * (1 - t));
  drop(ring);
}

// A piece breaks apart into glowing shards (captured).
export async function shatter(stage, scene, center, color, { ms = 950, count = 70, height = 0.9, rnd = Math.random } = {}) {
  const geo = new THREE.TetrahedronGeometry(0.05);
  const mat = new THREE.MeshBasicMaterial({ color: color.clone().lerp(WHITE, 0.25), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const shards = new THREE.InstancedMesh(geo, mat, count);
  const dark = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), new THREE.MeshStandardMaterial({ color: '#222634', metalness: 0.7, roughness: 0.4, transparent: true }), Math.floor(count / 2));
  const parts = [...Array(count + Math.floor(count / 2))].map(() => ({
    p: new THREE.Vector3((rnd() - 0.5) * 0.4, rnd() * height, (rnd() - 0.5) * 0.4),
    v: new THREE.Vector3((rnd() - 0.5) * 3.2, 1 + rnd() * 3, (rnd() - 0.5) * 3.2),
    r: new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6),
    s: 0.6 + rnd() * 1.2,
  }));
  shards.position.copy(center); dark.position.copy(center);
  const flash = glowSprite(color, 1.8, 1);
  flash.position.copy(center).add(new THREE.Vector3(0, height / 2, 0));
  add(scene, shards, dark, flash);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  await stage.animate(ms, (t) => {
    const time = t * ms / 1000;
    parts.forEach((pt, i) => {
      pos.copy(pt.p).addScaledVector(pt.v, time);
      pos.y = Math.max(0.02, pos.y - 4.5 * time * time);
      q.setFromEuler(new THREE.Euler(pt.r.x + time * 6, pt.r.y + time * 5, pt.r.z));
      sc.setScalar(pt.s * (1 - t * 0.6));
      m.compose(pos, q, sc);
      if (i < count) shards.setMatrixAt(i, m); else dark.setMatrixAt(i - count, m);
    });
    shards.instanceMatrix.needsUpdate = true; dark.instanceMatrix.needsUpdate = true;
    mat.opacity = 1 - t; dark.material.opacity = 1 - t * t;
    flash.material.opacity = Math.max(0, 1 - t * 3);
    flash.scale.setScalar(1.2 + t * 2);
  }, (t) => t);
  drop(shards, dark, flash);
}

// Sparks at a point (punches, hits).
export async function sparks(stage, scene, at, color, { ms = 380, count = 18, rnd = Math.random } = {}) {
  const flare = glowSprite(color, 0.7, 1);
  flare.position.copy(at);
  const dots = [...Array(count)].map(() => {
    const s = glowSprite(rnd() < 0.5 ? WHITE : color, 0.09, 1);
    s.position.copy(at);
    s.userData.v = new THREE.Vector3((rnd() - 0.5) * 3, rnd() * 2.5, (rnd() - 0.5) * 3);
    return s;
  });
  add(scene, flare, ...dots);
  await stage.animate(ms, (t) => {
    flare.material.opacity = 1 - t;
    flare.scale.setScalar(0.5 + t);
    for (const d of dots) { d.position.copy(at).addScaledVector(d.userData.v, t * 0.4); d.material.opacity = 1 - t; }
  }, (t) => t);
  drop(flare, ...dots);
}

// The Overlord's defence when in check: a shield dome and two drones circling it.
export async function shield(stage, scene, at, color, { ms = 1300 } = {}) {
  const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  dome.position.copy(at).add(new THREE.Vector3(0, 0.55, 0));
  const warn = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.48, 40), new THREE.MeshBasicMaterial({ color: '#ff3355', transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  warn.rotation.x = -Math.PI / 2;
  warn.position.copy(at).add(new THREE.Vector3(0, 0.03, 0));
  const drones = [0, 1].map(() => {
    const d = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), new THREE.MeshBasicMaterial({ color: WHITE }));
    d.add(glowSprite(color, 0.35, 0.9));
    return d;
  });
  add(scene, dome, warn, ...drones);
  await stage.animate(ms, (t) => {
    const up = Math.min(1, t * 5), fade = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
    dome.scale.setScalar(0.4 + up * 0.6);
    dome.rotation.y = t * 2;
    dome.material.opacity = (0.35 + 0.25 * Math.sin(t * 30)) * fade;
    warn.material.opacity = (0.5 + 0.5 * Math.sin(t * 22)) * fade;
    drones.forEach((d, i) => {
      const a = t * Math.PI * 4 + i * Math.PI;
      d.position.set(at.x + Math.cos(a) * 0.7, at.y + 0.9 + Math.sin(t * 9 + i) * 0.08, at.z + Math.sin(a) * 0.7);
      d.rotation.y = a * 2;
      d.scale.setScalar(up * fade);
    });
  }, (t) => t);
  drop(dome, warn, ...drones);
}

// A column of light (promotion, appearing pieces).
export async function lightColumn(stage, scene, at, color, { ms = 700 } = {}) {
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 3, 24, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  col.position.copy(at).add(new THREE.Vector3(0, 1.5, 0));
  add(scene, col);
  await stage.animate(ms, (t) => {
    col.material.opacity = Math.sin(t * Math.PI) * 0.55;
    col.scale.set(1 - t * 0.4, 1, 1 - t * 0.4);
  }, (t) => t);
  drop(col);
}

// Thruster flames under a flying Jetpack: returns { update(strength), remove() }.
export function thrusters(parent, color) {
  const flames = [-0.09, 0.09].map((x) => {
    const f = glowSprite(color, 0.3, 0.9);
    f.position.set(x, 0.45, -0.14);
    parent.add(f);
    return f;
  });
  return {
    update(k) { flames.forEach((f, i) => { f.scale.set(0.22 + k * 0.2, 0.3 + k * 0.6 + (i ? 0.05 : 0), 1); f.material.opacity = 0.35 + k * 0.6; }); },
    remove() { for (const f of flames) f.removeFromParent(); },
  };
}

// A fading trail of afterimages behind a fast mover (Assassin dash).
export function trail(scene, color) {
  const dots = [];
  return {
    push(at) {
      const d = glowSprite(color, 0.45, 0.7);
      d.position.copy(at);
      scene.add(d);
      dots.push(d);
    },
    fade(t) { dots.forEach((d, i) => { d.material.opacity = Math.max(0, 0.7 - t - (dots.length - i) * 0.03); }); },
    remove() { for (const d of dots) d.removeFromParent(); dots.length = 0; },
  };
}
