import * as THREE from 'three';
import { makeToon } from '../core/materials.js';

/**
 * SHARED WATER (src/world/water.js) - one animated sea surface, one draw call.
 *
 * Every room that shows open water builds it here so the cove reads as ONE
 * ocean: the same swell, the same banded foam, the same glint, the same depth
 * falloff, relit by the same world clock. `makeWater(opts)` hands back a small
 * handle; the room owns where it sits and what colour it is at this hour.
 *
 *   const water = makeWater({ ... });
 *   scene.add(water.mesh);
 *   // per frame
 *   water.update(t);
 *   // from onClock/_relight
 *   water.setTint(shallowColor); water.setDeep(deepColor);
 *   water.setSun(dirTowardSun, lightColor, amount);
 *
 * WHY IT LOOKS THE WAY IT DOES
 *  - Swell is VERTEX work on the GPU, injected into a MeshToonMaterial with
 *    onBeforeCompile. The old beach sea rewrote 1681 positions AND 1681
 *    analytic normals on the CPU every frame; this costs zero JS per frame and
 *    still lands in three's toon pipeline, so the shipped 3-step ramp bands the
 *    wave faces exactly like it always did. Nothing here allocates per frame:
 *    update() poking uniforms is the whole hot path.
 *  - Foam is BANDED, not soft: two hard arcs stepping out from the shoreline,
 *    pushed in and out by the swell. Each carries its OWN along-shore harmonics
 *    and its own varying width, so they cross each other and break into chunks
 *    instead of running parallel like contour lines. Chunky, like the rest of
 *    the art bible; uniform is the failure mode, not the goal.
 *  - Depth is QUANTIZED into five steps between the shallow and deep colours,
 *    so shallow water near the sand steps down to open blue in visible bands
 *    rather than smearing.
 *  - The glint is a real specular band off the sun/moon direction the room
 *    hands us, toon-stepped into two levels and swept by a slow travelling
 *    pulse. At night the room hands us the moon's direction and its cold
 *    colour, so the band goes narrow, dim and blue on its own.
 *
 * THE WAVE FUNCTION IS SHARED WITH JS. `waveHeight()` below and the generated
 * GLSL are the same three sine trains, so anything floating on the water (the
 * beach ball, the rowboat, fishing floats, the foam ribbon) can ask JS where
 * the surface is and agree with what the GPU drew. Do not edit one without the
 * other; the generator writes the GLSL from the same table.
 *
 * SHORELINE. Rooms describe their shore ANALYTICALLY (centre + radius + two
 * harmonics), which is how the beach's polar cove is defined anyway, so the
 * shader can ask "how far out to sea am I" without a texture or a lookup.
 * Pass `shore: null` for a room that is all water (The Drift).
 */

// ---------------------------------------------------------------- wave table
/**
 * Three crossed sine trains. Amplitudes sum to 0.28, which is what keeps the
 * beach surface above the sand lip and below the dry beach at all times: the
 * beach ball's buoyancy and the shoreline clamp are both tuned against it.
 * CHANGING THESE MOVES THE WATERLINE. Don't.
 */
export const COVE_WAVES = Object.freeze([
  Object.freeze({ a: 0.13, k: 0.62, s: 1.15, dx: 1, dz: 0 }),
  Object.freeze({ a: 0.09, k: 0.85, s: -0.9, dx: 0, dz: 1 }),
  Object.freeze({ a: 0.06, k: 0.40, s: 1.9, dx: 1, dz: 1 }),
]);

/**
 * Surface offset at world (x, z) and time t. The JS mirror of the GLSL below.
 * `amp` and `scale` match the makeWater options of the same name.
 */
export function waveHeight(x, z, t, waves = COVE_WAVES, amp = 1, scale = 1) {
  let h = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    h += w.a * Math.sin((x * w.dx + z * w.dz) * scale * w.k + t * w.s);
  }
  return h * amp;
}

// ------------------------------------------------------------------- shaders
const f = (n) => {
  const s = Number(n).toFixed(6);
  return s.indexOf('.') < 0 ? `${s}.0` : s;
};

