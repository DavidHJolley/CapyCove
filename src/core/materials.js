import * as THREE from 'three';

/**
 * Shared stylized-toon look. Use makeToon() for nearly everything so the whole
 * game reads as one art style. Materials are cached per color/options.
 *
 * ---------------------------------------------------------------------------
 * HOW A GLOW GETS TO BLOOM (the contract with src/core/postfx.js)
 * ---------------------------------------------------------------------------
 * The post chain thresholds bloom in DISPLAY luminance at 0.85 in the shipped
 * "Nice" preset, and the pass fades a pixel in over a hair of 0.01, so 0.86 is
 * a full contribution. Display luminance here means: the linear colour through
 * three's ACES tonemap (which scales by toneMappingExposure / 0.6 first, so the
 * curve runs hotter than a bare ACES fit), sRGB-encoded, then read with the
 * bloom pass's own Rec.601 weights.
 *
 * That makes the line SATURATION-dependent, and the numbers are worth knowing
 * before tuning anything, because they are not intuitive. Measured against the
 * shipped renderer config:
 *
 *     makeGlow(0xffffff)                 0.888  -> already blooms
 *     makeGlow(0xffd08a)                 0.824  -> bright lamp, no bloom
 *     makeGlow(0xffd08a, {intensity:1.4})  0.876  -> blooms
 *     makeGlow(0xffd08a, {intensity:1.8})  0.905  -> blooms hard
 *     makeGlow(0xff6a1f)                 0.598  -> a deep ember never blooms
 *
 * So a near-white core is over the line at intensity 1 and wants no help at
 * all; a warm cream 0xffd08a crosses at ~1.2; a saturated orange 0xff6a1f
 * needs ~3.7, by which point ACES has bleached most of the colour out of it.
 * If a prop is meant to be a light SOURCE in the frame (a lantern core, a neon
 * tube, an LED tile, a crystal) and its colour is saturated, the cheap answer
 * is a paler core rather than a bigger number:
 *
 *     makeGlow(0xffd08a)                 // bright, no bloom
 *     makeGlow(0xffd08a, { intensity: 1.6 })  // 0.892: a lamp that glows
 *
 * The colour is scaled in linear space and ACES rolls it back off, so the hue
 * stays put and nothing clips, but the roll-off is also a desaturation: the
 * cream above keeps 24% of its saturation at 1.6 and 7% at 4. Keep it for
 * cores only, and reach for 4+ only if you want white. A dark room blooms
 * harder by itself (postfx reads scene.background and drops the threshold to
 * 0.79 at full dusk, where the same cream crosses at intensity 1.0), so tune
 * at NOON: that is the strict case, and the cove day can only add.
 */

const gradientCache = new Map();
const toonCache = new Map();
// stable ids for cache-key values JSON cannot describe (textures, colors)
let objKeyN = 0;
const objKeys = new WeakMap();

function gradientTex(steps = 3) {
  // Key on the STEP COUNT actually built, not on what was asked for: 1, 1.9 and
  // NaN all build the same 2-texel ramp and must share one texture.
  const n = Math.max(2, Math.floor(steps) || 2); // a 1-step ramp has no gradient
  if (gradientCache.has(n)) return gradientCache.get(n);
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round(90 + (165 * i) / (n - 1));
  const tex = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  gradientCache.set(n, tex);
  return tex;
}

/**
 * Cache key for the extra material options. JSON.stringify alone is not safe
 * here: option order changes the string (two identical materials, two cache
 * entries) and a texture or a THREE.Color either explodes it into a wall of
 * numbers or throws on a circular reference. Keys are sorted, and anything
 * that is not a primitive gets a stable per-object id instead.
 */
function optKey(rest) {
  const keys = Object.keys(rest).sort();
  if (!keys.length) return '';
  let out = '';
  for (const k of keys) {
    const v = rest[k];
    let s;
    if (v === null || typeof v !== 'object') s = String(v);
    else {
      s = objKeys.get(v);
      if (s === undefined) { s = `#${++objKeyN}`; objKeys.set(v, s); }
    }
    out += `|${k}=${s}`;
  }
  return out;
}

/** Stylized toon material. Cached: do NOT mutate the returned material.
 *  For a unique material (emissive pulses etc.) pass {unique: true}. */
export function makeToon(color, { steps = 3, unique = false, ...rest } = {}) {
  const key = `${color}|${steps}${optKey(rest)}`;
  if (!unique && toonCache.has(key)) return toonCache.get(key);
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: gradientTex(steps), ...rest });
  mat.userData.shared = !unique;
  if (!unique) toonCache.set(key, mat);
  return mat;
}

/**
 * Flat unlit material for glowy accents (lamps, signs, dance floor tiles).
 * `intensity` over-drives the colour in linear space so the prop reads as a
 * light source and clears the bloom threshold: see the note at the top of this
 * file for what the numbers do. Any other MeshBasicMaterial option (transparent,
 * opacity, side, ...) is passed straight through and is part of the cache key.
 */
export function makeGlow(color, { unique = false, intensity = 1, ...rest } = {}) {
  const key = `glow|${color}|${intensity}${optKey(rest)}`;
  if (!unique && toonCache.has(key)) return toonCache.get(key);
  // Color() converts the hex out of sRGB first, so the scaling happens in the
  // renderer's linear working space and the hue does not drift.
  const c = new THREE.Color(color);
  if (intensity !== 1) c.multiplyScalar(Math.max(0, intensity));
  const mat = new THREE.MeshBasicMaterial({ color: c, ...rest });
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
    // geometry.userData.shared marks module-level singletons (avatar bodies):
    // other avatars are still drawing them, so they outlive any one subtree
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    // A shadow map is a WebGLRenderTarget hanging off the light, not off any
    // material, so the material sweep below never reaches it. Rooms are rebuilt
    // on every visit, so without this each visit leaks one GPU texture per
    // shadow-casting light.
    if (o.isLight) o.shadow?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.userData?.shared) continue; // cached/shared, keep
      m.map?.dispose?.();
      m.dispose?.();
    }
  });
}
