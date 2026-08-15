import * as THREE from 'three';

/**
 * Walk trails and idle auras: the cove's flourish slot.
 *
 * WHAT THIS IS
 * ------------
 * A capybara who has been around leaves something behind them: petals off the
 * plaza blossom, a scatter of paw sparkles, a ribbon of colour for the truly
 * fancy. Standing still, the fancier flourishes settle into an aura: a soft
 * glow ring at the paws, a few stars drifting overhead, three butterflies doing
 * laps. It is the cove's coin SINK that costs the player nothing but coins and
 * gives back something everyone else can see.
 *
 * HOW IT IS BUILT (read this before adding an effect)
 * --------------------------------------------------
 * ONE pooled system serves EVERY avatar on screen: the player, every remote,
 * every bot. There are exactly THREE draw calls for the whole field no matter
 * how many capybaras are wearing something:
 *
 *   flakes  InstancedMesh(hexagon plane)  petals, leaves, notes, snow, stars,
 *                                         ribbon segments, pawprints, wings
 *   motes   InstancedMesh(icosahedron)    bubbles, embers, fireflies, glow
 *   rings   InstancedMesh(flat ring)      the glow-ring aura, one per wearer
 *
 * Particles are allocated ONCE at first use and recycled forever; nothing in
 * here allocates per frame except the odd number. Live particles are compacted
 * into instance slots 0..n-1 every frame, so an empty cove costs three
 * invisible meshes and nothing else.
 *
 * Fading is done by SHRINKING (flakes, normal blending) or by DIMMING (motes
 * and rings, additive blending). Per-instance opacity would need a patched
 * shader; shrink-out is the toon answer and costs nothing.
 *
 * BUDGET
 * ------
 * The pools are the hard ceiling (MAX_FLAKES / MAX_MOTES). On top of that,
 * emission thins out as the cove fills: past SOFT_WEARERS the interval between
 * puffs stretches and lifetimes shorten, so twenty capybauras in the plaza cost
 * about what six do. Anything further than EMIT_RANGE from the camera's subject
 * does not emit at all.
 *
 * REDUCED MOTION
 * --------------
 * Trails are OFF (nothing is emitted, anything live fades out fast) and auras
 * are STATIC: the ring stops breathing, the stars and butterflies hold their
 * positions and the wings stop flapping. The flourish is still visible - it
 * just does not move. Read through `calm()`, which honours the game's own
 * "Calm animations" toggle as well as the OS flag.
 *
 * OWNERSHIP
 * ---------
 * This file owns everything visual about trails. shared/constants.js owns the
 * catalog's NAMES, PRICES and milestone flags (TRAILS); this file owns the
 * RECIPES, keyed by the same ids, exactly the way src/player/hats.js relates to
 * HATS. Neither imports the other.
 */

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

const MAX_FLAKES = 420;   // hexagon quads: petals, leaves, snow, stars, wings
const MAX_MOTES = 260;    // glow blobs: bubbles, embers, fireflies
const MAX_RINGS = 32;     // one per glow-ring wearer on screen
const SOFT_WEARERS = 6;   // past this, everyone's emission thins out
const EMIT_RANGE = 28;    // units from the local player; beyond this, no emit
const EMIT_RANGE_SQ = EMIT_RANGE * EMIT_RANGE;
const FULL_MARK = 0.86;   // pool fraction past which nobody may start a puff

// ---------------------------------------------------------------------------
// the catalog: recipes only. Names/prices/milestone live in shared/constants.js
// ---------------------------------------------------------------------------