/**
 * Build `coveWave(p, t, out h, out dHdx, out dHdz)` from the wave table.
 * Exported because a room may want the swell in a shader that is not the water
 * itself: The Drift offsets its seabed caustics by the slope of the sea
 * overhead, which is what makes the dapples on the sand crawl in lockstep with
 * the swell instead of merely near it.
 */
export function waveFunctionGLSL(waves = COVE_WAVES) {
  let body = '';
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    body += `  ph = (p.x * ${f(w.dx)} + p.y * ${f(w.dz)}) * ${f(w.k)} + t * ${f(w.s)};\n`;
    body += `  cs = cos(ph);\n`;
    body += `  h += ${f(w.a)} * sin(ph);\n`;
    if (w.dx) body += `  ddx += ${f(w.a * w.k * w.dx)} * cs;\n`;
    if (w.dz) body += `  ddz += ${f(w.a * w.k * w.dz)} * cs;\n`;
  }
  return `
void coveWave(vec2 p, float t, out float h, out float ddx, out float ddz) {
  h = 0.0; ddx = 0.0; ddz = 0.0;
  float ph; float cs;
${body}}
`;
}

/**
 * Domain-warped ridged sines: three cheap folds give the thin bright filaments
 * real caustics have, with no texture and no derivatives. Shared verbatim with
 * The Drift's seabed, so the dapples on the sand and the net on the underside
 * of the sea are the same FUNCTION - but each caller picks its own world scale
 * and its own rate, and The Drift's ceiling and seabed are deliberately 2-4x
 * apart in space and ~2x in time. They are the same body of water, not the same
 * frame of it; do not read this as "the two patterns lock together".
 */
