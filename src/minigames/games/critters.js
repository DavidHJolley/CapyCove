import * as THREE from 'three';
import { makeToon } from '../../core/materials.js';

/**
 * critters.js : the CRITTER FACTORY for the Capy Clash battle diorama
 * (docs/CARDGAME.md section 10). One procedural chibi capybara model for every
 * critter card in the section-6 table, in the prop/avatar art language:
 * merged low-poly geometry, toon material, canvas-free, no external assets.
 *
 * ===========================================================================
 * PUBLIC API  (frozen: the stage builds against exactly this)
 * ===========================================================================
 *
 *   import { buildCritter, buildElementBurst, CRITTER_IDS } from './critters.js';
 *
 *   buildCritter(cardId) -> {
 *     group,          // THREE.Group. Feet at y=0, faces +Z, ~1.2 units tall
 *                     //   (1.07 for the cheapest chibi cards up to 1.44 for
 *                     //   the elders; Great Ancient Capy reaches 2.06). An
 *                     //   unknown id falls back to a plain neutral capy and
 *                     //   never throws. Read .height for the exact top.
 *     update(dt),     // idle life: breathe, blink, ear flicks, element tics.
 *                     //   Call EVERY frame, including while an overlay plays.
 *     play(name),     // one-shot overlay: 'attack' | 'hurt' | 'ko' | 'cheer'.
 *                     //   Returns its duration in SECONDS (0 = unknown name or
 *                     //   already KO'd). Overlays paint ON TOP of the idle
 *                     //   pose and animate AROUND the group origin: the STAGE
 *                     //   moves the group across the board.
 *                     //   'attack' = anticipation crouch + lunge pose.
 *                     //   'ko'     = crack/tremble pause then collapse-shrink;
 *                     //              the model hides itself at the end and
 *                     //              stays hidden (the STAGE spawns the
 *                     //              shatter particles). KO is terminal.
 *     dispose(),      // frees every non-shared GL resource this critter owns
 *   }
 *
 *   buildElementBurst(element)  // 'sun'|'sea'|'snow'|'neutral' (anything else
 *                               // reads as neutral) -> one-shot particle
 *                               // THREE.Group for summon / impact flashes:
 *                               //   group.update(dt) -> alive:boolean
 *                               //   group.dispose()
 *                               // Sits at the origin; the stage positions and
 *                               // pools it. Lives ~0.85s.
 *
 *   CRITTER_IDS                 // the 14 card ids, in section-6 table order
 *
 * Extras (optional, safe to ignore): the critter object also carries
 *   .id .name .el .height (top of the head in world units, for damage numbers)
 *   .tris (triangle count) and a writable .speed (default 1) that scales ALL
 *   animation: set 2 for the splash screen's "fast mode" and play() returns the
 *   already-scaled duration. group.getObjectByName('blob') is the fake contact
 *   shadow; hide it if the stage lights real ones.
 *
 * ===========================================================================
 * SHAPE OF THIS FILE (read before editing)
 * ===========================================================================
 *  1. PRESENTATION ONLY. Nothing here knows a rule. The CRITTERS table below is
 *     art data keyed by the same card ids cards.js uses; it is deliberately NOT
 *     imported from cards.js so the factory stays standalone (and so a stage
 *     harness can build all 14 without booting the duel).
 *  2. Colour lives in the GEOMETRY, not in materials: every part bakes its
 *     colour into a per-vertex `color` attribute, so one shared white toon
 *     material draws every opaque part of every critter. That keeps a summoned
 *     critter at 6-8 draw calls (body / arms / head / ears / blob / motes, plus
 *     eyes unless the card wears shades, plus a halo on sun cards): 8 on the
 *     board stay well inside the section-10 budget of 120 draw calls for the
 *     whole diorama.
 *  3. Geometry is merged per card and REFERENCE COUNTED (CACHE below): the
 *     second Sunny Pup costs no GPU memory, and the last dispose() of a card
 *     frees it, so an unmounted duel leaves nothing behind.
 *  4. Deviation from section 10: a full chibi capybara with its props measures
 *     500-810 triangles (avg ~640), not the 200-400 the doc guesses. Segment
 *     counts are already at the chunky-toon floor (4-7 rings); dropping lower
 *     turns the head into a lumpy diamond at the 120px the board shows. Eight
 *     critters come to ~5k triangles, i.e. noise beside the 150k room budget,
 *     while the constraint that actually bites (draw calls) is met with room
 *     to spare.
 *  5. Every model was checked at 120px against its card portrait in cards.js:
 *     the 3D prop matches the 2D `look.prop` (shades / ring / scarf / board /
 *     earmuffs / mug / kelp / crown / moss / pebbles / towel) card for card.
 */

// ---------------------------------------------------------------------------
// palette (mirrors ELEMENTS in cards.js so the 3D show matches the card faces)
// ---------------------------------------------------------------------------

const PAL = {
  sun: { c1: 0xffd070, c2: 0xef942a, deep: 0xc96f16, pale: 0xfff1d6 },
  sea: { c1: 0x7fd0f0, c2: 0x2f95d6, deep: 0x166ba3, pale: 0xddf3ff },
  snow: { c1: 0xf2fbff, c2: 0xa6c9e6, deep: 0x5d7f9e, pale: 0xf4fbff },
  neutral: { c1: 0xe6cfa4, c2: 0xb28a58, deep: 0x7c5a32, pale: 0xfdf1dc },
};
const INK = 0x241a12;
const CREAM = 0xfff2dc;
const PINK = 0xf0959f;
const CORAL = 0xe8657a;
const GOLD = 0xf2b64a;
const LEAF = 0x7ac74f;
const WOOD = 0x8a6642;

// chibi proportions, authored so the top of the skull lands at y = 1.20
const HEAD_Y = 0.90;
const HEAD_Z = 0.02;
const ARM_Y = 0.52;
const EYE_Y = 0.05;
const TOP = 1.24; // including ear tips

const DUR = { attack: 0.7, hurt: 0.42, ko: 0.95, cheer: 1.1 };

/** sRGB byte mix, for tinting a fur colour lighter/darker without a Color. */
function mixHex(a, b, k) {
  const ar = (a >> 16) & 255; const ag = (a >> 8) & 255; const ab = a & 255;
  const br = (b >> 16) & 255; const bg = (b >> 8) & 255; const bb = b & 255;
  return ((Math.round(ar + (br - ar) * k) << 16)
    | (Math.round(ag + (bg - ag) * k) << 8)
    | Math.round(ab + (bb - ab) * k));
}
const lighten = (c, k = 0.35) => mixHex(c, 0xffffff, k);
const darken = (c, k = 0.35) => mixHex(c, 0x1c150e, k);

// ---------------------------------------------------------------------------
// shared-resource cache: refcounted so the LAST dispose() actually frees
// ---------------------------------------------------------------------------

const CACHE = new Map();

function acquire(key, make) {
  let e = CACHE.get(key);
  if (!e) { e = { v: make(), refs: 0 }; CACHE.set(key, e); }
  e.refs++;
  return e.v;
}

function release(key) {
  const e = CACHE.get(key);
  if (!e) return;
  e.refs--;
  if (e.refs > 0) return;
  CACHE.delete(key);
  const v = e.v;
  if (!v) return;
  if (v.isBufferGeometry) { v.dispose(); return; }
  for (const k of Object.keys(v)) {
    const g = v[k];
    if (g && g.isBufferGeometry) g.dispose();
  }
}

