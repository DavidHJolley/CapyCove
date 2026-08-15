import * as THREE from 'three';
import { canvasTexture } from '../core/materials.js';

/**
 * src/world/ambience.js — the living air of every room.
 *
 * Rooms build the world; this module builds the air in it. Spray lifting off
 * the beach break, snow tearing across the saddle, dust turning in a shaft of
 * crystal light, pollen hanging under the canopy, embers going up the loft
 * chimney, haze breathing with the club, fireflies coming out over the plaza
 * with the lanterns. It is the cheapest AAA there is: nothing here is a new
 * prop, it is the space BETWEEN the props finally having weather in it.
 *
 * IT IS ALSO THE CHEAPEST WAY TO SPOIL A ROOM. Air that is too busy reads as
 * litter, and that verdict has already been reached once in this cove (see the
 * plaza config). A room whose own source records that an effect was REMOVED
 * does not get it back from here.
 *
 * WIRING — one line in src/core/engine.js, immediately after attachCharm, in
 * BOTH switchRoom() and rebuildRoom():
 *
 *     attachAmbience(this.room, this.scene, this.game, id);
 *
 * That is the whole engine change. Signature and lifecycle mirror
 * src/world/overlay.js attachOverlay and src/world/charm.js attachCharm
 * exactly: this module hooks the room INSTANCE's update / dispose / onClock
 * (never the prototype) and restores them, so the engine needs no lifecycle
 * knowledge and disposing the room disposes the air with it.
 *
 * ---------------------------------------------------------------------------
 * SHAPE: two layers, two draw calls, per room. That is the whole budget.
 * ---------------------------------------------------------------------------
 *  - MOTES: one THREE.InstancedMesh over a single shared unit quad. Per
 *    particle it can carry rotation, non-uniform scale and colour, which is
 *    what buys tumbling leaves, flapping wings, wind-stretched snow streaks and
 *    flickering embers. Capped at MAX_MOTES.
 *  - DRIFT: one THREE.Points sprite layer, per-vertex colour, one shared size.
 *    Cheaper per particle and used for the counts that need to be high: petals,
 *    pollen, dust, snow dust, glitter, haze. Capped at MAX_DRIFT.
 *
 * A room may use one layer, the other, or both; a layer with count 0 is never
 * built at all. Nothing here allocates after attach: positions live in one flat
 * Float32Array per layer, and every per-frame vector, colour and matrix is a
 * module-level scratch reused in place.
 *
 * COST. Per frame per layer it is one loop of straight float maths over at most
 * a couple of hundred slots, plus one buffer upload. MEASURED over 20k frames
 * per room, node 24 / three 0.178, every room at noon in a breeze:
 *
 *     room     particles  draws   ms/frame   bytes/frame
 *     peak        206       2      0.0194        ~0
 *     mine        128       2      0.0130        ~0
 *     drift       130       2      0.0116        ~0
 *     jungle      134       2      0.0109        ~0
 *     plaza       120       2      0.0066        ~0
 *     club         30       1      0.0021        ~0
 *
 * The worst room in the cove is 0.12% of a 16.6ms frame for two draw calls, and
 * the heap delta per frame is indistinguishable from zero in both directions,
 * which is the check that nothing in here allocates. Re-run it before changing
 * a kernel; the caps at the top are the contract. Both layers are
 * frustumCulled = false on purpose: the bounds move every frame and culling a
 * room-sized cloud never pays.
 *
 * FADING. Distance is handled the honest way and costs nothing: normal-blended
 * layers keep `fog: true`, so far particles dissolve into the room's own fog
 * colour with the scenery. Additive layers cannot use fog (fog on additive
 * BRIGHTENS with distance), so those fade themselves through the per-particle
 * colour over the last few metres before the cull radius.
 *
 * DAY / NIGHT. onClock is passed through, never swallowed: the room's own
 * handler runs first and this reads the same frame. `dayT` drives a continuous
 * gain per layer (a shimmer that only exists at noon, fireflies that only exist
 * after dusk) and a discrete day/night MODE that may swap a layer's texture,
 * colour and blending. The mode swap is hysteretic and happens a couple of
 * times per cove day, never per frame.
 *
 * REDUCED MOTION. src/ui/settings.js owns the one answer (the game's "Calm
 * animations" toggle OR the OS flag) and it can flip mid-session, so it is
 * re-read at 2Hz rather than cached forever. When it is on: every density is
 * halved, and any layer marked `shimmer` (beach heat haze, club haze) is off
 * completely, because those are the two things here that read as flicker.
 */

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

const MAX_MOTES = 160;   // instanced quads: rotation + scale + colour per particle
const MAX_DRIFT = 220;   // point sprites: colour per particle, one shared size
const TAU = Math.PI * 2;

// x, y, z, homeX, homeR, homeZ, seed, alpha.
// "home" is where this particle was last spawned and how far it may wander from
// it — that is what keeps pollen inside its light shaft instead of slowly
// filling the room.
const STRIDE = 8;
const PARK_Y = -900;     // where a faded-out particle waits; never in frame

const MODE_HYST = 0.08;  // day <-> night needs to overshoot the midpoint by this
const CALM_EVERY = 0.5;  // seconds between reduced-motion re-reads
const ALPHA_RATE = 0.9;  // per-second ease as a particle joins or leaves the pool

// Dens are player-built and every one is a different shape; they get the same
// quiet interior dust as the cafe, keyed off this prefix.
const HOUSE_PREFIX = 'house:';

// ---------------------------------------------------------------------------
// per-room configuration
// ---------------------------------------------------------------------------
/**
 * A layer spec:
 *   tex     'dot' | 'petal' | 'leaf' | 'wing' | 'streak' | 'haze' | 'bubble'
 *   count   particles wanted (clamped to the layer cap)
 *   size    world units. Motes: the quad's edge. Drift: the sprite's diameter.
 *   color   hex tint
 *   add     true for AdditiveBlending (glows). false keeps fog-aware normal.
 *   opacity material opacity ceiling
 *   kernel  'fall' | 'rise' | 'float' | 'flit' | 'wind'
 *   area    { r, y0, y1 } the cylinder the particles live in, room-centred
 *   speed   the kernel's main rate (m/s)
 *   sway    lateral wander (m/s)
 *   spin    tumble rate (rad/s), motes only
 *   flap    wing beat (rad/s), motes only
 *   blink   0..1 how much the particle winks in and out
 *   at      'any' | 'day' | 'night' | 'noon' — the hour this layer belongs to
 *   fadeTop / fadeBottom  dissolve as the particle nears that end of the column
 *   shafts  [[x, z, r], ...] columns particles respawn into (light shafts)
 *   pulse   'beat' — size and brightness ride the room's beat hook
 *   shimmer true — a flicker layer: OFF entirely under reduced motion
 *   night   partial override merged in when the room mode is 'night'
 */
