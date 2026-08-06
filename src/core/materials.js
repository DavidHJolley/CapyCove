import * as THREE from 'three';

// Shared stylized-toon look. Use makeToon() for nearly everything so the whole
// game reads as one art style. Materials are cached per color/steps.

const gradientCache = new Map();
const toonCache = new Map();

function gradientTex(steps = 3) {
  if (gradientCache.has(steps)) return gradientCache.get(steps);
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) data[i] = Math.round(90 + (165 * i) / (steps - 1));
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  gradientCache.set(steps, tex);
  return tex;
}

/** Stylized toon material. Cached: do NOT mutate the returned material.
 *  For a unique material (emissive pulses etc.) pass {unique: true}. */
export function makeToon(color, { steps = 3, unique = false, ...rest } = {}) {
  const key = `${color}|${steps}|${JSON.stringify(rest)}`;
  if (!unique && toonCache.has(key)) return toonCache.get(key);
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: gradientTex(steps), ...rest });
  mat.userData.shared = !unique;
  if (!unique) toonCache.set(key, mat);
  return mat;
}

/** Flat unlit material for glowy accents (lamps, signs, dance floor tiles). */
export function makeGlow(color, { unique = false } = {}) {
  const key = `glow|${color}`;
  if (!unique && toonCache.has(key)) return toonCache.get(key);
  const mat = new THREE.MeshBasicMaterial({ color });
  mat.userData.shared = !unique;
  if (!unique) toonCache.set(key, mat);
  return mat;
}

/** Canvas-drawn texture helper for signs, labels, simple patterns. */
export function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Dispose helper: recursively free geometries + non-cached materials of a subtree. */
export function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.userData?.shared) continue; // cached/shared, keep
      m.map?.dispose?.();
      m.dispose?.();
    }
  });
}
