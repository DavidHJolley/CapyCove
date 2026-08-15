import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { BOT_ZONES } from '../../../shared/constants.js';

/**
 * Groove Grotto: an underground dance cave.
 *
 * Layout (looking north, -Z is deep in the cave):
 *   -Z  DJ booth wedge + bobbing capybara DJ + speaker stacks + neon sign
 *    0  8x8 LED dance floor podium (covers BOT_ZONES.club, flat + walkable)
 *   +Z  glowing stairway up to Sunny Plaza
 *  around: displaced rock shell, crystal clusters, uplight pillars
 *
 * Draw-call plan: everything repeated is an InstancedMesh (tiles, crystals,
 * stalactites, EQ bars, stair steps, mirror-ball dots, dust). The 64 LED tiles
 * are a single instanced draw whose per-instance colours are rewritten each
 * frame, so the floor animates without 64 materials.
 */

// ---- tuning -----------------------------------------------------------------

const BPM = 128;
const BEAT = 60 / BPM; // 0.46875s
const ZONE = BOT_ZONES.club; // { x: 0, z: 2, r: 4.5 }

const TILES = 8;
const TILE_STEP = 1.2;
const TILE_SIZE = 1.1;
const GRID_HALF = ((TILES - 1) * TILE_STEP) / 2; // 4.2
const PODIUM_TOP = 0.15; // walkable height of the dance floor
const TILE_TOP = 0.168; // LED tiles sit a hair proud of the slab

const FLOOR_R = 13.6; // walkable rock floor radius (scenery lives outside it)
const SHELL_R = 17; // cave shell sphere radius (scaled below)
const SHELL_SY = 0.62;
const SHELL_SXZ = 1.15;
const SHELL_Y = 1;

const STEP_H = 0.32;
const STEP_D = 0.95;
const STEP_N = 6;
const STAIR_Z0 = 8.4;
const STAIR_W = 3.8;
const LANDING_Y = STEP_N * STEP_H; // 1.92

const PAL = {
  rock: 0x453466,
  rockDeep: 0x2f2449,
  floor: 0x3a2c58,
  slab: 0x181026,
  booth: 0x4a3370,
  boothTop: 0x5d4288,
  metal: 0x574a7d,
  gear: 0x2e2547,
  fur: 0xb08a5a,
  furLight: 0xc9a678,
  snout: 0x3a2a1c,
  chrome: 0xbcc4e8,
};

const NEON = {
  pink: 0xff3ea5,
  cyan: 0x36e0ff,
  lime: 0x9dff4a,
  gold: 0xf2b64a,
  violet: 0xb46bff,
  coral: 0xe8657a,
};

// Each "track" the DJ can be asked for drives one LED floor pattern.
const TRACKS = [
  'Capybara Bassline',
  'Grotto Groove',
  'Neon Waterfall',
  'Stalactite Stomp',
  'Midnight Mudbath',
];

// Crystal clusters: kept off the dance floor and out of the stair corridor.
const CLUSTERS = [
  { x: -10.6, z: -5.4, hue: 0.78, n: 7 },
  { x: -12.4, z: 3.4, hue: 0.52, n: 6 },
  { x: -7.6, z: 9.8, hue: 0.88, n: 5 },
  { x: 10.8, z: -5.8, hue: 0.56, n: 7 },
  { x: 12.6, z: 3.0, hue: 0.28, n: 6 },
  { x: 7.8, z: 10.0, hue: 0.74, n: 5 },
  { x: -4.6, z: -12.0, hue: 0.62, n: 6 },
  { x: 4.6, z: -11.6, hue: 0.92, n: 6 },
];

// Stage uplights and rock lounge ledges, hand-placed to stay clear of the
// crystal clusters, the speaker stacks and the stair corridor.
const UPLIGHTS = [
  [-12.2, -1.0], [12.2, -1.0],
  [-9.5, 7.5], [9.5, 7.5],
  [-9.8, -9.5], [9.8, -9.5],
];

const LEDGES = [
  [-8.8, 2.5], [8.8, 2.5],
  [-8.2, -2.6], [8.2, -2.6],
];

// ---- small helpers ----------------------------------------------------------

/** Deterministic LCG so the cave looks identical on every visit. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Smooth, seam-safe noise: a pure function of position, so duplicated seam
 *  vertices displace identically and the shell stays watertight. */
function caveNoise(x, y, z) {
  return (
    Math.sin(x * 0.62 + y * 0.9) * 0.55 +
    Math.sin(z * 0.78 - y * 0.55) * 0.45 +
    Math.sin((x + z) * 1.25 + 1.7) * 0.28 +
    Math.sin((x - z) * 2.1 - y * 1.3) * 0.16
  );
}

/** Push every vertex along its own direction by noise: lumpy low-poly rock. */
function displaceRadial(geo, amp) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const len = v.length();
    if (len < 1e-4) continue;
    const n = caveNoise(v.x, v.y, v.z);
    v.multiplyScalar(1 + (n * amp) / len);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Hard-edged low-poly look. MeshToonMaterial has no `flatShading` flag, so we
 *  bake per-face normals into the geometry instead. */
