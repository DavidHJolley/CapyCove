import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

/**
 * Post-processing chain for the world renderer (and ONLY the world renderer:
 * minigames with their own canvases never come through here).
 *
 *   RenderPass -> UnrealBloomPass -> grade ShaderPass -> FXAAPass
 *
 * The scene renders into a target flagged `isXRRenderTarget` with an sRGB
 * texture colorSpace. That combination makes the renderer treat the target
 * exactly like the canvas: ACES tonemap per material, sRGB encode per
 * fragment, and (critically) all transparent/additive blending happening on
 * the ENCODED values. The rooms lean on stacks of alpha-blended glow sprites
 * (club spot cones, lantern halos, dust); compositing those in linear and
 * encoding afterwards visibly washes the whole scene out, so the buffer must
 * be a pixel-identical copy of what the plain renderer put on canvas.
 * Bloom then works classic LDR-style on that display image (threshold in
 * display luminance: only true glow cores pass), and the grade pass adds a
 * gentle filmic curve, a whisper of warm lift and desaturation in the shadows,
 * and a soft vignette. No OutputPass: the buffer is already display-ready.
 * MSAA cannot ride along (the sRGB texture + linear MSAA renderbuffer pair
 * fails to resolve: the resolve blit needs identical formats), so a final
 * FXAA pass replaces the canvas antialiasing: on chunky toon silhouettes the
 * difference is invisible and it costs a fraction of a millisecond.
 *
 * Fallback contract: init() returns false (and render() forever returns false)
 * if anything throws, so the engine keeps its plain renderer.render() path on
 * GPUs that can't build the chain. A failing render() rebuilds the chain once
 * (first-frame GL hiccups) and then latches the plain-render fallback.
 *
 * ---------------------------------------------------------------------------
 * THE PER-ROOM GRADE HOOK (for room owners)
 * ---------------------------------------------------------------------------
 * A room may publish ONE optional field:
 *
 *     this.grade = { warmth: 0, lift: 0 };   // both default 0 = today's look
 *
 * `warmth`  -1..+1  cools (blue) or warms (amber) the whole frame. +1 is about
 *                   a 3% channel skew, weighted toward the midtones and
 *                   highlights so shadows keep their own colour. Use small
 *                   numbers: +0.4 for a honey interior, -0.3 for snow or deep
 *                   water. This is a mood nudge, not a colour change; the room
 *                   still has to be built out of the DESIGN.md palette.
 * `lift`    -1..+1  raises or lowers the warm shadow lift (the "no hard black"
 *                   rule, applied in display space). +1 opens the shadows by
 *                   another ~0.014; -1 closes them back to nothing. A cave or
 *                   a club that wants its darks to stay dark passes a negative
 *                   number.
 *
 * `dusk`    OPTIONAL 0..1. Overrides the automatic dusk read (see WHAT MOVES BY
 *                   ITSELF): 0 pins the room at its noon bloom however dark its
 *                   backdrop is, 1 pins it at full dusk. Leave it out and the
 *                   backdrop answers, which is right for every room whose
 *                   backdrop tracks its light.
 *
 * It is read once per room build and eased in over ~0.4s, so a room can also
 * rewrite it in onClock() and the grade will drift to the new value instead of
 * cutting. Absent or malformed values are ignored; a room that never sets it
 * looks exactly as it does today.
 *
 * It is resolved from, in order: the `room` passed as setScene's 3rd argument
 * (engine.js hands over this.room on every switch and rebuild), then
 * `scene.userData.grade` for anything that builds a scene without a room.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVES BY ITSELF
 * ---------------------------------------------------------------------------
 * Dusk bloom. The bloom threshold is fixed in display luminance, which is
 * right for a bright room and too shy for a dark one: the same lantern that
 * must not smear noon-lit cream sand should be the brightest thing in a cave.
 * So the chain reads how dark the room's BACKDROP is (scene.background, which
 * every room sets and the day/night rooms re-mix in onClock) and, at full
 * dusk, multiplies bloom strength by 1.30 and drops the threshold by 0.06.
 * Both ride on top of whatever settings.js last passed to tune(), so the Low
 * graphics preset (strength 0) stays 0 at every hour.
 *
 * A backdrop is not the same question as a light budget, and one room parts
 * company with it: the jungle hangs a dark canopy (0x2a4426) behind a DAYLIGHT
 * clearing, so it reads as 0.997 dusk and blooms ~30% harder than the plaza at
 * the same hour. Measured backdrop dusk values: beach/cafe/plaza/house/peak/
 * speedway 0.000, club/mine/loft/lounge 1.000, jungle 0.997. A room in that
 * position pins the response with `grade.dusk` rather than re-mixing its sky.
 *
 * The vignette breathes. It sits wide open when the world comes back on
 * screen and closes to its resting width over ~0.5s. That covers the two
 * places the world is handed back to you: arriving in a room (it opens with
 * the iris) and returning from a minigame, which owns the whole screen while
 * it runs and never renders through this chain at all: no render call for
 * 400ms IS the signal that the world was away.
 *
 * Room-switch transition. `setScene` runs while the iris is fully closed, so
 * that is where the arrival is staged: the grade starts slightly lifted and
 * desaturated (as if the room were still coming up out of the dark) and
 * settles into the destination's own grade as the iris opens, and the iris
 * itself is tinted with a hint of the destination's sky. Engine.js owns the
 * iris mechanics (the #fade element, its radius, its timing); this module only
 * paints the colour, checks that the engine actually chose the iris path, and
 * takes its inline style back off afterwards. If any of that is missing the
 * stock iris plays unchanged. An in-place rebuildRoom() (the layout editor,
 * after every dragged handle) gets no arrival at all.
 *
 * The two are told apart by an EXPLICIT flag, `setScene(..., { arrive })`,
 * because they cannot be told apart from in here: the engine keeps rendering
 * the outgoing scene through the whole wipe (both awaits in switchRoom yield to
 * the event loop, so rAF keeps firing), and the only pause is the synchronous
 * teardown-and-build, which is 2-20ms depending on the room. A caller that
 * passes no flag falls back to a render-gap guess, which is right for a
 * harness swapping scenes and wrong for anything that renders continuously.
 *
 * Everything above is motion, so all of it is skipped when motion is calmed:
 * the game's own "Calm animations" setting (globalThis.capyReducedMotion, see
 * src/ui/settings.js) and the OS prefers-reduced-motion flag both count. The
 * grade snaps to its target, the vignette holds still, and the iris keeps the
 * flat colour styles.css gives it.
 */