let MAT_FUR = null;
let MAT_GLOW = null;
let MAT_BLOB = null;

/** One shared toon material for every opaque part of every critter. */
function furMat() {
  if (!MAT_FUR) MAT_FUR = makeToon(0xffffff, { vertexColors: true });
  return MAT_FUR;
}
/** Unlit variant, for the Great Ancient's lit eyes. */
function glowMat() {
  if (!MAT_GLOW) {
    MAT_GLOW = new THREE.MeshBasicMaterial({ vertexColors: true });
    MAT_GLOW.userData.shared = true;
  }
  return MAT_GLOW;
}
function blobMat() {
  if (!MAT_BLOB) {
    MAT_BLOB = new THREE.MeshBasicMaterial({
      color: 0x2a2018, transparent: true, opacity: 0.19, depthWrite: false,
    });
    MAT_BLOB.userData.shared = true;
  }
  return MAT_BLOB;
}

// ---------------------------------------------------------------------------
// geometry kit: primitives are built per card, merged, then thrown away
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();

function prims() {
  const map = new Map();
  const get = (k, f) => { let g = map.get(k); if (!g) { g = f(); map.set(k, g); } return g; };
  return {
    sph: (w = 4, h = 3) => get(`s${w}.${h}`, () => new THREE.SphereGeometry(1, w, h)),
    box: () => get('box', () => new THREE.BoxGeometry(1, 1, 1)),
    cone: (s = 4) => get(`c${s}`, () => new THREE.ConeGeometry(1, 1, s)),
    cyl: (s = 6, open = false) => get(`y${s}${open ? 'o' : ''}`,
      () => new THREE.CylinderGeometry(1, 1, 1, s, 1, open)),
    tor: (tube = 0.3, rs = 3, ts = 8, arc = Math.PI * 2) => get(`t${tube}.${rs}.${ts}.${arc.toFixed(2)}`,
      () => new THREE.TorusGeometry(1, tube, rs, ts, arc)),
    tet: () => get('tet', () => new THREE.TetrahedronGeometry(1)),
    disc: (s = 12) => get(`d${s}`, () => new THREE.CircleGeometry(1, s)),
    free: () => { for (const g of map.values()) g.dispose(); map.clear(); },
  };
}

/** One merged piece: source geometry + colour + placement. */
function P(g, hex, pos, scale, rot) { return { g, hex, pos, scale, rot }; }

/** Front surface of an ellipsoid, so face details sit ON the muzzle instead of
 *  sinking into it (the same trick avatar.js uses for its beads and grin). */
function frontZ(e, x, y, out = 0) {
  const dx = (x - e.c[0]) / e.r[0];
  const dy = (y - e.c[1]) / e.r[1];
  return e.c[2] + e.r[2] * Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy)) + out;
}

/**
 * Merge parts into one indexed geometry carrying a baked linear `color`
 * attribute, then scale the result uniformly (the per-card size multiplier).
 */