export const GLSL_CAUSTIC = `
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

let waterN = 0;

/**
 * The one answer to "should this be calmed down": the player's in-game Motion
 * setting OR the OS flag. src/ui/settings.js owns it and installs the helper
 * lazily, so the `?.` and the media-query fallback are both load-bearing (a
 * session that never opens the menu never defines it).
 *
 * NOTE: unlike everything else that reads this, the water resolves it ONCE, at
 * makeWater() time, because the sparkle rate is baked into the compiled shader
 * as a literal. A player who flips Motion mid-session gets the new behaviour on
 * the next room build, not immediately. That is the honest trade for a zero-JS
 * hot path; if it ever needs to be live, promote the rate to a uniform.
 */
function prefersReducedMotion() {
  try {
    const c = globalThis.capyReducedMotion?.();
    if (c !== undefined) return !!c;
  } catch { /* settings not loaded yet: the media query alone answers */ }
  try {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

function toColor(out, c) {
  if (c === null || c === undefined) return out;
  if (c.isColor) out.copy(c); else out.setHex(c);
  return out;
}

// ------------------------------------------------------------------ makeWater
/**
 * Build one animated water surface.
 *
 * @param {object} opts
 *  width/depth/segments  plane size in world units and its tessellation
 *  center {x,z}          world centre; the geometry is baked there so local xz
 *                        IS world xz (do not move the mesh in x/z afterwards)
 *  y                     mean surface height
 *  amplitude             multiplies the wave table (1 = the cove's own swell)
 *  scale                 multiplies the wave FREQUENCY (<1 = longer swell)
 *  shallow / deep        the two ends of the depth ramp (hex or THREE.Color)
 *  foam / foamAmount     foam colour and how strongly the arcs paint
 *  glint / glintAmount   specular colour and strength (the room's clock owns
 *                        the amount; setSun() is how it hands it over)
 *  glintPower            how tightly the glitter hugs the sun's side of the
 *                        water when the sun is low. 2 = a broad wash, 5 = a
 *                        hard western path. Fades out as the sun climbs and
 *                        the whole sea lights up (see the glint note).
 *  shore                 {x, z, r, a1, p1, a3, p3, foamW, depthRange} or null.
 *                        r + a1*cos(th+p1) + a3*sin(3th+p3) is the shoreline
 *                        radius, exactly the form the beach cove already uses.
 *  caustics              0..1 net of light filaments added on top (The Drift)
 *  causticScale          world scale of that net
 *  self                  self-illumination: 0 for a lit sea, ~1 for a surface
 *                        seen from UNDERNEATH, where three's lights are behind it
 *  underside             render the far side and glare toward the sun instead
 *                        of reflecting off it (the view from below)
 */
export function makeWater(opts = {}) {
  const {
    width = 62,
    depth = width,
    segments = 56,
    center = null,
    y = 0,
    waves = COVE_WAVES,
    amplitude = 1,
    scale = 1,
    shallow = 0x3ba7dd,
    deep = 0x1d5f92,
    foam = 0xfff6e3,
    foamAmount = 0.85,
    glint = 0xfff3d0,
    glintAmount = 0.55,
    glintPower = 34,
    shore = null,
    caustics = 0,
    causticScale = 0.085,
    self = 0,
    underside = false,
    renderOrder = 0,
    name = 'water',
  } = opts;

  const cx = center ? (center.x || 0) : 0;
  const cz = center ? (center.z || 0) : 0;
  const reduced = opts.reducedMotion === undefined ? prefersReducedMotion() : !!opts.reducedMotion;

  // The steepest this swell can ever get, at THIS room's amplitude and scale.
  // The underside's toon bands are cut against it (see FGLINT), which is what
  // makes them fire for any wave table a room asks for instead of only for the
  // one they happened to be hand-tuned against.
  let slopeX = 0, slopeZ = 0;
  for (const w of waves) {
    slopeX += Math.abs(w.a * w.k * w.dx);
    slopeZ += Math.abs(w.a * w.k * w.dz);
  }
  const maxSlope = Math.max(1e-3, Math.hypot(slopeX, slopeZ) * Math.abs(amplitude) * Math.abs(scale));

  // ---- geometry: pre-rotated and pre-centred so local xz === world xz -------
  const geo = new THREE.PlaneGeometry(width, depth, segments, segments);
  geo.rotateX(-Math.PI / 2);
  if (cx || cz) geo.translate(cx, 0, cz);

  // ---- uniforms (the room writes these; nothing here allocates per frame) ---
  const uniforms = {
    uTime: { value: 0 },
    uAmp: { value: amplitude },
    uScl: { value: scale },
    uShallow: { value: toColor(new THREE.Color(), shallow) },
    uDeepC: { value: toColor(new THREE.Color(), deep) },
    uFoamC: { value: toColor(new THREE.Color(), foam) },
    uGlintC: { value: toColor(new THREE.Color(), glint) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.75, -0.5).normalize() },
    uGlint: { value: glintAmount },
    uSelf: { value: self },
    uCaust: { value: caustics },
    uFoamAmt: { value: foamAmount },
    // 1 = the glitter sweeps; 0 = it holds still. prefers-reduced-motion turns
    // this off, damps the glint amount in setSun(), and slows the sparkle net
    // to a crawl in the generated shader: the swell itself is a gentle roll and
    // stays, but a strobing highlight field is exactly what the query is for.
    uPulse: { value: reduced ? 0 : 1 },
    uShoreC: { value: new THREE.Vector2(shore ? shore.x || 0 : 0, shore ? shore.z || 0 : 0) },
    uShoreA: {
      value: new THREE.Vector4(
        shore ? shore.r ?? 10 : 0, shore ? shore.a1 || 0 : 0,
        shore ? shore.p1 || 0 : 0, shore ? shore.a3 || 0 : 0,
      ),
    },
    uShoreB: {
      value: new THREE.Vector2(
        shore ? shore.p3 || 0 : 0, Math.max(0.001, shore ? shore.depthRange ?? 22 : 22),
      ),
    },
    uFoamW: { value: Math.max(0.001, shore ? shore.foamW ?? 1 : 1) },
  };

  // ---- material: a real MeshToonMaterial with the swell injected -----------
  const material = makeToon(0xffffff, {
    unique: true,
    side: underside ? THREE.BackSide : THREE.FrontSide,
  });
  material.name = name;
  const cacheKey = `cove-water-${++waterN}`;

  const VPARS = `