// ---- tunables ---------------------------------------------------------------
// Bloom thresholds in DISPLAY space (post-ACES, sRGB-encoded, luminance): the
// threshold rides the line between "noon-lit cream sand" (which must stay
// quiet) and "LED tile / lantern core / neon" (which must sing). Verified
// against beach noon / plaza dusk / grotto shots. settings.js mirrors these
// three numbers as its "Nice" preset: keep them in step.
const BLOOM_STRENGTH = 0.35;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.85;
const DUSK_BLOOM_MUL = 0.30;   // extra bloom strength at full dusk (x1.30)
const DUSK_THRESH_DROP = 0.06; // ...and how far the threshold drops there
const DUSK_LIGHT = 0.03;       // scene.background luminance read as full night
const DUSK_DAY = 0.55;         // ...and as full daylight

const VIGNETTE = 0.16;         // corner darkening amount (0 = off)
const VIG_INNER = 0.42;        // where it starts, at rest
const VIG_OUTER = 0.92;        // ...and where it reaches full strength
const VIG_WIDE_INNER = 0.64;   // pushed out while the frame is open
const VIG_WIDE_MUL = 0.45;     // and quieter: amount x this at full open

const LIFT = 0.016;            // warm shadow lift (display space)
const LIFT_RANGE = 0.014;      // room.grade.lift = +/-1 moves it this far
const WARM_RANGE = 0.030;      // room.grade.warmth = +/-1 skews channels this far
const DESAT_SHADOWS = 0.02;    // ~2% desaturation in the shadows
const CURVE = 0.10;            // gentle filmic S, blended over the flat image

const ARRIVE_LIFT = 0.020;     // extra lift while a room fades up
const ARRIVE_DESAT = 0.08;     // ...and extra desaturation
const RAMP = 3.4;              // grade ease, per second
const BREATH = 2.4;            // vignette ease, per second
const GAP_MS = 400;            // no render for this long = the world was away
const IRIS_SAT = 0.7;          // slice of the destination's saturation the wipe keeps
const IRIS_SAT_MAX = 0.45;     // ...never more than this: it is a hint, not a colour
const IRIS_L = 0.125;          // and always the lightness styles.css wipes with
// When the inline tint comes back off. engine.js `_irisOpen` strips the .iris
// class 260ms after it calls setScene, so anything past that is a window in
// which a SECOND switch would close its wipe in the previous room's colour.
const IRIS_CLEAR_MS = 320;