function mergeParts(parts, uniform = 1) {
  if (!parts || !parts.length) return null;
  let vTotal = 0;
  let iTotal = 0;
  const prep = [];
  for (const p of parts) {
    const g = p.g.clone();
    const s = p.scale;
    _sc.set(
      typeof s === 'number' ? s : (s?.[0] ?? 1),
      typeof s === 'number' ? s : (s?.[1] ?? 1),
      typeof s === 'number' ? s : (s?.[2] ?? 1),
    );
    _e.set(p.rot?.[0] || 0, p.rot?.[1] || 0, p.rot?.[2] || 0);
    _m4.compose(_v.set(p.pos?.[0] || 0, p.pos?.[1] || 0, p.pos?.[2] || 0), _q.setFromEuler(_e), _sc);
    g.applyMatrix4(_m4);
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
    _col.setHex(p.hex ?? 0xffffff); // -> working (linear) space, like makeToon
    prep.push([g, _col.r, _col.g, _col.b]);
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const [g, r, gr, b] of prep) {
    const A = g.attributes.position;
    pos.set(A.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    for (let i = 0; i < A.count; i++) {
      col[(vo + i) * 3] = r;
      col[(vo + i) * 3 + 1] = gr;
      col[(vo + i) * 3 + 2] = b;
    }
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo;
      io += a.length;
    } else {
      for (let i = 0; i < A.count; i++) idx[io + i] = vo + i;
      io += A.count;
    }
    vo += A.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  if (uniform !== 1) out.scale(uniform, uniform, uniform);
  out.computeBoundingSphere();
  // other copies of this card are still drawing it: never let a scene sweep
  // (disposeObject) free it. buildCritter's refcount owns its lifetime.
  out.userData.shared = true;
  return out;
}

// ---------------------------------------------------------------------------
// the base capybara, then the props that turn it into a specific card
// ---------------------------------------------------------------------------

function baseCapy(p, S, rig, d) {
  const fur = d.fur;
  // Cream is DERIVED from the fur, exactly like the avatar's baked tint (belly,
  // muzzle and paw tips are a lighter version of the body colour, never a fixed
  // white): that is what keeps a blue critter and a gold one in one family.
  const cream = d.cream || lighten(fur, 0.58);
  const bx = d.bx ?? 1; const by = d.by ?? 1; const bz = d.bz ?? 1;
  const lift = d.lift || 0;
  const hs = d.hs ?? 1;

  // torso egg + one big cream tummy + stub feet + nub tail
  S.body.push(P(p.sph(7, 5), fur, [0, 0.44 + lift, -0.01], [0.34 * bx, 0.345 * by, 0.305 * bz]));
  S.body.push(P(p.sph(5, 4), cream, [0, 0.40 + lift, 0.15 * bz], [0.245 * bx, 0.25 * by, 0.19 * bz]));
  for (const sd of [-1, 1]) {
    S.body.push(P(p.sph(4, 3), cream, [sd * 0.15 * bx, 0.075 + lift, 0.085], [0.115, 0.078, 0.145]));
  }
  S.body.push(P(p.sph(4, 3), fur, [0, 0.36 + lift, -0.30 * bz], [0.08, 0.088, 0.072]));

  // stub arms hang from the shoulder pivot (the arms group), cream paw tips
  const splay = d.splay ?? 0.16;
  for (const sd of [-1, 1]) {
    S.arms.push(P(p.sph(4, 3), fur, [sd * 0.315 * bx, -0.085, 0.02], [0.1, 0.15, 0.1], [0, 0, -sd * splay]));
    S.arms.push(P(p.sph(4, 3), cream, [sd * (0.325 * bx + splay * 0.14), -0.2, 0.05], [0.088, 0.075, 0.095]));
  }

  // head: skull + the blunt capy muzzle, with nose and grin ON its front face
  const MZ = { c: [0, -0.11 * hs, 0.225 * hs], r: [0.225 * hs, 0.135 * hs, 0.185 * hs] };
  S.head.push(P(p.sph(7, 5), fur, [0, 0, 0], [0.325 * hs, 0.30 * hs, 0.30 * hs]));
  S.head.push(P(p.sph(5, 4), cream, MZ.c, MZ.r));
  S.head.push(P(p.sph(4, 3), INK, [0, -0.055 * hs, frontZ(MZ, 0, -0.055 * hs, -0.02)], [0.075, 0.05, 0.05]));
  for (const sd of [-1, 1]) {
    const my = -0.165 * hs;
    S.head.push(P(p.sph(4, 3), INK, [sd * 0.055 * hs, my, frontZ(MZ, sd * 0.055 * hs, my, -0.012)],
      [0.052, 0.024, 0.035], [0, 0, sd * 0.34]));
  }
  if (d.blush !== false) {
    for (const sd of [-1, 1]) {
      S.head.push(P(p.sph(4, 3), PINK, [sd * 0.25 * hs, -0.035 * hs, 0.185 * hs], [0.06, 0.042, 0.04]));
    }
  }

  // ears live in their own mesh so a flick can rotate the pair
  const ez = (d.earUp ? 0.02 : -0.03) * hs;
  const ey = (d.earUp ? 0.235 : 0.215) * hs;
  for (const sd of [-1, 1]) {
    S.ears.push(P(p.sph(4, 3), fur, [sd * 0.22 * hs, ey, ez], [0.098, 0.092, 0.062]));
    S.ears.push(P(p.sph(4, 3), PINK, [sd * 0.22 * hs, ey - 0.012, ez + 0.036], [0.05, 0.046, 0.034]));
  }

  // eyes: their own mesh, geometry centred on y=0 so a blink squashes in place
  if (!d.noEyes) {
    const sq = d.squint ?? 1;
    const ec = d.eyeColor ?? INK;
    for (const sd of [-1, 1]) {
      S.eyes.push(P(p.sph(5, 4), ec, [sd * 0.145 * hs, 0, 0.245 * hs], [0.07, 0.082 * sq, 0.06]));
      S.eyes.push(P(p.tet(), 0xfffaf0, [sd * 0.168 * hs, 0.035 * sq, 0.285 * hs], 0.032, [0.4, 0.5, 0]));
    }
  }

  rig.headY = HEAD_Y + lift;
  rig.armY = ARM_Y + lift;
  rig.headZ = HEAD_Z;
  rig.tic = { x: 0, y: HEAD_Y + lift - 0.09, z: 0.36 };
}

// ---- reusable props -------------------------------------------------------

/** Chunky sunglasses. `up` parks them on the brow instead of over the eyes. */
function propShades(p, S, hs, up = false) {
  const y = (up ? 0.175 : 0.055) * hs;
  const z = (up ? 0.235 : 0.285) * hs;
  const tilt = up ? -0.5 : 0;
  S.head.push(P(p.box(), 0x2f2a3a, [0, y, z], [0.45 * hs, 0.055, 0.045], [tilt, 0, 0]));
  for (const sd of [-1, 1]) {
    S.head.push(P(p.box(), 0x2f2a3a, [sd * 0.145 * hs, y - 0.005, z + 0.015], [0.185 * hs, 0.13, 0.04], [tilt, 0, 0]));
  }
  S.head.push(P(p.box(), 0xfff6e3, [-0.185 * hs, y + 0.02, z + 0.04], [0.055, 0.03, 0.012], [tilt, 0, 0.6]));
}

/** Knitted scarf: a ring at the neck plus a trailing flap. */
function propScarf(p, S, color, trail = 1) {
  const dark = darken(color, 0.22);
  S.body.push(P(p.tor(0.36, 3, 9), color, [0, 0.695, 0.02], [0.265, 0.265, 0.245], [Math.PI / 2, 0, 0]));
  S.body.push(P(p.box(), dark, [0.235, 0.55 - 0.05 * trail, 0.02 - 0.16 * trail],
    [0.135, 0.34 * trail, 0.06], [0.35 * trail, 0, 0.5]));
  if (trail > 1) {
    S.body.push(P(p.box(), color, [-0.24, 0.62, -0.3], [0.12, 0.34, 0.055], [1.05, 0, -0.6]));
  }
}

/** Surfboard: rounded oval with a stripe. */
function propBoard(p, S, c1, c2, pos, rot, len = 0.46) {
  S.body.push(P(p.sph(6, 4), c1, pos, [0.135, len, 0.05], rot));
  S.body.push(P(p.box(), c2, [pos[0], pos[1], pos[2] + 0.05], [0.035, len * 1.35, 0.02], rot));
}

/** Radiating gold sunbeam spikes around the skull. */
function propBeams(p, S, hs, n, r, len, color = GOLD, from = -0.5, to = 0.5) {
  for (let i = 0; i < n; i++) {
    const a = from * Math.PI + ((to - from) * Math.PI * i) / (n - 1);
    S.head.push(P(p.cone(4), color,
      [Math.sin(a) * r * hs, Math.cos(a) * r * hs, -0.02],
      [0.035, len, 0.035], [0, 0, -a]));
  }
}

/** Flat kelp / moss blades hanging off a point. */
function propBlades(p, S, list, color) {
  for (const [x, y, z, w, h, rx, rz] of list) {
    S.head.push(P(p.box(), color, [x, y, z], [w, h, 0.03], [rx || 0, 0, rz || 0]));
  }
}

// ---------------------------------------------------------------------------
// THE 14 CARDS. `dress` runs after baseCapy and may push extra parts or move
// the rest pose / element-tic anchor around.
// ---------------------------------------------------------------------------

const CRITTERS = {
  pebble_pal: {
    name: 'Pebble Pal', el: 'neutral', fur: 0xa9a79c, cream: 0xe6e2d6, size: 0.86,
    bx: 1.16, by: 0.88, bz: 1.1, hs: 0.96, blush: false, squint: 1.12,
    dress(p, S, rig, d) {
      // a boulder doing its best: flat-ish stone plates, worried brows, pebbles
      for (const [x, y, z, s] of [[-0.24, 0.55, 0.02, 0.13], [0.26, 0.42, -0.06, 0.11], [0.05, 0.66, -0.18, 0.1]]) {
        S.body.push(P(p.sph(4, 3), lighten(d.fur, 0.18), [x, y, z], [s, s * 0.7, s]));
      }
      for (const [x, z, s] of [[-0.36, 0.19, 0.075], [0.38, 0.1, 0.06], [0.2, 0.32, 0.05]]) {
        S.body.push(P(p.sph(4, 3), darken(d.fur, 0.2), [x, s * 0.6, z], [s, s * 0.7, s]));
      }
      for (const sd of [-1, 1]) {
        S.head.push(P(p.box(), INK, [sd * 0.14, 0.135, 0.26], [0.13, 0.032, 0.03], [0, 0, sd * 0.42]));
      }
    },
  },

  sunny_pup: {
    name: 'Sunny Pup', el: 'sun', fur: 0xe9a94f, size: 0.9, halo: true, haloR: 0.3,
    earUp: true, noEyes: true, by: 0.96,
    dress(p, S, rig, d) {
      propShades(p, S, 1, false);
      // a cheeky sun tuft, and a warm chest patch
      S.head.push(P(p.cone(5), GOLD, [0.03, 0.30, 0.02], [0.07, 0.16, 0.07], [0, 0, -0.35]));
      S.body.push(P(p.sph(4, 3), lighten(d.fur, 0.3), [0, 0.53, 0.24], [0.11, 0.1, 0.06]));
      rig.rest.tilt = -0.04;
    },
  },

  puddle_sitter: {
    name: 'Puddle Sitter', el: 'sea', fur: 0x79b0cc, size: 0.92,
    bx: 1.1, by: 0.84, bz: 1.05, squint: 0.5,
    dress(p, S, rig, d) {
      // sat in a swim ring, in a puddle, since Tuesday
      S.body.push(P(p.tor(0.34, 4, 10), 0x4fb3e8, [0, 0.34, 0.01], [0.38, 0.38, 0.38], [Math.PI / 2, 0, 0]));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.6;
        S.body.push(P(p.sph(4, 3), CREAM, [Math.sin(a) * 0.38, 0.34, Math.cos(a) * 0.38], [0.1, 0.1, 0.1]));
      }
      S.body.push(P(p.disc(14), mixHex(0x4fb3e8, 0xffffff, 0.25), [0, 0.012, 0.02], [0.52, 0.44, 1], [-Math.PI / 2, 0, 0]));
      for (const sd of [-1, 1]) {
        S.head.push(P(p.box(), darken(d.fur, 0.25), [sd * 0.135, 0.115, 0.245], [0.12, 0.028, 0.03], [0, 0, -sd * 0.1]));
      }
      rig.rest.y = -0.02;
      rig.tic = { x: 0.28, y: 0.5, z: 0.1 };
    },
  },

  snow_nibbler: {
    name: 'Snow Nibbler', el: 'snow', fur: 0xd7e3ef, cream: 0xfdfdff, size: 0.86,
    bx: 0.96, by: 0.98,
    dress(p, S, rig, d) {
      propScarf(p, S, CORAL, 1);
      // a crust of blue ice on the head: white-on-white would vanish
      S.head.push(P(p.sph(5, 4), 0xa6c9e6, [0, 0.245, -0.03], [0.25, 0.1, 0.23]));
      for (const [x, z, h] of [[-0.12, 0.02, 0.15], [0.11, -0.08, 0.19], [0.02, 0.1, 0.12]]) {
        S.head.push(P(p.cone(4), 0xd9edff, [x, 0.3, z], [0.055, h, 0.055], [0.1, 0, -x * 1.2]));
      }
      rig.rest.tilt = 0.09;
      rig.rest.headTilt = -0.06;
    },
  },

  beach_bum: {
    name: 'Beach Bum', el: 'sun', fur: 0xdc9d55, size: 1.0, halo: true, haloR: 0.32,
    bx: 1.06, by: 0.96, squint: 0.62,
    dress(p, S, rig, d) {
      propShades(p, S, 1, true); // parked on the brow: he is not going anywhere
      // striped towel slung over one shoulder, hanging down the back
      const stripes = [CORAL, CREAM, CORAL, CREAM, CORAL];
      for (let i = 0; i < stripes.length; i++) {
        S.body.push(P(p.box(), stripes[i], [-0.16, 0.7 - i * 0.105, -0.06 - i * 0.05],
          [0.34, 0.105, 0.34], [0.5 - i * 0.06, 0, 0.5]));
      }
      // and a cold drink he is definitely not sharing
      S.arms.push(P(p.cyl(7), 0xef7f9a, [0.3, -0.2, 0.16], [0.1, 0.12, 0.1]));
      S.arms.push(P(p.box(), CREAM, [0.33, -0.05, 0.18], [0.022, 0.2, 0.022], [0.1, 0, 0.35]));
      rig.rest.tilt = -0.06;
      rig.rest.arm = -0.1;
    },
  },

  surf_scout: {
    name: 'Surf Scout', el: 'sea', fur: 0x63a3c6, size: 1.0, earUp: true,
    dress(p, S, rig, d) {
      // board carried upright at his side: it has to break the silhouette
      propBoard(p, S, 0xfff2dc, CORAL, [0.44, 0.6, -0.06], [0.1, 0.2, 0.28], 0.52);
      S.body.push(P(p.box(), darken(d.fur, 0.22), [0, 0.56, 0.03], [0.64, 0.08, 0.5], [0, 0, 0.35]));
      rig.rest.tilt = 0.07;
      rig.rest.arm = -0.25;
    },
  },

  frost_friend: {
    name: 'Frost Friend', el: 'snow', fur: 0xc2d6e6, cream: 0xfdfdff, size: 1.04,
    bx: 1.12, by: 1.02, bz: 1.08, splay: 0.42,
    dress(p, S, rig, d) {
      // earmuffs: wooden band over the skull, two fat coral pads (cream pads
      // would vanish into the frost-white fur)
      S.head.push(P(p.tor(0.055, 3, 7, Math.PI * 0.92), WOOD, [0, 0.06, -0.02], [0.34, 0.34, 0.34], [0, 0, -0.04]));
      for (const sd of [-1, 1]) {
        S.head.push(P(p.sph(5, 4), CORAL, [sd * 0.315, 0.055, -0.01], [0.105, 0.14, 0.13]));
        S.head.push(P(p.sph(4, 3), mixHex(CORAL, 0xffffff, 0.5), [sd * 0.385, 0.055, -0.01], [0.045, 0.09, 0.08]));
      }
      rig.rest.arm = -0.42; // arms out, ready for a hug
    },
  },

  ray_ray: {
    name: 'Ray Ray', el: 'sun', fur: 0xf0b45c, size: 1.06, halo: true, haloR: 0.38,
    noEyes: true, earUp: true, by: 1.04,
    dress(p, S, rig, d) {
      propShades(p, S, 1, false);
      propBeams(p, S, 1, 7, 0.42, 0.28, GOLD, -0.66, 0.66);
      S.body.push(P(p.sph(5, 4), GOLD, [0, 0.52, 0.26], [0.15, 0.15, 0.05]));
      rig.rest.tilt = -0.08;
      rig.rest.arm = -0.2;
    },
  },

  wave_rider: {
    name: 'Wave Rider', el: 'sea', fur: 0x5195bd, size: 1.0, lift: 0.14, splay: 0.34,
    dress(p, S, rig, d) {
      // stood on a board that cuts across frame, on a curling crest. The board
      // is warm on purpose: a pale board on a pale wave was one white smudge.
      S.body.push(P(p.sph(6, 4), GOLD, [0, 0.055, 0.02], [0.17, 0.05, 0.6], [0, 0.85, 0.05]));
      S.body.push(P(p.box(), CORAL, [0, 0.085, 0.02], [0.045, 0.02, 0.92], [0, 0.85, 0.05]));
      for (const [x, y, z, s, f] of [[-0.46, 0.05, -0.2, 0.3, 0.75], [0.42, 0.03, 0.2, 0.24, 0.6], [0.1, 0.02, -0.44, 0.28, 0.5]]) {
        S.body.push(P(p.sph(5, 4), 0x2f95d6, [x, y, z], [s, s * f, s * 0.8]));
      }
      S.body.push(P(p.sph(5, 4), 0x4fb3e8, [-0.5, 0.22, -0.12], [0.2, 0.26, 0.16], [0, 0, 0.3]));
      S.body.push(P(p.sph(4, 3), 0xeafaff, [-0.52, 0.36, -0.14], [0.13, 0.09, 0.11]));
      rig.rest.tilt = 0.12;
      rig.rest.roll = 0.1;
      rig.rest.arm = -0.5;
      rig.tic = { x: -0.3, y: 0.3, z: 0.1 };
    },
  },

  cocoa_courier: {
    name: 'Cocoa Courier', el: 'snow', fur: 0xc8b8a2, size: 1.0,
    dress(p, S, rig, d) {
      propScarf(p, S, 0x5fa8d8, 1);
      // the mug rides in the ARMS mesh so it swings with the delivery
      S.arms.push(P(p.cyl(8), CREAM, [0, -0.18, 0.3], [0.15, 0.2, 0.15]));
      S.arms.push(P(p.tor(0.26, 3, 6, Math.PI), CREAM, [0.155, -0.18, 0.3], [0.095, 0.095, 0.085], [0, Math.PI / 2, -1.6]));
      S.arms.push(P(p.cyl(8), CORAL, [0, -0.22, 0.3], [0.157, 0.055, 0.157]));
      S.arms.push(P(p.cyl(8), 0x4a2c1c, [0, -0.075, 0.3], [0.137, 0.025, 0.137]));
      // satchel strap
      S.body.push(P(p.box(), WOOD, [0, 0.5, 0.06], [0.62, 0.075, 0.46], [0, 0, -0.5]));
      S.body.push(P(p.box(), darken(WOOD, 0.2), [-0.3, 0.32, -0.14], [0.2, 0.19, 0.14], [0, 0.3, 0]));
      rig.rest.arm = -0.55;
      rig.tic = { x: 0, y: 0.66, z: 0.34 }; // steam off the cocoa
    },
  },

  tide_elder: {
    name: 'Tide Elder', el: 'sea', fur: 0x4a86ac, size: 1.16,
    bx: 1.08, by: 1.02, bz: 1.06, squint: 0.72,
    dress(p, S, rig, d) {
      // kelp drape over the skull, kelp beard, barnacles on the shell of a back
      propBlades(p, S, [
        [-0.3, 0.06, 0.02, 0.09, 0.34, 0.1, 0.25],
        [-0.12, 0.16, -0.14, 0.1, 0.3, 0.3, 0.1],
        [0.14, 0.16, -0.14, 0.1, 0.32, 0.3, -0.1],
        [0.31, 0.04, 0.02, 0.09, 0.3, 0.1, -0.28],
      ], 0x4f9c5a);
      for (const sd of [-1, 1]) {
        S.head.push(P(p.box(), 0x6fbf74, [sd * 0.085, -0.28, 0.29], [0.1, 0.26, 0.035], [0.2, 0, sd * 0.14]));
      }
      for (const [x, y, z, s] of [[-0.22, 0.62, -0.26, 0.1], [0.18, 0.5, -0.3, 0.085], [0.02, 0.68, -0.24, 0.07]]) {
        S.body.push(P(p.cone(5), CREAM, [x, y, z], [s, s * 0.9, s], [-0.5, 0, 0]));
      }
      for (const sd of [-1, 1]) {
        S.head.push(P(p.box(), lighten(d.fur, 0.25), [sd * 0.15, 0.14, 0.245], [0.16, 0.045, 0.035], [0, 0, -sd * 0.16]));
      }
      rig.rest.tilt = 0.09;
      rig.rest.headTilt = 0.07;
      rig.rest.arm = -0.12;
    },
  },

  blizzard_buddy: {
    name: 'Blizzard Buddy', el: 'snow', fur: 0xe6eff8, cream: 0xffffff, size: 1.16,
    bx: 1.14, by: 1.0, bz: 1.06, earUp: true,
    dress(p, S, rig, d) {
      propScarf(p, S, 0x3f8fd0, 2); // whipping sideways, at speed
      S.head.push(P(p.sph(5, 4), 0xbcd8ee, [0, 0.26, -0.06], [0.27, 0.13, 0.25]));
      S.head.push(P(p.cone(5), 0xdcefff, [-0.13, 0.35, -0.12], [0.1, 0.24, 0.1], [-0.45, 0, 0.6]));
      // snow it brought with it, piled on the shoulders
      for (const [x, y, z, s] of [[-0.4, 0.68, -0.12, 0.15], [0.38, 0.6, -0.18, 0.12]]) {
        S.body.push(P(p.sph(5, 4), 0xdcefff, [x, y, z], [s, s * 0.6, s]));
      }
      rig.rest.tilt = 0.16;
      rig.rest.headTilt = -0.1;
      rig.rest.arm = -0.34;
    },
  },

  solar_elder: {
    name: 'Solar Elder', el: 'sun', fur: 0xe79b3a, size: 1.16, halo: true, haloR: 0.5, haloY: 0.52,
    bx: 1.08, by: 1.04, bz: 1.05, squint: 0.78,
    dress(p, S, rig, d) {
      // a full sun mane, then a proper crown on top of it
      propBeams(p, S, 1, 9, 0.42, 0.17, mixHex(GOLD, 0xffffff, 0.2), -0.72, 0.72);
      S.head.push(P(p.cyl(9, true), GOLD, [0, 0.235, -0.01], [0.235, 0.1, 0.235]));
      for (let i = 0; i < 5; i++) {
        const a = -0.9 + (i / 4) * 1.8;
        S.head.push(P(p.cone(4), GOLD, [Math.sin(a) * 0.22, 0.33, Math.cos(a) * 0.22 - 0.01], [0.05, 0.13, 0.05]));
      }
      S.head.push(P(p.sph(5, 4), 0xfffaf0, [0, -0.33, 0.2], [0.21, 0.15, 0.19]));
      S.head.push(P(p.sph(4, 3), 0xfffaf0, [0, -0.45, 0.14], [0.11, 0.1, 0.11]));
      S.body.push(P(p.sph(5, 4), GOLD, [0, 0.52, 0.26], [0.17, 0.16, 0.06]));
      rig.rest.arm = -0.16;
    },
  },

  great_ancient: {
    name: 'Great Ancient Capy', el: 'neutral', fur: 0x9c9784, cream: 0xd2ccb4, size: 1.66,
    bx: 1.16, by: 1.06, bz: 1.12, hs: 1.06, blush: false, splay: 0.3,
    eyeColor: 0xffc94a, glowEyes: true, squint: 0.6,
    dress(p, S, rig, d) {
      // older than the cove: stone brows, a carved chest plate, moss everywhere
      for (const sd of [-1, 1]) {
        S.head.push(P(p.box(), darken(d.fur, 0.52), [sd * 0.16, 0.155, 0.24], [0.2, 0.06, 0.07], [0, 0, -sd * 0.2]));
      }
      S.body.push(P(p.sph(6, 4), darken(d.fur, 0.42), [0, 0.43, 0.25], [0.3, 0.29, 0.13]));
      S.body.push(P(p.cyl(9), GOLD, [0, 0.45, 0.36], [0.115, 0.02, 0.115], [Math.PI / 2, 0, 0]));
      S.body.push(P(p.cyl(9), darken(GOLD, 0.45), [0, 0.45, 0.375], [0.06, 0.02, 0.06], [Math.PI / 2, 0, 0]));
      for (const [x, y, z, s] of [
        [-0.24, 0.19, 0.02, 0.19], [0.19, 0.18, -0.04, 0.15], [-0.04, 0.27, -0.12, 0.13],
      ]) {
        S.head.push(P(p.sph(5, 4), LEAF, [x, y, z], [s, s * 0.55, s]));
      }
      for (const [x, y, z, s] of [
        [-0.34, 0.68, -0.1, 0.22], [0.3, 0.58, -0.2, 0.18], [0.04, 0.78, -0.06, 0.15],
        [-0.24, 0.26, 0.14, 0.14],
      ]) {
        S.body.push(P(p.sph(5, 4), mixHex(LEAF, 0x4f7f3a, 0.35), [x, y, z], [s, s * 0.5, s]));
      }
      rig.rest.headTilt = 0.05;
    },
  },
};

