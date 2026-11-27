// Shared Three.js stage: transparent canvas for OBS, render-on-demand loop,
// promise-based animations, FPS + pixel-ratio caps.

import * as THREE from 'three';

export const ease = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  out: (t) => 1 - (1 - t) ** 3,
  outBack: (t) => { const c = 1.6; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
};

const DEFAULT_FOV = 34;

// True while a text field has focus (the on-screen keyboard is probably open).
function isTyping() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

export class Stage {
  constructor(container, { fpsCap = 60, maxPixelRatio = 1.5, antialias = true, panelOffsets = true } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 16 / 9, 0.5, 200);
    this.target = new THREE.Vector3();

    this.scene.add(new THREE.HemisphereLight(0xfff6ea, 0x40342a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-6, 14, 8);
    this.scene.add(sun);

    this.panelOffsets = panelOffsets;
    this.minFrameMs = 1000 / fpsCap;
    this.anims = new Set();
    this.dirty = true;
    this.running = false;
    this.lastFrame = 0;

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    // On phones the on-screen keyboard shrinks the window. While someone is typing, the board
    // keeps its size (no jumping camera); the skipped resize is done once the input loses focus.
    this.onFocusOut = () => setTimeout(() => { if (this.resizePending && !isTyping()) this.resize(); }, 250);
    window.addEventListener('focusout', this.onFocusOut);
    this.resize();
  }

  // Positions the camera so a square board of `size` fits, viewed at `tilt` degrees from vertical.
  frame(size, { tilt = 38, fill = 0.92, center = [0, 0, 0] } = {}) {
    this.viewArgs = null;
    // Games shift the board sideways (center x) to leave room for the HUD's side panel. When the
    // stage itself already stops at the panel (touch layout), that shift is switched off.
    if (!this.panelOffsets) center = [0, center[1], center[2]];
    this.camera.fov = DEFAULT_FOV;
    this.#applyShift(0);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect;
    // Fit the board's diagonal-ish footprint in whichever dimension is tighter.
    const needH = size * (0.82 + 0.18 * Math.cos(THREE.MathUtils.degToRad(tilt))) / fill;
    // Some games overfill (fill > 1) on purpose for a 16:9 screen. On a narrower touch stage
    // that would cut the board off at the sides, so the width always fits there.
    const needW = size / (this.panelOffsets ? fill : Math.min(fill, 0.9));
    const distH = needH / 2 / Math.tan(vfov / 2);
    const distW = needW / 2 / (Math.tan(vfov / 2) * aspect);
    const dist = Math.max(distH, distW);
    const a = THREE.MathUtils.degToRad(tilt);
    this.target.set(...center);
    this.camera.position.set(center[0], center[1] + Math.cos(a) * dist, center[2] + Math.sin(a) * dist);
    this.camera.lookAt(this.target);
    this.frameArgs = [size, { tilt, fill, center }];
    this.invalidate();
  }

  // Frames an upright object (width x height around `center`) from the front, e.g. a standing board.
  // elevation: degrees above horizontal. shiftX: moves the picture sideways as a fraction of the
  // screen width (negative = left) with a lens shift, so the camera still looks straight on and
  // nothing gets viewed at an angle. A narrow fov keeps perspective distortion low.
  view({ width, height, center = [0, 0, 0], fov = 24, elevation = 6, fill = 0.9, shiftX = 0 }) {
    this.frameArgs = null;
    if (!this.panelOffsets) shiftX = 0; // see frame()
    this.viewArgs = { width, height, center, fov, elevation, fill, shiftX };
    this.camera.fov = fov;
    const t = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const usableW = 1 - 2 * Math.abs(shiftX);
    const distH = height / fill / 2 / t;
    const distW = width / fill / 2 / (t * this.camera.aspect * usableW);
    const dist = Math.max(distH, distW);
    const e = THREE.MathUtils.degToRad(elevation);
    this.target.set(...center);
    this.camera.position.set(center[0], center[1] + Math.sin(e) * dist, center[2] + Math.cos(e) * dist);
    this.camera.lookAt(this.target);
    this.#applyShift(shiftX);
    this.invalidate();
  }

  #applyShift(shiftX) {
    const w = this.width ?? window.innerWidth;
    const h = this.height ?? window.innerHeight;
    if (shiftX) this.camera.setViewOffset(w, h, -shiftX * w, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    // Only the height changed while typing → the keyboard opened or closed.
    if (isTyping() && this.width === w && this.height) { this.resizePending = true; return; }
    this.resizePending = false;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.frameArgs) this.frame(...this.frameArgs);
    else if (this.viewArgs) this.view(this.viewArgs);
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
    this.#kick();
  }

  // Runs fn(t) with t going 0→1 over `ms`, eased. Resolves when done.
  animate(ms, fn, easing = ease.inOut) {
    return new Promise((resolve) => {
      if (ms <= 0) { fn(1); this.invalidate(); resolve(); return; }
      this.anims.add({ start: performance.now(), ms, fn, easing, resolve });
      this.#kick();
    });
  }

  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  #kick() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.#tick);
  }

  #tick = (now) => {
    if (now - this.lastFrame < this.minFrameMs - 1 && (this.anims.size || this.dirty)) {
      requestAnimationFrame(this.#tick);
      return;
    }
    this.lastFrame = now;
    try {
      for (const a of this.anims) {
        // The frame timestamp can be a few ms *before* animate() was called,
        // so clamp: animations must only ever see t in [0, 1].
        const t = Math.min(1, Math.max(0, (now - a.start) / a.ms));
        try {
          a.fn(a.easing(t));
        } catch (err) {
          // One broken animation must never freeze the overlay: end it and move on.
          console.error('[stage] animation failed, skipping it', err);
          this.anims.delete(a);
          a.resolve();
          continue;
        }
        if (t >= 1) { this.anims.delete(a); a.resolve(); }
      }
      if (this.anims.size || this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
      }
    } catch (err) {
      console.error('[stage] render failed', err);
    }
    if (this.anims.size) requestAnimationFrame(this.#tick);
    else this.running = false; // idle: no frames at all until something changes
  };

  dispose() {
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('focusout', this.onFocusOut);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// Soft round "blob" shadow texture, shared.
let blobTex;
export function blobShadowTexture() {
  if (blobTex) return blobTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(cv);
  return blobTex;
}

export function blobShadow(radius) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}

// Number badge sprite ("1", "2" …) shown above choosable pieces.
const badgeCache = new Map();
export function badgeSprite(text, color = '#ffffff', bg = '#1d1a26') {
  const key = `${text}|${color}|${bg}`;
  let mat = badgeCache.get(key);
  if (!mat) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    g.beginPath();
    g.arc(64, 64, 56, 0, Math.PI * 2);
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = color;
    g.stroke();
    g.fillStyle = color;
    g.font = 'bold 72px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 64, 68);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    badgeCache.set(key, mat);
  }
  const s = new THREE.Sprite(mat);
  s.renderOrder = 10;
  return s;
}