const ROOMS = {
  // THE PLAZA IS DELIBERATELY EMPTY AIR BY DAY. Read this before adding
  // anything here, because it is the one room where "more life" has already
  // been tried and rejected in playtest, twice, and both verdicts are recorded
  // in the room's own source:
  //
  //  - src/world/rooms/plaza.js:1735-1739. Twenty-six drifting petals were
  //    REMOVED: "read as loose sheets of paper blowing through a tidy town
  //    square rather than as blossom, and there were enough of them to speckle
  //    every frame."
  //  - src/world/rooms/plaza.js:1710-1714. Butterflies were cut from fourteen
  //    to SEVEN: "at fourteen of them the plaza was permanently speckled with
  //    litter."
  //
  // A first pass at this file gave the plaza 90 petals and 12 more flyers on
  // top of the room's own 7, which is 3.5x the petal count that was judged too
  // many and 19 flyers against a ceiling of 14 that was judged too many, in the
  // one room every player sees first. So: no petals, and no daytime flyers -
  // the plaza already owns exactly as many butterflies as it wants, and the
  // fountain, bunting and clouds carry the rest of the daytime motion.
  //
  // What is left is the one thing the plaza has never had and the record does
  // not speak against: fireflies coming out with the lanterns. Additive sparks
  // at dusk are not the pale flapping rectangles that were cut, they are what
  // the lit square is missing after dark. If they ever read as speckle too,
  // this is one number and it should go the same way the petals did.
  plaza: {
    motes: {
      tex: 'dot', count: 30, size: 0.14, color: 0xd8ff9a, add: true, opacity: 1,
      kernel: 'flit', area: { r: 11, y0: 0.9, y1: 3.4 }, speed: 0.5,
      blink: 0.85, at: 'night',
    },
  },

  // Driftwood Beach: spray coming off the break, and the air over hot sand
  // wobbling at midday. The gulls are the room's own and are left alone.
  beach: {
    motes: {
      tex: 'dot', count: 34, size: 0.13, color: 0xeafaff, add: false, opacity: 0.75,
      kernel: 'rise', area: { r: 16, y0: 0.15, y1: 2.6 }, speed: 0.55, sway: 0.5,
      fadeTop: true, at: 'any',
    },
    drift: {
      tex: 'haze', count: 46, size: 1.5, color: 0xffe4ac, add: true, opacity: 0.085,
      kernel: 'rise', area: { r: 15, y0: 0.05, y1: 2.4 }, speed: 0.35, sway: 0.25,
      fadeTop: true, fadeBottom: true, at: 'noon', shimmer: true,
    },
  },

  // Frosty Peak: the saddle is never still. Both layers ride the room's wind if
  // it publishes one, and the weather word if it does not.
  peak: {
    motes: {
      tex: 'streak', count: 110, size: 0.22, color: 0xffffff, add: false, opacity: 0.8,
      kernel: 'wind', area: { r: 20, y0: 0.2, y1: 7 }, speed: 1.1, sway: 0.6, at: 'any',
    },
    drift: {
      tex: 'dot', count: 96, size: 0.10, color: 0xf2f8ff, add: false, opacity: 0.7,
      kernel: 'wind', area: { r: 22, y0: 0.1, y1: 9 }, speed: 0.9, sway: 0.5, at: 'any',
    },
  },

  // Glimmer Mine: lantern dust turning in the warm middle, and the seams
  // shedding the odd fleck of glitter. Shafts are the crystal wall seams.
  mine: {
    motes: {
      tex: 'dot', count: 70, size: 0.055, color: 0xffd9a4, add: true, opacity: 0.55,
      kernel: 'float', area: { r: 11, y0: 0.4, y1: 3.6 }, speed: 0.16, sway: 0.16, at: 'any',
    },
    drift: {
      tex: 'dot', count: 58, size: 0.075, color: 0x9ff0e2, add: true, opacity: 0.6,
      kernel: 'fall', area: { r: 12.5, y0: 0.05, y1: 5 }, speed: 0.5, sway: 0.2,
      blink: 0.7, at: 'any',
      shafts: [
        [-12.8, -0.2, 1.6], [-11.8, 6.2, 1.5], [-8.4, 10.4, 1.4], [8.6, 10.2, 1.4],
        [11.9, 6.0, 1.5], [12.6, -1.4, 1.5], [11.2, -8.0, 1.5], [-11.0, -8.2, 1.5],
      ],
    },
  },

  // The Tangle: pollen hanging in the canopy shafts (the eight columns the room
  // builds), and a leaf letting go every so often. Both go with the daylight,
  // because the shafts they live in do.
  jungle: {
    motes: {
      tex: 'leaf', count: 24, size: 0.30, color: 0x8ece62, add: false, opacity: 0.95,
      kernel: 'fall', area: { r: 13, y0: 0.05, y1: 13 }, speed: 0.8, sway: 0.7, spin: 1.5,
      at: 'any',
    },
    drift: {
      tex: 'dot', count: 110, size: 0.075, color: 0xffe79a, add: true, opacity: 0.5,
      kernel: 'float', area: { r: 13, y0: 0.4, y1: 8 }, speed: 0.14, sway: 0.14, at: 'day',
      shafts: [
        [-6.5, 2.5, 1.6], [-2.2, -4.5, 1.1], [1.8, 5.0, 1.3], [4.6, -2.0, 1.5],
        [-8.5, -8.0, 1.0], [7.5, 6.5, 1.2], [0.4, -10.5, 1.4], [10.0, -6.0, 1.1],
      ],
    },
  },

  // Interiors. One layer each: dust turning in the window light. Cheap, quiet,
  // and it is what makes a lit room look like it has AIR in it.
  cafe: {
    drift: {
      tex: 'dot', count: 58, size: 0.05, color: 0xffdcac, add: true, opacity: 0.45,
      kernel: 'float', area: { r: 7.5, y0: 0.5, y1: 3.4 }, speed: 0.13, sway: 0.13, at: 'any',
    },
  },
  lounge: {
    drift: {
      tex: 'dot', count: 52, size: 0.05, color: 0xffe0bc, add: true, opacity: 0.4,
      kernel: 'float', area: { r: 8.5, y0: 0.5, y1: 3.6 }, speed: 0.12, sway: 0.12, at: 'any',
    },
  },

  // The Trophy Loft: dust in the dormer light, and the grand fireplace on the
  // north gable (z = -6.5) sending embers up the stack all evening.
  loft: {
    motes: {
      tex: 'dot', count: 40, size: 0.055, color: 0xff9a3c, add: true, opacity: 0.9,
      kernel: 'rise', area: { r: 2.2, y0: 0.5, y1: 5.4, cx: 0, cz: -6.1 },
      speed: 1.05, sway: 0.35, blink: 0.6, fadeTop: true, at: 'any',
    },
    drift: {
      tex: 'dot', count: 40, size: 0.05, color: 0xffdcb0, add: true, opacity: 0.38,
      kernel: 'float', area: { r: 7, y0: 0.6, y1: 3.6 }, speed: 0.12, sway: 0.12, at: 'any',
    },
  },

  // Groove Grotto: slow haze that breathes with the floor. `pulse: 'beat'`
  // reads the room's beat hook if it has one and falls back to a slow swell.
  club: {
    drift: {
      tex: 'haze', count: 30, size: 3.4, color: 0xb27ce8, add: true, opacity: 0.075,
      kernel: 'float', area: { r: 9, y0: 0.6, y1: 4.2 }, speed: 0.16, sway: 0.16,
      pulse: 'beat', at: 'any', shimmer: true,
    },
  },

  // The Drift: this room already grows its own bubbles off every swimmer, so
  // ambience stays FAR FIELD — a wide, sparse column of rising bubbles out past
  // where anyone swims, plus plankton catching the god rays.
  drift: {
    motes: {
      tex: 'bubble', count: 34, size: 0.19, color: 0xd8f4ff, add: false, opacity: 0.5,
      kernel: 'rise', area: { r: 24, rIn: 11, y0: 0.6, y1: 21 }, speed: 1.05, sway: 0.5,
      fadeTop: true, at: 'any',
    },
    drift: {
      tex: 'dot', count: 96, size: 0.075, color: 0xbfe9ff, add: true, opacity: 0.4,
      kernel: 'float', area: { r: 22, y0: 1, y1: 19 }, speed: 0.12, sway: 0.12,
      blink: 0.4, at: 'any',
    },
  },
};