for (const [id, d] of Object.entries(CRITTERS)) d.id = id;

/** Card ids in docs/CARDGAME.md section-6 table order. */
export const CRITTER_IDS = [
  'pebble_pal', 'sunny_pup', 'puddle_sitter', 'snow_nibbler', 'beach_bum',
  'surf_scout', 'frost_friend', 'ray_ray', 'wave_rider', 'cocoa_courier',
  'tide_elder', 'blizzard_buddy', 'solar_elder', 'great_ancient',
];

const FALLBACK = { id: '_capy', name: 'Capybara', el: 'neutral', fur: 0xb08a5a, size: 1 };

// ---------------------------------------------------------------------------
// bundle build (cached per card id)
// ---------------------------------------------------------------------------

function buildBundle(d) {
  const p = prims();
  const S = { body: [], arms: [], head: [], ears: [], eyes: [] };
  const rig = {
    el: PAL[d.el] ? d.el : 'neutral',
    size: d.size || 1,
    halo: !!d.halo,
    haloR: d.haloR || 0.3,
    haloY: d.haloY ?? 0.34,
    glowEyes: !!d.glowEyes,
    headY: HEAD_Y, headZ: HEAD_Z, armY: ARM_Y, eyeY: EYE_Y,
    rest: { y: 0, tilt: 0, roll: 0, headTilt: 0, arm: 0 },
    tic: { x: 0, y: HEAD_Y - 0.09, z: 0.36 },
  };
  baseCapy(p, S, rig, d);
  if (d.dress) d.dress(p, S, rig, d);

  const s = rig.size;
  const bundle = {
    body: mergeParts(S.body, s),
    arms: mergeParts(S.arms, s),
    head: mergeParts(S.head, s),
    ears: mergeParts(S.ears, s),
    eyes: mergeParts(S.eyes, s),
    rig,
  };
  p.free();

  rig.headY *= s; rig.headZ *= s; rig.armY *= s; rig.eyeY *= s;
  rig.rest.y *= s;
  rig.tic = { x: rig.tic.x * s, y: rig.tic.y * s, z: rig.tic.z * s };
  rig.height = (TOP + (d.lift || 0)) * s;
  rig.blobR = 0.42 * s * (d.bx ?? 1);
  let tris = 0;
  for (const k of ['body', 'arms', 'head', 'ears', 'eyes']) {
    const g = bundle[k];
    if (g) tris += g.index.count / 3;
  }
  rig.tris = tris;
  return bundle;
}

