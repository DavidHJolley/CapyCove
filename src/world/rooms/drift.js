import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { SwimController } from '../../player/swim.js';

/* ---------------------------------------------------------------------------
 * THE DRIFT (docs/LIVING-COVE.md section C): the graphics showcase room.
 *
 * You take the brass dive bell down off the Driftwood dock and come out in a
 * sunlit blue volume: caustics crawling over the sand, god rays hanging from a
 * surface far overhead, three fish schools, jellies, a turtle on a lazy loop,
 * and BIG BLUE, a whale the size of the room who seats six on her back.
 *
 * TWO PROJECT RULES ARE DELIBERATELY BROKEN HERE, AND ONLY HERE (sanctioned by
 * LIVING-COVE.md C):
 *  1. Custom GLSL. The seabed, the surface, the water shell, the god rays, the
 *     seagrass and both particle systems are ShaderMaterials. Everything solid
 *     and toon-shaded (rock, coral, the whale, the bell) still uses makeToon.
 *     Those shaders are NOT in the toon cache, so dispose() frees them by hand.
 *     Fog is hand-rolled in every one of them (uFog/uFogDensity) instead of
 *     three's fog chunks, so the shaders stay chunk-version independent and
 *     compile on WebGL2 with no extensions.
 *  2. Movement is swimming. The room sets `engine.controller.enabled = false`
 *     and drives a SwimController (src/player/swim.js) instead, and therefore
 *     has EMPTY groundMeshes: there is no floor to raycast. The net client
 *     already interpolates remote y for rooms with no ground.
 *
 * HOW RIDING BIG BLUE TRAVELS (the "ride flag", spelled out because it is not
 * a new protocol message):
 *  - The wire anim vocabulary the server accepts is idle|walk|dance|sit. The
 *    local avatar plays 'swim'/'ride', which the server rejects and therefore
 *    ignores, so those never reach anyone.
 *  - On entering the room we push one {t:'move', anim:'idle'} so a capy who was
 *    last seen sitting on a bench somewhere does not arrive flagged as a rider.
 *  - On mounting we push one {t:'move', ..., anim:'sit', ride:1}; on dismount
 *    one with anim:'idle'. `ride` is a hint for the server's stamp tracking and
 *    is harmless if it ignores it. In THIS room 'sit' means "on the whale".
 *  - A remote counts as a rider when their wire anim is 'sit' AND their
 *    reported position is inside Big Blue's neighbourhood (a stale 'sit' from
 *    another room can therefore never glue someone to her back).
 *  - Seats are assigned by sorting rider ids, so every client independently
 *    computes the same six seats. Instead of reparenting we write the seat
 *    transform onto the avatar AND onto the net client's interpolation target,
 *    which pins the rider to her back exactly (the lerp becomes a no-op) with
 *    none of the teardown hazards of reparenting: the engine removes the local
 *    player from the scene by parent, and a remote that leaves while parented
 *    to the whale would never leave the scene graph.
 *
 * Draw calls: ~33 for the room + 16 per capybara (budget 130).
 * ------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const SURFACE_Y = 24;            // the underside of the sea, far overhead
const SURFACE_GLSL = SURFACE_Y.toFixed(1); // same number, spelled for GLSL
const FLOOR_R = 50;              // seabed plate radius (fog eats the rim)
const DAY_SECONDS = 40 * 60;     // one cove day, from LIVING-COVE.md A

// Swimmable volume. Pushing the edge eases you back: "the current". The floor
// of it is the DUNES, not this y (see SwimController.floorAt): the box bottom
// is only the backstop out past the rim where the plate runs out.
const BOUND_MIN = [-30, 0.35, -30];
const BOUND_MAX = [30, 16.5, 30];

// The dive bell: arrival and exit. It sits BEHIND the arrival camera on
// purpose. Parked between the camera and the spawn it filled a third of the
// first frame you ever see of this room; from here you drop in facing open
// water with Big Blue's lap ahead of you, and the cable running up to the
// surface keeps the way home readable from anywhere in the room.
const BELL = { x: 0, y: 0, z: 21 };
const BELL_MID = 3.4;            // the height the exit prompt lives at
const FOG_DENSITY = 0.025;       // exponential; ~50 units of useful visibility

// Big Blue's lap. Her phase comes from the world clock so every client agrees
// where she is, which is what makes the six seats line up for everyone.
const WHALE = {
  period: 150,                    // seconds per lap
  // The ellipse she cruises. Phase 0 puts her broadside about 16 units off the
  // dive bell, up in the light shafts: close enough to read as "surfacing by
  // the bell", far enough that arriving players see a whale rather than a wall.
  cx: -4, cz: -17, rx: 18, rz: 15,
  y0: 9.5, ya: 4.7,               // mid depth, and how far she rises to surface
  len: 12, wide: 3.0, tall: 2.6,  // half length / half width / half height
};
const LAPS_PER_DAY = DAY_SECONDS / WHALE.period;

// Six seats on her back, in her local frame (+Z is her nose).
const SEATS = [
  [-1.2, 0, 3.4], [1.2, 0, 3.4],
  [-1.25, 0, 0.9], [1.25, 0, 0.9],
  [-1.15, 0, -1.7], [1.15, 0, -1.7],
];

const C = {
  sand: 0xd8c48e,
  sandDark: 0xa8935f,
  shallow: 0x3ea3cf,
  deep: 0x08304e,
  nightDeep: 0x061a30,
  nightShallow: 0x113a60,
  caustic: 0xbfe9ff,
  rock: 0x39697e,
  rockDark: 0x27505f,
  weed: 0x5fa86a,
  weedLit: 0x8fd07a,
  kelp: 0x3f7d55,
  coral: 0xe8657a,
  coralGold: 0xf2b64a,
  coralPurple: 0x9b6bd4,
  cream: 0xfff6e3,
  brass: 0xd9a441,
  brassDark: 0x9c7126,
  glassGlow: 0xffe9a8,
  whale: 0x4f9fd6,
  whaleDark: 0x2f6f9e,
  jelly: 0xa9f0ff,
  jellyCore: 0xf6a8d0,
  ink: 0x2d2417,
};

// ---------------------------------------------------------------- shaders ---

// Domain-warped ridged sines: three cheap folds give the thin bright filaments
// real caustics have, with no texture and no derivatives.
const GLSL_CAUSTIC = `
float caust(vec2 p, float t) {
  vec2 q = p;
  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float k = float(i) * 0.7 + 1.0;
    q += vec2(sin(q.y * 1.7 + t * 0.85 / k), cos(q.x * 1.55 - t * 0.62 / k)) * 0.62;
    acc += 1.0 - abs(sin(q.x * 1.15 + q.y * 0.95 + t * 0.35));
  }
  // a cube, not a fifth power: any higher and the filaments thin out to
  // nothing on a 100-unit seabed
  return pow(clamp(acc * 0.3333, 0.0, 1.0), 3.0);
}
`;

// NOTE on the two #includes every fragment shader below ends with: three only
// appends tone mapping and the output colour-space conversion to its OWN
// materials. A ShaderMaterial that writes gl_FragColor and stops hands linear
// values to an sRGB framebuffer, which renders every custom surface visibly
// darker than the makeToon geometry sitting next to it.

// Exponential depth fog, hand-rolled so these materials need no three chunks.
const GLSL_FOG = `
uniform vec3 uFog;
uniform float uFogDensity;
vec3 fogged(vec3 col, float dist) {
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  return mix(col, uFog, clamp(f, 0.0, 1.0));
}
`;

const VS_WORLD = `
varying vec3 vW;
varying vec3 vN;
varying float vDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FS_SEABED = `
uniform vec3 uSand, uDeep, uCaustCol, uBio, uWhale;
uniform float uTime, uCaust, uNight;
varying vec3 vW;
varying vec3 vN;
varying float vDist;
${GLSL_FOG}
${GLSL_CAUSTIC}
void main() {
  // three-step toon ramp off a fixed "sun through the surface" direction
  float nl = dot(normalize(vN), normalize(vec3(0.22, 1.0, 0.12)));
  float ramp = nl < 0.55 ? 0.66 : (nl < 0.86 ? 0.85 : 1.0);
  vec3 col = uSand * ramp;

  // depth grade: the floor drinks the deep colour, exponentially
  float d = clamp((${SURFACE_GLSL} - vW.y) / ${SURFACE_GLSL}, 0.0, 1.0);
  col = mix(col, uDeep, 0.2 + 0.42 * d * d);

  // Big Blue's shadow sliding over the sand sells her size more than she does
  float sh = 0.55 * (1.0 - smoothstep(3.0, 13.0, length(vW.xz - uWhale.xz)));

  // two octaves so the caustic net never reads as a tiling pattern
  float c = caust(vW.xz * 0.16, uTime * 0.6) * 0.95
          + caust(vW.xz * 0.31 + 11.0, uTime * 0.42) * 0.5;
  c *= 0.6 + 0.4 * sin(vW.x * 0.06 + uTime * 0.11) * cos(vW.z * 0.05 - uTime * 0.08);
  col *= 1.0 - sh * 0.6;
  col += uCaustCol * c * uCaust * (1.0 - sh);

  // night: the caustics are gone, the sand answers with bioluminescent grit
  col += uBio * pow(caust(vW.xz * 0.62 + 30.0, uTime * 0.22), 1.6) * uNight;

  gl_FragColor = vec4(fogged(col, vDist), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// The far water: a shell whose gradient matches the fog colour at every depth,
// so there is no seam where geometry fades out and the horizon begins.
const FS_SHELL = `
uniform vec3 uShallow, uDeep;
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying float vDist;
void main() {
  // same curve the room uses for the fog colour, so the horizon has no seam
  float h = clamp(vW.y / ${SURFACE_GLSL}, 0.0, 1.0);
  vec3 col = mix(uDeep, uShallow, 0.34 + 0.5 * h);
  col += uShallow * 0.05 * sin(vW.y * 0.35 + uTime * 0.25 + vW.x * 0.02);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// The underside of the sea, seen from below (BackSide): rippling silver with a
// smeared sun glare. Never seen from above, so the camera can never break it.
const FS_SURFACE = `
uniform vec3 uBright, uDeep;
uniform float uTime, uDay;
varying vec3 vW;
varying vec3 vN;
varying float vDist;
${GLSL_FOG}
${GLSL_CAUSTIC}
void main() {
  vec2 p = vW.xz;
  float c = caust(p * 0.085, uTime * 0.32);
  float ripple = 0.5 + 0.5 * sin(p.x * 0.32 + uTime * 0.7) * cos(p.y * 0.29 - uTime * 0.55);
  vec3 col = mix(uDeep, uBright, clamp(c * 0.95 + ripple * 0.18, 0.0, 1.0));
  float glare = exp(-length(p - vec2(-6.0, -10.0)) * 0.045);
  col += uBright * glare * 0.6 * uDay;
  gl_FragColor = vec4(fogged(col, vDist), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// God rays: tapered quads that billboard around their own vertical axis, which
// is what a cone from the surface actually looks like from any angle, for one
// draw call and no per-frame CPU work. Additive and depth-faded.
const VS_RAY = `
attribute vec3 aBase;
attribute vec3 aParam;   // half width at the top, length, seed
attribute vec2 aCorner;  // x in -1..1 across, y in 0..1 down
varying vec2 vUv;
varying float vSeed;
varying float vDist;
void main() {
  vec3 axis = vec3(0.0, 1.0, 0.0);
  vec3 centre = aBase - axis * (aParam.y * aCorner.y);
  vec3 toCam = cameraPosition - centre;
  vec3 right = normalize(cross(axis, toCam) + vec3(1e-5, 0.0, 0.0));
  float w = aParam.x * mix(1.0, 2.6, aCorner.y);
  vec3 wp = centre + right * (aCorner.x * w);
  vUv = vec2(aCorner.x * 0.5 + 0.5, aCorner.y);
  vSeed = aParam.z;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FS_RAY = `
uniform vec3 uRayColor;
uniform float uTime, uRay, uFogDensity;
varying vec2 vUv;
varying float vSeed;
varying float vDist;
void main() {
  float x = abs(vUv.x * 2.0 - 1.0);
  // the shaft stays bright most of the way down, then fades out: the play
  // camera lives at mid depth, and a top-weighted falloff hid the whole effect
  float a = pow(1.0 - x, 2.2) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
  a *= 0.55 + 0.45 * sin(uTime * 0.55 + vSeed * 6.283);
  a *= uRay * exp(-uFogDensity * uFogDensity * vDist * vDist);
  gl_FragColor = vec4(uRayColor * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Seagrass: vertex displacement, per-instance phase and height.
const VS_GRASS = `
uniform float uTime;
attribute float aPhase;
attribute float aTall;
varying float vY;
varying float vDist;
void main() {
  vec3 p = position;
  float k = pow(clamp(uv.y, 0.0, 1.0), 1.7);
  float ph = aPhase + uTime * 1.15;
  p.x += sin(ph) * k * 0.6 * aTall;
  p.z += cos(ph * 0.83) * k * 0.38 * aTall;
  vY = uv.y;
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FS_GRASS = `
uniform vec3 uLow, uHigh;
uniform float uTime, uNight, uGlow;
varying float vY;
varying float vDist;
${GLSL_FOG}
void main() {
  float step2 = vY < 0.45 ? 0.66 : (vY < 0.8 ? 0.88 : 1.06);
  vec3 col = mix(uLow, uHigh, vY * vY) * step2;
  col += uHigh * uGlow * uNight * pow(vY, 3.0) * 0.6;
  gl_FragColor = vec4(fogged(col, vDist), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Bubbles + plankton share one point shader; alpha comes from an attribute the
// CPU writes for bubbles and from swim speed / depth for plankton.
const VS_POINTS = `
attribute float aSize;
attribute float aLife;
uniform float uPixel;
uniform vec3 uPlayer;
uniform float uSpeed, uNight, uWake;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (uPixel / max(1.0, -mv.z));
  float a = aLife;
  if (uWake > 0.5) {
    float d = distance(position, uPlayer);
    float wake = 1.0 - smoothstep(1.0, 9.0, d);
    a *= (0.1 + 0.9 * uNight) * (0.22 + 0.9 * wake * uSpeed);
  }
  vA = clamp(a, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FS_POINTS = `
uniform vec3 uColor;
varying float vA;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5 || vA <= 0.003) discard;
  float a = (1.0 - smoothstep(0.08, 0.5, d)) * vA;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------- helpers ---

/* THE SWIM CAMERA (follow mode only; static mode is untouched).
 *
 * The engine's follow camera is built for walking: a fixed world offset behind
 * and high above the player, aimed at a point `lookHeight` above the SMOOTHED
 * player position. Down here that read as a low, near-level shot that lost the
 * swimmer the moment she climbed or dived (the look point lags, so a fast
 * ascent slid her off the top of the frame) and left every click ray skimming
 * the seabed at a few degrees, where two pixels of cursor swing the hit point
 * through tens of units of depth.
 *
 * The room fixes both WITHOUT touching engine.js, because `_tick` reads
 * `camTarget`, `camCfg.offset` and `camCfg.lookHeight` fresh every frame and
 * AFTER `room.update()`:
 *  - we write camTarget = the avatar's ACTUAL position, so the engine's lerp
 *    toward it is a no-op and the camera looks exactly at her, always;
 *  - we write camCfg.offset every frame, so the vantage can orbit;
 *  - the engine's own `camera.position.lerp(camTarget + offset)` stays the
 *    only thing that moves the camera: that is the soft lag, on all 3 axes.
 *
 * The vantage sits behind whatever you are travelling on, but it does NOT
 * chase every turn: it holds still (which is what makes the static camera
 * comfortable) until your heading swings more than `reframe` away from it,
 * then eases around behind you at no more than `slew` rad/s. So swimming into
 * open water never moves it, and turning back toward the bell does.
 */