uniform float uTime, uAmp, uScl;
varying vec3 vWPos;
varying vec3 vWNrm;
varying float vWave;
${waveFunctionGLSL(waves)}`;

  // beginnormal_vertex runs BEFORE begin_vertex, so the swell is solved once
  // here and both the normal and the displaced position fall out of it.
  const VNORM = `
  vec4 wWorld0 = modelMatrix * vec4( position, 1.0 );
  float wH, wDx, wDz;
  coveWave( wWorld0.xz * uScl, uTime, wH, wDx, wDz );
  wH *= uAmp;
  // chain rule: the sample coords were scaled, so the slopes scale with them
  wDx *= uAmp * uScl;
  wDz *= uAmp * uScl;
  vec3 objectNormal = normalize( vec3( -wDx, 1.0, -wDz ) );`;

  const VPOS = `
  vec3 transformed = vec3( position );
  transformed.y += wH;
  vWPos = wWorld0.xyz + vec3( 0.0, wH, 0.0 );
  vWNrm = objectNormal;
  vWave = wH;`;

  const FPARS = `
uniform vec3 uShallow, uDeepC, uFoamC, uGlintC;
uniform vec3 uSunDir;
uniform float uTime, uGlint, uSelf, uCaust, uFoamAmt, uPulse, uFoamW;
uniform vec2 uShoreC, uShoreB;
uniform vec4 uShoreA;
varying vec3 vWPos;
varying vec3 vWNrm;
varying float vWave;
${caustics > 0 || !underside ? GLSL_CAUSTIC : ''}`;

  // Depth falloff + banded shore foam. Both fall out of ONE number: how far
  // this pixel is out past the analytic shoreline.
  const FCOLOR = shore ? `
  vec2 wSd = vWPos.xz - uShoreC;
  float wTh = atan( wSd.y, wSd.x );
  float wR = uShoreA.x + uShoreA.y * cos( wTh + uShoreA.z ) + uShoreA.w * sin( 3.0 * wTh + uShoreB.x );
  float wOut = length( wSd ) - wR;
  float wDk = clamp( wOut / uShoreB.y, 0.0, 1.0 );
  wDk = wDk * wDk * ( 3.0 - 2.0 * wDk );
  wDk = floor( wDk * 5.0 + 0.5 ) * 0.2;          // five chunky depth steps
  diffuseColor.rgb *= mix( uShallow, uDeepC, wDk );

  // FOAM: two banded arcs, and the banding is the only thing they have in
  // common. The first cut of this was three arcs sharing ONE along-shore wobble
  // and one fixed width each, which is a recipe for exactly the wrong picture:
  // three hard cream ribbons of identical thickness running perfectly parallel
  // to the shoreline and to each other, forever. That reads as lane markings or
  // map contours, never as surf, because real breakers converge, overtake each
  // other and PINCH OUT. So:
  //
  //  - every arc gets its OWN mix of the along-shore harmonics, at its own
  //    phase and its own rate, so the two of them wander across each other
  //    instead of moving in lockstep;
  //  - every arc's WIDTH is a function of angle too, and the second one's goes
  //    NEGATIVE over part of the cove, which is where the band simply stops.
  //    That is what turns a ribbon into a run of chunks;
  //  - the third arc is gone. Out past the second one the sea should be sea;
  //    with the room's own foam ribbon at the sand there were four white lines
  //    stacked up the beach.
  //
  // The edges stay hard steps: chunky IS the house style (DESIGN.md). Uniform
  // was the bug.
  float wSw = ( wOut - vWave * 2.4 ) / uFoamW;
  float wH1 = sin( wTh * 5.0 + uTime * 0.55 );
  float wH2 = sin( wTh * 11.0 - uTime * 0.31 );
  float wH3 = sin( wTh * 2.3 + uTime * 0.17 );

  // the break at the sand: always present, but its line crawls and its
  // thickness breathes, so no two stretches of shore look alike
  float wP1 = wSw - ( 0.30 * wH1 + 0.14 * wH2 + 0.26 * wH3 );
  float wW1 = 0.34 + 0.16 * sin( wTh * 6.0 - uTime * 0.40 );
  float wFo = step( abs( wP1 - 0.55 ), wW1 );

  // the swell behind it: a different harmonic mix entirely, so it drifts across
  // the break rather than shadowing it, and a width that spends part of every
  // lap below zero, so it arrives in pieces
  float wP2 = wSw - ( 0.52 * sin( wTh * 3.1 - uTime * 0.37 + 2.1 )
                    + 0.24 * wH2 + 0.18 * wH1 );
  float wW2 = 0.13 + 0.26 * sin( wTh * 3.7 + uTime * 0.23 );
  wFo += step( abs( wP2 - 1.75 ), max( wW2, 0.0 ) ) * 0.58;
  wFo *= uFoamAmt * ( 1.0 - wDk * 0.55 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uFoamC, clamp( wFo, 0.0, 0.95 ) );` : `
  diffuseColor.rgb *= uShallow;`;

  const FGLINT = underside ? `
  // seen from below: the sun is a smeared blaze in the direction you look up in
  vec3 wV = normalize( vWPos - cameraPosition );
  float wGl = pow( max( dot( wV, uSunDir ), 0.0 ), 5.0 );
  // THE BANDS. Cut against the surface's LEAN TOWARD THE SUN, not against an
  // absolute N.L. From 24 metres under an ocean swell the normal never tilts
  // more than about 15 degrees, so a dot against a sun 67 degrees up spans
  // roughly 0.79..0.99 and every threshold you could write is either
  // unreachable or grazed: the ceiling comes out as one flat level with a bit
  // of fog on it, which is not banding, it is a gradient. Measured off the
  // HORIZONTAL part of the normal (which is exactly the slope) and divided by
  // the steepest slope this wave table can produce here, the number spans about
  // -1..+1 whatever the sun is doing, so the toon steps land on the wave faces
  // the way they do on every other surface in the cove.
  vec2 wSunA = normalize( uSunDir.xz + vec2( 1e-5, 0.0 ) );
  float wLean = dot( normalize( vWNrm ).xz, wSunA ) * ${f(1 / maxSlope)};
  // three roughly equal-area levels (measured: 32% / 35% / 33% of the surface).
  // The steps are wider than the old 0.74/0.88/1.0 because the ceiling is seen
  // through 24 metres of fog, which flattens whatever contrast leaves the
  // shader: at the old spacing the bands were technically present and visually
  // absent.
  float wRamp = wLean < -0.22 ? 0.58 : ( wLean < 0.20 ? 0.80 : 1.0 );
  totalEmissiveRadiance += uGlintC * wGl * uGlint;
  totalEmissiveRadiance += diffuseColor.rgb * uSelf * wRamp;` : `
  // Seen from above: sun glitter, built in TWO parts, because either one alone
  // is wrong and the pair is what the eye reads as "sunlight on water".
  //
  //  THE LANE says WHERE the light is. It is NOT a Blinn-Phong highlight, and
  //  that is deliberate: with a 3/4 camera pitched ~28 degrees and a sun on the
  //  horizon, the half-vector sits 30 degrees off the surface normal and a real
  //  specular lobe evaluates to about 1e-6. Physically right, and it deleted
  //  the sunset, which is the one shot the beach exists for. A wedge cast from
  //  the CAMERA along the sun's azimuth was tried next and was nearly as dim,
  //  because a camera 25 units back from the cove is not looking down the
  //  glitter path either. So the lane is what an illustrator would actually
  //  paint: THE SIDE OF THE WATER THE SUN IS ON. It is a hemisphere of sea
  //  centred on the sun's azimuth, hard at sunset and sunrise, opening out to
  //  the whole sea as the sun climbs (wHigh). The swell then decides which
  //  faces inside it catch the light.
  //
  //  THE SPARKLE is the chop inside it. Two crossed sines were tried and read
  //  as woven fabric - anything on a regular lattice does. So it is the SAME
  //  domain-warped ridged net the caustics use, which is irregular by
  //  construction, thresholded into thin bright filaments, and faded out with
  //  distance: chop you can resolve at ten units is a flat sheen at a hundred,
  //  and that fade is also what stops the far field from crawling.
  float wLen = distance( cameraPosition, vWPos );
  vec2 wAim = normalize( vWPos.xz - uShoreC + vec2( 1e-5, 0.0 ) );
  vec2 wSunA = normalize( uSunDir.xz + vec2( 1e-5, 0.0 ) );
  float wHigh = clamp( uSunDir.y, 0.0, 1.0 );
  float wSide = dot( wAim, wSunA ) * 0.5 + 0.5;      // 1 = the sun's side of the cove
  float wLane = mix( pow( wSide, ${f(glintPower)} ), 1.0, wHigh * wHigh );
  // Which faces inside it catch the light: the ones LEANING toward the sun's
  // azimuth. Measured off the normal's horizontal part, so it means the same
  // thing whether the sun is overhead or on the horizon (an absolute dot
  // against a lifted sun vector was tried and silently switched the sunset
  // off, because at a 9 degree sun no gentle swell ever clears the threshold).
  float wFace = dot( normalize( vWNrm ).xz, wSunA );
  wLane *= 0.35 + 0.65 * smoothstep( -0.02, 0.10, wFace );
  float wGb = 0.0;
  // most of the sea is nowhere near the lane; skip the expensive half there
  if ( wLane > 0.01 ) {
    float wF = caust( vWPos.xz * 0.85, uTime * ${f(reduced ? 0.3 : 1.7)} );
    wGb = wLane * ( 0.20 + 1.45 * smoothstep( 0.20, 0.60, wF ) * exp( -wLen * 0.020 ) );
    wGb *= mix( 1.0, 0.70 + 0.30 * sin( vWPos.x * 0.09 + vWPos.z * 0.06 - uTime * 0.75 ), uPulse );
  }
  // a lift toward white: the hue stays the sun's, but a highlight has to be
  // brighter than the thing it is sitting on or it is just a stain
  totalEmissiveRadiance += mix( uGlintC, vec3( 1.0 ), 0.4 ) * wGb * uGlint;
  totalEmissiveRadiance += diffuseColor.rgb * uSelf;`;

  const FCAUST = caustics > 0 ? `
  totalEmissiveRadiance += uGlintC * caust( vWPos.xz * ${f(causticScale)}, uTime * 0.32 ) * uCaust;` : '';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VPARS}`)
      .replace('#include <beginnormal_vertex>', VNORM)
      .replace('#include <begin_vertex>', VPOS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FPARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FCOLOR}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FGLINT}${FCAUST}`);
  };
  // two waters in one scene must not share a compiled program
  material.customProgramCacheKey = () => cacheKey;

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.position.y = y;
  mesh.frustumCulled = false;   // vertices move in the shader; the box lies
  if (renderOrder) mesh.renderOrder = renderOrder;

  let disposed = false;

  return {
    mesh,
    material,
    uniforms,
    waves,
    amplitude,
    scale,
    reducedMotion: reduced,

    /** Per frame. `t` is the room's own clock in seconds. Writes 1 uniform. */
    update(t) { uniforms.uTime.value = t; },

    /** Where the surface is, in world space, at the same t update() was given. */
    heightAt(x, z, t) { return waveHeight(x, z, t, waves, amplitude, scale) + y; },

    /** Surface offset only (no mean height), for callers that add their own. */
    offsetAt(x, z, t) { return waveHeight(x, z, t, waves, amplitude, scale); },

    /** The near-shore colour. Accepts a hex or a THREE.Color; copies, never keeps. */
    setTint(c) { toColor(uniforms.uShallow.value, c); },
    /** The open-water colour the depth ramp runs out to. */
    setDeep(c) { toColor(uniforms.uDeepC.value, c); },
    setFoam(c, amount) {
      toColor(uniforms.uFoamC.value, c);
      if (Number.isFinite(amount)) uniforms.uFoamAmt.value = amount;
    },

    /**
     * Hand the water the key light. `dir` points TOWARD the sun (or the moon:
     * the beach's clock keeps one direction for both, which is exactly what
     * turns the glitter path into a moon trail after dark). `amount` is how
     * much glitter this hour deserves - rain and midnight should shrink it.
     */
    setSun(dir, color, amount) {
      if (dir) uniforms.uSunDir.value.copy(dir).normalize();
      if (color !== null && color !== undefined) toColor(uniforms.uGlintC.value, color);
      if (Number.isFinite(amount)) {
        uniforms.uGlint.value = Math.max(0, amount) * (reduced ? 0.72 : 1);
      }
    },

    /** Caustic net strength (The Drift drives this off the world clock). */
    setCaustics(v) { if (Number.isFinite(v)) uniforms.uCaust.value = Math.max(0, v); },

    dispose() {
      if (disposed) return;
      disposed = true;
      geo.dispose();
      material.dispose();
    },
  };
}