function faceted(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/** instanceColor only reaches the fragment shader when USE_COLOR is defined,
 *  and USE_COLOR needs a real `color` attribute: give the geometry white. */
function whiteVertexColors(geo) {
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return geo;
}

/** InstancedMesh whose per-instance colour we drive from update(). */
function instancedGlow(geo, count) {
  const mat = makeGlow(0xffffff, { unique: true });
  mat.vertexColors = true;
  const im = new THREE.InstancedMesh(whiteVertexColors(geo), mat, count);
  const c = new THREE.Color(0xffffff);
  for (let i = 0; i < count; i++) im.setColorAt(i, c);
  im.instanceColor.setUsage(THREE.DynamicDrawUsage);
  return im;
}

/** Unique additive/transparent basic material for beams, haze and portals. */
function fxMat(color, { opacity = 0.12, side = THREE.DoubleSide, additive = true } = {}) {
  const m = makeGlow(color, { unique: true });
  m.transparent = true;
  m.opacity = opacity;
  m.side = side;
  m.depthWrite = false;
  m.fog = false;
  if (additive) m.blending = THREE.AdditiveBlending;
  return m;
}

/** World clock (wave 7): 1 at noon, 0 at midnight, 0.5 at dawn and dusk.
 *  The grotto is a cave with no windows, so per LIVING-COVE.md it ignores
 *  weather entirely; the only thing time of day can reach is the daylight
 *  falling down the stairwell from the plaza (see onClock). */
function daylight(dayT) {
  return 0.5 + 0.5 * Math.cos(((((dayT % 1) + 1) % 1) - 0.25) * Math.PI * 2);
}

/** Soft round sprite for dust motes. */
function dotTexture() {
  return canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(220,200,255,0.55)');
    g.addColorStop(1, 'rgba(180,150,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

// -----------------------------------------------------------------------------

export class ClubRoom extends Room {
  id = 'club';
  name = 'Groove Grotto';

  build(scene, game) {
    // per-visit animation state (rooms are rebuilt on every entry)
    this._t = 0;
    this._pattern = 0;
    this._patternAt = 0;
    this._boost = 0;
    this._track = 0;
    this._dummy = new THREE.Object3D();
    this._col = new THREE.Color();
    this._instanced = [];
    // world clock (wave 7): how much daylight is falling down the stairwell,
    // and the two ends the portal tint lerps between. Preallocated: onClock
    // must not allocate.
    this._portalK = 1;
    this._sunSpill = new THREE.Color(0xffd9a0);
    this._moonSpill = new THREE.Color(0x8f7ce0);

    scene.background = new THREE.Color(0x090612);
    // Per-room colour grade (src/core/postfx.js; -1..+1). The one room that
    // must NOT be warmed and must NOT be lifted: the whole look is saturated
    // neon over near-black purple, and a warm shadow lift turns the grotto
    // brown and greys out the only thing the room is for. Darks stay dark; the
    // dance floor and the crystals do the lighting.
    this.grade = { warmth: -0.2, lift: -0.5 };
    scene.fog = new THREE.FogExp2(0x110a20, 0.017);

    this.cameraHint = { offset: new THREE.Vector3(0, 11, 15), lookHeight: 1 };
    // Static camera: a 3/4 vantage like every other room. The old near-vertical
    // one (y=31 over z=12) kept the stalactites off the sign but shrank a dancer
    // to 12px: from the floor you were looking at a floorplan, not a club. The
    // fix is the x offset, not the elevation: 2 east threads the gap in the
    // drip curtain, so the neon sign, the DJ booth and the LED floor all read
    // whole and a capy on the floor is ~45px. Worst hotspot/spawn NDC 0.56.
    this.staticCamera = { position: new THREE.Vector3(2, 15, 21), lookAt: new THREE.Vector3(0, 1.4, 0.5) };

    this._buildCave(scene);
    this._buildDanceFloor(scene);
    this._buildCrystals(scene);
    this._buildUplights(scene);
    this._buildLounge(scene);
    this._buildBooth(scene);
    this._buildSpeakers(scene);
    this._buildSign(scene);
    this._buildMirrorBall(scene);
    this._buildBeams(scene);
    this._buildStairs(scene);
    this._buildAtmosphere(scene);
    this._buildLights(scene);

    // both sit clear of the exit-plaza hotspot at (0,8) r=3.2, so arriving (or
    // jumping here from the map) does not pop the "go back" prompt over you
    this.spawnPoints = {
      default: new THREE.Vector3(0, PODIUM_TOP, 4.2),
      from_plaza: new THREE.Vector3(0, PODIUM_TOP, 4.2),
    };

    this.hotspots.push({
      id: 'exit-plaza',
      position: new THREE.Vector3(0, 0, 8),
      radius: 3.2,
      label: 'Up to Sunny Plaza',
      action: (g) => g.goToRoom('plaza', 'club'),
    });

    this.hotspots.push({
      id: 'dj-request',
      position: new THREE.Vector3(0, 0, -4.4),
      radius: 2.6,
      label: 'Request a track',
      action: (g) => this._requestTrack(g),
    });

    // prime the LEDs so frame one already looks alive
    this._updateTiles(0);
  }

  // ---- cave shell ----------------------------------------------------------

  _buildCave(scene) {
    // One displaced sphere is the whole cave: walls + domed ceiling, BackSide.
    const shellGeo = faceted(displaceRadial(new THREE.SphereGeometry(SHELL_R, 36, 18), 0.95));
    const shell = new THREE.Mesh(shellGeo, makeToon(PAL.rock, { side: THREE.BackSide }));
    shell.scale.set(SHELL_SXZ, SHELL_SY, SHELL_SXZ);
    shell.position.y = SHELL_Y;
    scene.add(shell);

    // Walkable rock floor (kept well inside the wall) + a non-walkable apron
    // so the cave reads as solid rock all the way to the wall base.
    // The floor is the biggest single surface in the room and it was one flat
    // purple, which is why the grotto read as a lit stage standing on a sheet
    // of card: the LED floor had an edge, the rock around it had none. A vertex
    // tint puts damp, uneven rock under it - broad blotches, and a slow
    // darkening out toward the wall base so the middle of the cave stays the
    // brightest thing that is not a light. RingGeometry (inner radius 0) is the
    // same disc as CircleGeometry with rings of vertices for the tint to live
    // in; the fan is degenerate and costs nothing. Build-time, one draw call.
    const floorMat = makeToon(PAL.floor, { vertexColors: true });
    const floorGeo = new THREE.RingGeometry(0, FLOOR_R, 44, 4);
    {
      const p = floorGeo.attributes.position;
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i); // un-rotated: the disc lies in XY
        const blot = Math.sin(x * 0.42 - 0.9) * Math.sin(y * 0.37 + 1.6)
          + 0.5 * Math.sin((x - y) * 0.78 + 0.4);
        const far = Math.min(1, Math.hypot(x, y) / FLOOR_R);
        const t = 1 + blot * 0.09 - far * far * 0.22;
        col[i * 3] = t + blot * 0.02;
        col[i * 3 + 1] = t - blot * 0.01;
        col[i * 3 + 2] = t + blot * 0.03;
      }
      floorGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    this.groundMeshes.push(floor);

    // The apron keeps the PLAIN material: a vertexColors material over geometry
    // with no colour attribute renders black (the disabled attribute reads as
    // 0,0,0), so the two cannot share one material any more. It is a separate
    // mesh either way, so this costs a cache entry and no draw call - and it
    // wants to be a shade darker than the floor it rings anyway.
    // It also has to drop out of the floor's plane now. The two rings overlap
    // by 0.1 at r 13.5..13.6, which was invisible while they shared one
    // material and is a crawling dashed ring the moment they do not. 2mm is the
    // spacing the plaza uses for its stacked ground layers.
    const apron = new THREE.Mesh(
      new THREE.RingGeometry(FLOOR_R - 0.1, 22, 44, 1), makeToon(PAL.rockDeep),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.002;
    scene.add(apron);

    const r = rng(20260806);

    // Stalactites removed (playtester call, 2026-08-07): from every play
    // camera they crossed the frame as dark blades over the dance floor and
    // hid dancers. The dome, crystals and floor spikes carry the cave read;
    // burn the rng draws they consumed so everything placed after them keeps
    // its seeded spot.
    // (8 draws each: angle, radius, 3 rotation, 3 scale)
    for (let i = 0; i < 34 * 8; i++) r();
    const d = this._dummy;

    // stalagmites + boulders around the rim
    const spikeGeo = faceted(new THREE.ConeGeometry(0.55, 2.2, 6));
    spikeGeo.translate(0, 1.1, 0);
    const spikes = new THREE.InstancedMesh(spikeGeo, makeToon(PAL.rock), 22);
    for (let i = 0; i < 22; i++) {
      const a = r() * Math.PI * 2;
      const rad = FLOOR_R + 0.2 + r() * 3.2;
      d.position.set(Math.cos(a) * rad, -0.15, Math.sin(a) * rad);
      d.rotation.set((r() - 0.5) * 0.2, r() * 6.28, (r() - 0.5) * 0.2);
      d.scale.set(0.6 + r() * 0.8, 0.6 + r() * 1.6, 0.6 + r() * 0.8);
      d.updateMatrix();
      spikes.setMatrixAt(i, d.matrix);
    }
    scene.add(spikes);

    const rockGeo = faceted(new THREE.IcosahedronGeometry(0.9, 0));
    const rocks = new THREE.InstancedMesh(rockGeo, makeToon(PAL.rockDeep), 18);
    for (let i = 0; i < 18; i++) {
      const a = r() * Math.PI * 2;
      const rad = FLOOR_R - 0.6 + r() * 4;
      d.position.set(Math.cos(a) * rad, -0.25 + r() * 0.2, Math.sin(a) * rad);
      d.rotation.set(r() * 6.28, r() * 6.28, r() * 6.28);
      d.scale.set(0.6 + r() * 1.1, 0.5 + r() * 0.7, 0.6 + r() * 1.1);
      d.updateMatrix();
      rocks.setMatrixAt(i, d.matrix);
    }
    scene.add(rocks);
  }

  /** Approximate ceiling height of the shell above (x, z). */
  _ceilingY(x, z) {
    const rad = Math.hypot(x, z) / SHELL_SXZ;
    const inner = Math.max(0, SHELL_R * SHELL_R - rad * rad);
    return SHELL_Y + Math.sqrt(inner) * SHELL_SY - 0.6;
  }

  // ---- LED dance floor -----------------------------------------------------

  _buildDanceFloor(scene) {
    const w = GRID_HALF * 2 + TILE_SIZE + 0.9;
    const dpt = GRID_HALF * 2 + TILE_SIZE + 2.2;

    // The slab top is the walkable surface; tiles poke 1.8cm above it, which is
    // far below anything the eye (or the foot-height raycast) cares about.
    const podium = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.34, dpt),
      makeToon(PAL.slab),
    );
    podium.position.set(ZONE.x, PODIUM_TOP - 0.17, ZONE.z);
    scene.add(podium);
    this.groundMeshes.push(podium);

    // 64 emissive tiles: one instanced draw, colours rewritten every frame.
    const tileGeo = new THREE.BoxGeometry(TILE_SIZE, 0.12, TILE_SIZE);
    const tiles = instancedGlow(tileGeo, TILES * TILES);
    const d = this._dummy;
    this._tileGX = new Float32Array(TILES * TILES);
    this._tileGZ = new Float32Array(TILES * TILES);
    this._tileD = new Float32Array(TILES * TILES);
    this._tileA = new Float32Array(TILES * TILES);
    let i = 0;
    for (let gz = 0; gz < TILES; gz++) {
      for (let gx = 0; gx < TILES; gx++, i++) {
        d.position.set(
          ZONE.x - GRID_HALF + gx * TILE_STEP,
          TILE_TOP - 0.06,
          ZONE.z - GRID_HALF + gz * TILE_STEP,
        );
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        tiles.setMatrixAt(i, d.matrix);
        this._tileGX[i] = gx;
        this._tileGZ[i] = gz;
        this._tileD[i] = Math.hypot(gx - (TILES - 1) / 2, gz - (TILES - 1) / 2);
        this._tileA[i] = Math.atan2(gz - (TILES - 1) / 2, gx - (TILES - 1) / 2);
      }
    }
    scene.add(tiles);
    this.tiles = tiles;
    this._instanced.push(tiles);

    // glowing rim around the podium (4 scaled instances of one bar)
    const rim = instancedGlow(new THREE.BoxGeometry(1, 0.09, 0.16), 4);
    const half = { x: w / 2, z: dpt / 2 };
    const edges = [
      [0, -half.z, w, 0],
      [0, half.z, w, 0],
      [-half.x, 0, dpt, Math.PI / 2],
      [half.x, 0, dpt, Math.PI / 2],
    ];
    for (let e = 0; e < 4; e++) {
      const [ex, ez, len, rot] = edges[e];
      d.position.set(ZONE.x + ex, PODIUM_TOP + 0.02, ZONE.z + ez);
      d.rotation.set(0, rot, 0);
      d.scale.set(len, 1, 1);
      d.updateMatrix();
      rim.setMatrixAt(e, d.matrix);
    }
    scene.add(rim);
    this.rim = rim;
    this._instanced.push(rim);

    // mirror-ball light pools sliding across the floor (rotated as a group)
    const spotGeo = new THREE.CircleGeometry(0.55, 12);
    spotGeo.rotateX(-Math.PI / 2);
    const pools = new THREE.InstancedMesh(spotGeo, fxMat(0xdcd0ff, { opacity: 0.4, side: THREE.FrontSide }), 20);
    const r = rng(4242);
    for (let k = 0; k < 20; k++) {
      const a = r() * Math.PI * 2;
      const rad = 2.5 + r() * 11;
      d.position.set(Math.cos(a) * rad, PODIUM_TOP + 0.06, ZONE.z + Math.sin(a) * rad);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(0.5 + r() * 0.9);
      d.updateMatrix();
      pools.setMatrixAt(k, d.matrix);
    }
    const poolGroup = new THREE.Group();
    poolGroup.add(pools);
    scene.add(poolGroup);
    this.poolGroup = poolGroup;
    this._instanced.push(pools);
  }

  // ---- crystals + uplights -------------------------------------------------

  _buildCrystals(scene) {
    const r = rng(90210);
    const d = this._dummy;
    let total = 0;
    for (const c of CLUSTERS) total += c.n;

    const crystalGeo = new THREE.ConeGeometry(0.3, 1.5, 5);
    crystalGeo.translate(0, 0.75, 0);
    const crystals = instancedGlow(crystalGeo, total);
    const baseGeo = faceted(new THREE.IcosahedronGeometry(0.7, 0));
    const bases = new THREE.InstancedMesh(baseGeo, makeToon(PAL.rockDeep), CLUSTERS.length * 3);

    this._crystalHue = new Float32Array(total);
    this._crystalPhase = new Float32Array(total);

    let i = 0;
    let b = 0;
    for (const c of CLUSTERS) {
      for (let k = 0; k < c.n; k++, i++) {
        const a = r() * Math.PI * 2;
        const rad = r() * 1.25;
        const s = 0.55 + r() * 1.15;
        d.position.set(c.x + Math.cos(a) * rad, -0.1, c.z + Math.sin(a) * rad);
        d.rotation.set((r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.5);
        d.scale.set(s * (0.7 + r() * 0.6), s * (0.8 + r() * 1.5), s * (0.7 + r() * 0.6));
        d.updateMatrix();
        crystals.setMatrixAt(i, d.matrix);
        this._crystalHue[i] = c.hue + (r() - 0.5) * 0.06;
        this._crystalPhase[i] = r() * 6.28;
      }
      for (let k = 0; k < 3; k++, b++) {
        const a = r() * Math.PI * 2;
        d.position.set(c.x + Math.cos(a) * 1.1, -0.3, c.z + Math.sin(a) * 1.1);
        d.rotation.set(r() * 6.28, r() * 6.28, r() * 6.28);
        d.scale.set(0.7 + r() * 0.8, 0.5 + r() * 0.5, 0.7 + r() * 0.8);
        d.updateMatrix();
        bases.setMatrixAt(b, d.matrix);
      }
      this.obstacles.push({ x: c.x, z: c.z, r: 1.7 });
    }
    scene.add(bases);
    scene.add(crystals);
    this.crystals = crystals;
    this._instanced.push(crystals, bases);
  }

  _buildUplights(scene) {
    const n = UPLIGHTS.length;
    const d = this._dummy;
    const stands = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.28, 0.36, 0.5, 8),
      makeToon(PAL.metal),
      n,
    );
    const tubeGeo = new THREE.CylinderGeometry(0.11, 0.11, 2.6, 6);
    tubeGeo.translate(0, 1.3, 0);
    const tubes = instancedGlow(tubeGeo, n);
    for (let i = 0; i < n; i++) {
      const [x, z] = UPLIGHTS[i];
      d.position.set(x, 0.25, z);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      stands.setMatrixAt(i, d.matrix);
      d.position.set(x, 0.45, z);
      d.updateMatrix();
      tubes.setMatrixAt(i, d.matrix);
      this.obstacles.push({ x, z, r: 0.8 });
    }
    scene.add(stands);
    scene.add(tubes);
    this.tubes = tubes;
    this._instanced.push(stands, tubes);
  }

  /** Rock ledges to lean on, ringing the dance floor. */
  _buildLounge(scene) {
    const d = this._dummy;
    const n = LEDGES.length;
    const seats = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.8, 0.62, 1.15),
      makeToon(PAL.rock),
      n,
    );
    const rims = instancedGlow(new THREE.BoxGeometry(2.65, 0.07, 0.1), n);
    for (let i = 0; i < n; i++) {
      const [x, z] = LEDGES[i];
      const yaw = Math.atan2(ZONE.x - x, ZONE.z - z);
      d.position.set(x, 0.28, z);
      d.rotation.set(0, yaw, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      seats.setMatrixAt(i, d.matrix);
      d.position.set(x + Math.sin(yaw) * 0.56, 0.6, z + Math.cos(yaw) * 0.56);
      d.updateMatrix();
      rims.setMatrixAt(i, d.matrix);
      this.obstacles.push({ x, z, r: 1.6 });
    }
    scene.add(seats);
    scene.add(rims);
    this.rims = rims;
    this._instanced.push(seats, rims);
  }

  // ---- DJ booth ------------------------------------------------------------

  _buildBooth(scene) {
    const BZ = -7;
    const booth = new THREE.Group();
    booth.position.set(0, 0, BZ);
    scene.add(booth);

    // wedge-shaped booth, open at the back so the DJ can stand behind it
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(2.9, 3.05, 1.2, 22, 1, false, -Math.PI * 0.35, Math.PI * 0.7),
      makeToon(PAL.booth),
    );
    body.position.y = 0.6;
    booth.add(body);

    const desk = new THREE.Mesh(
      new THREE.CylinderGeometry(3.1, 3.1, 0.16, 22, 1, false, -Math.PI * 0.37, Math.PI * 0.74),
      makeToon(PAL.boothTop),
    );
    desk.position.y = 1.28;
    booth.add(desk);

    // animated EQ bars across the booth face
    const barGeo = new THREE.BoxGeometry(0.15, 1, 0.08);
    barGeo.translate(0, 0.5, 0);
    const bars = instancedGlow(barGeo, 18);
    bars.frustumCulled = false; // per-frame scale changes invalidate the bounds
    const d = this._dummy;
    for (let i = 0; i < 18; i++) {
      const th = -1.02 + (i / 17) * 2.04;
      d.position.set(Math.sin(th) * 2.99, 0.22, Math.cos(th) * 2.99);
      d.rotation.set(0, th, 0);
      d.scale.set(1, 0.4, 1);
      d.updateMatrix();
      bars.setMatrixAt(i, d.matrix);
    }
    booth.add(bars);
    this.bars = bars;
    this._instanced.push(bars);

    // turntables
    const platterMat = makeToon(PAL.metal);
    const vinylMat = makeToon(0x171223);
    this.records = [];
    for (const side of [-1, 1]) {
      const platter = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.7, 0.12, 16), platterMat);
      platter.position.set(side * 1.35, 1.4, 1.15);
      booth.add(platter);

      const rec = new THREE.Group();
      rec.position.set(side * 1.35, 1.47, 1.15);
      booth.add(rec);
      const vinyl = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.04, 18), vinylMat);
      rec.add(vinyl);
      const label = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12),
        makeGlow(side < 0 ? NEON.pink : NEON.cyan),
      );
      rec.add(label);
      const nub = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.34), makeGlow(0xfff0d0));
      nub.position.set(0, 0.03, 0.3);
      rec.add(nub);
      this.records.push({ obj: rec, dir: side });

      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.8), makeToon(PAL.chrome));
      arm.position.set(side * 1.95, 1.52, 1.0);
      arm.rotation.y = side * 0.7;
      booth.add(arm);
    }

    // mixer
    const mixer = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.16, 0.8), makeToon(PAL.gear));
    mixer.position.set(0, 1.42, 1.5);
    booth.add(mixer);
    const knobs = instancedGlow(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 6), 8);
    for (let i = 0; i < 8; i++) {
      d.position.set(-0.42 + (i % 4) * 0.28, 1.53, 1.32 + Math.floor(i / 4) * 0.3);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      knobs.setMatrixAt(i, d.matrix);
    }
    booth.add(knobs);
    this.knobs = knobs;
    this._instanced.push(knobs);

    // nameplate on the booth face
    const plateTex = canvasTexture(512, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = 'bold 74px "Trebuchet MS", Verdana, sans-serif';
      c.shadowColor = '#ffb03a';
      c.shadowBlur = 26;
      c.fillStyle = '#fff2d0';
      c.fillText('DJ CAPYBARA', w / 2, h / 2);
      c.fillText('DJ CAPYBARA', w / 2, h / 2);
    });
    const plateMat = fxMat(0xffffff, { opacity: 0.95, side: THREE.FrontSide, additive: false });
    plateMat.map = plateTex;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), plateMat);
    plate.position.set(0, 0.95, 2.98);
    booth.add(plate);

    // riser + the capybara DJ himself
    const riser = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.55, 1.6), makeToon(PAL.rock));
    riser.position.set(0, 0.275, -0.95);
    booth.add(riser);

    const dj = this._buildCapyDJ();
    dj.group.position.set(0, 0.55, -0.95);
    booth.add(dj.group);
    this.dj = dj;

    this.obstacles.push({ x: 0, z: BZ, r: 3.5 });
  }

  /** Chibi capybara DJ statue, proportioned to match the player avatars. */
  _buildCapyDJ() {
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);

    const fur = makeToon(PAL.fur);
    const furLight = makeToon(PAL.furLight);
    const gear = makeToon(PAL.gear);

    const torso = new THREE.Mesh(new THREE.SphereGeometry(0.56, 16, 12), fur);
    torso.scale.set(1, 1.1, 0.88);
    torso.position.y = 0.66;
    body.add(torso);

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), furLight);
    belly.scale.set(0.85, 1, 0.55);
    belly.position.set(0, 0.62, 0.22);
    body.add(belly);

    const head = new THREE.Group();
    head.position.set(0, 1.36, 0.05);
    body.add(head);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), fur);
    skull.scale.set(1, 0.92, 0.95);
    head.add(skull);

    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.36, 0.36), fur);
    muzzle.position.set(0, -0.09, 0.34);
    head.add(muzzle);

    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.11, 0.07), makeToon(PAL.snout));
    nose.position.set(0, 0.01, 0.53);
    head.add(nose);

    const earGeo = new THREE.SphereGeometry(0.1, 8, 6);
    const ears = new THREE.InstancedMesh(earGeo, fur, 2);
    const d = new THREE.Object3D();
    for (let i = 0; i < 2; i++) {
      const s = i ? 1 : -1;
      d.position.set(s * 0.28, 0.38, -0.02);
      d.scale.set(1, 0.8, 0.5);
      d.updateMatrix();
      ears.setMatrixAt(i, d.matrix);
    }
    head.add(ears);
    this._instanced.push(ears);

    // shades
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.17, 0.1), makeToon(0x191122));
    visor.position.set(0, 0.13, 0.36);
    head.add(visor);
    const visorGlow = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.05, 0.03), makeGlow(NEON.cyan));
    visorGlow.position.set(0, 0.13, 0.42);
    head.add(visorGlow);

    // headphones
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 6, 18, Math.PI), gear);
    band.position.y = 0.06;
    head.add(band);
    const cupGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.14, 12);
    cupGeo.rotateZ(Math.PI / 2);
    const cups = new THREE.InstancedMesh(cupGeo, gear, 2);
    const ringGeo = new THREE.TorusGeometry(0.14, 0.035, 6, 14);
    ringGeo.rotateY(Math.PI / 2);
    const rings = new THREE.InstancedMesh(ringGeo, makeGlow(NEON.pink), 2);
    for (let i = 0; i < 2; i++) {
      const s = i ? 1 : -1;
      d.scale.setScalar(1);
      d.position.set(s * 0.5, 0.04, 0);
      d.updateMatrix();
      cups.setMatrixAt(i, d.matrix);
      d.position.set(s * 0.58, 0.04, 0);
      d.updateMatrix();
      rings.setMatrixAt(i, d.matrix);
    }
    head.add(cups);
    head.add(rings);
    this._instanced.push(cups, rings);

    const arms = [];
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.28, 4, 8), fur);
      arm.position.set(s * 0.56, 0.78, 0.12);
      arm.rotation.z = s * 0.55;
      body.add(arm);
      arms.push(arm);
    }

    return { group, body, head, arms };
  }

  // ---- speaker stacks ------------------------------------------------------

  _buildSpeakers(scene) {
    this.speakers = [];
    const cabMat = makeToon(0x2a2140);
    const coneMat = makeToon(0x4a3b6b);
    const cabGeo = new THREE.BoxGeometry(2, 3.6, 1.5);
    const subGeo = new THREE.BoxGeometry(2.3, 1.1, 1.7);
    const wooferGeo = new THREE.CylinderGeometry(0.55, 0.42, 0.22, 14);
    wooferGeo.rotateX(Math.PI / 2);

    for (const side of [-1, 1]) {
      const stack = new THREE.Group();
      stack.position.set(side * 5.9, 0, -6.4);
      stack.rotation.y = side * -0.42;
      scene.add(stack);

      const sub = new THREE.Mesh(subGeo, cabMat);
      sub.position.y = 0.55;
      stack.add(sub);

      const cab = new THREE.Mesh(cabGeo, cabMat);
      cab.position.y = 2.9;
      stack.add(cab);

      const woofers = new THREE.InstancedMesh(wooferGeo, coneMat, 2);
      const d = this._dummy;
      for (let i = 0; i < 2; i++) {
        d.position.set(0, 2.15 + i * 1.35, 0.76);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        woofers.setMatrixAt(i, d.matrix);
      }
      stack.add(woofers);
      this._instanced.push(woofers);

      const grille = instancedGlow(new THREE.BoxGeometry(1.7, 0.1, 0.06), 2);
      for (let i = 0; i < 2; i++) {
        d.position.set(0, 1.5 + i * 3.2, 0.78);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        grille.setMatrixAt(i, d.matrix);
      }
      stack.add(grille);
      this._instanced.push(grille);

      this.speakers.push({ stack, woofers, grille, side });
      this.obstacles.push({ x: side * 5.9, z: -6.4, r: 1.7 });
    }
  }

  // ---- neon sign -----------------------------------------------------------

  _buildSign(scene) {
    const tex = canvasTexture(1024, 320, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.textAlign = 'center';
      c.textBaseline = 'middle';

      c.font = 'bold 138px "Trebuchet MS", Verdana, sans-serif';
      c.shadowColor = '#ff3ea5';
      c.shadowBlur = 46;
      c.fillStyle = '#ffe3f4';
      for (let i = 0; i < 3; i++) c.fillText('GROOVE GROTTO', w / 2, 132);
      c.shadowBlur = 0;
      c.lineWidth = 4;
      c.strokeStyle = '#36e0ff';
      c.strokeText('GROOVE GROTTO', w / 2, 132);

      c.font = 'bold 48px "Trebuchet MS", Verdana, sans-serif';
      c.shadowColor = '#36e0ff';
      c.shadowBlur = 30;
      c.fillStyle = '#dcfbff';
      c.fillText('128 BPM   ALL NIGHT', w / 2, 244);
      c.fillText('128 BPM   ALL NIGHT', w / 2, 244);
    });

    // Sits low and wide behind the booth: the room camera (offset y 11, z 15,
    // 42 deg FOV) clips anything higher than ~y 3.9 this far back.
    const group = new THREE.Group();
    group.position.set(0, 2.95, -11);
    group.rotation.x = 0.14;
    scene.add(group);

    const mat = fxMat(0xffffff, { opacity: 1, side: THREE.FrontSide, additive: false });
    mat.map = tex;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 1.9), mat);
    group.add(sign);

    const bloomMat = fxMat(0xffffff, { opacity: 0.45, side: THREE.FrontSide });
    bloomMat.map = tex;
    const bloom = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 2.3), bloomMat);
    bloom.position.z = -0.05;
    group.add(bloom);
    this.signBloom = bloomMat;

    // neon tube frame (four scaled instances of one bar)
    const frame = instancedGlow(new THREE.BoxGeometry(1, 0.11, 0.11), 4);
    const d = this._dummy;
    const fw = 8.2;
    const fh = 2.3;
    const segs = [
      [0, fh / 2, fw, 0],
      [0, -fh / 2, fw, 0],
      [-fw / 2, 0, fh, Math.PI / 2],
      [fw / 2, 0, fh, Math.PI / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const [x, y, len, rot] = segs[i];
      d.position.set(x, y, 0.06);
      d.rotation.set(0, 0, rot);
      d.scale.set(len, 1, 1);
      d.updateMatrix();
      frame.setMatrixAt(i, d.matrix);
    }
    group.add(frame);
    this.signFrame = frame;
    this._instanced.push(frame);

    // hanging cables back up into the dark
    const cable = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.035, 0.035, 5.4, 4),
      makeToon(PAL.gear),
      2,
    );
    for (let i = 0; i < 2; i++) {
      d.position.set(i ? 3.4 : -3.4, 3.6, -0.3);
      d.rotation.set(-0.2, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      cable.setMatrixAt(i, d.matrix);
    }
    group.add(cable);
    this._instanced.push(cable);
  }

  // ---- mirror ball + beams -------------------------------------------------

  _buildMirrorBall(scene) {
    // Hung low enough to stay inside the room camera's frame.
    const pivot = new THREE.Group();
    pivot.position.set(0, 5.7, 1);
    scene.add(pivot);
    this.ballPivot = pivot;

    const ball = new THREE.Mesh(
      faceted(new THREE.IcosahedronGeometry(0.95, 1)),
      makeToon(PAL.chrome),
    );
    pivot.add(ball);

    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 5), makeToon(PAL.gear));
    rod.position.set(0, 9.1, 1);
    scene.add(rod);

    // orbiting light dots: fixed on a shell, the pivot spins them
    const dots = instancedGlow(new THREE.IcosahedronGeometry(0.1, 0), 26);
    const r = rng(777);
    const d = this._dummy;
    this._dotPhase = new Float32Array(26);
    for (let i = 0; i < 26; i++) {
      const u = r() * Math.PI * 2;
      const v = Math.acos(2 * r() - 1);
      const rad = 1.5 + r() * 0.5;
      d.position.set(
        Math.sin(v) * Math.cos(u) * rad,
        Math.cos(v) * rad * 0.8,
        Math.sin(v) * Math.sin(u) * rad,
      );
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(0.7 + r() * 0.8);
      d.updateMatrix();
      dots.setMatrixAt(i, d.matrix);
      this._dotPhase[i] = r() * 6.28;
    }
    pivot.add(dots);
    this.dots = dots;
    this._instanced.push(dots);
  }

  _buildBeams(scene) {
    const coneGeo = new THREE.ConeGeometry(1.9, 11, 16, 1, true);
    coneGeo.translate(0, -5.5, 0);
    const spec = [
      [-3.6, 9.2, -3.2, NEON.pink, 0.55],
      [3.6, 9.2, -3.2, NEON.cyan, -0.42],
      [-3.4, 9.0, 3.6, NEON.lime, -0.33],
      [3.4, 9.0, 3.6, NEON.violet, 0.48],
      [0, 9.6, -0.4, NEON.gold, 0.24],
    ];
    this.beams = [];
    for (const [x, y, z, color, spin] of spec) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      scene.add(pivot);
      const cone = new THREE.Mesh(coneGeo, fxMat(color, { opacity: 0.13 }));
      cone.rotation.x = 0.38;
      pivot.add(cone);
      this.beams.push({ pivot, cone, spin, phase: Math.random() * 6.28 });
    }
  }

  // ---- stairway ------------------------------------------------------------

  _buildStairs(scene) {
    const d = this._dummy;

    const stepGeo = new THREE.BoxGeometry(STAIR_W, STEP_H, STEP_D);
    const steps = new THREE.InstancedMesh(stepGeo, makeToon(PAL.rock), STEP_N);
    for (let i = 0; i < STEP_N; i++) {
      d.position.set(0, ((i + 1) * STEP_H) / 2, STAIR_Z0 + i * STEP_D + STEP_D / 2);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, i + 1, 1);
      d.updateMatrix();
      steps.setMatrixAt(i, d.matrix);
    }
    scene.add(steps);
    this.groundMeshes.push(steps);
    this._instanced.push(steps);

    // deep enough to stand under the arch and reach the portal
    const landing = new THREE.Mesh(
      new THREE.BoxGeometry(STAIR_W, LANDING_Y, 2.8),
      makeToon(PAL.rock),
    );
    landing.position.set(0, LANDING_Y / 2, STAIR_Z0 + STEP_N * STEP_D + 1.4);
    scene.add(landing);
    this.groundMeshes.push(landing);

    // glowing nosing strip on every step
    const strips = instancedGlow(new THREE.BoxGeometry(STAIR_W - 0.1, 0.06, 0.08), STEP_N);
    for (let i = 0; i < STEP_N; i++) {
      d.position.set(0, (i + 1) * STEP_H - 0.03, STAIR_Z0 + i * STEP_D + 0.06);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      strips.setMatrixAt(i, d.matrix);
    }
    scene.add(strips);
    this.strips = strips;
    this._instanced.push(strips);

    // archway at the top
    const archZ = STAIR_Z0 + STEP_N * STEP_D + 0.5;
    const arch = new THREE.Mesh(
      faceted(new THREE.TorusGeometry(1.95, 0.2, 5, 22, Math.PI)),
      makeToon(PAL.rockDeep),
    );
    arch.position.set(0, LANDING_Y + 1.4, archZ);
    scene.add(arch);

    const posts = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.42, 1.4, 0.42),
      makeToon(PAL.rockDeep),
      2,
    );
    for (let i = 0; i < 2; i++) {
      d.position.set(i ? 1.95 : -1.95, LANDING_Y + 0.7, archZ);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      posts.setMatrixAt(i, d.matrix);
    }
    scene.add(posts);
    this._instanced.push(posts);

    // warm daylight spilling down from the plaza
    const portalMat = fxMat(0xffd9a0, { opacity: 0.5 });
    const portal = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 3.4), portalMat);
    portal.position.set(0, LANDING_Y + 1.5, archZ + 1.3);
    scene.add(portal);
    this.portal = portalMat;

    // glow carpet lying along the stair slope
    const rise = STEP_N * STEP_H - STEP_H;
    const run = (STEP_N - 1) * STEP_D;
    const spill = new THREE.Mesh(
      new THREE.PlaneGeometry(STAIR_W - 0.2, Math.hypot(run, rise) + 0.6),
      fxMat(0xffd9a0, { opacity: 0.16 }),
    );
    spill.rotation.x = -Math.PI / 2 - Math.atan2(rise, run);
    spill.position.set(0, (STEP_H + STEP_N * STEP_H) / 2 + 0.07, STAIR_Z0 + run / 2 + 0.1);
    scene.add(spill);

    // "this way out" sign over the arch
    const tex = canvasTexture(512, 192, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.shadowColor = '#36e0ff';
      c.shadowBlur = 24;
      c.fillStyle = '#e8fbff';
      c.beginPath();
      c.moveTo(w / 2, 26);
      c.lineTo(w / 2 + 34, 74);
      c.lineTo(w / 2 - 34, 74);
      c.closePath();
      c.fill();
      c.font = 'bold 58px "Trebuchet MS", Verdana, sans-serif';
      c.fillText('SUNNY PLAZA', w / 2, 130);
      c.fillText('SUNNY PLAZA', w / 2, 130);
    });
    const signMat = fxMat(0xffffff, { opacity: 0.95, side: THREE.FrontSide, additive: false });
    signMat.map = tex;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.1), signMat);
    sign.position.set(0, LANDING_Y + 2.55, archZ - 0.4);
    sign.rotation.y = Math.PI; // face back down the stairs, toward the camera
    sign.rotation.x = -0.12;
    scene.add(sign);
  }

  // ---- haze, dust, lights --------------------------------------------------

  _buildAtmosphere(scene) {
    const hazeTex = canvasTexture(256, 256, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(210,180,255,0.9)');
      g.addColorStop(0.45, 'rgba(160,125,240,0.6)');
      g.addColorStop(0.8, 'rgba(110,75,190,0.22)');
      g.addColorStop(1, 'rgba(90,60,160,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });

    this.haze = [];
    const layers = [
      { y: 0.5, size: 36, op: 0.17, spin: 0.035, z: 3 },
      { y: 1.7, size: 46, op: 0.09, spin: -0.022, z: 3 },
    ];
    for (const l of layers) {
      const mat = fxMat(0xffffff, { opacity: l.op, side: THREE.DoubleSide });
      mat.map = hazeTex;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(l.size, l.size), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, l.y, l.z);
      scene.add(m);
      this.haze.push({ mesh: m, spin: l.spin, base: l.op });
    }

    // drifting dust motes
    const N = 170;
    const pts = new Float32Array(N * 3);
    const r = rng(31337);
    for (let i = 0; i < N; i++) {
      const a = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * 14;
      pts[i * 3] = Math.cos(a) * rad;
      pts[i * 3 + 1] = 0.4 + r() * 7.5;
      pts[i * 3 + 2] = Math.sin(a) * rad + 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const dustMat = new THREE.PointsMaterial({
      size: 0.14,
      map: dotTexture(),
      color: 0xcaa8ff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const dust = new THREE.Points(g, dustMat);
    scene.add(dust);
    this.dust = dust;
  }

  _buildLights(scene) {
    scene.add(new THREE.AmbientLight(0x6b4fa0, 1.5));
    scene.add(new THREE.HemisphereLight(0x9c7cf0, 0x2a1c40, 1.1));

    this.floorLight = new THREE.PointLight(NEON.pink, 60, 26, 2);
    this.floorLight.position.set(ZONE.x, 5.2, ZONE.z);
    scene.add(this.floorLight);

    // Warm key on the booth: a cyan key turns the capybara's tan fur green.
    // The cool accents come from the unlit visor/EQ/headphone glows instead.
    this.djLight = new THREE.PointLight(0xffb488, 48, 22, 2);
    this.djLight.position.set(0, 4.2, -5.6);
    scene.add(this.djLight);

    this.crystalLightA = new THREE.PointLight(NEON.violet, 28, 18, 2);
    this.crystalLightA.position.set(-10.5, 3.2, -3);
    scene.add(this.crystalLightA);

    this.crystalLightB = new THREE.PointLight(NEON.lime, 26, 18, 2);
    this.crystalLightB.position.set(11, 3.2, 3);
    scene.add(this.crystalLightB);

    const stairLight = new THREE.PointLight(0xffd2a0, 26, 16, 2);
    stairLight.position.set(0, LANDING_Y + 2, STAIR_Z0 + STEP_N * STEP_D + 1.2);
    scene.add(stairLight);
    this.stairLight = stairLight;

    // keeps the entrance side of the cave from going dead black
    this.entryLight = new THREE.PointLight(0x9a6bff, 20, 20, 2);
    this.entryLight.position.set(0, 4.5, 10.5);
    scene.add(this.entryLight);
  }

  /** World clock (wave 7). No windows down here and no weather: the grotto's
   *  own rig never changes. What does change is the stairwell, where the plaza
   *  pours in: warm daylight by day, and after dusk a dim violet spill with the
   *  cave's entry glow deepened underneath it so the arch still reads. */
  onClock(dayT) {
    const lit = daylight(dayT);
    this._portalK = 0.3 + 0.7 * lit;          // update() rides this, see below
    this.portal.color.copy(this._moonSpill).lerp(this._sunSpill, lit);
    this.stairLight.intensity = 7 + 19 * lit;
    this.stairLight.color.copy(this._moonSpill).lerp(this._sunSpill, lit);
    this.entryLight.intensity = 20 + 15 * (1 - lit);
  }

  // ---- interaction ---------------------------------------------------------

  _requestTrack(g) {
    this._track = (this._track + 1) % TRACKS.length;
    this._pattern = this._track;
    this._patternAt = this._t;
    this._boost = 1;
    g.audio?.play?.('ding');
    g.toast(`Now spinning: ${TRACKS[this._track]}`);
  }

  // ---- per-frame -----------------------------------------------------------

  update(dt) {
    this._t += dt;
    const t = this._t;
    const beat = t / BEAT;
    const bi = Math.floor(beat);
    const bf = beat - bi;
    const punch = (1 - bf) * (1 - bf) * (1 - bf) * (1 - bf);
    this._boost = Math.max(0, this._boost - dt * 0.45);

    // auto-cycle the floor pattern every 8 beats unless a track was requested
    if (t - this._patternAt > BEAT * 8) {
      this._pattern = (this._pattern + 1) % TRACKS.length;
      this._patternAt = t;
    }

    this._updateTiles(punch);
    this._updateRoomGlow(t, bi, bf, punch);
    this._updateBooth(dt, t, punch);
    this._updateBeams(dt, t, punch);
  }

  _updateTiles(punch) {
    const t = this._t;
    const pat = this._pattern;
    const bi = Math.floor(t / BEAT);
    const col = this._col;
    const tiles = this.tiles;
    const hot = 1.05 + punch * 0.45 + this._boost * 0.5;

    for (let i = 0; i < TILES * TILES; i++) {
      const gx = this._tileGX[i];
      const gz = this._tileGZ[i];
      const d = this._tileD[i];
      let h = 0;
      let l = 0;
      switch (pat) {
        case 0: {
          // rolling rainbow wave
          h = 0.6 + (gx + gz) * 0.035 + t * 0.06;
          l = 0.14 + 0.34 * (0.5 + 0.5 * Math.sin((gx + gz) * 0.85 - t * 3.4));
          break;
        }
        case 1: {
          // checkerboard flipping on every beat
          const on = ((gx + gz) & 1) === (bi & 1);
          h = 0.84 + (bi % 4) * 0.08;
          l = on ? 0.26 + 0.32 * punch : 0.05;
          break;
        }
        case 2: {
          // pulse rings from the centre
          const s = Math.max(0, Math.sin(d * 1.35 - t * 4.4));
          h = 0.5 + d * 0.035 + t * 0.02;
          l = 0.05 + 0.5 * s * s * s;
          break;
        }
        case 3: {
          // bright column sweeping across
          const head = ((t * 2.6) % 11) - 1.5;
          const g2 = Math.max(0, 1 - Math.abs(gx - head) * 0.6);
          h = 0.07 + gz * 0.018 + t * 0.01;
          l = 0.05 + 0.5 * g2 * g2;
          break;
        }
        default: {
          // spiral
          const s = 0.5 + 0.5 * Math.sin(this._tileA[i] * 1.5 + d * 0.7 - t * 2.8);
          h = 0.28 + s * 0.38;
          l = 0.08 + 0.38 * s * s;
          break;
        }
      }
      col.setHSL(h, 0.95, l, THREE.SRGBColorSpace);
      col.multiplyScalar(hot);
      tiles.setColorAt(i, col);
    }
    tiles.instanceColor.needsUpdate = true;
  }

  _updateRoomGlow(t, bi, bf, punch) {
    const col = this._col;

    // podium rim: one hue for the whole ring, drifting
    col.setHSL(0.55 + Math.sin(t * 0.35) * 0.22, 0.9, 0.5 + punch * 0.2, THREE.SRGBColorSpace);
    for (let i = 0; i < 4; i++) this.rim.setColorAt(i, col);
    this.rim.instanceColor.needsUpdate = true;

    // crystals breathe out of phase with each other
    for (let i = 0; i < this._crystalHue.length; i++) {
      const p = 0.5 + 0.5 * Math.sin(t * 1.4 + this._crystalPhase[i]);
      col.setHSL(this._crystalHue[i], 0.85, 0.34 + p * 0.24, THREE.SRGBColorSpace);
      col.multiplyScalar(1 + punch * 0.25);
      this.crystals.setColorAt(i, col);
    }
    this.crystals.instanceColor.needsUpdate = true;

    // uplight tubes chase around the room on the beat
    for (let i = 0; i < UPLIGHTS.length; i++) {
      const on = i === bi % UPLIGHTS.length;
      col.setHSL(0.72 + i * 0.05, 0.9, on ? 0.62 : 0.24, THREE.SRGBColorSpace);
      col.multiplyScalar(on ? 1.3 : 0.8);
      this.tubes.setColorAt(i, col);
    }
    this.tubes.instanceColor.needsUpdate = true;

    // stair nosings run upward like an escalator
    for (let i = 0; i < STEP_N; i++) {
      const p = 0.5 + 0.5 * Math.sin(t * 3 - i * 0.9);
      col.setHSL(0.11, 0.75, 0.3 + p * 0.32, THREE.SRGBColorSpace);
      this.strips.setColorAt(i, col);
    }
    this.strips.instanceColor.needsUpdate = true;

    // mirror-ball dots twinkle while the whole rig spins
    for (let i = 0; i < this._dotPhase.length; i++) {
      const p = 0.5 + 0.5 * Math.sin(t * 5 + this._dotPhase[i]);
      col.setHSL(0.62 + p * 0.1, 0.35, 0.5 + p * 0.45, THREE.SRGBColorSpace);
      this.dots.setColorAt(i, col);
    }
    this.dots.instanceColor.needsUpdate = true;
    this.ballPivot.rotation.y = t * 0.55;
    this.ballPivot.rotation.z = Math.sin(t * 0.4) * 0.12;
    this.poolGroup.rotation.y = -t * 0.22;

    // lounge ledge rims idle-glow, offset from the main beat
    for (let i = 0; i < LEDGES.length; i++) {
      const p = 0.5 + 0.5 * Math.sin(t * 1.8 + i * 1.4);
      col.setHSL(0.03 + i * 0.02, 0.8, 0.3 + p * 0.2, THREE.SRGBColorSpace);
      this.rims.setColorAt(i, col);
    }
    this.rims.instanceColor.needsUpdate = true;

    // sign + portal shimmer
    this.signBloom.opacity = 0.34 + punch * 0.3;
    const flick = Math.sin(t * 41) > 0.985 ? 0.25 : 1;
    for (let i = 0; i < 4; i++) {
      col.setHSL(0.9 - Math.sin(t * 0.6) * 0.12, 0.95, 0.5 * flick + punch * 0.12, THREE.SRGBColorSpace);
      this.signFrame.setColorAt(i, col);
    }
    this.signFrame.instanceColor.needsUpdate = true;
    this.portal.opacity = (0.45 + Math.sin(t * 1.6) * 0.06) * this._portalK;

    // haze + dust drift
    for (const h of this.haze) {
      h.mesh.rotation.z += h.spin * 0.016;
      h.mesh.material.opacity = h.base * (0.8 + 0.35 * Math.sin(t * 0.7));
    }
    this.dust.rotation.y = t * 0.035;
    this.dust.position.y = Math.sin(t * 0.4) * 0.35;

    // lights ride the beat
    this.floorLight.intensity = 42 + punch * 46 + this._boost * 30;
    this.floorLight.color.setHSL(0.9 - Math.sin(t * 0.5) * 0.25, 0.85, 0.55, THREE.SRGBColorSpace);
    this.djLight.intensity = 34 + (1 - bf) * 18;
    this.crystalLightA.intensity = 22 + Math.sin(t * 1.1) * 8;
    this.crystalLightB.intensity = 22 + Math.sin(t * 1.1 + 2) * 8;
  }

  _updateBooth(dt, t, punch) {
    const col = this._col;
    const d = this._dummy;

    // EQ bars: a fake spectrum with a kick on every beat
    for (let i = 0; i < 18; i++) {
      const th = -1.02 + (i / 17) * 2.04;
      const lowEnd = 1 - Math.abs(i - 8.5) / 12;
      const v =
        0.22 +
        0.5 * Math.abs(Math.sin(t * (2.2 + i * 0.31) + i)) * lowEnd +
        punch * 0.55 * lowEnd;
      d.position.set(Math.sin(th) * 2.99, 0.22, Math.cos(th) * 2.99);
      d.rotation.set(0, th, 0);
      d.scale.set(1, Math.min(2.1, v * 1.8), 1);
      d.updateMatrix();
      this.bars.setMatrixAt(i, d.matrix);
      col.setHSL(0.52 + i * 0.022 + t * 0.05, 0.95, 0.34 + v * 0.28, THREE.SRGBColorSpace);
      this.bars.setColorAt(i, col);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.bars.instanceColor.needsUpdate = true;

    for (let i = 0; i < 8; i++) {
      col.setHSL(0.1 + i * 0.09, 0.9, 0.4 + punch * 0.25, THREE.SRGBColorSpace);
      this.knobs.setColorAt(i, col);
    }
    this.knobs.instanceColor.needsUpdate = true;

    // records spin, one of them scratched back and forth
    for (const r of this.records) {
      if (r.dir < 0) r.obj.rotation.y += dt * 4.2;
      else r.obj.rotation.y += dt * (3.2 + Math.sin(t * 2.4) * 4.5);
    }

    // the DJ bobs, nods and works the deck (one bounce per beat)
    const dj = this.dj;
    const w = Math.PI / BEAT;
    dj.body.position.y = Math.abs(Math.sin(t * w)) * 0.15 + punch * 0.04;
    dj.body.rotation.y = Math.sin(t * 1.6) * 0.22;
    dj.head.rotation.x = 0.1 + Math.sin(t * w * 2) * 0.1;
    dj.head.rotation.z = Math.sin(t * 1.6) * 0.08;
    dj.arms[0].rotation.x = -0.9 + Math.sin(t * 6.5) * 0.5;
    dj.arms[1].rotation.z = 0.55 + Math.sin(t * 3.2 + 1) * 0.55;

    // speaker stacks thump
    for (const s of this.speakers) {
      const k = 1 + punch * 0.09 + this._boost * 0.03;
      s.stack.scale.set(1 + (k - 1) * 0.6, k, 1 + (k - 1) * 0.6);
      col.setHSL(0.55 + Math.sin(t * 0.5 + s.side) * 0.2, 0.9, 0.32 + punch * 0.3, THREE.SRGBColorSpace);
      s.grille.setColorAt(0, col);
      s.grille.setColorAt(1, col);
      s.grille.instanceColor.needsUpdate = true;
      for (let i = 0; i < 2; i++) {
        d.position.set(0, 2.15 + i * 1.35, 0.76 + punch * 0.07);
        d.rotation.set(0, 0, 0);
        d.scale.set(1 + punch * 0.06, 1 + punch * 0.06, 1);
        d.updateMatrix();
        s.woofers.setMatrixAt(i, d.matrix);
      }
      s.woofers.instanceMatrix.needsUpdate = true;
    }
  }

  _updateBeams(dt, t, punch) {
    for (const b of this.beams) {
      b.pivot.rotation.y += dt * b.spin;
      b.pivot.rotation.z = Math.sin(t * 0.6 + b.phase) * 0.2;
      b.cone.material.opacity = 0.09 + punch * 0.09 + this._boost * 0.05;
    }
  }

  dispose() {
    // The engine disposes the scene graph; release instanced GPU buffers early
    // and drop references so nothing survives the room swap.
    for (const im of this._instanced) im.dispose?.();
    this._instanced.length = 0;
    this.tiles = null;
    this.crystals = null;
    this.beams = null;
    this.speakers = null;
    this.records = null;
    this.dj = null;
    this.haze = null;
    this.portal = null;
    this.stairLight = null;
    this.entryLight = null;
  }
}
