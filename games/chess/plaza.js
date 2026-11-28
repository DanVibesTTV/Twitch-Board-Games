// Neon Chess — the scene: a night-time cyberpunk plaza with the board in the middle.
// Everything is drawn from code (canvas textures + simple geometry): no image files.
//
// Board layout (world units, one square = S): Cyan's back rank (rank 1) on the LEFT, Magenta's
// on the RIGHT, the a-file at the back and the h-file at the front — the camera looks at the
// board from Cyan's left, so both armies are seen side-on, facing each other.

import * as THREE from 'three';

export const S = 1;                    // square size
export const BOARD_TOP = 0.16;         // pieces stand at this height
export const CYAN = new THREE.Color('#19e6ff');
export const MAGENTA = new THREE.Color('#ff2bd6');
export const sideColor = (seat) => (seat === 0 ? CYAN : MAGENTA);

export const squareX = (sq) => ((sq >> 3) - 3.5) * S;   // rank → x
export const squareZ = (sq) => ((sq & 7) - 3.5) * S;    // file → z
export const squarePos = (sq, y = BOARD_TOP) => new THREE.Vector3(squareX(sq), y, squareZ(sq));

function canvasTexture(w, h, draw, { repeat = null, srgb = true } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

// A small deterministic random (the plaza looks the same every time).
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ───────────────────────────── board ─────────────────────────────

function boardTexture() {
  const N = 1024, M = 56;                 // margin for coordinates
  const cell = (N - 2 * M) / 8;
  return canvasTexture(N, N, (g) => {
    g.fillStyle = '#05060c';
    g.fillRect(0, 0, N, N);
    // squares: canvas x = rank (left → right = 1 → 8), canvas y = file (top → bottom = a → h)
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const dark = (r + f) % 2 === 0;
      const x = M + r * cell, y = M + f * cell;
      const grd = g.createLinearGradient(x, y, x + cell, y + cell);
      if (dark) { grd.addColorStop(0, '#0c1020'); grd.addColorStop(1, '#070912'); }
      else { grd.addColorStop(0, '#26304a'); grd.addColorStop(1, '#1a2238'); }
      g.fillStyle = grd;
      g.fillRect(x, y, cell, cell);
      // faint circuit traces on light squares
      if (!dark) {
        g.strokeStyle = 'rgba(140, 180, 255, 0.10)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x + cell * 0.15, y + cell * 0.8); g.lineTo(x + cell * 0.45, y + cell * 0.8); g.lineTo(x + cell * 0.6, y + cell * 0.65);
        g.moveTo(x + cell * 0.8, y + cell * 0.15); g.lineTo(x + cell * 0.8, y + cell * 0.4);
        g.stroke();
      }
    }
    // grid lines
    g.strokeStyle = 'rgba(120, 160, 255, 0.35)';
    g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(M + i * cell, M); g.lineTo(M + i * cell, N - M); g.stroke();
      g.beginPath(); g.moveTo(M, M + i * cell); g.lineTo(N - M, M + i * cell); g.stroke();
    }
    // side glow: cyan half / magenta half of the frame
    const edge = (x0, color) => {
      g.strokeStyle = color; g.lineWidth = 6; g.shadowColor = color; g.shadowBlur = 18;
      g.beginPath(); g.moveTo(x0, M - 14); g.lineTo(x0, N - M + 14); g.stroke();
      g.shadowBlur = 0;
    };
    edge(M - 14, '#19e6ff');
    edge(N - M + 14, '#ff2bd6');
    const half = (y0) => {
      const grd = g.createLinearGradient(M, 0, N - M, 0);
      grd.addColorStop(0, '#19e6ff'); grd.addColorStop(0.5, 'rgba(160,120,255,0.7)'); grd.addColorStop(1, '#ff2bd6');
      g.strokeStyle = grd; g.lineWidth = 4;
      g.beginPath(); g.moveTo(M - 14, y0); g.lineTo(N - M + 14, y0); g.stroke();
    };
    half(M - 14); half(N - M + 14);
    // coordinates: files (a–h) down the left side, ranks (1–8) along the front edge
    g.font = `700 ${M * 0.5}px "Inter", "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(200, 230, 255, 0.85)';
    for (let f = 0; f < 8; f++) {
      g.fillText('abcdefgh'[f], M * 0.42, M + (f + 0.5) * cell);
      g.fillText('abcdefgh'[f], N - M * 0.42, M + (f + 0.5) * cell);
    }
    for (let r = 0; r < 8; r++) {
      g.fillText(String(r + 1), M + (r + 0.5) * cell, N - M * 0.42);
      g.fillText(String(r + 1), M + (r + 0.5) * cell, M * 0.42);
    }
  });
}

export function buildBoard() {
  const size = 8 * S + 2 * 0.47;          // the texture's coordinate margin, in world units
  const group = new THREE.Group();
  const top = new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.35, metalness: 0.4, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.06 });
  top.emissiveMap = top.map;
  const side = new THREE.MeshStandardMaterial({ color: '#0b0d16', roughness: 0.5, metalness: 0.7 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(size, BOARD_TOP, size), [side, side, top, side, side, side]);
  slab.position.y = BOARD_TOP / 2;
  group.add(slab);
  // glowing strips along the long edges, cyan on the left half, magenta on the right
  for (const z of [-size / 2, size / 2]) {
    for (const [x, c] of [[-size / 4, CYAN], [size / 4, MAGENTA]]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(size / 2, 0.03, 0.03), new THREE.MeshBasicMaterial({ color: c }));
      strip.position.set(x, BOARD_TOP * 0.55, z);
      group.add(strip);
    }
  }
  for (const [x, c] of [[-size / 2, CYAN], [size / 2, MAGENTA]]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, size), new THREE.MeshBasicMaterial({ color: c }));
    strip.position.set(x, BOARD_TOP * 0.55, 0);
    group.add(strip);
  }
  // base under the slab
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(size + 0.5, 0.12, size + 0.5), new THREE.MeshStandardMaterial({ color: '#10121c', roughness: 0.6, metalness: 0.6 }));
  plinth.position.y = 0.0;
  group.add(plinth);
  return group;
}

// ───────────────────────────── plaza ─────────────────────────────

function groundTexture() {
  return canvasTexture(1024, 1024, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    // paving: dark wet stone with a hex pattern, fading out to transparent at the edge
    g.fillStyle = '#0a0b12';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(90, 110, 170, 0.18)';
    g.lineWidth = 2;
    const r = 26;
    for (let y = -r; y < h + r; y += r * 1.5) {
      for (let x = -r; x < w + r; x += r * Math.sqrt(3)) {
        const ox = (Math.round(y / (r * 1.5)) % 2) * r * Math.sqrt(3) / 2;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          const px = x + ox + r * Math.cos(a), py = y + r * Math.sin(a);
          k ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.closePath(); g.stroke();
      }
    }
    // neon rings around the board area
    for (const [rad, c, wdt] of [[300, 'rgba(25,230,255,0.55)', 4], [330, 'rgba(255,43,214,0.45)', 3], [420, 'rgba(120,100,255,0.25)', 2]]) {
      g.strokeStyle = c; g.lineWidth = wdt; g.shadowColor = c; g.shadowBlur = 16;
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.stroke();
    }
    g.shadowBlur = 0;
    // puddle reflections
    const rnd = seeded(7);
    for (let i = 0; i < 22; i++) {
      const a = rnd() * Math.PI * 2, d = 180 + rnd() * 300;
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
      const grd = g.createRadialGradient(px, py, 2, px, py, 30 + rnd() * 40);
      grd.addColorStop(0, rnd() > 0.5 ? 'rgba(25,230,255,0.18)' : 'rgba(255,43,214,0.16)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(px - 80, py - 80, 160, 160);
    }
    // fade to transparent
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createRadialGradient(cx, cy, w * 0.3, cx, cy, w * 0.5);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);
  });
}

function windowsTexture(seed, hue) {
  return canvasTexture(256, 512, (g, w, h) => {
    const rnd = seeded(seed);
    g.fillStyle = '#07080e';
    g.fillRect(0, 0, w, h);
    const cw = 16, ch = 22;
    for (let y = 10; y < h - ch; y += ch + 8) {
      for (let x = 10; x < w - cw; x += cw + 8) {
        const lit = rnd();
        if (lit < 0.45) continue;
        const warm = rnd() < 0.25;
        const a = 0.25 + rnd() * 0.6;
        g.fillStyle = warm ? `rgba(255, 190, 120, ${a})` : `hsla(${hue + rnd() * 30}, 90%, 65%, ${a})`;
        g.fillRect(x, y, cw, ch);
      }
    }
  });
}

function signTexture(text, color, sub = '') {
  return canvasTexture(512, 192, (g, w, h) => {
    g.fillStyle = 'rgba(8, 6, 18, 0.85)';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = color; g.lineWidth = 6; g.shadowColor = color; g.shadowBlur = 22;
    g.strokeRect(10, 10, w - 20, h - 20);
    g.font = `900 ${sub ? 78 : 96}px "Inter", "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(text, w / 2, sub ? h * 0.42 : h / 2);
    if (sub) {
      g.shadowBlur = 10;
      g.font = `600 30px "Inter", "Segoe UI", system-ui, sans-serif`;
      g.fillStyle = color;
      g.fillText(sub, w / 2, h * 0.78);
    }
  });
}