/**
 * Emission recipe fields (all optional unless noted):
 *   pool     'flake' | 'mote'                                        REQUIRED
 *   every    seconds of walking between puffs
 *   everyD   units WALKED between puffs (use instead of `every` when the
 *            spacing should be the same at every speed, e.g. pawprints)
 *   n        [min, max] particles per puff
 *   ttl      [min, max] seconds
 *   size     [min, max] units
 *   ratio    [x, y] shape stretch, 1,1 = round
 *   rise     [min, max] initial upward speed
 *   side     lateral/backward scatter speed
 *   grav     vertical acceleration (negative falls)
 *   drag     velocity damping per second (0 = none, 1 = stops dead)
 *   spin     [min, max] radians/sec of tumble
 *   flat     lie the quad on the ground (pawprints, ripples)
 *   trailBack how far behind the walk direction to spawn
 *   y        spawn height above the paws
 *   colors   palette to pick from
 *   hue      cycle the hue by spawn index instead of using `colors`
 *   twinkle  brightness flickers over the life (stars, fireflies)
 *
 * Aura recipe (`aura`), for the standing flourishes:
 *   kind     'ring' | 'orbit' | 'wing'
 *   n        particles (orbit/wing: wings come in pairs)
 *   r/rz     orbit radii, y = height above the paws
 *   speed    radians/sec (frozen under reduced motion)
 *   size     particle size
 *   colors   palette
 */
export const TRAIL_FX = {
  none: null,

  // --- 200..2000, the coin ladder -----------------------------------------
  petals: {
    pool: 'flake', every: 0.11, n: [1, 2], ttl: [1.5, 2.4], size: [0.11, 0.17],
    ratio: [1.5, 0.85], rise: [0.5, 1.1], side: 0.5, grav: -1.5, drag: 0.9,
    spin: [-3, 3], trailBack: 0.22, y: 0.5,
    colors: [0xf7a8bd, 0xe8657a, 0xffd9e4, 0xf2b64a],
  },
  sparkles: {
    pool: 'flake', every: 0.08, n: [1, 2], ttl: [0.5, 0.9], size: [0.06, 0.11],
    ratio: [1, 1], rise: [1.0, 1.8], side: 0.55, grav: -3.4, drag: 1.2,
    spin: [-8, 8], trailBack: 0.1, y: 0.16, twinkle: true,
    colors: [0xfff2c4, 0xf2b64a, 0xffffff],
  },
  notes: {
    pool: 'flake', every: 0.2, n: [1, 1], ttl: [1.8, 2.6], size: [0.14, 0.2],
    ratio: [0.62, 1.5], rise: [0.9, 1.3], side: 0.28, grav: 0.35, drag: 0.5,
    spin: [-1.4, 1.4], trailBack: 0.18, y: 1.15,
    colors: [0xfff6e3, 0x4fb3e8, 0xe8657a],
  },
  bubbles: {
    pool: 'mote', every: 0.14, n: [1, 2], ttl: [1.6, 2.8], size: [0.09, 0.19],
    rise: [0.7, 1.2], side: 0.3, grav: 0.5, drag: 0.7, trailBack: 0.2, y: 0.35,
    colors: [0xbfe9ff, 0x8fd8f5, 0xffffff],
  },
  snow: {
    pool: 'flake', every: 0.09, n: [1, 2], ttl: [2.0, 3.2], size: [0.07, 0.12],
    ratio: [1, 1], rise: [0.2, 0.6], side: 0.42, grav: -0.9, drag: 1.4,
    spin: [-2.5, 2.5], trailBack: 0.24, y: 0.85, twinkle: true,
    colors: [0xffffff, 0xdff0ff, 0xbfe0f7],
  },
  fireflies: {
    pool: 'mote', every: 0.34, n: [1, 1], ttl: [2.6, 4.2], size: [0.08, 0.13],
    rise: [0.25, 0.6], side: 0.35, grav: 0.12, drag: 1.1, trailBack: 0.3,
    y: 0.75, twinkle: true,
    colors: [0xd8f07a, 0xf2e77a, 0xa8e86a],
  },
  leaves: {
    pool: 'flake', every: 0.16, n: [1, 2], ttl: [1.8, 3.0], size: [0.14, 0.22],
    ratio: [1.7, 0.7], rise: [0.6, 1.2], side: 0.6, grav: -1.8, drag: 0.7,
    spin: [-6, 6], trailBack: 0.26, y: 0.6,
    colors: [0x7ac74f, 0xf2b64a, 0xd9803f, 0xa8c94a],
  },
  embers: {
    pool: 'mote', every: 0.07, n: [1, 2], ttl: [0.8, 1.5], size: [0.07, 0.14],
    rise: [1.1, 2.0], side: 0.32, grav: 0.9, drag: 1.5, trailBack: 0.16,
    y: 0.3, twinkle: true,
    colors: [0xffb454, 0xff7a3c, 0xffe6a8],
  },
  stars: {
    pool: 'flake', every: 0.13, n: [1, 2], ttl: [1.6, 2.6], size: [0.12, 0.2],
    ratio: [0.55, 1.55], rise: [0.4, 0.9], side: 0.4, grav: -1.1, drag: 1.0,
    spin: [-1.2, 1.2], trailBack: 0.2, y: 0.7, twinkle: true,
    colors: [0xfff6e3, 0xf2b64a, 0xc9b0ff],
  },
  rainbow: {
    pool: 'flake', every: 0.045, n: [1, 1], ttl: [1.1, 1.4], size: [0.2, 0.26],
    ratio: [1.9, 0.5], rise: [0.05, 0.2], side: 0.08, grav: -0.15, drag: 2.2,
    spin: [-0.4, 0.4], trailBack: 0.3, y: 0.62, hue: true,
  },

  // --- milestone: earned from the stamp album, never bought -----------------
  // 25 stamps: the wake Big Blue leaves, in your own paw-sized version.
  tidewake: {
    pool: 'mote', every: 0.1, n: [1, 2], ttl: [1.4, 2.4], size: [0.1, 0.2],
    rise: [0.35, 0.8], side: 0.4, grav: 0.25, drag: 1.0, trailBack: 0.26,
    y: 0.28, colors: [0x42d6c8, 0x7ff0d0, 0xbfe9ff],
  },
  // 45 stamps: gold pawprints that stamp the ground and fade. Distance-spaced
  // and alternately offset left/right, so they read as actual footfalls.
  goldpaw: {
    pool: 'flake', everyD: 0.62, n: [1, 1], ttl: [2.2, 2.6], size: [0.19, 0.22],
    ratio: [0.8, 1.2], rise: [0, 0], side: 0, grav: 0, drag: 0, spin: [0, 0],
    flat: true, stride: 0.19, trailBack: 0.1, y: 0.03,
    colors: [0xf2b64a, 0xffd98a],
  },

  // --- the three idle auras ------------------------------------------------
  glowring: {
    aura: { kind: 'ring', size: 0.78, colors: [0xffd9a8], pulse: 0.09 },
  },
  stardrift: {
    aura: {
      kind: 'orbit', pool: 'flake', n: 5, r: 0.72, rz: 0.72, y: 1.95,
      speed: 0.5, size: 0.17, ratio: [0.55, 1.55],
      colors: [0xfff6e3, 0xf2b64a, 0xc9b0ff],
    },
  },
  butterflies: {
    aura: {
      kind: 'wing', pool: 'flake', n: 3, r: 0.95, rz: 0.7, y: 1.1,
      speed: 0.85, size: 0.22, ratio: [1.25, 0.85],
      colors: [0xf7a8bd, 0xf2b64a, 0xbfe9ff],
    },
  },
};