const GradeShader = {
  name: 'CapyGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uVig: { value: VIGNETTE },
    uVigIn: { value: VIG_INNER },
    uLift: { value: LIFT },
    uWarm: { value: 0 },
    uDesat: { value: DESAT_SHADOWS },
    uCurve: { value: CURVE },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVig;
    uniform float uVigIn;
    uniform float uLift;
    uniform float uWarm;
    uniform float uDesat;
    uniform float uCurve;
    varying vec2 vUv;
    void main() {
      // the buffer already holds the finished display image (tonemapped and
      // sRGB-encoded during the scene render), so the grade works in familiar
      // display space, where its tiny offsets stay tiny and every value is
      // safely inside 0..1
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = t.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // gentle filmic curve: a smoothstep S about the 0.5 pivot, blended in at
      // ~10%. Enough shoulder to stop cream skies reading as flat paper, not
      // enough toe to crush a capybara's shadow side into a hole.
      c = mix(c, c * c * (3.0 - 2.0 * c), uCurve);
      float sh = 1.0 - smoothstep(0.0, 0.45, l);   // shadow mask (pre-curve luma)
      c += vec3(1.0, 0.60, 0.20) * (uLift * sh);   // warm lift: no hard black
      c = mix(c, vec3(l), uDesat * sh);            // gentle shadow desaturation
      // per-room warmth, weighted to the midtones and up so the shadows keep
      // the colour the lift just gave them
      c += uWarm * vec3(1.0, 0.35, -0.75) * (0.30 + 0.70 * l);
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - uVig * smoothstep(uVigIn, ${VIG_OUTER.toFixed(2)}, d);
      gl_FragColor = vec4(c, t.a);
    }
  `,
};

let _renderer = null;
let _composer = null;
let _renderPass = null;
let _bloom = null;
let _grade = null;
let _failed = false;
let _retried = false; // one rebuild attempt before latching the fallback
let _w = 0, _h = 0;
const _size = new THREE.Vector2();

// live grade state. `*Now` chases `*To` at RAMP/s; nothing here allocates.
let _warmTo = 0, _warmNow = 0;
let _liftTo = LIFT, _liftNow = LIFT;
let _duskTo = 0, _duskNow = 0;   // 0 = noon, 1 = full dusk/interior
let _wide = 0;                   // 1 = vignette fully open, eases back to 0
let _arrive = 0;                 // 1 = room still coming up out of the dark
let _lastRender = 0;             // performance.now() of the last chain render
let _roomG = null;               // live room.grade of the current scene, or null
let _motionOk = null;            // prefers-reduced-motion, resolved lazily
let _irisTimer = null;
const _tintC = new THREE.Color(); // scratch for the wipe colour, never per frame
const _hsl = { h: 0, s: 0, l: 0 };

// what settings.js last asked for; the dusk response rides on top of this, so
// the Low preset (strength 0) stays 0 at every hour of the cove day
const _base = { strength: BLOOM_STRENGTH, radius: BLOOM_RADIUS, threshold: BLOOM_THRESHOLD };
const _grades = { vig: VIGNETTE, lift: LIFT, desat: DESAT_SHADOWS, curve: CURVE };

/** Should this animation be calmed down? src/ui/settings.js owns the one
 *  answer: the game's own "Calm animations" toggle OR the OS flag. The toggle
 *  can flip mid-session and fires no matchMedia 'change', so it is re-read on
 *  every ask; the media query itself is resolved once and kept current by its
 *  own listener. Everything that moves in here asks this first. */
function motionOk() {
  if (_motionOk === null) {
    try {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      _motionOk = !mq.matches;
      // one listener for the life of the page (the chain outlives every room)
      mq.addEventListener?.('change', (e) => { _motionOk = !e.matches; });
    } catch { _motionOk = true; }
  }
  try {
    const calm = globalThis.capyReducedMotion?.();
    if (calm !== undefined) return !calm;
  } catch { /* settings not loaded: the media query alone answers */ }
  return _motionOk;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v)
  ? (v < lo ? lo : v > hi ? hi : v) : 0);

/**
 * Build the chain. `scene`/`camera` may be null at boot; nothing renders until
 * setScene() hands over a real pair. Returns true when the chain is live.
 */
export function init(renderer, scene, camera) {
  _renderer = renderer;
  _failed = false;
  try {
    renderer.getSize(_size);
    const pr = renderer.getPixelRatio(); // engine caps this at 2
    // 8-bit is plenty since the buffer holds the finished display image.
    // The composer clones this target for its ping-pong pair.
    const rt = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(_size.x * pr)),
      Math.max(1, Math.floor(_size.y * pr)),
      { type: THREE.UnsignedByteType },
    );
    _composer = new EffectComposer(renderer, rt);
    // Make the renderer treat these targets exactly like the canvas: the XR
    // flag turns material tone mapping back on (it is skipped for plain render
    // targets) and, with an sRGB texture colorSpace, fragments are encoded on
    // write so all alpha/additive blending happens on encoded values (see the
    // header comment: linear-space blending visibly washes out the glow-sprite
    // heavy rooms). The XR force-linear internal format means the texture is
    // NOT auto-decoded when later passes sample it: they see the display image.
    for (const t of [_composer.renderTarget1, _composer.renderTarget2]) {
      t.isXRRenderTarget = true;
      t.texture.colorSpace = THREE.SRGBColorSpace;
    }
    _composer.setPixelRatio(pr);
    _composer.setSize(_size.x, _size.y);

    _renderPass = new RenderPass(scene, camera);
    _bloom = new UnrealBloomPass(
      new THREE.Vector2(_size.x, _size.y),
      _base.strength, _base.radius, _base.threshold,
    );
    _grade = new ShaderPass(GradeShader); // display-space grade
    _composer.addPass(_renderPass);
    _composer.addPass(_bloom);
    _composer.addPass(_grade);
    _composer.addPass(new FXAAPass());    // AA back (no MSAA here), to screen
    _w = _size.x; _h = _size.y;
    _applyGrade();
    return true;
  } catch (e) {
    console.warn('[postfx] init failed, falling back to plain render:', e);
    _dispose();
    _failed = true;
    return false;
  }
}

/**
 * Point the chain at a (new) room scene, and stage the arrival: read the new
 * room's grade, start the frame open and slightly veiled, and lend the iris a
 * hint of where it is opening onto. Cheap; call on every room switch.
 * `room` is optional (see the per-room grade hook in the header).
 * `opts.arrive` says whether the player is walking in behind a closed iris
 * (true, engine.switchRoom) or the room is being rebuilt in place under a live
 * screen (false, engine.rebuildRoom).
 */
export function setScene(scene, camera, room, opts) {
  if (!_renderPass) return;
  _renderPass.scene = scene;
  _renderPass.camera = camera;

  const g = _roomGrade(scene, room);
  _warmTo = num(g?.warmth, -1, 1) * WARM_RANGE;
  _liftTo = Math.max(0, _grades.lift + num(g?.lift, -1, 1) * LIFT_RANGE);
  _duskTo = _duskOf(scene, g);

  // Whether the player is ARRIVING (a wipe is over the top of this and the
  // room has to come up out of it) or the room is being rebuilt under a screen
  // nobody covered, which wants no fade-up at all. The caller knows; a caller
  // that does not say falls back to a render gap, which is only a true signal
  // for something that stops rendering while it swaps scenes.
  let arriving = opts?.arrive;
  if (typeof arriving !== 'boolean') {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    arriving = !_lastRender || now - _lastRender > GAP_MS / 2;
  }

  if (!motionOk()) {
    // no motion: no veil, no breath, no tinted wipe. The grade is simply there.
    _arrive = 0;
    _wide = 0;
    _warmNow = _warmTo;
    _liftNow = _liftTo;
    _duskNow = _duskTo;
  } else if (arriving) {
    _arrive = 1;  // veil, eased off over the next ~0.5s
    _wide = 1;    // ...with the vignette open, closing on the settled room
    _tintIris(scene);
  }
  // else: an in-place rebuild. The per-frame ease walks the grade to the new
  // target on its own, which is what a room re-grading itself should look like.
  // `_grade` holds whatever the last frame left, so nothing snaps.
  _lastRender = 0; // the next render starts the breath, it does not measure a gap
  _applyGrade();
}

export function resize(w, h) {
  if (!_composer || _failed) return;
  _composer.setPixelRatio(_renderer.getPixelRatio());
  _composer.setSize(w, h);
  _w = w; _h = h;
}

/**
 * Render one frame through the chain. Returns false when the chain is not
 * usable (init failed, no scene yet, or a pass threw): the engine then does a
 * plain renderer.render() itself, so a broken chain never blanks the screen.
 */
export function render(dt) {
  if (_failed || !_composer || !_renderPass?.scene || !_renderPass.camera) return false;
  // Debug harnesses (and anything else) may resize the renderer directly
  // without telling us; a mismatched composer draws a stretched half-frame.
  _renderer.getSize(_size);
  if (_size.x !== _w || _size.y !== _h) resize(_size.x, _size.y);
  try {
    _step(dt); // inside the guard: a grade that throws must still fall back
    _composer.render(dt);
    return true;
  } catch (e) {
    // A first-frame hiccup (mid-boot GL state) can throw once and then be
    // fine, so rebuild the chain once before writing the GPU off for good.
    if (!_retried) {
      _retried = true;
      console.warn('[postfx] render failed, rebuilding the chain once:', e);
      const scene = _renderPass.scene, camera = _renderPass.camera;
      const grade = _roomG; // _dispose() does not clear it: keep the room's look
      _dispose();
      init(_renderer, scene, camera); // sets _failed itself if it cannot build
      setScene(scene, camera, { grade }, { arrive: false });
    } else {
      console.warn('[postfx] render failed, falling back to plain render:', e);
      _failed = true;
    }
    return false; // engine plain-renders this frame either way
  }
}

/** Dev/tuning helper: adjust bloom + grade live (used by playtest harnesses
 *  and by the Settings graphics presets). The values passed here are the BASE
 *  the automatic dusk response rides on top of, so strength 0 stays 0. */
export function tune({ strength, radius, threshold, vignette, lift, desat, curve } = {}) {
  if (strength !== undefined) _base.strength = strength;
  if (radius !== undefined) _base.radius = radius;
  if (threshold !== undefined) _base.threshold = threshold;
  if (vignette !== undefined) _grades.vig = vignette;
  if (desat !== undefined) _grades.desat = desat;
  if (curve !== undefined) _grades.curve = curve;
  if (lift !== undefined) {
    _grades.lift = lift;
    _liftTo = lift;
    _liftNow = lift;
  }
  _applyGrade();
}

// ---- the moving parts -------------------------------------------------------

/** One ease step for everything that breathes. No allocation, ~20 flops. */
function _step(dt) {
  const d = (typeof dt === 'number' && dt > 0 && dt < 0.25) ? dt : 0.016;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // A gap means the world was off screen (a minigame owns the whole screen
  // while it runs, and a hidden tab stops rendering): come back open.
  if (_lastRender && now - _lastRender > GAP_MS && motionOk()) _wide = 1;
  _lastRender = now;

  // the room's own darkness drives the dusk bloom response; rooms that re-mix
  // scene.background (or rewrite grade.dusk) through the cove day move it
  // continuously, because _roomG is the room's live object, not a copy
  _duskTo = _duskOf(_renderPass.scene, _roomG);

  const k = Math.min(1, d * RAMP);
  const kb = Math.min(1, d * BREATH);
  _warmNow += (_warmTo - _warmNow) * k;
  _liftNow += (_liftTo - _liftNow) * k;
  _duskNow += (_duskTo - _duskNow) * k;
  _arrive += (0 - _arrive) * k;
  _wide += (0 - _wide) * kb;
  if (_arrive < 0.002) _arrive = 0;
  if (_wide < 0.002) _wide = 0;
  _applyGrade();
}

/** Push the current state into the bloom pass and the grade uniforms. */
function _applyGrade() {
  if (_bloom) {
    _bloom.strength = _base.strength * (1 + DUSK_BLOOM_MUL * _duskNow);
    _bloom.radius = _base.radius;
    _bloom.threshold = Math.max(0, _base.threshold - DUSK_THRESH_DROP * _duskNow);
  }
  const u = _grade?.uniforms;
  if (!u) return;
  u.uVig.value = _grades.vig * (1 - VIG_WIDE_MUL * _wide);
  u.uVigIn.value = VIG_INNER + (VIG_WIDE_INNER - VIG_INNER) * _wide;
  u.uLift.value = _liftNow + ARRIVE_LIFT * _arrive;
  u.uWarm.value = _warmNow;
  u.uDesat.value = _grades.desat + ARRIVE_DESAT * _arrive;
  u.uCurve.value = _grades.curve;
}

/**
 * How dark the room's backdrop is, 0 (noon) .. 1 (cave, club, deep night).
 * Read from scene.background, which every room sets to a THREE.Color and the
 * day/night rooms re-mix in onClock; scene.fog is the fallback. A room whose
 * backdrop does not track its own light (see the jungle note in the header)
 * pins the answer with grade.dusk instead.
 */
function _duskOf(scene, grade) {
  if (typeof grade?.dusk === 'number' && Number.isFinite(grade.dusk)) return clamp01(grade.dusk);
  const c = (scene?.background?.isColor && scene.background)
    || (scene?.fog?.color?.isColor && scene.fog.color)
    || null;
  if (!c) return 0;
  // Color channels are in the renderer's linear working space, which is what
  // a luminance question wants anyway.
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const t = clamp01((lum - DUSK_LIGHT) / (DUSK_DAY - DUSK_LIGHT));
  return 1 - t * t * (3 - 2 * t); // smoothstep, inverted
}

/** room.grade, from whichever source answers first, kept as a LIVE reference so
 *  a room that rewrites it in onClock() is followed rather than snapshotted. */
function _roomGrade(scene, room) {
  const g = room?.grade || scene?.userData?.grade;
  _roomG = (g && typeof g === 'object') ? g : null;
  return _roomG;
}

// ---- the room-switch wipe ---------------------------------------------------
/**
 * Lend the iris a hint of the destination's sky. engine.js owns the wipe (the
 * #fade element, the radius, the timing, the reduced-motion collapse); this
 * only repaints its gradient in a colour mixed toward the room we are opening
 * onto, with a softer edge, and takes the inline style back off afterwards.
 * Every step is guarded: if the engine did not choose the iris path (no
 * @property support, or reduced motion) nothing here happens at all.
 */
function _tintIris(scene) {
  try {
    if (typeof document === 'undefined') return;
    const fade = document.getElementById('fade');
    if (!fade || !fade.classList.contains('iris')) return;
    const c = (scene?.background?.isColor && scene.background) || null;
    if (!c) return;
    // Take the destination's HUE, not its brightness: a wipe has to stay dark
    // or it flashes. So the sky's hue and a muted slice of its saturation are
    // rebuilt at the lightness styles.css already wipes with (#14202c), which
    // is why the beach wipes warm brown, the peak cold blue and the club
    // near-black purple, all at the same weight. Colours are converted OUT of
    // the renderer's linear working space: CSS wants sRGB.
    c.getHSL(_hsl, THREE.SRGBColorSpace);
    _tintC.setHSL(_hsl.h, Math.min(IRIS_SAT_MAX, _hsl.s * IRIS_SAT), IRIS_L, THREE.SRGBColorSpace);
    const hex = _tintC.getHex(THREE.SRGBColorSpace);
    const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    const solid = `rgb(${r}, ${g}, ${b})`;
    fade.style.background = `radial-gradient(circle at var(--iris-x, 50%) var(--iris-y, 50%),`
      + ` rgba(${r}, ${g}, ${b}, 0) calc(var(--iris-r) * 0.62),`
      + ` rgba(${r}, ${g}, ${b}, 0.55) calc(var(--iris-r) * 0.86),`
      + ` ${solid} var(--iris-r))`;
    if (_irisTimer) clearTimeout(_irisTimer);
    _irisTimer = setTimeout(() => {
      _irisTimer = null;
      // hand the element back to styles.css; it is at opacity 0 by now
      try { fade.style.removeProperty('background'); } catch { /* gone with the DOM */ }
    }, IRIS_CLEAR_MS);
  } catch (e) {
    console.warn('[postfx] iris tint skipped:', e);
  }
}

function _dispose() {
  if (_irisTimer) { clearTimeout(_irisTimer); _irisTimer = null; }
  try { _composer?.dispose?.(); } catch { /* best-effort */ }
  _composer = null;
  _renderPass = null;
  _bloom = null;
  _grade = null;
}