const CAM = {
  swimH: 5.2, swimD: 15.4, swimLook: 0.9,  // back, and nearly level with her
  rideH: 6.6, rideD: 16.0, rideLook: 1.1,  // riding: six capys have to fit
  slew: 1.0,                               // rad/s the vantage may orbit
  reframe: 1.55,                           // heading change that earns a swing
  ease: 1.4,                               // 1/s swim <-> ride blend
  step: 0.55,                              // rad per arrow-key look-around
};

// Click-to-swim. REACH is how far one click takes you; STEER_R is the radius of
// the sphere the click ray is projected onto when there is nothing solid to aim
// at, and so how sharply one click can turn you (smaller = sharper).
const REACH = 20;
const STEER_R = 10;
const NUDGE = 2.6;               // wheel / arrow-key rise and sink, per press

const _dummy = new THREE.Object3D();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _seat = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _mat = new THREE.Matrix4();
const _col = new THREE.Color();

/** Shortest signed angle from a to b, in (-PI, PI]. */
function angleDelta(a, b) {
  return ((((b - a) % TAU) + Math.PI * 3) % TAU) - Math.PI;
}

/** Deterministic scatter: the room looks the same on every visit. */
function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Merge parts into ONE geometry with a baked colour attribute (same trick as
 * avatar.js): the whale, the turtle and the bell are each one draw call.
 * parts: [{ g, color:[r,g,b], pos?, scale?, rot? }]
 */
