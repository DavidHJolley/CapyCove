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
 * whisper of warm lift and desaturation in the shadows plus a gentle
 * vignette. No OutputPass: the buffer is already display-ready.
 * MSAA cannot ride along (the sRGB texture + linear MSAA renderbuffer pair
 * fails to resolve: the resolve blit needs identical formats), so a final
 * FXAA pass replaces the canvas antialiasing: on chunky toon silhouettes the
 * difference is invisible and it costs a fraction of a millisecond.
 *
 * Fallback contract: init() returns false (and render() forever returns false)
 * if anything throws, so the engine keeps its plain renderer.render() path on
 * GPUs that can't build the chain. A failing render() rebuilds the chain once
 * (first-frame GL hiccups) and then latches the plain-render fallback.
 */

// ---- tunables ---------------------------------------------------------------
// Bloom thresholds in DISPLAY space (post-ACES, sRGB-encoded, luminance): the
// threshold rides the line between "noon-lit cream sand" (which must stay
// quiet) and "LED tile / lantern core / neon" (which must sing). Verified
// against beach noon / plaza dusk / grotto shots.
const BLOOM_STRENGTH = 0.35;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.85;
const VIGNETTE = 0.16;      // corner darkening amount (0 = off)
const LIFT = 0.014;         // warm shadow lift (display space)
const DESAT_SHADOWS = 0.02; // ~2% desaturation in the shadows

const GradeShader = {
  name: 'CapyGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uVig: { value: VIGNETTE },
    uLift: { value: LIFT },
    uDesat: { value: DESAT_SHADOWS },
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
    uniform float uLift;
    uniform float uDesat;
    varying vec2 vUv;
    void main() {
      // the buffer already holds the finished display image (tonemapped and
      // sRGB-encoded during the scene render), so the grade works in familiar
      // display space, where its tiny offsets stay tiny
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = t.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float sh = 1.0 - smoothstep(0.0, 0.45, l);   // shadow mask
      c += vec3(1.0, 0.62, 0.22) * (uLift * sh);   // slight warm lift
      c = mix(c, vec3(l), uDesat * sh);            // gentle shadow desaturation
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - uVig * smoothstep(0.42, 0.86, d); // vignette
      gl_FragColor = vec4(c, t.a);
    }
  `,
};

let _renderer = null;
let _composer = null;
let _renderPass = null;
let _bloom = null;
let _failed = false;
let _retried = false; // one rebuild attempt before latching the fallback
let _w = 0, _h = 0;
const _size = new THREE.Vector2();

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
      BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD,
    );
    _composer.addPass(_renderPass);
    _composer.addPass(_bloom);
    _composer.addPass(new ShaderPass(GradeShader)); // display-space grade
    _composer.addPass(new FXAAPass());              // AA back (no MSAA here), to screen
    _w = _size.x; _h = _size.y;
    return true;
  } catch (e) {
    console.warn('[postfx] init failed, falling back to plain render:', e);
    _dispose();
    _failed = true;
    return false;
  }
}

/** Point the chain at a (new) room scene. Cheap; call on every room switch. */
export function setScene(scene, camera) {
  if (!_renderPass) return;
  _renderPass.scene = scene;
  _renderPass.camera = camera;
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
    _composer.render(dt);
    return true;
  } catch (e) {
    // A first-frame hiccup (mid-boot GL state) can throw once and then be
    // fine, so rebuild the chain once before writing the GPU off for good.
    if (!_retried) {
      _retried = true;
      console.warn('[postfx] render failed, rebuilding the chain once:', e);
      const scene = _renderPass.scene, camera = _renderPass.camera;
      _dispose();
      init(_renderer, scene, camera); // sets _failed itself if it cannot build
    } else {
      console.warn('[postfx] render failed, falling back to plain render:', e);
      _failed = true;
    }
    return false; // engine plain-renders this frame either way
  }
}

/** Dev/tuning helper: adjust bloom + grade live (used by playtest harnesses). */
export function tune({ strength, radius, threshold, vignette, lift, desat } = {}) {
  if (_bloom) {
    if (strength !== undefined) _bloom.strength = strength;
    if (radius !== undefined) _bloom.radius = radius;
    if (threshold !== undefined) _bloom.threshold = threshold;
  }
  const grade = _composer?.passes?.[2];
  if (grade?.uniforms) {
    if (vignette !== undefined) grade.uniforms.uVig.value = vignette;
    if (lift !== undefined) grade.uniforms.uLift.value = lift;
    if (desat !== undefined) grade.uniforms.uDesat.value = desat;
  }
}

function _dispose() {
  try { _composer?.dispose?.(); } catch { /* best-effort */ }
  _composer = null;
  _renderPass = null;
  _bloom = null;
}