// Every den, whatever shape its owner built, gets the cafe's quiet dust.
const HOUSE_CFG = {
  drift: {
    tex: 'dot', count: 30, size: 0.05, color: 0xffdfb4, add: true, opacity: 0.38,
    kernel: 'float', area: { r: 7, y0: 0.5, y1: 3.2 }, speed: 0.12, sway: 0.12, at: 'any',
  },
};

/** Room ids this module dresses. Exported for tests and for the room census. */
export const AMBIENCE_ROOMS = Object.freeze(Object.keys(ROOMS));

/** The config for a room id, or null when this room has no air of its own. */
export function ambienceConfig(roomId) {
  if (typeof roomId !== 'string' || !roomId) return null;
  if (roomId.startsWith(HOUSE_PREFIX)) return HOUSE_CFG;
  return Object.prototype.hasOwnProperty.call(ROOMS, roomId) ? ROOMS[roomId] : null;
}

// ---------------------------------------------------------------------------
// shared, module-lived resources
// ---------------------------------------------------------------------------

// One unit quad behind every mote in the game. Marked shared so a stray
// disposeObject() sweep leaves it for the next room.
let QUAD = null;
function quad() {
  if (!QUAD) {
    QUAD = new THREE.PlaneGeometry(1, 1);
    QUAD.userData.shared = true;
  }
  return QUAD;
}

// Canvas sprites, drawn once for the life of the page and shared by every room.
// Built lazily at attach time: this module has no import-time side effects and
// must import cleanly with no DOM at all.
const TEXES = new Map();
function texFor(name) {
  if (TEXES.has(name)) return TEXES.get(name);
  let tex = null;
  try { tex = drawTex(name); } catch { tex = null; } // no DOM: the layer opts out
  TEXES.set(name, tex);
  return tex;
}

function drawTex(name) {
  const S = 64;
  switch (name) {
    case 'petal': return canvasTexture(S, S, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.save(); c.translate(w / 2, h / 2); c.rotate(-0.4); c.scale(1, 0.52);
      c.beginPath(); c.arc(0, 0, w / 2, 0, TAU); c.fill(); c.restore();
    });
    case 'leaf': return canvasTexture(S, S, (c, w, h) => {
      // a pointed almond: two arcs meeting, with a soft edge so it never aliases
      c.fillStyle = 'rgba(255,255,255,0.95)';
      c.beginPath();
      c.moveTo(w * 0.08, h * 0.5);
      c.quadraticCurveTo(w * 0.5, h * 0.02, w * 0.92, h * 0.5);
      c.quadraticCurveTo(w * 0.5, h * 0.98, w * 0.08, h * 0.5);
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.lineWidth = 2; c.beginPath();
      c.moveTo(w * 0.12, h * 0.5); c.lineTo(w * 0.88, h * 0.5); c.stroke();
    });
    case 'wing': return canvasTexture(S, S, (c, w, h) => {
      // two lobes: a butterfly at 12 pixels on screen is a silhouette, not a bug
      c.fillStyle = 'rgba(255,255,255,0.95)';
      for (const s of [-1, 1]) {
        c.save(); c.translate(w / 2, h / 2); c.scale(s, 1);
        c.beginPath(); c.ellipse(w * 0.17, -h * 0.09, w * 0.19, h * 0.24, 0.35, 0, TAU); c.fill();
        c.beginPath(); c.ellipse(w * 0.13, h * 0.16, w * 0.13, h * 0.16, -0.2, 0, TAU); c.fill();
        c.restore();
      }
      c.fillStyle = 'rgba(255,255,255,0.7)';
      c.fillRect(w * 0.47, h * 0.28, w * 0.06, h * 0.44);
    });
    case 'streak': return canvasTexture(S, S, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.save(); c.translate(0, h / 2); c.scale(1, 0.24); c.translate(0, -h / 2);
      c.fillRect(0, 0, w, h); c.restore();
    });
    case 'haze': return canvasTexture(S, S, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.75)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    });
    case 'bubble': return canvasTexture(S, S, (c, w, h) => {
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = w * 0.11;
      c.beginPath(); c.arc(w / 2, h / 2, w * 0.34, 0, TAU); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.8)';
      c.beginPath(); c.arc(w * 0.37, h * 0.34, w * 0.08, 0, TAU); c.fill();
    });
    case 'dot':
    default: return canvasTexture(S, S, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.72)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    });
  }
}