/** Every id this module can render, in catalog order. */
export const TRAIL_IDS = Object.keys(TRAIL_FX);

/** Is this a flourish we know how to draw? ('none' counts: it draws nothing.) */
export function hasTrail(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(TRAIL_FX, id);
}

/** The recipe for an id, or null for 'none' / anything unknown. */
function fxOf(id) {
  return hasTrail(id) ? TRAIL_FX[id] : null;
}

// ---------------------------------------------------------------------------
// reduced motion
// ---------------------------------------------------------------------------

let _mqCalm = null; // OS prefers-reduced-motion, resolved lazily, kept current

/**
 * Should the flourish hold still? The game's own "Calm animations" toggle
 * (src/ui/settings.js installs globalThis.capyReducedMotion) wins; the OS flag
 * answers when that module was never loaded. Re-read every ask: the toggle can
 * flip mid-session and fires no matchMedia 'change'.
 */
function calm() {
  try {
    const c = globalThis.capyReducedMotion?.();
    if (c !== undefined) return !!c;
  } catch { /* settings not loaded: the media query alone answers */ }
  if (_mqCalm === null) {
    _mqCalm = false;
    try {
      const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
      if (mq) {
        _mqCalm = !!mq.matches;
        mq.addEventListener?.('change', (e) => { _mqCalm = !!e.matches; });
      }
    } catch { _mqCalm = false; }
  }
  return _mqCalm;
}