export function buildPlaza() {
  const group = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ map: groundTexture(), transparent: true, roughness: 0.25, metalness: 0.5, depthWrite: false }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.065;
  ground.renderOrder = -1;
  group.add(ground);

  // Towers behind the board (the far side), a few at the sides: a skyline, not walls.
  const rnd = seeded(42);
  const towers = [
    [-9.5, -9.5, 2.6, 7.5], [-6.2, -11, 2.2, 10], [-2.6, -12, 2.8, 12.5], [1.4, -11.5, 2.3, 9], [5.2, -12, 2.6, 13],
    [8.8, -10.5, 2.4, 8.5], [11.5, -7, 2.0, 6.5], [-12, -6.5, 2.0, 6],
  ];
  const mats = [0, 1, 2].map((i) => {
    const t = windowsTexture(10 + i, [190, 300, 260][i]);
    return new THREE.MeshStandardMaterial({ color: '#0d0f18', roughness: 0.6, metalness: 0.5, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 0.9, map: t });
  });
  towers.forEach(([x, z, w, h], i) => {
    const m = mats[i % 3].clone();
    m.map = m.map.clone(); m.emissiveMap = m.map;
    m.map.repeat.set(1, h / 6); m.map.wrapT = THREE.RepeatWrapping; m.map.needsUpdate = true;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * (0.8 + rnd() * 0.4)), m);
    tower.position.set(x, h / 2 - 0.06, z);
    group.add(tower);
    // neon edge on the roof line
    const c = i % 2 ? MAGENTA : CYAN;
    const rim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: c }));
    rim.position.set(x, h - 0.06, z + w * 0.45);
    group.add(rim);
  });

  // Holo-signs
  const signs = [
    ['NEON CHESS', '#19e6ff', 'SYNDICATE ARENA', [-2.2, 5.6, -10.4], 4.2],
    ['NIGHT MARKET', '#ff2bd6', '', [5.0, 4.2, -10.3], 2.8],
    ['OPEN 24/7', '#a78bfa', '', [-8.4, 3.4, -8.1], 2.0],
  ];
  for (const [text, color, sub, pos, width] of signs) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 0.375), new THREE.MeshBasicMaterial({ map: signTexture(text, color, sub), transparent: true }));
    sign.position.set(...pos);
    group.add(sign);
  }

  // Lamp posts at the board's corners, glowing in each side's colour.
  for (const [x, z, c] of [[-6, -5.8, CYAN], [-3, -6.4, CYAN], [3, -6.4, MAGENTA], [6, -5.8, MAGENTA]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.6, 8), new THREE.MeshStandardMaterial({ color: '#1a1d2a', metalness: 0.8, roughness: 0.4 }));
    pole.position.set(x, 1.24, z);
    group.add(pole);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8), new THREE.MeshBasicMaterial({ color: c }));
    tube.position.set(x, 2.3, z);
    group.add(tube);
    const halo = glowSprite(c, 1.1, 0.6);
    halo.position.set(x, 2.3, z);
    group.add(halo);
  }
  return group;
}

// A soft round glow (additive) — used for lamps, muzzle flashes, sparks.
let glowTex = null;
export function glowSprite(color, size = 1, opacity = 0.8) {
  glowTex ??= canvasTexture(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size);
  return s;
}

// Holo panel showing both clocks / captured pieces — a canvas sprite redrawn when it changes.
export function holoPanel(width = 2.4, height = 0.9) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = Math.round(512 * height / width);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  return { mesh, canvas: cv, ctx: cv.getContext('2d'), refresh: () => { tex.needsUpdate = true; } };
}