// ---------------------------------------------------------------------------
// scratch — allocated once, reused for the life of the page
// ---------------------------------------------------------------------------
const _obj = new THREE.Object3D();
const _tint = new THREE.Color();
const _camPos = new THREE.Vector3();

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const frac = (v) => v - Math.floor(v);
const smooth = (e0, e1, v) => { const t = clamp01((v - e0) / (e1 - e0 || 1)); return t * t * (3 - 2 * t); };

/** The one answer to "should this be calmed down". src/ui/settings.js owns it
 *  and it can flip mid-session, so it is asked rather than remembered. */
function calmed() {
  try {
    const c = globalThis.capyReducedMotion?.();
    if (c !== undefined) return !!c;
  } catch { /* settings not loaded yet: the media query alone answers */ }
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
/**
 * Give a freshly built room its air.
 * @param {object} room  the built Room instance
 * @param {THREE.Scene} scene
 * @param {object} game  the game facade (only `engine.camera` is ever read)
 * @param {string} [roomId]
 * @returns {Ambience|null} null when the room has no config or no WebGL story.
 */
export function attachAmbience(room, scene, game, roomId = room?.id) {
  if (!room || !scene) return null;
  const rid = typeof roomId === 'string' && roomId ? roomId : room?.id;
  const cfg = ambienceConfig(rid);
  if (!cfg) return null;

  if (room.__ambience?.active) room.__ambience.dispose(); // never wrap a wrap
  let view = null;
  try {
    view = new Ambience(room, scene, game, rid, cfg);
  } catch (e) {
    console.error('[ambience] build:', e);
    return null;
  }
  if (!view.layers.length) { view.dispose(); return null; } // nothing survived
  room.__ambience = view;
  return view;
}

class Ambience {
  constructor(room, scene, game, roomId, cfg) {
    this.room = room;
    this.scene = scene;
    this.game = game;
    this.roomId = roomId;
    this.cfg = cfg;
    this.active = true;
    this.layers = [];
    this.t = 0;

    this.dayT = 0.25;        // noon until the server says otherwise
    this.weather = 'clear';
    this.nightK = 0;
    this.noonK = 1;
    this.mode = 'day';

    this.calm = calmed();
    this._calmAt = 0;

    this._wind = { x: 0.7, z: 0.25, k: 0.4 }; // resolved per frame from the room
    this._beatT = 0;
    this._yaw = 0;           // camera yaw, refreshed once per tick

    this._build();
    this._hook();
    this._applyMode(true);
  }

  // -- construction --------------------------------------------------------
  _build() {
    const m = this._layer(this.cfg.motes, 'motes', MAX_MOTES);
    if (m) this.layers.push(m);
    const d = this._layer(this.cfg.drift, 'drift', MAX_DRIFT);
    if (d) this.layers.push(d);
  }

  /** Build one layer, or return null if there is nothing (or no texture) to
   *  draw. Everything a layer will ever need is allocated right here. */
  _layer(spec, kind, cap) {
    if (!spec || !(spec.count > 0)) return null;
    const nightSpec = spec.night ? { ...spec, ...spec.night, night: null } : null;
    const pool = Math.min(cap, Math.max(spec.count | 0, nightSpec ? nightSpec.count | 0 : 0));
    if (pool <= 0) return null;

    const tex = texFor(spec.tex || 'dot');
    if (!tex) return null; // headless / no canvas: this layer simply does not exist

    const L = {
      kind, spec, nightSpec, live: spec, pool,
      n: 0, gain: 0, data: new Float32Array(pool * STRIDE),
      mesh: null, mat: null, geo: null, colAttr: null, posArr: null, colArr: null,
      area: null, shafts: null,
    };
    this._readLive(L);

    const opacity = Number.isFinite(spec.opacity) ? spec.opacity : 1;
    if (kind === 'motes') {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.NormalBlending, fog: true,
        alphaTest: 0.01,
      });
      // `shared` keeps the engine's disposeObject(scene) sweep off this
      // material — not because the material is shared (it is ours, and dispose()
      // frees it) but because that sweep also disposes `material.map`, and the
      // map IS shared: it is a page-lived sprite the next room will want.
      mat.userData.shared = true;
      const mesh = new THREE.InstancedMesh(quad(), mat, pool);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pool * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 3;
      mesh.matrixAutoUpdate = false;
      L.mesh = mesh; L.mat = mat;
    } else {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(pool * 3);
      const col = new Float32Array(pool * 3);
      for (let i = 0; i < pool; i++) pos[i * 3 + 1] = PARK_Y;
      const pAttr = new THREE.BufferAttribute(pos, 3); pAttr.setUsage(THREE.DynamicDrawUsage);
      const cAttr = new THREE.BufferAttribute(col, 3); cAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pAttr);
      geo.setAttribute('color', cAttr);
      const mat = new THREE.PointsMaterial({
        map: tex, size: spec.size || 0.1, sizeAttenuation: true, transparent: true,
        opacity, depthWrite: false, vertexColors: true, blending: THREE.NormalBlending,
        fog: true, alphaTest: 0.01,
      });
      mat.userData.shared = true; // same reason as above: protect the shared map
      const mesh = new THREE.Points(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.matrixAutoUpdate = false;
      L.mesh = mesh; L.mat = mat; L.geo = geo;
      L.posArr = pos; L.colArr = col; L.colAttr = cAttr;
    }

    // Seed the pool. Every particle is placed once; from here on they recycle.
    for (let i = 0; i < pool; i++) this._spawn(L, i, 'any');

    // Park the GPU side. An InstancedMesh starts life with identity matrices,
    // which is a stack of full-size quads sitting on the room's origin; the
    // first tick overwrites them, but a room that is built and drawn before its
    // first update would flash that stack for one frame. Points start parked
    // already (posArr was filled with PARK_Y above).
    if (L.kind === 'motes') {
      _obj.position.set(0, PARK_Y, 0);
      _obj.rotation.set(0, 0, 0);
      _obj.scale.setScalar(0.0001);
      _obj.updateMatrix();
      for (let i = 0; i < pool; i++) {
        L.mesh.setMatrixAt(i, _obj.matrix);
        L.mesh.instanceColor.setXYZ(i, 0, 0, 0);
      }
      L.mesh.instanceMatrix.needsUpdate = true;
      L.mesh.instanceColor.needsUpdate = true;
    }

    this.scene.add(L.mesh);
    return L;
  }

  /** Point a layer at its day or night face and cache the derived numbers. */
  _readLive(L) {
    L.live = (this.mode === 'night' && L.nightSpec) ? L.nightSpec : L.spec;
    const a = L.live.area || L.spec.area || { r: 10, y0: 0, y1: 5 };
    L.area = {
      r: a.r || 10, rIn: a.rIn || 0, y0: a.y0 || 0, y1: a.y1 ?? ((a.y0 || 0) + 5),
      cx: a.cx || 0, cz: a.cz || 0,
    };
    L.shafts = Array.isArray(L.live.shafts) && L.live.shafts.length ? L.live.shafts : null;
  }

  /** Push the current face's texture, colour and blending onto the material.
   *  Only ever runs on a mode change (a couple of times per cove day). */
  _applyMode(force = false) {
    for (const L of this.layers) {
      const before = L.live;
      this._readLive(L);
      if (!force && before === L.live) continue;
      const s = L.live;
      const tex = texFor(s.tex || 'dot');
      if (tex && L.mat.map !== tex) { L.mat.map = tex; L.mat.needsUpdate = true; }
      const blend = s.add ? THREE.AdditiveBlending : THREE.NormalBlending;
      if (L.mat.blending !== blend) {
        L.mat.blending = blend;
        // additive + fog brightens with distance, which is exactly backwards
        L.mat.fog = !s.add;
        L.mat.needsUpdate = true;
      }
      L.mat.opacity = Number.isFinite(s.opacity) ? s.opacity : 1;
      if (L.kind === 'drift' && Number.isFinite(s.size)) L.mat.size = s.size;
    }
  }

  // -- lifecycle -----------------------------------------------------------
  /** Hook the room INSTANCE, following src/world/charm.js: wrap, call through,
   *  and restore on the way out. Nothing on the prototype is touched and
   *  nothing the room does is swallowed.
   *
   *  Two values are kept per method, and the difference matters: `_orig*` is
   *  the EXACT value found on the instance, which is what gets put back, and
   *  `_prev*` is a bound copy, which is what we call. Restoring the bound copy
   *  instead would work, but a room is rebuilt on every visit and every rebuild
   *  would add another bind layer to the same function, so the chain would grow
   *  for as long as the session lasted. */
  _hook() {
    const room = this.room;
    const own = (k) => Object.prototype.hasOwnProperty.call(room, k);

    this._ownDispose = own('dispose');
    this._origDispose = this._ownDispose ? room.dispose : undefined;
    this._prevDispose = typeof room.dispose === 'function' ? room.dispose.bind(room) : null;
    this._wrapDispose = () => { try { this._prevDispose?.(); } finally { this.dispose(); } };
    room.dispose = this._wrapDispose;

    this._ownUpdate = own('update');
    this._origUpdate = this._ownUpdate ? room.update : undefined;
    const prevUpdate = typeof room.update === 'function' ? room.update.bind(room) : null;
    this._prevUpdate = prevUpdate;
    this._wrapUpdate = (dt, g) => { prevUpdate?.(dt, g); this.tick(dt); };
    room.update = this._wrapUpdate;

    // onClock is OPTIONAL on a room: the mine has none. Wrapping an absent one
    // installs ours, and the engine calls it because it tests for presence.
    this._ownClock = own('onClock');
    this._origClock = this._ownClock ? room.onClock : undefined;
    const prevClock = typeof room.onClock === 'function' ? room.onClock.bind(room) : null;
    this._prevClock = prevClock;
    this._wrapClock = (dayT, weather, aurora, frame) => {
      try { prevClock?.(dayT, weather, aurora, frame); }
      finally { this.onClock(dayT, weather); }
    };
    room.onClock = this._wrapClock;
  }

  /** Restore a hook, but only while it is still ours: if something wrapped on
   *  top of us, putting the old value back would cut that wrapper out of the
   *  chain. Our own wrappers are inert once `active` is false, so leaving one
   *  in somebody else's chain costs a function call and nothing else.
   *
   *  `wasOwn` false means the method came off the prototype (or did not exist
   *  at all, which is the mine's onClock): deleting the instance property is
   *  the correct restore for both. */
  _unhook(key, mine, prev, wasOwn) {
    if (!this.room || this.room[key] !== mine) return;
    if (wasOwn) this.room[key] = prev;
    else delete this.room[key];
  }

  // -- world clock ---------------------------------------------------------
  /** dayT: 0 dawn, 0.25 noon, 0.5 dusk, 0.75 midnight. */
  onClock(dayT, weather) {
    if (!this.active) return;
    const t = Number(dayT);
    if (Number.isFinite(t)) this.dayT = ((t % 1) + 1) % 1;
    if (weather === 'rain' || weather === 'breeze' || weather === 'clear') this.weather = weather;

    const h = Math.cos((this.dayT - 0.25) * TAU); // 1 noon, -1 midnight
    this.nightK = 1 - smooth(-0.22, 0.16, h);
    this.noonK = clamp01(h) ** 1.4;

    // Fireflies want dusk as well as night, so the mode watches the later of
    // the two, with hysteresis so a clock frame on the edge cannot flap it.
    const dusk = Math.max(0, 1 - Math.abs(((this.dayT - 0.5 + 1.5) % 1) - 0.5) / 0.1);
    const nightish = Math.max(this.nightK, dusk);
    const want = this.mode === 'night'
      ? (nightish > 0.5 - MODE_HYST ? 'night' : 'day')
      : (nightish > 0.5 + MODE_HYST ? 'night' : 'day');
    if (want !== this.mode) { this.mode = want; this._applyMode(); }
  }

  // -- feature-detected room signals ---------------------------------------
  /** The wind the room already believes in, if it publishes one. Falls back to
   *  the weather word plus a slow gust, so a room that says nothing still gets
   *  air that agrees with the bunting. */
  _readWind() {
    const r = this.room;
    const w = this._wind;
    let vx = null, vz = null, k = null;
    const src = (typeof r?.wind === 'function' ? safeCall(r.wind, r) : null)
      ?? r?.wind ?? r?._wind ?? r?.anim?.wind ?? null;
    if (src && typeof src === 'object') {
      if (Number.isFinite(src.x) && Number.isFinite(src.z)) { vx = src.x; vz = src.z; }
      if (Number.isFinite(src.k)) k = src.k;
      else if (Number.isFinite(src.strength)) k = src.strength;
    }
    if (k === null) {
      const amt = r?._windAmt ?? r?.windAmt ?? r?._snowWant ?? null;
      if (Number.isFinite(amt)) k = amt;
    }
    if (k === null) k = this.weather === 'breeze' ? 1 : this.weather === 'rain' ? 0.8 : 0.35;
    k = Math.max(0, Math.min(2, k));
    // a slow wander so a still day is never mathematically still
    const ang = Math.sin(this.t * 0.07) * 0.5 + Math.sin(this.t * 0.019) * 0.9;
    if (vx === null) { vx = Math.cos(ang); vz = Math.sin(ang) * 0.6; }
    const gust = 0.75 + 0.25 * Math.sin(this.t * 0.55) + 0.12 * Math.sin(this.t * 1.7);
    w.x = vx * k * gust; w.z = vz * k * gust; w.k = k * gust;
    return w;
  }

  /** 0..1 kick envelope. Uses the room's beat hook when it has one, and a slow
   *  swell when it does not (the brief: synced if it exists, else slow). */
  _beat(dt) {
    const r = this.room;
    let ph = null;
    if (typeof r?.beatPhase === 'function') ph = num(safeCall(r.beatPhase, r));
    if (ph === null && Number.isFinite(r?.beat)) ph = r.beat;
    if (ph === null && Number.isFinite(r?._beat)) ph = r._beat;
    if (ph === null && Number.isFinite(r?.anim?.beat)) ph = r.anim.beat;
    if (ph === null && Number.isFinite(r?.bpm)) {
      this._beatT += dt * (r.bpm / 60);
      ph = this._beatT;
    }
    if (ph === null) return 0.5 + 0.5 * Math.sin(this.t * 0.45); // a slow breath
    const f = frac(ph);
    return (1 - f) ** 2.2; // a decaying kick on every beat
  }

  // -- per frame -----------------------------------------------------------
  tick(dt) {
    if (!this.active || !this.layers.length) return;
    const d = Math.min(0.1, Math.max(0, dt || 0)); // a slept tab must not jump
    if (d <= 0) return;
    this.t += d;

    this._calmAt -= d;
    if (this._calmAt <= 0) { this._calmAt = CALM_EVERY; this.calm = calmed(); }

    const cam = this.game?.engine?.camera;
    if (cam?.getWorldPosition) cam.getWorldPosition(_camPos);
    else if (cam?.position) _camPos.copy(cam.position);
    else _camPos.set(0, 14, 19);
    // Yaw-billboard, resolved ONCE per frame rather than per particle: the
    // camera is 20+ metres out on a 3/4 view, so every quad in a room-sized
    // cloud turns the same way to within a degree or two.
    this._yaw = Math.atan2(_camPos.x, _camPos.z);

    const wind = this._readWind();
    const beat = this._beat(d);

    for (const L of this.layers) this._tickLayer(L, d, wind, beat);
  }

  _tickLayer(L, dt, wind, beat) {
    const s = L.live;
    const A = L.area;

    // --- how much of this layer belongs to this hour, and to this player -----
    const hour = s.at === 'day' ? 1 - this.nightK
      : s.at === 'night' ? this.nightK
        : s.at === 'noon' ? this.noonK
          : 1;
    const off = this.calm && s.shimmer === true;
    const dens = off ? 0 : (this.calm ? 0.5 : 1);
    const wantN = off ? 0 : Math.min(L.pool, Math.round((s.count || 0) * dens));
    L.n = wantN;
    // the hour's contribution eases so dusk is a fade, never a switch
    const gk = Math.min(1, dt * 1.2);
    L.gain += (off ? 0 : hour) * gk - L.gain * gk;

    const pulse = s.pulse === 'beat' ? 0.75 + beat * 0.55 : 1;
    const baseOp = Number.isFinite(s.opacity) ? s.opacity : 1;
    if (s.pulse === 'beat') {
      L.mat.opacity = baseOp * pulse;
      if (L.kind === 'drift') L.mat.size = (s.size || 0.1) * (0.9 + beat * 0.25);
    }

    _tint.setHex(s.color ?? 0xffffff);
    const data = L.data;
    const add = !!s.add;
    const far = A.r * 2.6 + 24;      // additive cull distance for this room
    const fadeBand = 12;
    const size = s.size || 0.1;
    const gain = clamp01(L.gain);
    const t = this.t;

    let dirty = false;

    for (let i = 0; i < L.pool; i++) {
      const o = i * STRIDE;
      const seed = data[o + 6];
      const ph = seed * TAU;
      const sp = 0.55 + frac(seed * 13.7) * 0.9;   // per-particle rate / size jitter
      const s2 = frac(seed * 31.3);

      // alpha: joining or leaving the live pool, eased so nothing ever pops
      const target = i < L.n ? 1 : 0;
      let al = data[o + 7];
      if (al !== target) {
        const step = ALPHA_RATE * dt;
        al = target > al ? Math.min(target, al + step) : Math.max(target, al - step);
        data[o + 7] = al;
      }
      if (al <= 0.001) { // fully retired: park it and skip all the maths
        if (L.kind === 'drift') {
          if (L.posArr[i * 3 + 1] !== PARK_Y) {
            L.posArr[i * 3 + 1] = PARK_Y; L.colArr[i * 3] = 0;
            L.colArr[i * 3 + 1] = 0; L.colArr[i * 3 + 2] = 0; dirty = true;
          }
        } else {
          _obj.position.set(0, PARK_Y, 0); _obj.rotation.set(0, 0, 0);
          _obj.scale.setScalar(0.0001); _obj.updateMatrix();
          L.mesh.setMatrixAt(i, _obj.matrix);
          L.mesh.instanceColor.setXYZ(i, 0, 0, 0);
          dirty = true;
        }
        continue;
      }

      // --- motion ---------------------------------------------------------
      let x = data[o], y = data[o + 1], z = data[o + 2];
      let spin = 0, stretch = 1, tilt = 0;

      switch (s.kernel) {
        case 'fall': {
          y -= (s.speed || 0.5) * sp * dt;
          const sway = s.sway || 0;
          x += (Math.sin(t * 1.3 + ph) * sway + wind.x * 0.35) * dt;
          z += (Math.cos(t * 1.1 + ph * 1.7) * sway + wind.z * 0.35) * dt;
          spin = s.spin ? t * s.spin * (s2 > 0.5 ? 1 : -1) + ph : 0;
          if (y < A.y0) { this._spawn(L, i, 'top'); x = data[o]; y = data[o + 1]; z = data[o + 2]; }
          break;
        }
        case 'rise': {
          y += (s.speed || 0.5) * sp * dt;
          const sway = s.sway || 0;
          x += Math.sin(t * 1.7 + ph) * sway * dt;
          z += Math.cos(t * 1.5 + ph * 1.3) * sway * dt;
          if (y > A.y1) { this._spawn(L, i, 'bottom'); x = data[o]; y = data[o + 1]; z = data[o + 2]; }
          break;
        }
        case 'wind': {
          const k = 0.4 + sp;
          x += wind.x * k * (s.speed || 1) * dt;
          z += wind.z * k * (s.speed || 1) * dt;
          y -= ((s.speed || 1) * 0.35 * sp + Math.sin(t * 2 + ph) * (s.sway || 0)) * dt;
          stretch = 1 + Math.min(2.4, wind.k * 1.5) * (0.4 + s2 * 0.8);
          tilt = -Math.atan2(0.35 * wind.k, 1) * (wind.x < 0 ? -1 : 1);
          if (y < A.y0 || Math.abs(x - A.cx) > A.r || Math.abs(z - A.cz) > A.r) {
            this._spawn(L, i, 'wind', wind);
            x = data[o]; y = data[o + 1]; z = data[o + 2];
          }
          break;
        }
        case 'flit': {
          // A closed wander: pure function of t, so it never drifts out of the
          // area and never needs a boundary test.
          const cx = A.cx + (frac(seed * 5.1) * 2 - 1) * A.r * 0.7;
          const cz = A.cz + (frac(seed * 9.7) * 2 - 1) * A.r * 0.7;
          const rr = 1.1 + s2 * 2.4;
          const a = ph + t * (s.speed || 0.6) * (0.5 + sp * 0.5);
          x = cx + Math.sin(a) * rr + Math.sin(a * 2.3 + ph) * rr * 0.28;
          z = cz + Math.cos(a * 0.87 + ph) * rr + Math.cos(a * 1.9) * rr * 0.22;
          y = A.y0 + (A.y1 - A.y0) * (0.5 + 0.42 * Math.sin(a * 1.6 + ph * 2));
          spin = Math.atan2(Math.cos(a) * rr, -Math.sin(a * 0.87) * rr);
          if (s.flap) stretch = 0.35 + 0.65 * Math.abs(Math.sin(t * s.flap + ph));
          break;
        }
        case 'float':
        default: {
          // Brownian-looking without any randomness per frame: three sines with
          // coprime-ish rates, seeded per particle.
          const sp2 = (s.speed || 0.15) * (0.5 + sp);
          x += Math.sin(t * 0.31 + ph) * sp2 * dt * 3;
          y += Math.sin(t * 0.23 + ph * 2.1) * sp2 * dt * 1.4;
          z += Math.cos(t * 0.27 + ph * 1.3) * sp2 * dt * 3;
          if (y < A.y0) y = A.y0; else if (y > A.y1) y = A.y1;
          // Wander around HOME, not around the room: a pollen mote that spawned
          // in a light shaft stays in that shaft instead of slowly filling the
          // clearing, which is the whole reason the shafts read at all.
          const hx = data[o + 3], hr = data[o + 4], hz = data[o + 5];
          const dx = x - hx, dz = z - hz;
          const dd = Math.sqrt(dx * dx + dz * dz);
          if (dd > hr) { x = hx + (dx / dd) * hr; z = hz + (dz / dd) * hr; }
          break;
        }
      }

      data[o] = x; data[o + 1] = y; data[o + 2] = z;

      // --- brightness -----------------------------------------------------
      let a = al * gain;
      if (s.fadeTop) a *= 1 - smooth(A.y1 - (A.y1 - A.y0) * 0.35, A.y1, y);
      if (s.fadeBottom) a *= smooth(A.y0, A.y0 + (A.y1 - A.y0) * 0.2, y);
      if (s.blink) {
        const b = 0.5 + 0.5 * Math.sin(t * (1.3 + s2 * 2.2) + ph * 5);
        a *= 1 - s.blink + s.blink * (this.calm ? 0.5 + b * 0.5 : b * b);
      }
      if (s.pulse === 'beat') a *= pulse;

      // Additive layers have no fog to hide behind, so they dissolve themselves
      // over the last few metres. Normal-blended layers let the room's fog do
      // it, which matches the scenery exactly and costs nothing.
      if (add) {
        const dx = x - _camPos.x, dy = y - _camPos.y, dz = z - _camPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        a *= 1 - smooth(far - fadeBand, far, dist);
      }

      // --- write ----------------------------------------------------------
      if (L.kind === 'drift') {
        const p = i * 3;
        L.posArr[p] = x; L.posArr[p + 1] = y; L.posArr[p + 2] = z;
        // normal blending cannot fade through colour, so it rides the fog and
        // keeps its tint; additive uses colour as its alpha.
        const k = add ? a : Math.max(a, 0.001);
        L.colArr[p] = _tint.r * k;
        L.colArr[p + 1] = _tint.g * k;
        L.colArr[p + 2] = _tint.b * k;
        dirty = true;
      } else {
        _obj.position.set(x, y, z);
        _obj.rotation.set(0, this._yaw, spin + tilt);
        const sc = size * (0.7 + s2 * 0.6);
        // A normal-blended mote cannot fade through its colour (black is not
        // transparent), so it fades by SHRINKING, and it must reach zero: a
        // floor here would leave half-size butterflies hanging over the plaza
        // all night, between their hour ending and the night mode taking over.
        // sqrt because a quad's area is its scale squared, so the square root
        // keeps the apparent fade closer to linear.
        const shrink = add ? 1 : Math.sqrt(clamp01(a));
        _obj.scale.set(sc * stretch * shrink, sc * shrink, 1);
        _obj.updateMatrix();
        L.mesh.setMatrixAt(i, _obj.matrix);
        const k = add ? a : 1;
        L.mesh.instanceColor.setXYZ(i, _tint.r * k, _tint.g * k, _tint.b * k);
        dirty = true;
      }
    }

    if (!dirty) return;
    if (L.kind === 'drift') {
      L.geo.attributes.position.needsUpdate = true;
      L.colAttr.needsUpdate = true;
    } else {
      L.mesh.instanceMatrix.needsUpdate = true;
      L.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Place particle `i` somewhere sensible. `from` says which face of the
   *  column it enters through, so recycling never happens in plain view. */
  _spawn(L, i, from, wind = null) {
    const o = i * STRIDE;
    const A = L.area;
    const data = L.data;
    // A seed, not a per-frame random: everything else about this particle is
    // derived from it, so a recycled particle gets a genuinely new character.
    const seed = Math.random();
    data[o + 6] = seed;

    let x, z;
    let hx = A.cx, hz = A.cz, hr = A.r; // where this one may wander (float kernel)
    if (L.shafts) {
      const sh = L.shafts[(Math.random() * L.shafts.length) | 0];
      const a = Math.random() * TAU;
      const rr = Math.sqrt(Math.random()) * (sh[2] || 1);
      x = sh[0] + Math.cos(a) * rr;
      z = sh[1] + Math.sin(a) * rr;
      hx = sh[0]; hz = sh[1]; hr = (sh[2] || 1) * 1.3;
    } else {
      const a = Math.random() * TAU;
      const inR = A.rIn || 0;
      const rr = Math.sqrt(inR * inR + Math.random() * (A.r * A.r - inR * inR));
      x = A.cx + Math.cos(a) * rr;
      z = A.cz + Math.sin(a) * rr;
    }

    let y;
    if (from === 'top') y = A.y1 - Math.random() * (A.y1 - A.y0) * 0.08;
    else if (from === 'bottom') y = A.y0 + Math.random() * (A.y1 - A.y0) * 0.08;
    else y = A.y0 + Math.random() * (A.y1 - A.y0);

    if (from === 'wind' && wind) {
      // re-enter upwind, so a gust looks like it is BRINGING the snow in
      const m = Math.hypot(wind.x, wind.z) || 1;
      x = A.cx - (wind.x / m) * A.r * (0.85 + Math.random() * 0.15);
      z = A.cz - (wind.z / m) * A.r * (0.85 + Math.random() * 0.15);
      x += (Math.random() - 0.5) * A.r * 0.9;
      z += (Math.random() - 0.5) * A.r * 0.9;
      y = A.y0 + Math.random() * (A.y1 - A.y0);
    }

    data[o] = x; data[o + 1] = y; data[o + 2] = z;
    data[o + 3] = hx; data[o + 4] = hr; data[o + 5] = hz;
    // alpha is left alone on a recycle: a particle that was visible stays
    // visible, and one still fading in keeps fading in.
    if (from === 'any') data[o + 7] = i < (L.spec.count || 0) ? 1 : 0;
  }

  // -- teardown ------------------------------------------------------------
  dispose() {
    if (!this.active) return;
    this.active = false;

    for (const L of this.layers) {
      try {
        if (L.mesh) {
          this.scene?.remove(L.mesh);
          L.mesh.dispose?.();               // InstancedMesh frees its own buffers
        }
        L.geo?.dispose?.();
        // The map is a page-lived shared sprite (TEXES): the material goes, the
        // texture stays for the next room.
        if (L.mat) { L.mat.map = null; L.mat.dispose?.(); }
      } catch (e) { console.error('[ambience] dispose:', e); }
      L.mesh = null; L.mat = null; L.geo = null;
      L.posArr = null; L.colArr = null; L.colAttr = null; L.data = null;
    }
    this.layers.length = 0;

    this._unhook('update', this._wrapUpdate, this._origUpdate, this._ownUpdate);
    this._unhook('dispose', this._wrapDispose, this._origDispose, this._ownDispose);
    this._unhook('onClock', this._wrapClock, this._origClock, this._ownClock);
    this._prevUpdate = null; this._prevDispose = null; this._prevClock = null;
    this._origUpdate = null; this._origDispose = null; this._origClock = null;
    this._wrapUpdate = null; this._wrapDispose = null; this._wrapClock = null;

    if (this.room?.__ambience === this) this.room.__ambience = null;
    this.room = null; this.scene = null; this.game = null;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function safeCall(fn, self) {
  try { return fn.call(self); } catch { return null; }
}
function num(v) { return Number.isFinite(v) ? v : null; }

export default { attachAmbience, ambienceConfig, AMBIENCE_ROOMS };