// ---------------------------------------------------------------------------
// motes: one InstancedMesh per critter (and per burst) = one draw call
// ---------------------------------------------------------------------------

function makeMotes(color, cap, opacity = 0.92) {
  const geo = acquire('mote', () => new THREE.OctahedronGeometry(0.5, 0));
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  const ps = [];
  for (let i = 0; i < cap; i++) ps.push({ ttl: 0, life: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, s: 0.1, grow: false, spin: 0 });
  let live = 0;
  const hideAll = () => {
    _m4.compose(_v.set(0, -999, 0), _q.identity(), _sc.set(0, 0, 0));
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _m4);
    mesh.instanceMatrix.needsUpdate = true;
  };
  hideAll();
  return {
    mesh,
    emit(o) {
      for (let i = 0; i < cap; i++) {
        const q = ps[i];
        if (q.ttl > 0) continue;
        q.ttl = o.life; q.life = o.life;
        q.x = o.x; q.y = o.y; q.z = o.z;
        q.vx = o.vx; q.vy = o.vy; q.vz = o.vz;
        q.g = o.g || 0; q.s = o.s; q.grow = !!o.grow;
        q.spin = (Math.random() - 0.5) * 6;
        live++;
        return;
      }
    },
    update(dt) {
      if (live <= 0) return;
      live = 0;
      for (let i = 0; i < cap; i++) {
        const q = ps[i];
        if (q.ttl <= 0) continue;
        q.ttl -= dt;
        if (q.ttl <= 0) {
          _m4.compose(_v.set(0, -999, 0), _q.identity(), _sc.set(0, 0, 0));
          mesh.setMatrixAt(i, _m4);
          continue;
        }
        live++;
        q.vy -= q.g * dt;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        const u = 1 - q.ttl / q.life;
        const k = q.grow ? Math.sin(Math.min(1, u) * Math.PI) : 1 - u * u;
        const s = Math.max(0.0001, q.s * k);
        _e.set(u * q.spin, u * q.spin * 1.3, 0);
        _m4.compose(_v.set(q.x, q.y, q.z), _q.setFromEuler(_e), _sc.set(s, s, s));
        mesh.setMatrixAt(i, _m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      mesh.dispose();
      mat.dispose();
      release('mote');
    },
  };
}

// ---------------------------------------------------------------------------
// buildCritter
// ---------------------------------------------------------------------------

/**
 * One summoned critter. See the API block at the top of this file.
 * @param {string} cardId a critter id from CRITTER_IDS
 */
export function buildCritter(cardId) {
  const d = CRITTERS[cardId] || FALLBACK;
  const key = `critter:${d.id}`;
  const B = acquire(key, () => buildBundle(d));
  const rig = B.rig;
  const pal = PAL[rig.el];
  const fur = furMat();
  const owned = []; // materials this instance must free

  const group = new THREE.Group();
  group.name = `critter:${d.id}`;

  const bodyG = new THREE.Group();
  group.add(bodyG);
  const bodyMesh = new THREE.Mesh(B.body, fur);
  bodyMesh.castShadow = true;
  bodyG.add(bodyMesh);

  const armsG = new THREE.Group();
  armsG.position.set(0, rig.armY, 0.02 * rig.size);
  bodyG.add(armsG);
  if (B.arms) {
    const armsMesh = new THREE.Mesh(B.arms, fur);
    armsMesh.castShadow = true;
    armsG.add(armsMesh);
  }

  const headG = new THREE.Group();
  headG.position.set(0, rig.headY, rig.headZ);
  bodyG.add(headG);
  const headMesh = new THREE.Mesh(B.head, fur);
  headMesh.castShadow = true;
  headG.add(headMesh);

  const earsMesh = B.ears ? new THREE.Mesh(B.ears, fur) : null;
  if (earsMesh) headG.add(earsMesh);

  const eyesMesh = B.eyes ? new THREE.Mesh(B.eyes, rig.glowEyes ? glowMat() : fur) : null;
  if (eyesMesh) {
    eyesMesh.position.y = rig.eyeY;
    headG.add(eyesMesh);
  }

  // sun critters carry a little sunbeam halo that pulses and turns
  let halo = null;
  if (rig.halo) {
    const hg = acquire('halo', () => new THREE.TorusGeometry(1, 0.085, 3, 12));
    const hm = new THREE.MeshBasicMaterial({
      color: pal.c1, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
    });
    owned.push(hm);
    halo = new THREE.Mesh(hg, hm);
    halo.scale.setScalar(rig.haloR * rig.size);
    halo.position.set(0, rig.haloY * rig.size, -0.02 * rig.size);
    halo.rotation.set(-Math.PI / 2 + 0.3, 0, 0);
    headG.add(halo);
  }

  // fake contact shadow so a critter never looks like it is hovering
  const blobG = acquire('blob', () => new THREE.CircleGeometry(1, 16));
  const blob = new THREE.Mesh(blobG, blobMat());
  blob.name = 'blob';
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.012;
  blob.scale.setScalar(rig.blobR);
  group.add(blob);

  const motes = makeMotes(rig.el === 'snow' ? 0xffffff : pal.c1, 12, rig.el === 'sun' ? 0.85 : 0.9);
  group.add(motes.mesh);

  const api = {
    id: d.id,
    name: d.name || 'Capybara',
    el: rig.el,
    height: rig.height,
    tris: rig.tris,
    speed: 1,
    group,
    update,
    play,
    dispose,
  };

  const st = {
    t: Math.random() * 8,
    blinkIn: 0.6 + Math.random() * 3.4,
    blinkT: 0,
    flickIn: 2 + Math.random() * 4,
    flickT: 0,
    hopIn: 3 + Math.random() * 4,
    hopT: 0,
    ticIn: 0.6 + Math.random() * 1.6,
    ov: null,
    dead: false,
  };

  const S = rig.size;
  const ease = (u) => u * u * (3 - 2 * u);

  function elementTic() {
    const c = rig.tic;
    const r = () => (Math.random() - 0.5);
    if (rig.el === 'snow') {
      // breath puffs: they bloom in front of the muzzle then thin out
      st.ticIn = 2.2 + Math.random() * 1.4;
      for (let i = 0; i < 3; i++) {
        motes.emit({
          x: c.x + r() * 0.06, y: c.y + r() * 0.05, z: c.z + i * 0.04 * S,
          vx: r() * 0.1, vy: 0.16 + Math.random() * 0.1, vz: (0.18 + i * 0.05) * S,
          g: 0, s: (0.09 + Math.random() * 0.05) * S, life: 0.7 + i * 0.12, grow: true,
        });
      }
    } else if (rig.el === 'sea') {
      // drips that gather on the fur and fall off
      st.ticIn = 1.6 + Math.random() * 1.2;
      const n = 1 + (Math.random() < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        motes.emit({
          x: (c.x + r() * 0.5) * (i ? -0.8 : 1), y: (0.35 + Math.random() * 0.45) * S, z: (0.1 + r() * 0.4) * S,
          vx: r() * 0.05, vy: 0.05, vz: r() * 0.05,
          g: 1.6, s: 0.075 * S, life: 0.75, grow: false,
        });
      }
    } else if (rig.el === 'sun') {
      // a slow warm sparkle drifting up off the halo
      st.ticIn = 1.3 + Math.random() * 1.1;
      const a = Math.random() * Math.PI * 2;
      motes.emit({
        x: Math.sin(a) * rig.haloR * S, y: (rig.headY / S + 0.3) * S, z: Math.cos(a) * rig.haloR * S - 0.02,
        vx: Math.sin(a) * 0.12, vy: 0.22, vz: Math.cos(a) * 0.12,
        g: 0, s: 0.085 * S, life: 0.85, grow: true,
      });
    } else {
      // neutral: a puff of cove dust off the feet
      st.ticIn = 3 + Math.random() * 2.5;
      for (let i = 0; i < 2; i++) {
        motes.emit({
          x: (i ? 0.28 : -0.28) * S, y: 0.06 * S, z: 0.1 * S,
          vx: (i ? 0.16 : -0.16), vy: 0.14, vz: 0.05,
          g: 0.2, s: 0.08 * S, life: 0.6, grow: true,
        });
      }
    }
  }

  function puff(n, up) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      motes.emit({
        x: Math.sin(a) * 0.2 * S, y: 0.05 * S, z: Math.cos(a) * 0.2 * S,
        vx: Math.sin(a) * 0.5, vy: up, vz: Math.cos(a) * 0.5,
        g: 0.6, s: 0.09 * S, life: 0.45, grow: true,
      });
    }
  }

  /** @param {number} dt seconds */
  function update(dt) {
    const step = Math.min(0.08, Math.max(0, dt)) * api.speed;
    st.t += step;
    const t = st.t;

    // rest pose first: overlays paint onto a clean rig, nothing leaks between
    bodyG.position.set(0, rig.rest.y, 0);
    bodyG.rotation.set(rig.rest.tilt, 0, rig.rest.roll);
    bodyG.scale.set(1, 1, 1);
    headG.position.set(0, rig.headY, rig.headZ);
    headG.rotation.set(rig.rest.headTilt, 0, 0);
    armsG.rotation.set(rig.rest.arm, 0, 0);
    if (earsMesh) earsMesh.rotation.set(0, 0, 0);
    let blink = 1;
    let blobK = 1;

    if (!st.dead) {
      // ---- idle life ------------------------------------------------------
      const br = Math.sin(t * 2.15);
      bodyG.scale.y = 1 + br * 0.024;
      bodyG.scale.x = 1 - br * 0.015;
      bodyG.scale.z = bodyG.scale.x;
      bodyG.rotation.z += Math.sin(t * 0.83) * 0.03;
      headG.position.y += br * 0.012 * S;
      headG.rotation.y = Math.sin(t * 0.61) * 0.14;
      headG.rotation.z = Math.sin(t * 1.11) * 0.05;
      headG.rotation.x += Math.sin(t * 1.9) * 0.03;
      armsG.rotation.x += Math.sin(t * 2.15 + 0.7) * 0.1;

      // weight shift: a little foot shuffle every few seconds
      st.hopIn -= step;
      if (st.hopIn <= 0) { st.hopIn = 3.4 + Math.random() * 3.6; st.hopT = 0.42; }
      if (st.hopT > 0) {
        st.hopT = Math.max(0, st.hopT - step);
        const k = Math.sin((1 - st.hopT / 0.42) * Math.PI);
        bodyG.position.y += k * 0.035 * S;
        bodyG.rotation.z += k * 0.06;
        bodyG.scale.y *= 1 + k * 0.02;
      }

      // blink (a quarter of them double up: reads far more alive)
      st.blinkIn -= step;
      if (st.blinkIn <= 0) {
        st.blinkIn = Math.random() < 0.24 ? 0.3 : 2.4 + Math.random() * 3.6;
        st.blinkT = 0.14;
      }
      if (st.blinkT > 0) {
        st.blinkT -= step;
        blink = 1 - 0.9 * Math.sin(Math.max(0, st.blinkT) / 0.14 * Math.PI);
      }

      // ear flick
      st.flickIn -= step;
      if (st.flickIn <= 0) { st.flickIn = 2.8 + Math.random() * 4.2; st.flickT = 0.4; }
      if (st.flickT > 0 && earsMesh) {
        st.flickT = Math.max(0, st.flickT - step);
        const u = st.flickT / 0.4;
        const k = Math.sin(u * Math.PI * 3.4) * u * 0.45;
        earsMesh.rotation.x += k;
        earsMesh.rotation.z += k * 0.5;
      }

      // element tic
      st.ticIn -= step;
      if (st.ticIn <= 0) elementTic();

      if (halo) {
        halo.rotation.z += step * 0.7;
        const hp = 1 + Math.sin(t * 1.7) * 0.07;
        halo.scale.setScalar(rig.haloR * S * hp);
        halo.material.opacity = 0.42 + Math.sin(t * 1.7) * 0.12;
      }
    }

    // ---- one-shot overlays, painted on top ---------------------------------
    const ov = st.ov;
    if (ov) {
      ov.t += step;
      const u = Math.min(1, ov.t / ov.dur);

      if (ov.name === 'attack') {
        // anticipation crouch, then a lunge AROUND the origin: the stage is the
        // one that carries the group across the board
        const crouch = u < 0.32 ? ease(u / 0.32) : Math.max(0, 1 - (u - 0.32) / 0.14);
        const lunge = u < 0.32 ? 0 : Math.sin(Math.min(1, (u - 0.32) / 0.68) * Math.PI);
        bodyG.rotation.x += -0.4 * crouch + 0.52 * lunge;
        bodyG.position.z += (-0.11 * crouch + 0.24 * lunge) * S;
        bodyG.position.y += 0.14 * lunge * S;
        bodyG.scale.y *= 1 - 0.15 * crouch + 0.13 * lunge;
        bodyG.scale.x *= 1 + 0.12 * crouch - 0.08 * lunge;
        bodyG.scale.z = bodyG.scale.x;
        armsG.rotation.x += 0.6 * crouch - 1.4 * lunge;
        headG.rotation.x += 0.24 * crouch - 0.3 * lunge;
        if (earsMesh) earsMesh.rotation.x += 0.3 * crouch + 0.5 * lunge;
        if (!ov.fired && u >= 0.32) { ov.fired = true; puff(4, 0.5); }
      } else if (ov.name === 'hurt') {
        // ramp the recoil in over ~2 frames: snapping to full lean on frame one
        // read as "fell over backwards" rather than "took a hit"
        const ramp = Math.min(1, u / 0.13);
        const dec = ramp * (1 - u) * (1 - u);
        // +rotation.x pitches FORWARD (a lunge), so a recoil is the negative:
        // chest up, head snapped back, sliding away from whatever just landed
        bodyG.rotation.x -= 0.42 * dec;
        bodyG.position.z -= 0.16 * dec * S;
        bodyG.rotation.z += Math.sin(u * 58) * 0.1 * (1 - u) * ramp;
        bodyG.scale.y *= 1 - 0.18 * dec;
        bodyG.scale.x *= 1 + 0.16 * dec;
        bodyG.scale.z = bodyG.scale.x;
        headG.rotation.x -= 0.3 * dec;
        armsG.rotation.x += 1.05 * dec;
        if (earsMesh) earsMesh.rotation.x += 0.55 * dec;
        if (u < 0.7) blink = Math.min(blink, 0.22);
      } else if (ov.name === 'ko') {
        if (u < 0.38) {
          // the crack: it holds, trembling, long enough for the room to gasp
          const k = u / 0.38;
          bodyG.rotation.z += Math.sin(u * 74) * 0.05 * (1 - k * 0.35);
          bodyG.rotation.x += 0.12 * k;
          bodyG.scale.y *= 1 - 0.06 * k;
          headG.rotation.x += 0.26 * k;
          if (u > 0.16) blink = 0.1;
        } else {
          // then the collapse-shrink (the stage spawns the shatter motes)
          const k = (u - 0.38) / 0.62;
          const e2 = k * k;
          const sc = Math.max(0, 1 - e2);
          bodyG.rotation.x += 0.12 + 0.6 * e2;
          bodyG.rotation.z += 0.4 * e2;
          bodyG.scale.set(bodyG.scale.x * sc, bodyG.scale.y * sc * 0.92, bodyG.scale.z * sc);
          bodyG.position.y -= 0.06 * e2 * S;
          blink = 0.1;
          blobK = sc;
        }
      } else if (ov.name === 'cheer') {
        const hop = Math.abs(Math.sin(u * Math.PI * 2));
        const fade = 1 - u * 0.35;
        bodyG.position.y += hop * 0.24 * S * fade;
        bodyG.rotation.y += Math.sin(u * Math.PI * 2) * 0.3;
        bodyG.scale.y *= 1 + hop * 0.09 - (1 - hop) * 0.07;
        bodyG.scale.x *= 1 - hop * 0.05 + (1 - hop) * 0.05;
        bodyG.scale.z = bodyG.scale.x;
        armsG.rotation.x -= (0.5 + hop * 1.7) * fade;
        headG.rotation.x -= hop * 0.28;
        if (earsMesh) earsMesh.rotation.x -= hop * 0.35;
        if (!ov.fired && u >= 0.24) { ov.fired = true; puff(5, 1.1); }
      }

      if (u >= 1) {
        if (ov.name === 'ko') {
          st.dead = true;
          group.visible = false;
        }
        st.ov = null;
      }
    }

    if (eyesMesh) eyesMesh.scale.y = blink;
    blob.scale.setScalar(rig.blobR * blobK);
    motes.update(step);
  }

  /**
   * @param {'attack'|'hurt'|'ko'|'cheer'} name
   * @returns {number} duration in seconds (0 if unknown / already KO'd)
   */
  function play(name) {
    if (st.dead) return 0;
    const dur = DUR[name];
    if (!dur) return 0;
    st.ov = { name, t: 0, dur, fired: false };
    if (name === 'ko') st.blinkT = 0;
    return dur / (api.speed || 1);
  }

  function dispose() {
    for (const m of owned) m.dispose();
    owned.length = 0;
    motes.dispose();
    group.clear();
    release('blob');
    if (rig.halo) release('halo');
    release(key);
  }

  update(0); // land on a valid pose before the first frame is drawn
  return api;
}