function mergeParts(parts) {
  let vTotal = 0;
  let iTotal = 0;
  const prep = [];
  for (const p of parts) {
    const g = p.g.clone();
    const s = p.scale;
    _v.set(p.pos?.[0] || 0, p.pos?.[1] || 0, p.pos?.[2] || 0);
    _v2.set(
      typeof s === 'number' ? s : (s?.[0] ?? 1),
      typeof s === 'number' ? s : (s?.[1] ?? 1),
      typeof s === 'number' ? s : (s?.[2] ?? 1),
    );
    _mat.compose(_v, new THREE.Quaternion().setFromEuler(
      new THREE.Euler(p.rot?.[0] || 0, p.rot?.[1] || 0, p.rot?.[2] || 0),
    ), _v2);
    g.applyMatrix4(_mat);
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
    prep.push([g, p.color || [1, 1, 1]]);
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const [g, tint] of prep) {
    const P = g.attributes.position;
    pos.set(P.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    for (let i = 0; i < P.count; i++) {
      col[(vo + i) * 3] = tint[0];
      col[(vo + i) * 3 + 1] = tint[1];
      col[(vo + i) * 3 + 2] = tint[2];
    }
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo;
      io += a.length;
    } else {
      for (let i = 0; i < P.count; i++) idx[io + i] = vo + i;
      io += P.count;
    }
    vo += P.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Hex -> [r,g,b] for mergeParts tints. */
function rgb(hex) {
  _col.setHex(hex);
  return [_col.r, _col.g, _col.b];
}

/** Gentle dunes so the seabed is not a billiard table. */
function duneHeight(x, z) {
  return Math.sin(x * 0.09) * Math.cos(z * 0.075) * 0.55
    + Math.sin(x * 0.031 + z * 0.043) * 0.75
    - Math.max(0, 1.4 - Math.hypot(x, z) * 0.06) * 0.4;
}

/** Big Blue's radius profile: blunt rostrum, big shoulders, long peduncle. */
function whaleR(t) {
  const head = Math.pow(Math.min(1, Math.max(0, t) / 0.17), 0.55);
  const taper = 1 - 0.87 * Math.pow(Math.max(0, (t - 0.48) / 0.52), 1.7);
  return (0.3 + 0.7 * head) * taper;
}

/**
 * Map a point on the unit sphere onto Big Blue's hide. Her body is a sphere run
 * through this exact transform, so anything placed with it (eyes, jaw, the
 * blowhole, barnacles) lands ON her skin instead of floating or sinking in.
 */
function whalePoint(sx, sy, sz) {
  const r = whaleR((1 - sz) * 0.5);
  let ny = sy * r * WHALE.tall;
  if (ny < 0) ny *= 0.8;                                  // flat belly
  ny += Math.pow(Math.max(0, sy), 3) * r * 0.35;          // dorsal ridge
  return [sx * r * WHALE.wide, ny, sz * WHALE.len];
}

/** A point on her flank at latitude `sy` and lengthwise `sz`, on side `side`. */
function whaleFlank(side, sy, sz) {
  const k = Math.max(0, 1 - sy * sy - sz * sz);
  return whalePoint(side * Math.sqrt(k), sy, sz);
}

// ------------------------------------------------------------ fish schools ---

/**
 * One instanced school. Separation / alignment / cohesion, plus containment in
 * a home ellipsoid and a shove away from the player, so swimming into a school
 * scatters it. One draw call, no allocation in update().
 */
class School {
  constructor(geo, mat, n, home, spread, speed, rng) {
    this.n = n;
    this.home = home;              // [x, y, z]
    this.spread = spread;          // [rx, ry, rz]
    this.speed = speed;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.sc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = home[0] + (rng() - 0.5) * spread[0];
      this.py[i] = home[1] + (rng() - 0.5) * spread[1];
      this.pz[i] = home[2] + (rng() - 0.5) * spread[2];
      const a = rng() * TAU;
      this.vx[i] = Math.sin(a) * speed;
      this.vy[i] = (rng() - 0.5) * 0.4;
      this.vz[i] = Math.cos(a) * speed;
      this.sc[i] = 0.8 + rng() * 0.5;
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  update(dt, t, player) {
    const { n, px, py, pz, vx, vy, vz, home, spread } = this;
    let cx = 0; let cy = 0; let cz = 0;
    let ax = 0; let ay = 0; let az = 0;
    for (let i = 0; i < n; i++) {
      cx += px[i]; cy += py[i]; cz += pz[i];
      ax += vx[i]; ay += vy[i]; az += vz[i];
    }
    cx /= n; cy /= n; cz /= n;
    ax /= n; ay /= n; az /= n;

    const k = Math.min(1, dt * 4);
    for (let i = 0; i < n; i++) {
      // cohesion + alignment
      let fx = (cx - px[i]) * 0.55 + (ax - vx[i]) * 0.9;
      let fy = (cy - py[i]) * 0.55 + (ay - vy[i]) * 0.9;
      let fz = (cz - pz[i]) * 0.55 + (az - vz[i]) * 0.9;
      // separation
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = px[i] - px[j];
        const dy = py[i] - py[j];
        const dz = pz[i] - pz[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1.4 && d2 > 1e-5) {
          const w = (1.4 - d2) * 2.6;
          fx += dx * w; fy += dy * w; fz += dz * w;
        }
      }
      // containment: an ellipsoid the school calls home
      fx += ((home[0] - px[i]) / spread[0]) * 3.2;
      fy += ((home[1] - py[i]) / spread[1]) * 3.6;
      fz += ((home[2] - pz[i]) / spread[2]) * 3.2;
      if (py[i] < 2.2) fy += (2.2 - py[i]) * 4;
      // scatter around the swimmer
      const dx = px[i] - player.x;
      const dy = py[i] - player.y;
      const dz = pz[i] - player.z;
      const pd = dx * dx + dy * dy + dz * dz;
      if (pd < 20 && pd > 1e-4) {
        const w = (20 - pd) * 0.55;
        fx += dx * w; fy += dy * w; fz += dz * w;
      }
      // wander
      fx += Math.sin(t * 1.7 + i) * 0.5;
      fy += Math.sin(t * 1.1 + i * 2.3) * 0.35;

      vx[i] += fx * k * 0.5;
      vy[i] += fy * k * 0.5;
      vz[i] += fz * k * 0.5;
      const sp = Math.hypot(vx[i], vy[i], vz[i]) || 1e-4;
      const want = Math.min(Math.max(sp, this.speed * 0.7), this.speed * 1.5);
      const m = want / sp;
      vx[i] *= m; vy[i] *= m; vz[i] *= m;
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;

      _dummy.position.set(px[i], py[i], pz[i]);
      _v.set(px[i] + vx[i], py[i] + vy[i], pz[i] + vz[i]);
      _dummy.lookAt(_v);
      _dummy.rotateY(Math.sin(t * 9 + i) * 0.16); // tail wiggle
      const s = this.sc[i];
      _dummy.scale.set(s, s, s);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ================================================================== ROOM ====

export class DriftRoom extends Room {
  id = 'drift';
  name = 'The Drift';

  build(scene, game) {
    this._game = game;
    this._t = 0;
    this._day = 0.25;            // 0 dawn .5 dusk .75 midnight
    this._dayTarget = 0.25;
    this._night = 0;
    this._clockSeen = false;
    this._shaders = [];          // ShaderMaterials: NOT in the toon cache
    this._geos = [];             // geometry created for instancing/merges
    this._riderIds = [];
    this._riding = false;
    this._mountPending = false;
    this._needSpawn = true;
    this._whalePos = new THREE.Vector3(0, WHALE.y0, 0);
    this._spout = new THREE.Vector3();
    this._spouting = false;
    this._fallbackPos = new THREE.Vector3(0, 8, 0);
    this._songAt = -99;
    this._bubbleAt = 0;
    this._offs = [];
    this._scene = scene;
    // swim camera: where the vantage sits around her, as an azimuth (0 = due
    // +Z, which is the arrival shot), and where it is easing to
    this._camAz = 0;
    this._camGoal = 0;
    this._camH = CAM.swimH;
    this._camD = CAM.swimD;
    this._rideSpin = 0;      // look-around while riding, relative to her nose
    this._markT = 1;
    this._nudgeAt = -99;

    const rng = mulberry32(20260806);

    // ---- water, fog, light -----------------------------------------------
    this._fogColor = new THREE.Color(C.shallow);
    scene.background = this._fogColor.clone();
    scene.fog = new THREE.FogExp2(this._fogColor.clone(), FOG_DENSITY);
    this._shallow = new THREE.Color(C.shallow);
    this._deep = new THREE.Color(C.deep);

    const hemi = new THREE.HemisphereLight(0x9fe0ff, 0x3a7f9c, 1.05);
    scene.add(hemi);
    this._hemi = hemi;
    const sun = new THREE.DirectionalLight(0xdff3ff, 0.95);
    sun.position.set(-9, 26, -6);
    scene.add(sun);
    this._sun = sun;
    // one warm point inside the dive bell, the only artificial light down here
    const lamp = new THREE.PointLight(C.glassGlow, 1.5, 16, 2);
    lamp.position.set(BELL.x, BELL_MID, BELL.z);
    scene.add(lamp);
    this._lamp = lamp;

    this._buildSeabed(scene);
    this._buildShell(scene);
    this._buildSurface(scene);
    this._buildGodRays(scene, rng);
    this._buildReef(scene, rng);
    this._buildGrass(scene, rng);
    this._buildArch(scene);
    this._buildBell(scene);
    this._buildSchools(scene, rng);
    this._buildJellies(scene, rng);
    this._buildTurtle(scene);
    this._buildWhale(scene);
    this._buildParticles(scene, rng);

    // ---- room contract ----------------------------------------------------
    // EMPTY on purpose: there is no floor here. The engine's click-to-move and
    // ground snap both go quiet, remote y is interpolated from the wire, and
    // this room drives its own SwimController instead.
    this.groundMeshes = [];
    this.obstacles = [];
    this.spawnPoints = {
      default: new THREE.Vector3(0, 4.8, 5),
      from_beach: new THREE.Vector3(0, 4.8, 5),
    };
    // Nearly level, unlike every other room: the interest here is in the water
    // column (whale, rays, jellies, the surface), not on the floor, and a
    // downward-tilted 3/4 view cropped Big Blue clean out of the arrival shot.
    // update() re-authors this every frame from CAM (see the swim camera note).
    this.cameraHint = {
      offset: new THREE.Vector3(0, CAM.swimH, CAM.swimD),
      lookHeight: CAM.swimLook,
    };
    this.staticCamera = {
      // Behind the bell after all, but off its shoulder. Standing in FRONT of it
      // (z = 20) did keep the cable off the lens, at the price of putting the
      // only exit in the room BEHIND the camera: the prompt projected to NDC
      // -14, so from the whole-room view the way home did not exist. The cable
      // is only a problem when it is centred, and the fix for that is x, not z:
      // 9 east drops the bell and its cable into the left third and leaves the
      // sunken arch centre and Big Blue's lap (cx -4, cz -17, rx 18, rz 15)
      // across the upper frame. Exit prompt 410px, capy ~36px, worst NDC 0.52.
      position: new THREE.Vector3(9, 12.5, 38),
      lookAt: new THREE.Vector3(-2, 4, -6),
    };
    this._exit = {
      id: 'exit-beach',
      position: new THREE.Vector3(BELL.x, BELL_MID, BELL.z),
      radius: 3.4,
      label: 'Ride the dive bell up',
      action: (g) => g.goToRoom('beach', 'drift'),
    };
    this.hotspots.push(this._exit);

    // ---- swimming ---------------------------------------------------------
    const eng = game.engine;
    this._avatar = eng?.playerAvatar || null;
    if (eng?.controller) eng.controller.enabled = false;
    if (this._avatar) {
      this._swim = new SwimController(this._avatar, {
        bounds: new THREE.Box3(
          new THREE.Vector3(...BOUND_MIN), new THREE.Vector3(...BOUND_MAX),
        ),
        floorAt: duneHeight,   // hug the sand instead of a flat box bottom
      });
    }
    this._ray = new THREE.Raycaster();
    this._onPointer = (e) => this._pointer(e);
    this._canvas = eng?.canvas || null;
    this._canvas?.addEventListener('pointerdown', this._onPointer);
    // Explicit rise/sink. The click already steers in 3D, but a near-level
    // camera makes "straight down" a fiddly click, and this is how you park at
    // the bell's hatch or settle onto the sand. 'w' and 'd' are taken globally
    // (wave, dance), so the keys are the arrows.
    this._onWheel = (e) => {
      if (!this._canNudge()) return;
      e.preventDefault();
      this._nudge(e.deltaY > 0 ? -NUDGE : NUDGE);
    };
    this._canvas?.addEventListener('wheel', this._onWheel, { passive: false });
    this._onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (this._game?.activeMinigame || eng?.paused) return;
      const k = e.key;
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        if (!this._canNudge()) return;
        e.preventDefault();
        this._nudge(k === 'ArrowUp' ? NUDGE : -NUDGE);
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        // look around: the camera swings itself when you double back, but the
        // dive bell starts the room BEHIND you, and nobody should have to swim
        // a lap to find the way home
        e.preventDefault();
        this._spin(k === 'ArrowLeft' ? -CAM.step : CAM.step);
      }
    };
    addEventListener('keydown', this._onKey);

    // where the last click landed: the only readout of a swim target, since
    // there is no floor for the engine's own click ring to lie on
    const markG = new THREE.RingGeometry(0.55, 0.78, 22);
    this._mark = new THREE.Mesh(markG, new THREE.MeshBasicMaterial({
      color: 0xcdf3ff, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    this._mark.renderOrder = 6;
    this._mark.visible = false;
    scene.add(this._mark);

    // The daily message in a bottle is server-spawned; if no frame arrives we
    // simply never show one.
    this._offs.push(game.events.on('bottle', (m) => this._onBottle(m)));
    this._offs.push(game.events.on('bottle-found', (m) => this._onBottleFound(m)));
  }

  // ---------------------------------------------------------------- pieces --

  _buildSeabed(scene) {
    const g = new THREE.PlaneGeometry(FLOOR_R * 2, FLOOR_R * 2, 54, 54);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setY(i, duneHeight(p.getX(i), p.getZ(i)));
    }
    g.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS_WORLD,
      fragmentShader: FS_SEABED,
      uniforms: {
        uSand: { value: new THREE.Color(C.sand) },
        uDeep: { value: new THREE.Color(C.deep) },
        uCaustCol: { value: new THREE.Color(C.caustic) },
        uBio: { value: new THREE.Color(0x2f7fa8) },
        uWhale: { value: new THREE.Vector3() },
        uFog: { value: this._fogColor },
        uFogDensity: { value: FOG_DENSITY },
        uTime: { value: 0 },
        uCaust: { value: 0.85 },
        uNight: { value: 0 },
      },
    });
    this._shaders.push(mat);
    this._seabedMat = mat;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'seabed';
    scene.add(mesh);
    this._seabed = mesh;
  }

  _buildShell(scene) {
    const g = new THREE.SphereGeometry(78, 26, 18);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS_WORLD,
      fragmentShader: FS_SHELL,
      side: THREE.BackSide,
      uniforms: {
        uShallow: { value: new THREE.Color(C.shallow) },
        uDeep: { value: new THREE.Color(C.deep) },
        uTime: { value: 0 },
      },
    });
    this._shaders.push(mat);
    this._shellMat = mat;
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.y = 10;
    scene.add(mesh);
  }

  _buildSurface(scene) {
    const g = new THREE.PlaneGeometry(150, 150, 1, 1);
    g.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS_WORLD,
      fragmentShader: FS_SURFACE,
      side: THREE.BackSide, // only ever seen from below
      uniforms: {
        uBright: { value: new THREE.Color(0xcdeaf8) },
        uDeep: { value: new THREE.Color(C.shallow) },
        uFog: { value: this._fogColor },
        uFogDensity: { value: FOG_DENSITY },
        uTime: { value: 0 },
        uDay: { value: 1 },
      },
    });
    this._shaders.push(mat);
    this._surfaceMat = mat;
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.y = SURFACE_Y;
    scene.add(mesh);
  }

  _buildGodRays(scene, rng) {
    const N = 11;
    const pos = new Float32Array(N * 4 * 3);
    const base = new Float32Array(N * 4 * 3);
    const param = new Float32Array(N * 4 * 3);
    const corner = new Float32Array(N * 4 * 2);
    const idx = new Uint16Array(N * 6);
    for (let i = 0; i < N; i++) {
      const bx = (rng() - 0.5) * 54 - 4;
      const bz = (rng() - 0.5) * 58 - 6;
      const hw = 2.2 + rng() * 2.6;
      const len = 18 + rng() * 6;
      const seed = rng();
      const corners = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c);
        base[o * 3] = bx; base[o * 3 + 1] = SURFACE_Y - 0.4; base[o * 3 + 2] = bz;
        param[o * 3] = hw; param[o * 3 + 1] = len; param[o * 3 + 2] = seed;
        corner[o * 2] = corners[c][0]; corner[o * 2 + 1] = corners[c][1];
        pos[o * 3] = bx; pos[o * 3 + 1] = SURFACE_Y - 0.4; pos[o * 3 + 2] = bz;
      }
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aParam', new THREE.BufferAttribute(param, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS_RAY,
      fragmentShader: FS_RAY,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uRayColor: { value: new THREE.Color(0xffeecb) },
        uTime: { value: 0 },
        uRay: { value: 0.5 },
        uFogDensity: { value: FOG_DENSITY * 0.62 },
      },
    });
    this._shaders.push(mat);
    this._rayMat = mat;
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false; // positions are computed in the vertex shader
    mesh.renderOrder = 2;
    scene.add(mesh);
  }

  /** Boulders, coral fans, brain coral, anemones: four instanced draws. */
  _buildReef(scene, rng) {
    const place = (geo, mat, n, fn) => {
      const im = new THREE.InstancedMesh(geo, mat, n);
      for (let i = 0; i < n; i++) {
        fn(i, rng);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      scene.add(im);
      this._geos.push(geo);
      return im;
    };
    // keep the arrival corridor and the arch clear
    const spot = (minR, maxR) => {
      for (let tries = 0; tries < 14; tries++) {
        const a = rng() * TAU;
        const r = minR + rng() * (maxR - minR);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (Math.hypot(x - BELL.x, z - BELL.z) < 6) continue;
        return [x, z];
      }
      return [minR, minR];
    };

    const rockG = new THREE.IcosahedronGeometry(1, 0);
    const rocks = place(rockG, makeToon(C.rock), 30, (i) => {
      const [x, z] = spot(6, 34);
      const s = 0.9 + rng() * 2.6;
      _dummy.position.set(x, duneHeight(x, z) + s * 0.35, z);
      _dummy.scale.set(s, s * (0.6 + rng() * 0.5), s * (0.8 + rng() * 0.5));
      _dummy.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
    });
    this._rocks = rocks;

    // sea fans: three nested arcs on a stub of trunk, so they read as a fan
    // from the play camera instead of a croquet hoop
    const fanParts = [
      { g: new THREE.CylinderGeometry(0.08, 0.13, 0.4, 5), color: rgb(C.coral), pos: [0, -0.15, 0] },
    ];
    for (let i = 0; i < 3; i++) {
      const r = 0.4 + i * 0.24;
      fanParts.push({
        g: new THREE.TorusGeometry(r, 0.07 - i * 0.012, 4, 8, Math.PI),
        color: i === 2 ? rgb(0xf4909f) : rgb(C.coral),
        pos: [0, 0.05, 0],
      });
    }
    for (let i = 0; i < 4; i++) {
      const a = Math.PI * (0.18 + i * 0.215);
      fanParts.push({
        g: new THREE.CylinderGeometry(0.045, 0.03, 0.9, 4),
        color: rgb(C.coral),
        pos: [Math.cos(a) * 0.44, 0.05 + Math.sin(a) * 0.44, 0],
        rot: [0, 0, a - Math.PI / 2],
      });
    }
    const fanG = mergeParts(fanParts);
    place(fanG, makeToon(0xffffff, { vertexColors: true }), 24, () => {
      const [x, z] = spot(7, 30);
      _dummy.position.set(x, duneHeight(x, z) + 0.3, z);
      const s = 0.8 + rng() * 1.6;
      _dummy.scale.set(s, s, s);
      _dummy.rotation.set(0.16 - rng() * 0.32, rng() * TAU, 0);
    });

    const brainG = new THREE.SphereGeometry(0.7, 9, 6);
    place(brainG, makeToon(C.coralGold), 18, () => {
      const [x, z] = spot(6, 28);
      _dummy.position.set(x, duneHeight(x, z) + 0.24, z);
      const s = 0.6 + rng() * 1.2;
      _dummy.scale.set(s, s * 0.55, s);
      _dummy.rotation.set(0, rng() * TAU, 0);
    });

    // anemones: a squat stalk with a ring of pale tentacle tips
    const anemParts = [
      { g: new THREE.CylinderGeometry(0.3, 0.42, 0.7, 8), color: rgb(C.coralPurple) },
      { g: new THREE.SphereGeometry(0.32, 8, 6), color: rgb(0xc9a7f0), pos: [0, 0.36, 0], scale: [1, 0.6, 1] },
    ];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      anemParts.push({
        g: new THREE.ConeGeometry(0.07, 0.5, 4),
        color: rgb(0xf3d9ff),
        pos: [Math.sin(a) * 0.27, 0.55, Math.cos(a) * 0.27],
        rot: [Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5],
      });
    }
    const anemG = mergeParts(anemParts);
    place(anemG, makeToon(0xffffff, { vertexColors: true }), 22, () => {
      const [x, z] = spot(6, 26);
      _dummy.position.set(x, duneHeight(x, z) + 0.3, z);
      const s = 0.55 + rng() * 1.1;
      _dummy.scale.set(s, s, s);
      _dummy.rotation.set(0, rng() * TAU, 0);
    });

    // shells + starfish scattered on the sand, the small warm punctuation
    const shellG = mergeParts([
      { g: new THREE.SphereGeometry(0.2, 7, 5), color: rgb(C.cream), scale: [1, 0.45, 1.2] },
      { g: new THREE.TorusGeometry(0.14, 0.035, 3, 7), color: rgb(C.coral), pos: [0, 0.07, 0], rot: [Math.PI / 2, 0, 0] },
    ]);
    place(shellG, makeToon(0xffffff, { vertexColors: true }), 26, () => {
      const [x, z] = spot(5, 30);
      _dummy.position.set(x, duneHeight(x, z) + 0.06, z);
      _dummy.scale.set(1, 1, 1);
      _dummy.rotation.set(0, rng() * TAU, 0);
    });
  }

  /** Seagrass + kelp: two instanced draws, swayed in the vertex shader. */
  _buildGrass(scene, rng) {
    const make = (count, blade, low, high, glow, tallRange, area) => {
      const g = blade;
      const phase = new Float32Array(count);
      const tall = new Float32Array(count);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VS_GRASS,
        fragmentShader: FS_GRASS,
        side: THREE.DoubleSide,
        uniforms: {
          uLow: { value: new THREE.Color(low) },
          uHigh: { value: new THREE.Color(high) },
          uFog: { value: this._fogColor },
          uFogDensity: { value: FOG_DENSITY },
          uTime: { value: 0 },
          uNight: { value: 0 },
          uGlow: { value: glow },
        },
      });
      // clumped, not scattered: an even sprinkle of blades reads as a field of
      // celery, while tufts of 6-9 read as weed growing out of the reef
      const im = new THREE.InstancedMesh(g, mat, count);
      const perClump = 7;
      let cx = 0;
      let cz = 0;
      for (let i = 0; i < count; i++) {
        if (i % perClump === 0) {
          const a = rng() * TAU;
          const rad = area[0] + rng() * (area[1] - area[0]);
          cx = Math.cos(a) * rad;
          cz = Math.sin(a) * rad;
        }
        const x = cx + (rng() - 0.5) * 2.4;
        const z = cz + (rng() - 0.5) * 2.4;
        const s = tallRange[0] + rng() * (tallRange[1] - tallRange[0]);
        _dummy.position.set(x, duneHeight(x, z) - 0.1, z);
        _dummy.scale.set(0.7 + rng() * 0.5, s, 1);
        _dummy.rotation.set((rng() - 0.5) * 0.3, rng() * TAU, (rng() - 0.5) * 0.28);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
        phase[i] = rng() * TAU;
        tall[i] = s * 0.45;
      }
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
      g.setAttribute('aTall', new THREE.InstancedBufferAttribute(tall, 1));
      this._shaders.push(mat);
      this._geos.push(g);
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      scene.add(im);
      return mat;
    };

    const bladeG = new THREE.PlaneGeometry(0.26, 2.0, 1, 5);
    bladeG.translate(0, 1.0, 0);
    this._grassMat = make(140, bladeG, 0x1f5c3c, C.weed, 0.5, [0.7, 1.4], [6, 30]);

    const kelpG = new THREE.PlaneGeometry(0.62, 5.2, 1, 7);
    kelpG.translate(0, 2.6, 0);
    this._kelpMat = make(42, kelpG, 0x14442f, 0x4f9e5e, 0.8, [0.9, 1.6], [12, 30]);
  }

  /** The sunken arch: the landmark the camera looks at from the bell. */
  _buildArch(scene) {
    const parts = [];
    const stone = rgb(0x8fa79b);
    const stoneDark = rgb(0x62786e);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        parts.push({
          g: new THREE.BoxGeometry(1.5, 1.15, 1.5),
          color: i % 2 ? stone : stoneDark,
          pos: [side * 4.2, 0.6 + i * 1.12, 0],
          rot: [0, side * 0.05 * i, 0],
        });
      }
    }
    // the span: five voussoirs around the top
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * (0.08 + (i / 6) * 0.84);
      parts.push({
        g: new THREE.BoxGeometry(1.5, 1.3, 1.5),
        color: i % 2 ? stone : stoneDark,
        pos: [Math.cos(a) * -4.6, 5.6 + Math.sin(a) * 2.6, 0],
        rot: [0, 0, a - Math.PI / 2],
      });
    }
    // a capy face carved on the keystone: the cove was here first
    parts.push({ g: new THREE.SphereGeometry(0.62, 10, 8), color: stone, pos: [0, 8.35, 0.8], scale: [1, 0.9, 0.6] });
    for (const side of [-1, 1]) {
      parts.push({ g: new THREE.SphereGeometry(0.16, 6, 5), color: rgb(0x3d4a44), pos: [side * 0.24, 8.45, 1.18] });
      parts.push({ g: new THREE.SphereGeometry(0.2, 6, 5), color: stoneDark, pos: [side * 0.5, 8.75, 0.7] });
    }
    const g = mergeParts(parts);
    const mesh = new THREE.Mesh(g, makeToon(0xffffff, { vertexColors: true }));
    mesh.position.set(-2, duneHeight(-2, -20), -20);
    mesh.rotation.y = 0.24;
    scene.add(mesh);
    this._geos.push(g);
    this._arch = mesh;

    // glowing runes in the stone, one instanced draw
    const runeG = new THREE.CircleGeometry(0.2, 6);
    const runes = new THREE.InstancedMesh(runeG, makeGlow(0x7fe8d0, { unique: true }), 14);
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      _dummy.position.set(side * 4.2, 1.1 + (i >> 1) * 1.1, 0.78);
      _dummy.rotation.set(0, 0, (i * 1.7) % TAU);
      _dummy.scale.setScalar(0.7 + (i % 3) * 0.2);
      _dummy.updateMatrix();
      runes.setMatrixAt(i, _dummy.matrix);
    }
    runes.instanceMatrix.needsUpdate = true;
    mesh.add(runes);
    this._geos.push(runeG);
    this._runes = runes.material;
  }

  /** The brass dive bell on its shelf: arrival, exit, and the only warm light. */
  _buildBell(scene) {
    const grp = new THREE.Group();
    grp.position.set(BELL.x, duneHeight(BELL.x, BELL.z), BELL.z);
    scene.add(grp);
    this._bellGrp = grp;

    // stone shelf so she does not float on the sand
    const shelfG = mergeParts([
      { g: new THREE.CylinderGeometry(3.1, 3.6, 1.1, 12), color: rgb(C.rock), pos: [0, 0.4, 0] },
      { g: new THREE.CylinderGeometry(2.8, 3.0, 0.3, 12), color: rgb(C.rockDark), pos: [0, 1.0, 0] },
    ]);
    const shelf = new THREE.Mesh(shelfG, makeToon(0xffffff, { vertexColors: true }));
    grp.add(shelf);
    this._geos.push(shelfG);

    const brass = rgb(C.brass);
    const brassDark = rgb(C.brassDark);
    const parts = [
      { g: new THREE.CylinderGeometry(1.25, 1.45, 2.4, 14, 1, true), color: brass, pos: [0, 2.4, 0] },
      { g: new THREE.SphereGeometry(1.25, 14, 8, 0, TAU, 0, Math.PI / 2), color: brass, pos: [0, 3.6, 0] },
      { g: new THREE.TorusGeometry(1.45, 0.14, 5, 14), color: brassDark, pos: [0, 1.24, 0], rot: [Math.PI / 2, 0, 0] },
      { g: new THREE.TorusGeometry(1.3, 0.1, 5, 14), color: brassDark, pos: [0, 2.9, 0], rot: [Math.PI / 2, 0, 0] },
      { g: new THREE.CylinderGeometry(0.16, 0.16, 0.5, 6), color: brassDark, pos: [0, 4.75, 0] },
      { g: new THREE.TorusGeometry(0.35, 0.08, 5, 10), color: brassDark, pos: [0, 5.1, 0] },
    ];
    // three portholes with brass rims
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      parts.push({
        g: new THREE.TorusGeometry(0.42, 0.1, 5, 10),
        color: brassDark,
        pos: [Math.sin(a) * 1.3, 2.6, Math.cos(a) * 1.3],
        rot: [0, a, Math.PI / 2],
      });
    }
    const bellG = mergeParts(parts);
    const bell = new THREE.Mesh(bellG, makeToon(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
    bell.castShadow = false;
    grp.add(bell);
    this._geos.push(bellG);
    this._bellMesh = bell;

    // the lantern glow inside, and the same glass in each porthole
    const glassG = new THREE.SphereGeometry(0.75, 10, 8);
    const glow = new THREE.InstancedMesh(glassG, makeGlow(C.glassGlow, { unique: true }), 4);
    _dummy.scale.setScalar(1);
    _dummy.rotation.set(0, 0, 0);
    _dummy.position.set(0, 2.5, 0);
    _dummy.updateMatrix();
    glow.setMatrixAt(0, _dummy.matrix);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      _dummy.position.set(Math.sin(a) * 1.3, 2.6, Math.cos(a) * 1.3);
      _dummy.scale.setScalar(0.5);
      _dummy.updateMatrix();
      glow.setMatrixAt(i + 1, _dummy.matrix);
    }
    glow.instanceMatrix.needsUpdate = true;
    grp.add(glow);
    this._geos.push(glassG);
    this._bellGlow = glow.material;

    // the cable, running all the way up out of sight
    const cableG = new THREE.CylinderGeometry(0.07, 0.07, SURFACE_Y - 4.4, 5);
    const cable = new THREE.Mesh(cableG, makeToon(0x6b5a3a));
    cable.position.y = 5.1 + (SURFACE_Y - 4.4) / 2;
    grp.add(cable);
    this._geos.push(cableG);

    // a plaque that reads from the play camera (it faces +Z, the camera side)
    const tex = canvasTexture(256, 128, (ctx, w, h) => {
      ctx.fillStyle = '#c8973a';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#7d5a1c';
      ctx.lineWidth = 8;
      ctx.strokeRect(6, 6, w - 12, h - 12);
      ctx.fillStyle = '#3a2a0c';
      ctx.textAlign = 'center';
      ctx.font = 'bold 40px Trebuchet MS, sans-serif';
      ctx.fillText('THE DRIFT', w / 2, 56);
      ctx.font = '22px Trebuchet MS, sans-serif';
      ctx.fillText('mind the whale', w / 2, 92);
    });
    const plaqueG = new THREE.PlaneGeometry(2, 1);
    const plaque = new THREE.Mesh(plaqueG, new THREE.MeshBasicMaterial({ map: tex }));
    plaque.position.set(0, 1.5, 2.55);
    plaque.rotation.x = -0.35;
    grp.add(plaque);
    this._geos.push(plaqueG);
  }

  _buildSchools(scene, rng) {
    // one fish: a stretched body with a tail fin, merged, facing +Z
    const fishG = mergeParts([
      { g: new THREE.OctahedronGeometry(0.5, 0), color: [1, 1, 1], scale: [0.34, 0.42, 1] },
      { g: new THREE.OctahedronGeometry(0.3, 0), color: [0.75, 0.75, 0.8], pos: [0, 0, -0.55], scale: [0.06, 0.6, 0.5] },
      { g: new THREE.OctahedronGeometry(0.22, 0), color: [0.75, 0.75, 0.8], pos: [0, 0.2, 0], scale: [0.05, 0.7, 0.9] },
    ]);
    this._geos.push(fishG);
    const specs = [
      { color: C.coralGold, n: 52, home: [-13, 7.5, -6], spread: [12, 6, 13], speed: 3.1 },
      { color: 0xbfe6f2, n: 46, home: [14, 6, 6], spread: [11, 5, 12], speed: 3.6 },
      { color: C.coral, n: 42, home: [3, 10.5, -22], spread: [13, 5, 10], speed: 2.7 },
    ];
    this._schools = specs.map((s) => {
      const mat = makeToon(s.color, { unique: true, vertexColors: true });
      const school = new School(fishG, mat, s.n, s.home, s.spread, s.speed, rng);
      scene.add(school.mesh);
      return school;
    });
  }

  _buildJellies(scene, rng) {
    const N = 13;
    this._jellies = [];
    const bellG = new THREE.SphereGeometry(0.46, 12, 8, 0, TAU, 0, Math.PI * 0.62);
    const tentG = mergeParts([
      { g: new THREE.CylinderGeometry(0.055, 0.018, 1.5, 4), color: [1, 1, 1], pos: [0.13, -0.75, 0] },
      { g: new THREE.CylinderGeometry(0.055, 0.018, 1.8, 4), color: [1, 1, 1], pos: [-0.1, -0.9, 0.08] },
      { g: new THREE.CylinderGeometry(0.045, 0.015, 1.2, 4), color: [1, 1, 1], pos: [0.02, -0.6, -0.14] },
    ]);
    this._geos.push(bellG, tentG);
    const bellMat = makeGlow(C.jelly, { unique: true });
    bellMat.transparent = true;
    bellMat.opacity = 0.42;
    bellMat.depthWrite = false;
    bellMat.side = THREE.DoubleSide; // the dome is open underneath
    const tentMat = makeGlow(C.jellyCore, { unique: true });
    tentMat.transparent = true;
    tentMat.opacity = 0.3;
    tentMat.depthWrite = false;
    this._jellyMats = [bellMat, tentMat];

    this._jellyBells = new THREE.InstancedMesh(bellG, bellMat, N);
    this._jellyTents = new THREE.InstancedMesh(tentG, tentMat, N);
    for (const im of [this._jellyBells, this._jellyTents]) {
      im.frustumCulled = false;
      im.renderOrder = 3;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(im);
    }
    for (let i = 0; i < N; i++) {
      this._jellies.push({
        x: (rng() - 0.5) * 52,
        y: 2 + rng() * 14,
        z: (rng() - 0.5) * 52,
        s: 0.6 + rng() * 0.9,
        ph: rng() * TAU,
        rise: 0.25 + rng() * 0.4,
        drift: rng() * TAU,
      });
    }
  }

  _buildTurtle(scene) {
    const grp = new THREE.Group();
    scene.add(grp);
    this._turtle = grp;
    const shellCol = rgb(0x6f8f4f);
    const shellDark = rgb(0x4b6435);
    const skin = rgb(0x9db06a);
    const parts = [
      { g: new THREE.SphereGeometry(1, 12, 8), color: shellCol, scale: [1.15, 0.5, 1.45] },
      { g: new THREE.SphereGeometry(1, 10, 7), color: rgb(0xdcd0a8), pos: [0, -0.12, 0], scale: [1.0, 0.28, 1.28] },
      { g: new THREE.SphereGeometry(0.34, 9, 7), color: skin, pos: [0, 0.08, 1.5], scale: [0.9, 0.8, 1.1] },
      { g: new THREE.SphereGeometry(0.09, 6, 5), color: rgb(0x241a12), pos: [0.2, 0.18, 1.75] },
      { g: new THREE.SphereGeometry(0.09, 6, 5), color: rgb(0x241a12), pos: [-0.2, 0.18, 1.75] },
      { g: new THREE.SphereGeometry(0.22, 7, 5), color: skin, pos: [0, -0.1, -1.5], scale: [0.8, 0.6, 1.3] },
    ];
    // scute pattern on the shell
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      parts.push({
        g: new THREE.SphereGeometry(0.26, 6, 5),
        color: shellDark,
        pos: [Math.sin(a) * 0.66, 0.42 - Math.abs(Math.cos(a)) * 0.05, Math.cos(a) * 0.88],
        scale: [1, 0.35, 1],
      });
    }
    const bodyG = mergeParts(parts);
    const body = new THREE.Mesh(bodyG, makeToon(0xffffff, { vertexColors: true }));
    grp.add(body);
    this._geos.push(bodyG);

    const flipG = mergeParts([
      { g: new THREE.SphereGeometry(0.5, 8, 6), color: skin, scale: [1.5, 0.16, 0.55] },
    ]);
    const flips = new THREE.InstancedMesh(flipG, makeToon(0xffffff, { vertexColors: true }), 4);
    flips.frustumCulled = false;
    flips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grp.add(flips);
    this._geos.push(flipG);
    this._turtleFlips = flips;

    // a lazy closed loop through the reef
    this._turtlePath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-16, 6, 12),
      new THREE.Vector3(-22, 9, -8),
      new THREE.Vector3(-6, 11, -24),
      new THREE.Vector3(14, 7.5, -18),
      new THREE.Vector3(22, 5.5, 4),
      new THREE.Vector3(8, 8, 18),
    ], true, 'catmullrom', 0.5);
    this._turtleT = 0;
  }

  /** BIG BLUE. Static parts are one merged draw; fins and fluke animate. */
  _buildWhale(scene) {
    const grp = new THREE.Group();
    scene.add(grp);
    this._whale = grp;

    // ---- body: a sphere re-profiled into a whale, colours baked per vertex
    const bodyG = new THREE.SphereGeometry(1, 24, 16);
    const p = bodyG.attributes.position;
    const cols = new Float32Array(p.count * 3);
    const back = new THREE.Color(C.whale);
    const belly = new THREE.Color(0xf0ead6);
    const dark = new THREE.Color(C.whaleDark);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const t = (1 - z) * 0.5;              // 0 nose .. 1 tail
      const r = whaleR(t);
      const nz = z * WHALE.len;
      let ny = y * r * WHALE.tall;
      if (ny < 0) ny *= 0.8;                // flat belly
      ny += Math.pow(Math.max(0, y), 3) * r * 0.35; // dorsal ridge
      p.setXYZ(i, x * r * WHALE.wide, ny, nz);
      // colour: dark back -> blue flanks -> cream belly with ventral pleats
      const up = y;
      _col.copy(back).lerp(dark, Math.max(0, up) * 0.55);
      const bk = THREE.MathUtils.smoothstep(-up, 0.05, 0.6);
      if (bk > 0) {
        const pleat = t < 0.52 ? 0.9 + 0.1 * Math.sign(Math.sin(nz * 3.4)) : 1;
        _col.lerp(belly, bk).multiplyScalar(pleat);
      }
      cols[i * 3] = _col.r; cols[i * 3 + 1] = _col.g; cols[i * 3 + 2] = _col.b;
    }
    bodyG.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    bodyG.computeVertexNormals();

    // eyes, jaw, blowhole and barnacles ride the same merged draw. Every one is
    // placed with whalePoint/whaleFlank so it sits exactly on her hide.
    const parts = [];
    const eyeCol = rgb(0x1c1a16);
    const shineCol = rgb(0xfffaf0);
    const jawCol = rgb(0x3877a8);
    for (const side of [-1, 1]) {
      const eye = whaleFlank(side, 0.12, 0.58);
      parts.push({ g: new THREE.SphereGeometry(0.32, 8, 6), color: eyeCol, pos: eye, scale: [0.55, 1, 1] });
      parts.push({ g: new THREE.SphereGeometry(0.13, 6, 5), color: shineCol, pos: [eye[0] * 1.07, eye[1] + 0.15, eye[2] + 0.13] });
      // The jaw line: overlapping segments along a fixed latitude. Spaced out
      // in dark ink they read as portholes on a submarine, so they are close
      // together, stretched lengthways and only a shade under her flank.
      for (let i = 0; i < 17; i++) {
        const sz = 0.92 - (i / 16) * 0.56;
        const j = whaleFlank(side, -0.3, sz);
        parts.push({
          g: new THREE.SphereGeometry(0.15, 5, 4),
          color: jawCol,
          pos: [j[0] * 0.985, j[1], j[2]],
          scale: [0.6, 0.5, 2.4],
        });
      }
    }
    // blowhole on the crown, just ahead of the seats
    const blow = whalePoint(0, 0.97, 0.46);
    parts.push({ g: new THREE.SphereGeometry(0.42, 8, 6), color: rgb(0x1c3245), pos: [0, blow[1] - 0.06, blow[2]], scale: [1.1, 0.35, 0.8] });
    // barnacle patches on the rostrum
    const bRng = mulberry32(77);
    for (let i = 0; i < 14; i++) {
      const sz = 0.66 + bRng() * 0.28;
      const sy = 0.15 + bRng() * 0.6;
      const b = whaleFlank(bRng() < 0.5 ? -1 : 1, sy, sz);
      parts.push({
        g: new THREE.SphereGeometry(0.16, 5, 4),
        color: rgb(0xd9d2be),
        pos: [b[0] * 0.95, b[1], b[2]],
        scale: [1, 0.55, 1],
      });
    }
    // dorsal fin, small like a blue whale's
    const dorsal = whalePoint(0, 1, -0.45);
    parts.push({
      g: new THREE.SphereGeometry(0.75, 7, 6),
      color: rgb(C.whaleDark),
      pos: [0, dorsal[1] + 0.25, dorsal[2]],
      scale: [0.16, 0.8, 0.95],
      rot: [0.5, 0, 0],
    });
    const extraG = mergeParts(parts);

    const bodyMesh = new THREE.Mesh(
      mergeTwo(bodyG, extraG),
      makeToon(0xffffff, { unique: true, vertexColors: true }),
    );
    bodyG.dispose();
    extraG.dispose();
    grp.add(bodyMesh);
    this._geos.push(bodyMesh.geometry);
    this._whaleBody = bodyMesh;
    this._whaleMat = bodyMesh.material;

    // ---- fluke: swept, animated
    const flukeG = new THREE.SphereGeometry(1, 12, 8);
    const fp = flukeG.attributes.position;
    for (let i = 0; i < fp.count; i++) {
      const x = fp.getX(i) * 3.9;
      const y = fp.getY(i) * 0.2;
      let z = fp.getZ(i) * 1.15;
      z -= Math.pow(Math.abs(x), 1.7) * 0.12;
      fp.setXYZ(i, x, y + Math.abs(x) * 0.1, z);
    }
    flukeG.computeVertexNormals();
    const fluke = new THREE.Mesh(flukeG, makeToon(C.whaleDark, { unique: true }));
    fluke.position.set(0, 0, -11.4);
    grp.add(fluke);
    this._geos.push(flukeG);
    this._fluke = fluke;
    this._flukeMat = fluke.material;

    // ---- pectoral fins: one instanced draw, matrices updated per frame.
    // They share her body material, so they need a colour attribute of their own.
    const pecBase = new THREE.SphereGeometry(1, 10, 7);
    const pp = pecBase.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const x = pp.getX(i) * 0.42;
      const y = pp.getY(i) * 0.18;
      const z = pp.getZ(i) * 2.5;
      pp.setXYZ(i, x, y, z - Math.pow(Math.abs(z) / 2.5, 2) * 0.5);
    }
    pecBase.computeVertexNormals();
    const pecG = mergeParts([{ g: pecBase, color: rgb(C.whale) }]);
    pecBase.dispose();
    const pecs = new THREE.InstancedMesh(pecG, this._whaleMat, 2);
    pecs.frustumCulled = false;
    pecs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grp.add(pecs);
    this._geos.push(pecG);
    this._pecs = pecs;

    // ---- six coral cushions marking the seats
    const padG = new THREE.CylinderGeometry(0.55, 0.62, 0.16, 9);
    const pads = new THREE.InstancedMesh(padG, makeGlow(C.coral, { unique: true }), SEATS.length);
    for (let i = 0; i < SEATS.length; i++) {
      const s = SEATS[i];
      _dummy.position.set(s[0], this._backY(s[2]) + 0.05, s[2]);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      pads.setMatrixAt(i, _dummy.matrix);
    }
    pads.instanceMatrix.needsUpdate = true;
    grp.add(pads);
    this._geos.push(padG);
    this._padMat = pads.material;

    this._whaleSeat = new THREE.Object3D(); // scratch for seat world transforms
  }

  /** Height of her back at a local z (where the seats sit). */
  _backY(z) {
    const t = (WHALE.len - z) / (WHALE.len * 2);
    return whaleR(t) * WHALE.tall * 0.98;
  }

  _buildParticles(scene, rng) {
    // ---- bubbles: CPU-recycled, emitted by every swimmer and by two vents
    const N = 200;
    this._bub = {
      n: N,
      pos: new Float32Array(N * 3),
      vel: new Float32Array(N),
      life: new Float32Array(N),
      seed: new Float32Array(N),
      next: 0,
    };
    const size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      size[i] = 0.05 + rng() * 0.13;  // world radius; uPixel turns it into px
      this._bub.seed[i] = rng() * TAU;
      this._bub.pos[i * 3 + 1] = -999;
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(this._bub.pos, 3));
    bg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    bg.setAttribute('aLife', new THREE.BufferAttribute(this._bub.life, 1));
    const bmat = new THREE.ShaderMaterial({
      vertexShader: VS_POINTS,
      fragmentShader: FS_POINTS,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(0xdff6ff) },
        uPixel: { value: 900 },
        uPlayer: { value: new THREE.Vector3() },
        uSpeed: { value: 0 },
        uNight: { value: 0 },
        uWake: { value: 0 },
      },
    });
    this._shaders.push(bmat);
    const bubbles = new THREE.Points(bg, bmat);
    bubbles.frustumCulled = false;
    bubbles.renderOrder = 4;
    scene.add(bubbles);
    this._geos.push(bg);
    this._bubGeo = bg;

    // ---- plankton: fixed motes that light up around a moving swimmer at night
    const M = 620;
    const ppos = new Float32Array(M * 3);
    const psize = new Float32Array(M);
    const plife = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      ppos[i * 3] = (rng() - 0.5) * 62;
      ppos[i * 3 + 1] = 1.5 + rng() * 17;
      ppos[i * 3 + 2] = (rng() - 0.5) * 62;
      psize[i] = 0.02 + rng() * 0.04;
      plife[i] = 0.5 + rng() * 0.5;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
    pg.setAttribute('aSize', new THREE.BufferAttribute(psize, 1));
    pg.setAttribute('aLife', new THREE.BufferAttribute(plife, 1));
    const pmat = new THREE.ShaderMaterial({
      vertexShader: VS_POINTS,
      fragmentShader: FS_POINTS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0x9ff2e6) },
        uPixel: { value: 900 },
        uPlayer: { value: new THREE.Vector3() },
        uSpeed: { value: 0 },
        uNight: { value: 0 },
        uWake: { value: 1 },
      },
    });
    this._shaders.push(pmat);
    const plankton = new THREE.Points(pg, pmat);
    plankton.frustumCulled = false;
    plankton.renderOrder = 5;
    scene.add(plankton);
    this._geos.push(pg);
    this._planktonMat = pmat;
    this._bubMat = bmat;
  }

  // ------------------------------------------------------------- the clock --

  /** LIVING-COVE A: called on build and on every server clock frame. */
  onClock(dayT) {
    if (!Number.isFinite(dayT)) return;
    this._dayTarget = ((dayT % 1) + 1) % 1;
    if (!this._clockSeen) { this._day = this._dayTarget; this._clockSeen = true; }
  }

  /** Big Blue's lap phase, shared by every client through the world clock. */
  _lapPhase() {
    const u = this._day * LAPS_PER_DAY;
    return u - Math.floor(u);
  }

  // -------------------------------------------------------------- movement --

  _pointer(e) {
    const game = this._game;
    const eng = game?.engine;
    if (!eng || eng.paused || game.activeMinigame || e.button !== 0 || !this._swim) return;
    _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this._ray.setFromCamera(_ndc, eng.camera);
    // the engine already turns a click on another capy into a profile card
    if (this._ray.intersectObjects(eng.remoteGroup.children, true).length) return;

    const hits = this._ray.intersectObjects(this._clickTargets(), false);
    const hit = hits.length ? hits[0] : null;
    if (hit && hit.object === this._whaleBody) {
      this._beginMount();
      return;
    }
    if (this._riding) this._dismount();
    this._mountPending = false;
    if (hit && hit.object === this._bottleMesh) this._claimBottle();

    this._swim.setTarget(this._aim(hit, _v));
    this._showMark(this._swim.target);
    this._game.audio?.play?.('bubble');
  }

  /**
   * Turn a click into a swim target that behaves the same from ANY camera
   * angle. THE OLD BUG: the target was whatever the ray hit, and from a
   * near-level camera the seabed is nearly edge-on, so a two-pixel cursor move
   * slid the hit point (and therefore the swim) through 20+ units of depth,
   * with a hard discontinuity at the horizon where the ray stopped hitting the
   * floor at all and fell back to a flat 26 units. THE RULE NOW:
   *
   *   swim to the thing you clicked if it is within REACH of you; otherwise
   *   swim REACH units in the direction you clicked.
   *
   * The direction for that second case is the point where the ray leaves a
   * sphere of radius STEER_R around the swimmer, which is continuous over the
   * whole window, never grazes anything, and is bounded by construction: no
   * depth in the scene can influence it. Off the tangent of that sphere (the
   * far corners of a very wide window) it degrades into the ray's closest
   * approach, which is exactly the hardest turn the scheme can give.
   */
  _aim(hit, out) {
    const pos = this._swim.pos;
    const ray = this._ray.ray;
    if (hit) {
      // stop in FRONT of what you clicked, not inside it: back off along the
      // ray, which works for instanced/rotated props where a face normal is in
      // some other frame entirely
      out.copy(hit.point).addScaledVector(ray.direction, -1.15);
      // The seabed is the ONE thing you see edge-on, and so the one thing whose
      // distance cannot be trusted: past REACH it only gets to say which way.
      // A landmark you picked out on purpose (the bell, the arch, a boulder,
      // the bottle) is worth the whole swim, however far off it is.
      if (hit.object !== this._seabed || out.distanceTo(pos) <= REACH) return this._settle(out);
    }
    _v2.copy(pos).sub(ray.origin);
    const along = _v2.dot(ray.direction);          // how far along the ray she is
    const off2 = Math.max(0, _v2.lengthSq() - along * along); // squared miss distance
    const t = off2 < STEER_R * STEER_R
      ? along + Math.sqrt(STEER_R * STEER_R - off2)  // the far side of the sphere
      : along;                                       // grazing: closest approach
    out.copy(ray.origin).addScaledVector(ray.direction, Math.max(t, 0.5)).sub(pos);
    const len = out.length() || 1;
    return this._settle(out.multiplyScalar(REACH / len).add(pos));
  }

  /** Keep a target out of the sand; setTarget() clamps it into the volume. */
  _settle(v) {
    v.y = Math.max(v.y, duneHeight(v.x, v.z) + 0.9);
    return v;
  }

  /** Wheel / arrow keys are live whenever a click would be. */
  _canNudge() {
    const game = this._game;
    return !!(this._swim && !this._riding && game && !game.activeMinigame
      && !game.engine?.paused);
  }

  _nudge(dy) {
    this._showMark(this._swim.nudgeVertical(dy));
    // one flick of a real wheel is a dozen events: keep the blip, drop the spam
    if (this._t - this._nudgeAt > 0.16) {
      this._nudgeAt = this._t;
      this._game.audio?.play?.('bubble');
    }
  }

  /** Walk the vantage around her by `d` radians (arrow keys). */
  _spin(d) {
    if (this._riding) this._rideSpin += d;   // the ride owns its own azimuth
    else this._camGoal += d;
  }

  /** Pop the target ring at `v`; update() faces it at the camera and fades it. */
  _showMark(v) {
    if (!this._mark || !v) return;
    this._mark.position.copy(v);
    this._mark.visible = true;
    this._markT = 0;
  }

  _clickTargets() {
    const list = this._targets || (this._targets = []);
    list.length = 0;
    if (this._whaleBody) list.push(this._whaleBody);
    if (this._seabed) list.push(this._seabed);
    if (this._rocks) list.push(this._rocks);
    if (this._arch) list.push(this._arch);
    if (this._bellMesh) list.push(this._bellMesh);
    if (this._bottleMesh) list.push(this._bottleMesh);
    return list;
  }

  /** Swim over to a free seat; we climb on when we get there. */
  _beginMount() {
    if (this._riding) return;
    const seat = this._freeSeat();
    if (seat < 0) {
      this._game.toast?.('Big Blue is carrying six already. Wait for a spot!');
      this._game.audio?.play?.('pop');
      return;
    }
    this._mountPending = true;
    this._game.audio?.play?.('bubble');
  }

  _mount() {
    this._riding = true;
    this._mountPending = false;
    if (this._swim) this._swim.mounted = true;
    this._avatar?.setAnim('ride');
    this._sendPose('sit', 1);
    this._game.audio?.play?.('success');
    this._game.toast?.('You are riding Big Blue. Click the water to hop off.');
  }

  _dismount() {
    if (!this._riding) return;
    this._riding = false;
    if (this._swim) {
      this._swim.mounted = false;
      // step off sideways so we do not spawn inside her flank
      _v.copy(this._avatar.group.position);
      _v.y += 1.4;
      this._swim.teleport(_v);
    }
    this._avatar?.setAnim('swim');
    this._sendPose('idle', 0);
    this._game.audio?.play?.('splash');
  }

  /**
   * Push ONE move frame carrying a wire-legal pose. The net client keeps
   * sending 'swim'/'ride', which the server's anim whitelist drops, so the pose
   * we set here is the one everybody else sees until we change it again.
   */
  _sendPose(anim, ride = 0) {
    const net = this._game?.net;
    const a = this._avatar;
    if (!net?.connected || !a) return;
    const p = a.group.position;
    net.send({
      t: 'move',
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      rot: +a.group.rotation.y.toFixed(2),
      anim, ride,
    });
  }

  // ----------------------------------------------------------- the bottle ---

  _onBottle(m) {
    if (!m || m.found) { this._clearBottle(); return; }
    const x = Number(m.x);
    const y = Number(m.y);
    const z = Number(m.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this._clearBottle();
    const g = mergeParts([
      { g: new THREE.CylinderGeometry(0.16, 0.16, 0.6, 8), color: rgb(0x9fd8c0) },
      { g: new THREE.CylinderGeometry(0.06, 0.11, 0.24, 8), color: rgb(0x9fd8c0), pos: [0, 0.4, 0] },
      { g: new THREE.CylinderGeometry(0.065, 0.065, 0.1, 6), color: rgb(0xb08a5a), pos: [0, 0.55, 0] },
      { g: new THREE.CylinderGeometry(0.1, 0.1, 0.42, 6), color: rgb(0xfff6e3), pos: [0, -0.02, 0] },
    ]);
    const mesh = new THREE.Mesh(g, makeToon(0xffffff, { vertexColors: true }));
    const py = Number.isFinite(y) ? y : duneHeight(x, z) + 0.5;
    mesh.position.set(x, py, z);
    mesh.rotation.z = 0.8;
    this._scene.add(mesh);
    this._bottleMesh = mesh;
    this._geos.push(g);
    this._bottleSpot = {
      id: 'bottle', position: mesh.position.clone(), radius: 3,
      label: 'Open the message in a bottle',
      action: () => this._claimBottle(),
    };
    this.hotspots.push(this._bottleSpot);
  }

  _claimBottle() {
    if (!this._bottleMesh || this._bottleClaimed) return;
    this._bottleClaimed = true;
    this._game.net?.send({ t: 'bottle-found' });
    this._game.audio?.play?.('sparkle');
  }

  _onBottleFound(m) {
    const note = typeof m?.note === 'string' ? m.note : null;
    if (note) this._game.toast?.(note, 5200);
    this._clearBottle();
  }

  _clearBottle() {
    if (this._bottleMesh) {
      this._bottleMesh.parent?.remove(this._bottleMesh);
      this._bottleMesh.geometry.dispose();
      this._bottleMesh = null;
    }
    if (this._bottleSpot) {
      const i = this.hotspots.indexOf(this._bottleSpot);
      if (i >= 0) this.hotspots.splice(i, 1);
      this._bottleSpot = null;
    }
    this._bottleClaimed = false;
  }

  // -------------------------------------------------------------- the song --

  /** Low filtered sine swells on a room-local WebAudio graph. */
  _sing() {
    const game = this._game;
    if (game?.audio?.muted) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    if (!this._actx) {
      try { this._actx = new AC(); } catch { this._actx = null; return; }
    }
    const ctx = this._actx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.Q.value = 0.8;
    const out = ctx.createGain();
    out.gain.value = 0.42;
    lp.connect(out);
    out.connect(ctx.destination);
    // three swells, each sliding up then settling: a whale asking a question
    const calls = [[0, 62, 3.2], [3.0, 84, 3.6], [7.2, 47, 5.2]];
    for (const [off, f, len] of calls) {
      const t = t0 + off;
      for (const [mul, vol] of [[1, 0.3], [1.5, 0.1], [2.01, 0.05]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f * mul * 0.9, t);
        o.frequency.linearRampToValueAtTime(f * mul, t + len * 0.35);
        o.frequency.linearRampToValueAtTime(f * mul * 0.86, t + len);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + len * 0.3);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g);
        g.connect(lp);
        o.start(t);
        o.stop(t + len + 0.1);
      }
    }
  }

  // ---------------------------------------------------------------- update --

  update(dt, game) {
    this._t += dt;
    const t = this._t;

    // ---- world clock: run it forward locally, ease onto the server's phase.
    // Both hands advance, so the ease has no standing lag to fight and Big
    // Blue's lap phase (below) agrees between clients to a fraction of a second.
    this._dayTarget = (this._dayTarget + dt / DAY_SECONDS) % 1;
    let d = this._dayTarget - this._day;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    this._day += d * Math.min(1, dt * 0.8);
    this._day -= Math.floor(this._day);
    // 1 at noon, 0.5 at dawn/dusk, 0 at midnight. Night is curved so the
    // bioluminescence belongs to the small hours, not to every sunset.
    const light = 0.5 + 0.5 * Math.cos((this._day - 0.25) * TAU);
    const night = Math.pow(1 - light, 1.8);
    this._night = night;

    const avatar = this._avatar;
    const swim = this._swim;
    if (avatar && this._needSpawn) {
      // build() runs BEFORE the engine drops us on the spawn point, so the
      // arrival pose is set up here on the first frame instead
      this._needSpawn = false;
      swim?.teleport(avatar.group.position);
      if (swim) swim.yaw = Math.PI;          // facing into the room, not the bell
      avatar.group.rotation.set(0, Math.PI, 0, 'YXZ');
      avatar.setAnim('swim');
      // Reset our wire pose: a capy who arrives still flagged 'sit' from a
      // bench or a chairlift would otherwise read as a rider to everyone else.
      this._sendPose('idle');
      this._game.toast?.(
        'Click where you want to swim. Scroll (or up/down) to rise and sink, '
        + 'left/right to look around.',
        5600,
      );
    }

    // ---- Big Blue -------------------------------------------------------
    this._updateWhale(dt, t);

    // ---- the player -----------------------------------------------------
    if (avatar && swim) {
      if (this._mountPending && !this._riding) {
        const idx = this._freeSeat();
        if (idx < 0) {
          this._mountPending = false;
        } else {
          this._seatFor(idx, this._whaleSeat);
          swim.setTarget(this._whaleSeat.position);
          // climbing on mid-frame must fall through to the riding branch, or
          // the swim pose below stamps over 'ride' for a frame and pulses
          if (swim.pos.distanceTo(this._whaleSeat.position) < 2.2) this._mount();
        }
      }
      if (this._riding) {
        this._seatFor(this._seatIndex(this._selfId()), avatar.group);
        avatar.setAnim('ride');
      } else {
        // her flanks push you aside unless you are climbing aboard
        if (!this._mountPending) {
          swim.repel(this._whalePos.x, this._whalePos.y, this._whalePos.z, 6.5, dt);
        }
        swim.update(dt);
        if (avatar.state.anim !== 'swim') avatar.setAnim('swim');
      }
    }

    const p = avatar ? avatar.group.position : this._fallbackPos;
    const speed = swim ? swim.speedNow : 0;
    this._updateCamera(dt, p);
    this._updateMark(dt);

    // ---- exit gate: the bell only offers the ride up when you are level ---
    // (hotspots measure distance in xz only, and 0 would fall back to 2.5)
    this._exit.radius = (!this._riding && Math.abs(p.y - BELL_MID) < 3.4) ? 3.4 : 0.001;

    // ---- colour grade: depth + time of day ------------------------------
    const depth = THREE.MathUtils.clamp(p.y / SURFACE_Y, 0, 1);
    this._shallow.setHex(C.shallow).lerp(_col.setHex(C.nightShallow), night * 0.92);
    this._deep.setHex(C.deep).lerp(_col.setHex(C.nightDeep), night * 0.92);
    this._fogColor.copy(this._deep).lerp(this._shallow, 0.34 + depth * 0.5);
    this._scene.background.copy(this._fogColor);
    this._scene.fog.color.copy(this._fogColor);
    this._shellMat.uniforms.uShallow.value.copy(this._shallow);
    this._shellMat.uniforms.uDeep.value.copy(this._deep);
    this._shellMat.uniforms.uTime.value = t;
    this._surfaceMat.uniforms.uDeep.value.copy(this._shallow);
    this._surfaceMat.uniforms.uTime.value = t;
    this._surfaceMat.uniforms.uDay.value = light;
    this._surfaceMat.uniforms.uBright.value.setHex(0xcdeaf8).lerp(_col.setHex(0x8fadcc), night);
    this._seabedMat.uniforms.uTime.value = t;
    this._seabedMat.uniforms.uCaust.value = 0.2 + 0.75 * light;
    this._seabedMat.uniforms.uNight.value = night;
    this._seabedMat.uniforms.uDeep.value.copy(this._deep);
    this._seabedMat.uniforms.uWhale.value.copy(this._whalePos);
    this._rayMat.uniforms.uTime.value = t;
    this._rayMat.uniforms.uRay.value = 0.12 + 0.6 * light;
    this._rayMat.uniforms.uRayColor.value.setHex(0xffeecb).lerp(_col.setHex(0x9fc0ff), night);
    this._grassMat.uniforms.uTime.value = t;
    this._grassMat.uniforms.uNight.value = night;
    this._kelpMat.uniforms.uTime.value = t;
    this._kelpMat.uniforms.uNight.value = night;
    this._hemi.intensity = 0.5 + 0.6 * light;   // never below the play floor
    this._sun.intensity = 0.28 + 0.7 * light;
    this._lamp.intensity = 1.1 + 0.9 * night;

    // bioluminescence: jellies become lanterns, runes and cushions glow
    const jellyA = 0.2 + 0.62 * night;
    this._jellyMats[0].opacity = jellyA;
    this._jellyMats[1].opacity = jellyA * 0.65;
    this._jellyMats[0].color.setHex(C.jelly).multiplyScalar(0.75 + 0.45 * night);
    this._jellyMats[1].color.setHex(C.jellyCore).multiplyScalar(0.7 + 0.5 * night);
    this._runes.color.setHex(0x7fe8d0).multiplyScalar(0.55 + 0.6 * night);
    this._padMat.color.setHex(C.coral).multiplyScalar(0.8 + 0.45 * night);
    this._bellGlow.color.setHex(C.glassGlow).multiplyScalar(0.8 + 0.4 * night);
    this._whaleMat.color.setHex(0xffffff).multiplyScalar(0.72 + 0.28 * light);
    this._flukeMat.color.setHex(C.whaleDark).multiplyScalar(0.72 + 0.28 * light);

    // ---- life ------------------------------------------------------------
    for (const s of this._schools) s.update(dt, t, p);
    this._updateJellies(dt, t);
    this._updateTurtle(dt);
    this._updateParticles(dt, p, speed, night);

    // ---- other capybaras --------------------------------------------------
    this._syncRemotes(game);
  }

  /**
   * The swim camera (see the CAM note up top). Follow mode only: static mode
   * has its own authored vantage and must not feel any of this.
   */
  _updateCamera(dt, p) {
    const eng = this._game.engine;
    const cfg = eng?.camCfg;
    if (!cfg?.offset) return;

    // Where the vantage WANTS to be: an azimuth, on the far side of wherever
    // the swimmer is pointed. Only a real heading counts, so a dive, a climb
    // or a drift to a stop never moves it.
    const swim = this._swim;
    let want = null;
    if (this._riding && this._whale) want = this._whale.rotation.y + Math.PI + this._rideSpin;
    else if (swim && swim.hSpeed > 1.2) want = swim.yaw + Math.PI;
    // ...and it only earns a swing once you have turned most of the way round,
    // which is what keeps the shot as still as the static camera the whole
    // time you are exploring, and gets it out of your way when you double back
    // toward the bell. Once a swing starts it finishes (the goal is sticky).
    // (riding is the exception: she turns at a fortieth of a radian a second,
    // so the vantage simply tracks her and the ride reads as one long shot)
    const swinging = Math.abs(angleDelta(this._camAz, this._camGoal)) > 0.06;
    if (want !== null && (this._riding || swinging
      || Math.abs(angleDelta(this._camGoal, want)) > CAM.reframe)) {
      this._camGoal = want;
    }
    const d = angleDelta(this._camAz, this._camGoal);
    if (Math.abs(d) > 1e-4) {
      // ease out of the swing, but never faster than CAM.slew: no snap, no flip
      const rate = Math.min(Math.abs(d) * 2.2, CAM.slew);
      this._camAz += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    }

    const k = Math.min(1, dt * CAM.ease);
    this._camH += ((this._riding ? CAM.rideH : CAM.swimH) - this._camH) * k;
    this._camD += ((this._riding ? CAM.rideD : CAM.swimD) - this._camD) * k;
    if (eng.cameraMode === 'static') return;   // nothing below applies up there
    cfg.offset.set(
      Math.sin(this._camAz) * this._camD, this._camH, Math.cos(this._camAz) * this._camD,
    );
    cfg.lookHeight += ((this._riding ? CAM.rideLook : CAM.swimLook) - cfg.lookHeight) * k;
    // Look at her ACTUAL position, not the engine's smoothed one: its lerp
    // toward p is what used to slide a climbing swimmer out of frame. The lag
    // that is left is the camera's own, on all three axes, which is the part
    // that feels like water.
    eng.camTarget.copy(p);
  }

  /** The click ring: always facing the camera, gone in half a second. */
  _updateMark(dt) {
    const m = this._mark;
    if (!m?.visible) return;
    this._markT += dt;
    const k = this._markT / 0.55;
    if (k >= 1) { m.visible = false; return; }
    m.scale.setScalar(0.8 + k * 0.7);
    m.material.opacity = 0.85 * (1 - k);
    const cam = this._game.engine?.camera;
    if (cam) m.quaternion.copy(cam.quaternion);
  }

  /** Her lap, evaluated into `out`. Shared phase = shared position. */
  _pathAt(u, out) {
    const ang = u * TAU;
    return out.set(
      WHALE.cx + Math.sin(ang) * WHALE.rx,
      WHALE.y0 + Math.cos(ang) * WHALE.ya,
      WHALE.cz + Math.cos(ang) * WHALE.rz,
    );
  }

  _updateWhale(dt, t) {
    const u = this._lapPhase();
    const a = u * TAU;
    const grp = this._whale;
    this._pathAt(u, grp.position);
    this._pathAt(u + 0.004, _v).sub(grp.position); // heading, a moment ahead
    const yaw = Math.atan2(_v.x, _v.z);
    const pitch = -Math.asin(THREE.MathUtils.clamp(_v.y / (_v.length() || 1), -1, 1)) * 0.7;
    grp.rotation.set(pitch, yaw, Math.sin(a) * 0.12, 'YXZ');
    // she breathes: a slow vertical undulation on top of the path
    grp.position.y += Math.sin(t * 0.35) * 0.35;
    this._whalePos.copy(grp.position);

    // fluke and pectorals
    const beat = Math.sin(t * 0.62);
    this._fluke.rotation.x = beat * 0.32;
    this._fluke.position.y = beat * 0.5;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      _dummy.position.set(side * 2.7, -0.7, 4.0);
      _dummy.rotation.set(Math.sin(t * 0.5 + i) * 0.18, side * -0.35, side * (0.5 + beat * 0.16));
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      this._pecs.setMatrixAt(i, _dummy.matrix);
    }
    this._pecs.instanceMatrix.needsUpdate = true;

    // ---- the surfacing: she rises into the light shafts, blows, and sings.
    // DEVIATION from LIVING-COVE.md C ("surfaces near the bell"): she tops out
    // in open water ~20 units off the bell instead of over it. Her lap put her
    // directly on top of the arrival camera, which was a wall of whale rather
    // than a whale. She is in plain sight from the bell, which is the point.
    const near = u < 0.06 || u > 0.94;
    if (near && t - this._songAt > 40) {
      this._songAt = t;
      this._sing();
      this._game?.toast?.('Big Blue is rising into the light.');
    }
    this._spouting = near;
    if (near) grp.localToWorld(this._spout.set(0, 2.6, 5.6));
  }

  /** World transform of seat `i` into `out` (an Object3D). */
  _seatFor(i, out) {
    const s = SEATS[Math.max(0, Math.min(SEATS.length - 1, i))];
    _seat.set(s[0], this._backY(s[2]) + 0.15, s[2]);
    this._whale.localToWorld(_seat);
    if (out.isObject3D) {
      out.position.copy(_seat);
      out.rotation.set(0, this._whale.rotation.y, 0, 'YXZ');
    }
    return _seat;
  }

  _selfId() {
    return this._game?.net?.selfId || '~me';
  }

  /** Ids of everyone on her back right now, sorted so all clients agree. */
  _riders() {
    const list = this._riderIds;
    list.length = 0;
    if (this._riding) list.push(this._selfId());
    const remotes = this._game?.net?.remotes;
    if (remotes) {
      for (const [id, r] of remotes) {
        if (r.anim !== 'sit') continue;
        // A stale 'sit' from a bench in another room must not glue anyone on.
        // A real rider reports a seat, never more than ~4.6 units off her
        // centre; 10 leaves room for clock skew between clients.
        const dx = r.target.x - this._whalePos.x;
        const dz = r.target.z - this._whalePos.z;
        if (dx * dx + dz * dz > 100) continue;
        list.push(id);
      }
    }
    list.sort();
    return list;
  }

  _seatIndex(id) {
    return this._riders().indexOf(id);
  }

  _freeSeat() {
    const n = this._riders().length;
    return n >= SEATS.length ? -1 : n;
  }

  /**
   * Drive every remote capy: swimmers get the swim pose, riders get pinned to
   * their seat. We write the avatar transform AND the net client's target, so
   * its interpolation lands on the same value and never fights us.
   */
  _syncRemotes(game) {
    const remotes = game.net?.remotes;
    if (!remotes || !remotes.size) return;
    const riders = this._riders();
    for (const [id, r] of remotes) {
      const seat = riders.indexOf(id);
      if (seat >= 0) {
        this._seatFor(seat, this._whaleSeat);
        const g = r.avatar.group;
        g.position.copy(this._whaleSeat.position);
        g.rotation.set(0, this._whaleSeat.rotation.y, 0, 'YXZ');
        r.target.x = g.position.x;
        r.target.y = g.position.y;
        r.target.z = g.position.z;
        r.target.rot = g.rotation.y;
        if (r.avatar.state.anim !== 'ride') r.avatar.setAnim('ride');
      } else if (r.avatar.state.anim !== 'swim') {
        r.avatar.setAnim('swim');
      }
    }
  }

  _updateJellies(dt, t) {
    const arr = this._jellies;
    for (let i = 0; i < arr.length; i++) {
      const j = arr[i];
      const pulse = Math.sin(t * 1.5 + j.ph);
      j.y += (j.rise + pulse * 0.25) * dt;
      j.x += Math.sin(t * 0.22 + j.drift) * 0.35 * dt;
      j.z += Math.cos(t * 0.19 + j.drift) * 0.35 * dt;
      if (j.y > SURFACE_Y - 3) j.y = 1.6;
      const squash = 1 + pulse * 0.14;
      _dummy.position.set(j.x, j.y, j.z);
      _dummy.rotation.set(Math.sin(t * 0.4 + j.ph) * 0.12, j.drift, 0);
      _dummy.scale.set(j.s / squash, j.s * squash, j.s / squash);
      _dummy.updateMatrix();
      this._jellyBells.setMatrixAt(i, _dummy.matrix);
      _dummy.scale.set(j.s, j.s * (2 - squash), j.s);
      _dummy.updateMatrix();
      this._jellyTents.setMatrixAt(i, _dummy.matrix);
    }
    this._jellyBells.instanceMatrix.needsUpdate = true;
    this._jellyTents.instanceMatrix.needsUpdate = true;
  }

  _updateTurtle(dt) {
    this._turtleT = (this._turtleT + dt * 0.0075) % 1;
    const c = this._turtlePath;
    c.getPointAt(this._turtleT, _v);
    this._turtle.position.copy(_v);
    c.getPointAt((this._turtleT + 0.01) % 1, _v2);
    _v2.sub(_v);
    const yaw = Math.atan2(_v2.x, _v2.z);
    const pitch = -Math.asin(THREE.MathUtils.clamp(_v2.y / (_v2.length() || 1), -1, 1)) * 0.8;
    const dy = ((((yaw - this._turtle.rotation.y) % TAU) + Math.PI * 3) % TAU) - Math.PI;
    this._turtle.rotation.set(pitch, this._turtle.rotation.y + dy * Math.min(1, dt * 2), dy * 1.6, 'YXZ');
    const flap = Math.sin(this._t * 1.9);
    for (let i = 0; i < 4; i++) {
      const side = i % 2 ? 1 : -1;
      const front = i < 2;
      _dummy.position.set(side * (front ? 1.15 : 0.95), -0.06, front ? 0.75 : -0.85);
      _dummy.rotation.set(
        (front ? flap : -flap) * 0.55,
        side * (front ? 0.45 : 0.75),
        side * (front ? flap : -flap) * 0.5,
      );
      _dummy.scale.set(front ? 1 : 0.72, 1, front ? 1 : 0.8);
      _dummy.updateMatrix();
      this._turtleFlips.setMatrixAt(i, _dummy.matrix);
    }
    this._turtleFlips.instanceMatrix.needsUpdate = true;
  }

  _updateParticles(dt, player, speed, night) {
    const b = this._bub;
    const pos = b.pos;
    const life = b.life;
    // rise, sway, expire
    for (let i = 0; i < b.n; i++) {
      if (life[i] <= 0) continue;
      life[i] = Math.max(0, life[i] - dt * 0.34);
      pos[i * 3 + 1] += b.vel[i] * dt;
      pos[i * 3] += Math.sin(this._t * 2.4 + b.seed[i]) * 0.35 * dt;
      pos[i * 3 + 2] += Math.cos(this._t * 2.1 + b.seed[i]) * 0.35 * dt;
      if (pos[i * 3 + 1] > SURFACE_Y - 1) life[i] = 0;
    }
    // emit: the local swimmer, every remote swimmer, two vents, her blowhole
    this._bubbleAt -= dt;
    if (this._bubbleAt <= 0) {
      this._bubbleAt = 0.1;
      if (this._avatar && !this._riding) {
        _v.setFromMatrixPosition(this._avatar.headG.matrixWorld);
        this._emit(_v.x, _v.y + 0.2, _v.z, 0.9 + speed * 0.12);
      }
      const remotes = this._game?.net?.remotes;
      if (remotes) {
        for (const [, r] of remotes) {
          if (r.avatar.state.anim !== 'swim') continue;
          _v.setFromMatrixPosition(r.avatar.headG.matrixWorld);
          this._emit(_v.x, _v.y + 0.2, _v.z, 0.9);
        }
      }
      this._emit(-11, duneHeight(-11, 6) + 0.3, 6, 1.4);
      this._emit(17, duneHeight(17, -12) + 0.3, -12, 1.2);
      if (this._spouting) {
        const s = this._spout;
        for (let i = 0; i < 3; i++) {
          this._emit(s.x + (Math.random() - 0.5) * 1.6, s.y,
            s.z + (Math.random() - 0.5) * 1.6, 2.6);
        }
      }
    }
    this._bubGeo.attributes.position.needsUpdate = true;
    this._bubGeo.attributes.aLife.needsUpdate = true;
    this._bubMat.uniforms.uNight.value = night;

    const pm = this._planktonMat.uniforms;
    pm.uPlayer.value.copy(player);
    pm.uSpeed.value = THREE.MathUtils.clamp(speed / 4, 0.12, 1.6);
    pm.uNight.value = night;
    pm.uColor.value.setHex(0x9ff2e6).multiplyScalar(0.5 + 0.6 * night);
  }

  _emit(x, y, z, rise) {
    const b = this._bub;
    const i = b.next;
    b.next = (b.next + 1) % b.n;
    b.pos[i * 3] = x;
    b.pos[i * 3 + 1] = y;
    b.pos[i * 3 + 2] = z;
    b.vel[i] = rise;
    b.life[i] = 1;
  }

  // -------------------------------------------------------------- teardown --

  dispose() {
    this._canvas?.removeEventListener('pointerdown', this._onPointer);
    this._canvas?.removeEventListener('wheel', this._onWheel);
    removeEventListener('keydown', this._onKey);
    for (const off of this._offs) { try { off?.(); } catch { /* already gone */ } }
    this._offs.length = 0;
    // (camCfg.offset is this room's own cameraHint vector and camTarget is
    // re-seeded from the next room's spawn, so neither needs restoring here.)

    // hand the walker back and put the avatar upright again: every other room
    // assumes an XYZ euler with no pitch or roll
    const eng = this._game?.engine;
    if (eng?.controller) eng.controller.enabled = true;
    const a = eng?.playerAvatar;
    if (a) {
      a.group.rotation.set(0, a.group.rotation.y, 0, 'XYZ');
      a.setAnim('idle');
    }
    for (const [, r] of this._game?.net?.remotes || []) {
      if (r.avatar.state.anim === 'swim' || r.avatar.state.anim === 'ride') r.avatar.setAnim('idle');
    }
    if (this._riding) {
      this._riding = false;
      this._sendPose('idle', 0);
    }
    this._clearBottle();

    // the engine disposes the scene graph, but these shader materials are not
    // in the toon cache and the merged/instanced geometries are ours
    for (const m of this._shaders) m.dispose();
    this._shaders.length = 0;
    for (const g of this._geos) g.dispose();
    this._geos.length = 0;

    if (this._actx) {
      try { this._actx.close(); } catch { /* already closed */ }
      this._actx = null;
    }
  }
}

/**
 * Concatenate two colour-attributed indexed geometries. Used once, to glue Big
 * Blue's re-profiled body onto her merged details so she stays one draw call.
 */
function mergeTwo(a, b) {
  const parts = [a, b];
  let v = 0;
  let idx = 0;
  for (const g of parts) {
    v += g.attributes.position.count;
    idx += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(v * 3);
  const nrm = new Float32Array(v * 3);
  const col = new Float32Array(v * 3);
  const ind = v > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let vo = 0;
  let io = 0;
  for (const g of parts) {
    const P = g.attributes.position;
    pos.set(P.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    const ia = g.index.array;
    for (let i = 0; i < ia.length; i++) ind[io + i] = ia[i] + vo;
    io += ia.length;
    vo += P.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(ind, 1));
  out.computeBoundingSphere();
  return out;
}