// ---------------------------------------------------------------------------
// small helpers (no allocation on the hot path)
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const rng2 = (r, i, d) => (Array.isArray(r) ? rand(r[0], r[1]) : (r === undefined ? d : r));

/** Shared, never-disposed resources: the scene teardown sweep skips these. */
function shared(obj) {
  obj.userData.shared = true;
  return obj;
}

// ---------------------------------------------------------------------------
// the field
// ---------------------------------------------------------------------------

/**
 * One pooled particle field. There is exactly one of these for the world (see
 * `updateTrails`); `createTrailPreview` makes tiny private ones for shop and
 * wardrobe previews so a preview can never eat the world's budget.
 */
class TrailField {
  constructor({ flakes = MAX_FLAKES, motes = MAX_MOTES, rings = MAX_RINGS } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'trails';
    // The field spans the room; its own bounding sphere sits at the origin and
    // would cull the whole batch the moment the camera looked away from 0,0.
    this.group.frustumCulled = false;

    // a hexagon reads as a petal, a leaf, a snowflake and a wing depending on
    // the stretch it is given, and costs four triangles
    const flakeGeo = shared(new THREE.CircleGeometry(0.5, 6));
    const moteGeo = shared(new THREE.IcosahedronGeometry(0.5, 0));
    const ringGeo = shared(new THREE.RingGeometry(0.62, 0.78, 28));
    ringGeo.rotateX(-Math.PI / 2); // lies flat on the ground as authored

    // transparent + depthWrite:false is also what makes the whole field
    // unpickable in the layout editor (src/ui/editor.js), which is exactly
    // right: nobody should be able to drag somebody else's sparkles around
    const flakeMat = shared(new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide,
    }));
    // additive: dimming the instance colour IS the fade, and glows read as light
    const glowMat = shared(new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));

    this.flake = this._mesh(flakeGeo, flakeMat, flakes, 3);
    this.mote = this._mesh(moteGeo, glowMat, motes, 4);
    this.ring = this._mesh(ringGeo, glowMat, rings, 2);

    this.pools = { flake: { mesh: this.flake, max: flakes, list: [] },
      mote: { mesh: this.mote, max: motes, list: [] } };
    this.ringList = [];
    this.ringMax = rings;
    this.wearers = new Map();
    this.t = 0;
    this.frame = 0;
    this.scene = null;
  }

  _mesh(geo, mat, max, order) {
    const m = new THREE.InstancedMesh(geo, mat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, _c.setHex(0xffffff)); // allocates instanceColor once
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    // the free-form layout editor deliberately ignores depth-writeless overlays,
    // so nothing in here can be picked, dragged or hidden out from under a player
    m.renderOrder = order;
    this.group.add(m);
    return m;
  }

  /** Move the field into whichever scene the engine is currently rendering. */
  attach(scene) {
    if (this.scene === scene) return;
    this.group.parent?.remove(this.group);
    this.scene = scene || null;
    if (scene) scene.add(this.group);
    // the room changed under us: everything in the air belonged to the old one
    this.clear();
  }

  clear() {
    for (const k of ['flake', 'mote']) this.pools[k].list.length = 0;
    this.ringList.length = 0;
    for (const w of this.wearers.values()) { w.own.length = 0; w.ring = null; }
  }

  // ---- wearers ------------------------------------------------------------

  /**
   * Book a capybara into the field for this frame.
   * @param key   stable identity (remote id, or 'self')
   * @param id    the trail id they are wearing
   * @param pos   their world position (read, never kept)
   * @param moving true while they are walking
   */
  note(key, id, pos, moving) {
    let w = this.wearers.get(key);
    if (!w) {
      w = { key, id: null, x: pos.x, y: pos.y, z: pos.z, px: pos.x, pz: pos.z,
        dx: 0, dz: 1, emit: 0, dist: 0, foot: 1, moving: false, seen: 0, own: [], ring: null };
      this.wearers.set(key, w);
    }
    if (w.id !== id) { this._freeOwned(w); w.id = id; }
    w.px = w.x; w.pz = w.z;
    w.x = pos.x; w.y = pos.y; w.z = pos.z;
    const dx = w.x - w.px, dz = w.z - w.pz;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) { w.dx = dx / d; w.dz = dz / d; }
    w.step = d;
    w.moving = !!moving;
    w.seen = this.frame;
    return w;
  }

  _freeOwned(w) {
    if (w.own.length) {
      // cut the ownership FIRST: an aura particle is placed from its wearer and
      // never integrated, so one that kept `own` would outlive the capybara it
      // belonged to. Dropped to the free branch it simply expires next tick.
      for (const p of w.own) { p.own = null; p.life = -1; }
      w.own.length = 0;
    }
    if (w.ring) { w.ring.own = null; w.ring.life = -1; w.ring = null; }
  }

  // ---- particles ----------------------------------------------------------

  _alloc(poolName) {
    const pool = this.pools[poolName] || this.pools.flake;
    if (pool.list.length >= pool.max) return null;
    const p = {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grav: 0, drag: 0,
      life: 0, ttl: 1, s: 0.1, sx: 1, sy: 1, rot: 0, spin: 0, tilt: 0,
      r: 1, g: 1, b: 1, flat: false, twinkle: false, add: poolName === 'mote',
      own: null, oa: 0, os: 0, orx: 0, orz: 0, oy: 0, wing: 0, seed: Math.random() * 9,
    };
    pool.list.push(p);
    return p;
  }

  /** One puff of a walk trail at a wearer's paws. */
  _puff(w, fx, load) {
    const poolName = fx.pool === 'mote' ? 'mote' : 'flake';
    const pool = this.pools[poolName];
    if (pool.list.length > pool.max * FULL_MARK) return;
    const n = Math.max(1, Math.round(rng2(fx.n, 0, 1)));
    // behind them, so the trail comes out of the paws and not out of the nose
    const back = fx.trailBack ?? 0.2;
    const bx = w.x - w.dx * back;
    const bz = w.z - w.dz * back;
    // pawprints alternate left/right of the walk line
    const stride = fx.stride || 0;
    const sxo = stride ? -w.dz * stride * w.foot : 0;
    const szo = stride ? w.dx * stride * w.foot : 0;
    if (stride) w.foot = -w.foot;

    for (let i = 0; i < n; i++) {
      const p = this._alloc(poolName);
      if (!p) return;
      const jitter = stride ? 0 : 0.18;
      p.x = bx + sxo + (jitter ? rand(-jitter, jitter) : 0);
      p.z = bz + szo + (jitter ? rand(-jitter, jitter) : 0);
      p.y = w.y + (fx.y ?? 0.4) + (jitter ? rand(-0.05, 0.05) : 0);
      const side = fx.side ?? 0;
      p.vx = rand(-side, side) - w.dx * (fx.push || 0);
      p.vz = rand(-side, side) - w.dz * (fx.push || 0);
      p.vy = rng2(fx.rise, 0, 0.5);
      p.grav = fx.grav ?? 0;
      p.drag = fx.drag ?? 0;
      p.ttl = rng2(fx.ttl, 0, 1.5) * load.ttl;
      p.life = p.ttl;
      p.s = rng2(fx.size, 0, 0.12);
      p.sx = fx.ratio ? fx.ratio[0] : 1;
      p.sy = fx.ratio ? fx.ratio[1] : 1;
      p.spin = rng2(fx.spin, 0, 0);
      p.rot = Math.random() * Math.PI * 2;
      p.tilt = fx.flat ? -Math.PI / 2 : rand(-0.5, 0.5);
      p.flat = !!fx.flat;
      p.twinkle = !!fx.twinkle;
      p.own = null;
      if (fx.hue) _c.setHSL((this.t * 0.22 + i * 0.07) % 1, 0.85, 0.62);
      else _c.setHex(pick(fx.colors));
      p.r = _c.r; p.g = _c.g; p.b = _c.b;
    }
  }

  /** Build (or top up) a wearer's aura particles. Auras persist; they are not
   *  emitted and re-emitted, they simply belong to the capybara. */
  _aura(w, aura, load) {
    if (aura.kind === 'ring') {
      // rings are their own tiny list, one entry per wearer, never pooled with
      // the particles: the geometry is different and so is the budget
      if (w.ring || this.ringList.length >= this.ringMax) return;
      _c.setHex(aura.colors[0]);
      const rp = {
        own: w, life: 1e9, s: aura.size, seed: Math.random() * 9,
        r: _c.r, g: _c.g, b: _c.b,
      };
      this.ringList.push(rp);
      w.ring = rp;
      return;
    }
    // orbit / wing: n slots (wings come in pairs, one particle per wing)
    const want = aura.kind === 'wing'
      ? Math.max(2, Math.round(aura.n * load.aura)) * 2
      : Math.max(2, Math.round(aura.n * load.aura));
    if (w.own.length >= want) return;
    const poolName = aura.pool === 'mote' ? 'mote' : 'flake';
    for (let i = w.own.length; i < want; i++) {
      const p = this._alloc(poolName);
      if (!p) return;
      const unit = aura.kind === 'wing' ? (i >> 1) : i;
      const per = aura.kind === 'wing' ? want / 2 : want;
      p.own = w;
      p.life = 1e9; p.ttl = 1e9;
      p.oa = (unit / per) * Math.PI * 2;
      p.os = aura.speed * (aura.kind === 'wing' ? 1 : 1);
      p.orx = aura.r; p.orz = aura.rz;
      p.oy = aura.y + (aura.kind === 'wing' ? (unit % 2) * 0.22 : 0);
      p.wing = aura.kind === 'wing' ? (i & 1 ? 1 : -1) : 0;
      p.s = aura.size;
      p.sx = aura.ratio ? aura.ratio[0] : 1;
      p.sy = aura.ratio ? aura.ratio[1] : 1;
      p.flat = false;
      p.twinkle = aura.kind === 'orbit';
      p.seed = Math.random() * 9;
      _c.setHex(aura.colors[unit % aura.colors.length]);
      p.r = _c.r; p.g = _c.g; p.b = _c.b;
      w.own.push(p);
    }
  }

  // ---- the frame ----------------------------------------------------------

  /**
   * Advance and draw. `subject` is the position everything is ranged against
   * (the local player); pass null to range against nothing.
   */
  step(dt, subject) {
    const still = calm();
    this.t += dt;

    // drop wearers nobody reported this frame (left the room, logged off)
    for (const [key, w] of this.wearers) {
      if (w.seen !== this.frame) { this._freeOwned(w); this.wearers.delete(key); }
    }

    // how hard is the cove working? Past SOFT_WEARERS everyone thins out, so a
    // packed plaza costs about what a quiet one does. Honest play is never
    // capped - this only spends the same budget across more capybaras.
    let n = 0;
    for (const w of this.wearers.values()) if (w.id && w.id !== 'none') n++;
    const over = Math.max(1, n / SOFT_WEARERS);
    const load = { rate: over, ttl: 1 / Math.sqrt(over), aura: over > 1.6 ? 0.66 : 1 };

    // emit
    for (const w of this.wearers.values()) {
      const fx = fxOf(w.id);
      if (!fx) continue;
      if (fx.aura) { this._aura(w, fx.aura, load); continue; }
      if (still) continue;              // reduced motion: trails do not emit
      if (!w.moving) { w.emit = 0; w.dist = 0; continue; }
      if (subject) {
        const ddx = w.x - subject.x, ddz = w.z - subject.z;
        if (ddx * ddx + ddz * ddz > EMIT_RANGE_SQ) continue;
      }
      if (fx.everyD) {
        w.dist += w.step || 0;
        const gap = fx.everyD * (load.rate > 1.4 ? 1.5 : 1);
        while (w.dist >= gap) { w.dist -= gap; this._puff(w, fx, load); }
      } else {
        w.emit -= dt;
        const gap = (fx.every || 0.12) * load.rate;
        if (w.emit <= 0) { w.emit = gap; this._puff(w, fx, load); }
      }
    }

    this._integrate(dt, still, 'flake');
    this._integrate(dt, still, 'mote');
    this._drawRings(still);
  }

  _integrate(dt, still, poolName) {
    const pool = this.pools[poolName];
    const list = pool.list;
    const mesh = pool.mesh;
    let slot = 0;

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let k = 1; // brightness / alpha stand-in

      if (p.own) {
        // an aura particle: it belongs to a capybara, so it is placed, never
        // integrated. Under reduced motion the orbit angle simply stops.
        const w = p.own;
        if (!still) p.oa += p.os * dt;
        const ang = p.oa;
        const bobT = still ? p.seed : this.t + p.seed;
        p.x = w.x + Math.cos(ang) * p.orx;
        p.z = w.z + Math.sin(ang) * p.orz;
        p.y = w.y + p.oy + (still ? 0 : Math.sin(bobT * 1.6) * 0.07);
        if (p.wing) {
          // butterfly: two wings hinged either side of an invisible body,
          // flapping. Static (half-open) when motion is reduced.
          const flap = still ? 0.55 : 0.35 + 0.45 * Math.abs(Math.sin(bobT * 9));
          p.rot = -ang + Math.PI / 2;
          p.tilt = flap * p.wing;
          p.x += Math.cos(ang + Math.PI / 2) * 0.09 * p.wing;
          p.z += Math.sin(ang + Math.PI / 2) * 0.09 * p.wing;
        } else {
          p.rot = still ? p.seed : this.t * 0.6 + p.seed;
          p.tilt = 0.2;
        }
        if (p.twinkle) k = still ? 0.85 : 0.7 + 0.3 * Math.sin(bobT * 2.4);
      } else {
        // a free particle
        p.life -= still ? dt * 3 : dt; // reduced motion clears the air fast
        if (p.life <= 0) {
          list[i] = list[list.length - 1];
          list.pop();
          i--;
          continue;
        }
        if (!still) {
          p.vy += p.grav * dt;
          if (p.drag) {
            const damp = Math.max(0, 1 - p.drag * dt);
            p.vx *= damp; p.vy *= damp; p.vz *= damp;
          }
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          p.rot += p.spin * dt;
        }
        const u = p.life / p.ttl;         // 1 at birth, 0 at death
        // ease in over the first 12%, then out: nothing pops into existence
        k = u > 0.88 ? (1 - u) / 0.12 : u;
        if (p.twinkle) k *= 0.72 + 0.28 * Math.sin((this.t + p.seed) * 11);
      }

      if (slot >= pool.max) break;
      // flakes fade by SHRINKING (normal blending, so dimming would go black);
      // motes fade by DIMMING (additive, where dim is transparent)
      const shrink = p.add ? 1 : (p.own ? 1 : 0.25 + 0.75 * k);
      const size = p.s * shrink;
      _e.set(p.tilt, p.flat ? p.rot : 0, p.flat ? 0 : p.rot);
      _q.setFromEuler(_e);
      _v.set(p.x, p.y, p.z);
      _s.set(size * p.sx, size * p.sy, size);
      _m4.compose(_v, _q, _s);
      mesh.setMatrixAt(slot, _m4);
      const dim = p.add ? Math.max(0, k) : (p.own ? Math.max(0.25, k) : 1);
      _c2.setRGB(p.r * dim, p.g * dim, p.b * dim);
      mesh.setColorAt(slot, _c2);
      slot++;
    }

    mesh.count = slot;
    mesh.visible = slot > 0;
    if (slot > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  _drawRings(still) {
    const mesh = this.ring;
    let slot = 0;
    for (let i = 0; i < this.ringList.length; i++) {
      const p = this.ringList[i];
      if (p.life <= 0 || !p.own) {
        this.ringList[i] = this.ringList[this.ringList.length - 1];
        this.ringList.pop();
        i--;
        continue;
      }
      if (slot >= this.ringMax) break;
      const w = p.own;
      // a soft breath, held still when motion is reduced
      const pulse = still ? 1 : 1 + Math.sin((this.t + p.seed) * 1.5) * 0.09;
      _e.set(0, still ? p.seed : this.t * 0.35, 0);
      _q.setFromEuler(_e);
      _v.set(w.x, w.y + 0.035, w.z);
      _s.setScalar(p.s * pulse * 1.0);
      _m4.compose(_v, _q, _s);
      mesh.setMatrixAt(slot, _m4);
      const k = still ? 0.8 : 0.66 + 0.24 * Math.sin((this.t + p.seed) * 1.5);
      _c2.setRGB(p.r * k, p.g * k, p.b * k);
      mesh.setColorAt(slot, _c2);
      slot++;
    }
    mesh.count = slot;
    mesh.visible = slot > 0;
    if (slot > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Live particle count, for tests and the health overlay. */
  get live() {
    return this.pools.flake.list.length + this.pools.mote.list.length + this.ringList.length;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const m of [this.flake, this.mote, this.ring]) {
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    this.clear();
    this.wearers.clear();
    this.scene = null;
  }
}

// ---------------------------------------------------------------------------
// the world field: one instance, made on first use, kept for the page's life
// ---------------------------------------------------------------------------

let field = null;
let frameN = 0;

/** The world's field, for tests and debug overlays. Null until the first frame. */
export function trailField() {
  return field;
}

/**
 * THE ATTACH POINT. Called once per frame from the net client's remote update
 * (src/net/client.js `update`), which is the one place that already holds both
 * the local avatar and every remote's snapshot:
 *
 *     updateTrails(dt, this.engine, this.remotes);
 *
 * Everything else is read, never written: this takes the engine's current
 * scene, the player's avatar, and the remotes map, and asks nothing of either
 * file. A remote's worn flourish is read off its join snapshot (`r.p.trail`,
 * the world-tag snapshot field); the local player's off `game.state.trail`, so
 * equipping is instant for yourself and lands for everyone else the way hats
 * and colours do.
 *
 * @param {number} dt      seconds since the last frame
 * @param {object} engine  the Engine (scene, playerAvatar, game)
 * @param {Map}    remotes NetClient.remotes: id -> {p, avatar, anim}
 */
export function updateTrails(dt, engine, remotes) {
  // a hidden tab still ticks movement and networking; there is nothing to draw
  if (typeof document !== 'undefined' && document.hidden) return;
  const scene = engine?.scene;
  if (!scene) return;
  if (!(dt > 0)) return;

  if (!field) field = new TrailField();
  field.attach(scene);
  field.frame = ++frameN;

  let subject = null;

  // the local player
  const me = engine.playerAvatar;
  if (me?.group) {
    const id = normalize(engine.game?.state?.trail);
    subject = me.group.position;
    if (id) field.note('self', id, me.group.position, me.state?.anim === 'walk');
  }

  // everyone else, straight off the snapshots the net client already holds
  if (remotes) {
    for (const [rid, r] of remotes) {
      const g = r?.avatar?.group;
      if (!g) continue;
      const id = normalize(r.p?.trail);
      if (!id) continue;
      field.note(rid, id, g.position, r.anim === 'walk');
    }
  }

  field.step(Math.min(dt, 0.1), subject);
}

/** Only ever draw an id this build knows; anything else is simply no flourish. */
function normalize(id) {
  if (typeof id !== 'string' || id === 'none' || !hasTrail(id)) return null;
  return id;
}

/** Tear the world field down (page teardown / tests). Safe to call twice. */
export function disposeTrails() {
  field?.dispose();
  field = null;
}

// ---------------------------------------------------------------------------
// previews (shop / wardrobe)
// ---------------------------------------------------------------------------

/**
 * A self-contained little version of one flourish, for a shop card or the
 * wardrobe: its own tiny pools, its own budget, nothing shared with the world.
 * The caller adds `group` to their scene, calls `update(dt)` each frame and
 * `dispose()` when the card goes away.
 *
 *   const pv = createTrailPreview('petals');
 *   scene.add(pv.group);           // pv.update(dt) each frame
 *
 * The pretend capybara walks a slow circle so a walk trail actually trails.
 */
export function createTrailPreview(id, { radius = 0.85, speed = 1.1 } = {}) {
  const trail = normalize(id) || 'none';
  const pv = new TrailField({ flakes: 70, motes: 48, rings: 1 });
  const pos = new THREE.Vector3();
  let t = 0;
  let n = 0;
  return {
    group: pv.group,
    /** @param {number} dt seconds */
    update(dt) {
      if (!(dt > 0)) return;
      t += Math.min(dt, 0.1);
      const still = calm();
      const a = still ? 0 : t * speed;
      pos.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      pv.frame = ++n;
      if (trail !== 'none') pv.note('preview', trail, pos, !still);
      pv.step(Math.min(dt, 0.1), null);
    },
    dispose() { pv.dispose(); },
  };
}