// ---------------------------------------------------------------------------
// buildElementBurst
// ---------------------------------------------------------------------------

const BURST_DUR = 0.85;

/**
 * One-shot summon / impact flash: a ground ring, a core pop and a spray of
 * element motes. Positioned and pooled by the stage.
 * @param {'sun'|'sea'|'snow'|'neutral'} element
 */
export function buildElementBurst(element) {
  const pal = PAL[element] || PAL.neutral;
  const group = new THREE.Group();
  group.name = `burst:${PAL[element] ? element : 'neutral'}`;
  const mats = [];

  const ringGeo = acquire('bring', () => new THREE.RingGeometry(0.55, 0.82, 20, 1));
  const ringMat = new THREE.MeshBasicMaterial({
    color: pal.c1, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
  });
  mats.push(ringMat);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);

  const coreGeo = acquire('bcore', () => new THREE.SphereGeometry(1, 10, 7));
  const coreMat = new THREE.MeshBasicMaterial({
    color: pal.pale, transparent: true, opacity: 0.95, depthWrite: false,
  });
  mats.push(coreMat);
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.y = 0.45;
  group.add(core);

  const motes = makeMotes(pal.c2, 20, 0.95);
  group.add(motes.mesh);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2 + Math.random() * 0.3;
    const sp = 0.9 + Math.random() * 1.1;
    motes.emit({
      x: Math.sin(a) * 0.12, y: 0.12 + Math.random() * 0.5, z: Math.cos(a) * 0.12,
      vx: Math.sin(a) * sp, vy: 0.7 + Math.random() * 1.5, vz: Math.cos(a) * sp,
      g: 1.9, s: 0.09 + Math.random() * 0.07, life: 0.45 + Math.random() * 0.4, grow: false,
    });
  }

  let t = 0;
  let alive = true;

  /** @returns {boolean} still alive */
  group.update = (dt) => {
    if (!alive) return false;
    t += Math.min(0.08, Math.max(0, dt));
    const u = Math.min(1, t / BURST_DUR);
    const rs = 0.4 + u * 1.5;
    ring.scale.set(rs, rs, 1);
    ringMat.opacity = 0.9 * Math.max(0, 1 - u * 1.35);
    const cs = Math.sin(Math.min(1, u * 2.6) * Math.PI * 0.5) * (1 - u * 0.55);
    core.scale.setScalar(Math.max(0.0001, cs * 0.55));
    coreMat.opacity = 0.95 * Math.max(0, 1 - u * 1.6);
    motes.update(dt);
    if (u >= 1) alive = false;
    return alive;
  };

  group.dispose = () => {
    alive = false;
    motes.dispose();
    for (const m of mats) m.dispose();
    mats.length = 0;
    group.clear();
    release('bring');
    release('bcore');
  };

  return group;
}
