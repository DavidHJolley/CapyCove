import * as THREE from 'three';
import { HATS, MINIGAMES, ROOM_INFO } from '../../shared/constants.js';
import { createAvatar } from '../player/avatar.js';
import { makeToon, makeGlow, disposeObject } from '../core/materials.js';

/**
 * Player card: click a capybara, meet the capybara.
 *
 * A live 3D turntable of THEIR avatar (their color + hat), their name, a
 * flavor title, their minigame bests rendered as medals, and the friend
 * button when both sides have real accounts.
 *
 * Public API:
 *   openProfile(game, playerId)   - the card (also opened from the friends list)
 *   ensureSocialStyles()          - injects the single <style> tag for pf-/fr-
 *   normalizeFriends(payload)     - shared parser for the 'friends-data' event
 *
 * Data flow: we paint instantly from whatever the net client already knows
 * about that remote (name/color/hat/bot), fire {t:'inspect', id} and enrich the
 * card when 'profile-data' arrives. 'friends-data' keeps the button honest.
 */

// ---------------------------------------------------------------------------
// achievements
// ---------------------------------------------------------------------------

// bronze / silver / gold cut-offs per minigame
const MEDAL_TIERS = {
  fishing: [30, 60, 100],
  sled: [800, 2000, 4000],
  smoothie: [150, 350, 600],
};

const TIER_CLASS = ['is-none', 'is-bronze', 'is-silver', 'is-gold'];
const TIER_LABEL = ['No medal yet', 'Bronze', 'Silver', 'Gold'];

const MEDAL_BLURB = {
  fishing: 'Reeled in off Driftwood Beach',
  sled: 'Screamed down Frosty Peak',
  smoothie: 'Blended under pressure',
};

/** One line of context under each minigame name: where they are on the ladder. */
function medalSub(best, tier, next) {
  if (best == null) return next != null ? `Not tried yet : ${next} earns bronze` : 'Not tried yet';
  if (tier === 0) return `${next} earns bronze`;
  if (tier === 1) return `Bronze : ${next} earns silver`;
  if (tier === 2) return `Silver : ${next} earns gold`;
  return 'Gold : nothing left to prove';
}

/** A best of 0 (or missing / junk) means "never played". */
function bestOf(bests, id) {
  const has = bests && Object.prototype.hasOwnProperty.call(bests, id);
  const v = has ? Number(bests[id]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function medalTier(id, best) {
  const cuts = Object.prototype.hasOwnProperty.call(MEDAL_TIERS, id) ? MEDAL_TIERS[id] : null;
  if (!cuts || best == null) return 0;
  if (best >= cuts[2]) return 3;
  if (best >= cuts[1]) return 2;
  if (best >= cuts[0]) return 1;
  return 0;
}

function nextCut(id, best) {
  const cuts = Object.prototype.hasOwnProperty.call(MEDAL_TIERS, id) ? MEDAL_TIERS[id] : null;
  if (!cuts) return null;
  for (const c of cuts) if (best == null || best < c) return c;
  return null;
}

function flavorTitle(bests, isBot, isSelf) {
  if (isBot) return 'Local legend';
  const ids = Object.keys(MEDAL_TIERS);
  let gold = 0; let silver = 0; let bronze = 0; let played = 0;
  for (const id of ids) {
    const best = bestOf(bests, id);
    if (best != null) played++;
    const t = medalTier(id, best);
    if (t === 3) gold++;
    else if (t === 2) silver++;
    else if (t === 1) bronze++;
  }
  if (gold >= 3) return 'Champion of the cove';
  if (gold >= 1) return 'Podium regular';
  if (silver >= 1) return 'Dangerously good';
  if (bronze >= 1) return 'Getting the hang of it';
  if (played >= 1) return 'Warming up';
  return isSelf ? 'Your story starts here' : 'Newly washed ashore';
}

// ---------------------------------------------------------------------------
// payload parsing (server shapes are tolerated loosely on purpose)
// ---------------------------------------------------------------------------

function toRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw.profile && typeof raw.profile === 'object' ? { ...raw, ...raw.profile } : raw;
}

function normalizeProfile(raw) {
  const p = toRecord(raw);
  if (!p) return null;
  const id = p.id ?? p.playerId;
  const color = Number(p.color);
  return {
    id: id == null ? null : String(id),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
    color: Number.isFinite(color) && color > 0 ? color : null,
    hat: typeof p.hat === 'string' && Object.prototype.hasOwnProperty.call(HATS, p.hat) ? p.hat : null,
    bot: p.bot === true,
    // undefined means "the server did not say", which is not the same as guest
    registered: typeof p.registered === 'boolean' ? p.registered : null,
    room: typeof p.room === 'string' ? p.room : null,
    online: typeof p.online === 'boolean' ? p.online : null,
    bests: p.bests && typeof p.bests === 'object' ? p.bests : {},
    isFriend: typeof p.isFriend === 'boolean' ? p.isFriend
      : typeof p.friend === 'boolean' ? p.friend : null,
  };
}

/**
 * Shared with friends.js: accepts [..] or {friends:[..]} or {players:[..]}.
 * A friendship is stored by account, so the id is only the CONNECTION id of a
 * friend who happens to be online: entries keep their name and a null id when
 * they are not around, and callers gate "open their card" on the id.
 */
export function normalizeFriends(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.friends) ? raw.friends
      : Array.isArray(raw?.players) ? raw.players : [];
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const id = f.id ?? f.playerId;
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name && (id == null || id === '')) continue; // nothing to show or click
    const room = typeof f.room === 'string' && Object.prototype.hasOwnProperty.call(ROOM_INFO, f.room)
      ? f.room : null;
    out.push({
      id: id == null || id === '' ? null : String(id),
      name: name || 'A quiet capybara',
      online: typeof f.online === 'boolean' ? f.online : !!room,
      room,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// styles: ONE tag for both social overlays (pf- = player card, fr- = friends)
// ---------------------------------------------------------------------------

const STYLE_ID = 'capy-social-styles';

const CSS = `
.pf-overlay, .fr-overlay {
  position: absolute; inset: 0; padding: 18px; display: flex;
  align-items: center; justify-content: center;
  background: rgba(20, 32, 44, 0.55); backdrop-filter: blur(7px) saturate(1.15);
  animation: pf-fade 0.18s ease;
}
/* above the map/shop (40) and the pause menu (42); the card sits on the list */
.pf-overlay { z-index: 44; }
.fr-overlay { z-index: 43; }
.pf-overlay.is-closing, .fr-overlay.is-closing {
  opacity: 0; transition: opacity 0.15s ease; pointer-events: none;
}

.pf-card, .fr-card {
  position: relative; background: var(--cream); border: 4px solid #fff;
  border-radius: 26px; box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  max-height: 92vh; overflow: auto;
  animation: pf-rise 0.3s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.pf-card:focus, .fr-card:focus { outline: none; }
.pf-card { width: min(540px, 94vw); padding: 22px 24px 18px; }
.fr-card { width: min(430px, 94vw); padding: 22px 22px 16px; }
.pf-x, .fr-x { position: absolute; top: 14px; right: 14px; z-index: 2; }

/* ---- player card ---- */
.pf-body { display: flex; gap: 18px; align-items: flex-start; margin-top: 2px; }
.pf-stage { width: 200px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.pf-stage-frame {
  position: relative; width: 200px; height: 232px; border-radius: 22px; overflow: hidden;
  background: radial-gradient(ellipse 72% 62% at 50% 36%, #fffaea 0%, #ffeec9 44%, #f6dda6 72%, #ecca86 100%);
  box-shadow: inset 0 -18px 30px rgba(178, 136, 64, 0.22),
    inset 0 0 0 3px rgba(255, 255, 255, 0.7), 0 6px 18px rgba(45, 36, 23, 0.14);
}
.pf-canvas { position: absolute; inset: 0; width: 200px; height: 232px; display: block; }
.pf-shine {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(202deg, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 40%);
}
.pf-fallback {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 22px; font-weight: 800; font-size: 12.5px; color: #a3906c;
}
.pf-outfit {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  font-weight: 700; font-size: 12px; color: var(--muted); min-height: 16px;
}
.pf-dot-color {
  width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; flex: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

.pf-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
.pf-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-right: 40px; }
.pf-name {
  font-size: 24px; font-weight: 900; line-height: 1.1; letter-spacing: 0.01em;
  overflow-wrap: anywhere;
}
.pf-chip {
  font-size: 9px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; background: rgba(79, 179, 232, 0.2);
  color: #2f7fae; flex: none;
}
.pf-chip.is-friend { background: rgba(232, 101, 122, 0.18); color: #c0455c; }
.pf-chip.is-self { background: rgba(242, 182, 74, 0.28); color: #a4720f; }
.pf-title { font-weight: 800; font-size: 13.5px; color: var(--accent); margin-top: -4px; }
.pf-where { font-size: 12.5px; font-weight: 700; color: var(--muted); min-height: 16px; }
.pf-where b { color: var(--ink); }

.pf-section {
  font-size: 10px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase;
  color: #b6a688; margin-top: 4px;
}
.pf-medals { display: flex; flex-direction: column; gap: 7px; }
.pf-row {
  display: flex; align-items: center; gap: 11px; background: var(--card);
  border-radius: 15px; padding: 8px 13px; box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: pf-pop 0.32s backwards var(--spring); animation-delay: calc(var(--i) * 70ms);
}
.pf-medal {
  width: 30px; height: 30px; border-radius: 50%; flex: none;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.55), 0 2px 5px rgba(45, 36, 23, 0.2);
}
.pf-medal.is-gold { background: radial-gradient(circle at 34% 28%, #fff3bd 0%, var(--gold) 58%, #c98c1d 100%); }
.pf-medal.is-silver { background: radial-gradient(circle at 34% 28%, #ffffff 0%, #c3cedb 54%, #7d8b9b 100%); }
.pf-medal.is-bronze { background: radial-gradient(circle at 34% 28%, #ffdcb6 0%, #d18b4d 58%, #96592a 100%); }
.pf-medal.is-none {
  background: rgba(45, 36, 23, 0.05);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.12);
}
.pf-row-txt { flex: 1; min-width: 0; }
.pf-row-name { font-weight: 900; font-size: 13.5px; line-height: 1.2; }
.pf-row-sub { font-size: 11px; font-weight: 700; color: #a3906c; line-height: 1.3; }
.pf-row-score { font-weight: 900; font-size: 16px; text-align: right; flex: none; }
.pf-row-score.is-empty { color: #cbbb98; font-size: 20px; line-height: 1; }

.pf-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px; min-height: 20px; }
.pf-fbtn {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 13.5px;
  padding: 9px 18px; border-radius: 999px; color: #fff;
  background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  box-shadow: 0 4px 0 rgba(150, 55, 72, 0.32), 0 8px 18px rgba(45, 36, 23, 0.18);
  transition: scale 0.12s ease, filter 0.16s ease, background 0.2s ease;
}
.pf-fbtn:hover:not(:disabled) { scale: 1.06; filter: brightness(1.05); }
.pf-fbtn:active:not(:disabled) { scale: 0.95; }
.pf-fbtn:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }
.pf-fbtn.is-remove {
  background: linear-gradient(180deg, #fffefa 0%, #f2e6cd 100%); color: var(--ink);
  box-shadow: 0 4px 0 rgba(45, 36, 23, 0.14), 0 8px 18px rgba(45, 36, 23, 0.14);
}
.pf-fbtn:disabled { background: #ece0c4; color: #93815f; cursor: default; box-shadow: none; }
.pf-note {
  font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.4;
  background: rgba(45, 36, 23, 0.05); border-radius: 12px; padding: 8px 12px; flex: 1; min-width: 160px;
}
.pf-note b { color: var(--ink); }

/* ---- friends list ---- */
.fr-head { display: flex; align-items: baseline; gap: 9px; padding-right: 44px; }
.fr-head h2 { font-size: 24px; margin: 0; color: var(--accent); letter-spacing: 0.02em; }
.fr-count { font-size: 12px; font-weight: 800; color: var(--muted); }
.fr-sub { font-size: 12.5px; font-weight: 700; color: #a3906c; margin: 2px 0 12px; }
.fr-list { display: flex; flex-direction: column; gap: 7px; max-height: 46vh; overflow-y: auto; padding: 2px; }
.fr-row {
  display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
  border: 0; font-family: var(--font); cursor: pointer; background: var(--card);
  border-radius: 15px; padding: 10px 13px; color: var(--ink);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  transition: transform 0.14s ease, box-shadow 0.16s ease, background 0.16s ease;
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 45ms);
}
.fr-row:hover { transform: translateY(-2px); background: #fffdf2; box-shadow: 0 7px 14px rgba(45, 36, 23, 0.14); }
.fr-row:active { transform: translateY(0); }
.fr-row:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.fr-dot {
  position: relative; width: 11px; height: 11px; border-radius: 50%; flex: none;
  background: #c8bda4; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.6);
}
.fr-dot.is-on { background: #6fcf5f; }
.fr-dot.is-on::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  border: 2px solid rgba(111, 207, 95, 0.7); animation: fr-ping 2.6s ease-out infinite;
}
.fr-txt { flex: 1; min-width: 0; }
.fr-name { font-weight: 900; font-size: 14px; line-height: 1.2; overflow-wrap: anywhere; }
.fr-where { font-size: 11.5px; font-weight: 700; color: #a3906c; }
.fr-go { font-size: 11px; font-weight: 900; color: var(--accent2); letter-spacing: 0.06em; flex: none; }
.fr-empty { text-align: center; padding: 20px 14px 10px; }
/* a little capy face, drawn in gradients: nobody likes an empty box */
.fr-empty-art {
  position: relative; width: 72px; height: 72px; margin: 6px auto 16px; border-radius: 50%;
  background:
    radial-gradient(circle 3.5px at 37% 45%, #2d2417 98%, transparent 100%),
    radial-gradient(circle 3.5px at 63% 45%, #2d2417 98%, transparent 100%),
    radial-gradient(circle 3px at 50% 62%, #4a3524 98%, transparent 100%),
    radial-gradient(ellipse 17px 12px at 50% 68%, #c9a06b 98%, transparent 100%),
    radial-gradient(circle at 38% 30%, #ffeec9 0%, #e8c78e 62%, #cfa86d 100%);
  box-shadow: inset 0 -7px 13px rgba(150, 110, 55, 0.28), 0 5px 13px rgba(45, 36, 23, 0.16);
  animation: fr-bob 3.4s ease-in-out infinite;
}
.fr-empty-art::before, .fr-empty-art::after {
  content: ''; position: absolute; top: -5px; width: 17px; height: 15px; border-radius: 50%;
  background: #e0bd85; box-shadow: inset 0 -3px 5px rgba(150, 110, 55, 0.3);
}
.fr-empty-art::before { left: 3px; }
.fr-empty-art::after { right: 3px; }
.fr-empty h3 { font-size: 16px; margin-bottom: 6px; }
.fr-empty p { font-size: 12.5px; font-weight: 700; color: var(--muted); line-height: 1.5; }
.fr-foot { margin-top: 12px; font-size: 11.5px; font-weight: 700; color: #b6a688; text-align: center; }

/* friends HUD button badge */
.fr-hud-badge {
  position: absolute; top: -4px; right: -4px; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 999px; background: var(--accent); color: #fff; border: 2px solid var(--cream);
  font-size: 10px; font-weight: 900; line-height: 15px; text-align: center; pointer-events: none;
  animation: pf-pop 0.34s var(--spring);
}

@keyframes pf-fade { from { opacity: 0; } }
@keyframes pf-rise { from { opacity: 0; transform: translateY(16px) scale(0.95); } }
@keyframes pf-pop { from { opacity: 0; transform: translateY(9px) scale(0.92); } }
@keyframes fr-ping { 0% { scale: 0.7; opacity: 0.9; } 70%, 100% { scale: 2.4; opacity: 0; } }
@keyframes fr-bob { 50% { transform: translateY(-5px) rotate(-3deg); } }

@media (max-width: 640px) {
  .pf-body { flex-direction: column; align-items: center; }
  .pf-info { width: 100%; }
  .pf-name-row { padding-right: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .pf-card, .fr-card, .pf-row, .fr-row, .fr-dot.is-on::after,
  .fr-hud-badge, .fr-empty-art { animation: none; }
}
`;

/** Injects the shared pf-/fr- stylesheet once. Safe to call repeatedly. */
export function ensureSocialStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// 3D turntable (same recipe as the wardrobe mirror, smaller stage)
// ---------------------------------------------------------------------------

const PREVIEW_W = 200;
const PREVIEW_H = 232;

function buildTurntable(canvas, look) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(PREVIEW_W, PREVIEW_H, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, PREVIEW_W / PREVIEW_H, 0.1, 40);
  camera.position.set(0, 1.28, 3.6);
  camera.lookAt(0, 0.9, 0);

  scene.add(new THREE.HemisphereLight(0xfff3da, 0x8a6642, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2.4, 4.2, 3.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fd4ff, 0.45);
  rim.position.set(-3, 1.8, -2.6);
  scene.add(rim);

  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.92, 0.16, 20), makeToon(0xf0dca0));
  ped.position.y = -0.08;
  scene.add(ped);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.03, 8, 26), makeGlow(0xf2b64a));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  scene.add(ring);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const avatar = createAvatar({ color: look.color, hat: look.hat });
  turntable.add(avatar.group);
  avatar.playWave(); // say hello the moment the card opens

  let raf = 0;
  let last = 0;
  let punch = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    punch *= Math.exp(-dt * 5);
    turntable.rotation.y += dt * 0.5;
    avatar.update(dt);
    avatar.group.scale.setScalar(1 + punch * 0.12);
    ring.scale.setScalar(1 + punch * 0.1);
    renderer.render(scene, camera);
  }

  return {
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    setLook(color, hat) {
      if (color != null && color !== avatar.state.color) avatar.setColor(color);
      if (hat != null && hat !== avatar.state.hat) {
        const stale = avatar.hatAnchor.children.slice();
        avatar.setHat(hat);
        for (const o of stale) disposeObject(o);
      }
    },
    celebrate() { punch = 0.9; avatar.playWave(); },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      disposeObject(scene); // frees geometry; shared avatar/toon resources survive
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* not every context supports it */ }
    },
  };
}

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

let openInstance = null;

function elm(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function mountPoint() {
  return document.getElementById('hud-root')
    || document.getElementById('overlay-root')
    || document.body;
}

/** Everything the net client already knows about this capybara, right now. */
function localLook(game, playerId) {
  const r = game.net?.remotes?.get?.(playerId);
  const p = r?.p;
  if (!p) return null;
  return {
    name: typeof p.name === 'string' ? p.name : null,
    color: Number.isFinite(Number(p.color)) ? Number(p.color) : null,
    hat: typeof p.hat === 'string' && Object.prototype.hasOwnProperty.call(HATS, p.hat) ? p.hat : null,
    bot: !!p.bot,
  };
}

/**
 * Open the player card for a remote player id.
 * Re-opening for the same player is a no-op; a different player swaps cards.
 */
export function openProfile(game, playerId) {
  if (typeof document === 'undefined' || playerId == null) return;
  const id = String(playerId);
  if (openInstance) {
    if (openInstance.id === id) return;
    openInstance.close(true);
  }
  ensureSocialStyles();

  const isSelf = game.net?.selfId != null && String(game.net.selfId) === id;
  const local = localLook(game, id);

  // what we believe about them; profile-data overwrites the parts it knows
  const who = {
    id,
    name: isSelf ? game.state.name : (local?.name || null),
    color: isSelf ? game.state.color : (local?.color ?? null),
    hat: isSelf ? game.state.hat : (local?.hat ?? null),
    bot: !isSelf && !!local?.bot,
    registered: isSelf ? !!game.state.registered : null,
    room: isSelf ? game.roomId : (local ? game.roomId : null),
    online: isSelf ? true : (local ? true : null),
    bests: isSelf ? game.state.bests || {} : {},
    isFriend: null,
    loaded: isSelf,
  };

  const root = elm('div', 'pf-overlay');
  root.innerHTML = `
    <div class="pf-card" role="dialog" aria-label="Player card" tabindex="-1">
      <button class="hud-btn pf-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="pf-body">
        <div class="pf-stage">
          <div class="pf-stage-frame">
            <canvas class="pf-canvas"></canvas>
            <div class="pf-shine"></div>
          </div>
          <div class="pf-outfit"><span class="pf-dot-color"></span><span class="pf-outfit-txt"></span></div>
        </div>
        <div class="pf-info">
          <div>
            <div class="pf-name-row"><span class="pf-name"></span></div>
            <div class="pf-title"></div>
          </div>
          <div class="pf-where"></div>
          <div class="pf-section">Achievements</div>
          <div class="pf-medals"></div>
          <div class="pf-actions"></div>
        </div>
      </div>
    </div>
  `;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const card = q('.pf-card');
  const nameRow = q('.pf-name-row');
  const nameEl = q('.pf-name');
  const titleEl = q('.pf-title');
  const whereEl = q('.pf-where');
  const medalsEl = q('.pf-medals');
  const actionsEl = q('.pf-actions');
  const outfitDot = q('.pf-dot-color');
  const outfitTxt = q('.pf-outfit-txt');
  const canvas = q('.pf-canvas');

  // ---- 3D stage ------------------------------------------------------------
  let stage = null;
  try {
    stage = buildTurntable(canvas, { color: who.color ?? 0xb08a5a, hat: who.hat ?? 'none' });
    stage.start();
  } catch {
    canvas.remove();
    q('.pf-stage-frame').appendChild(
      elm('div', 'pf-fallback', 'Their portrait is still drying, but the numbers below are real.'),
    );
  }

  // ---- render --------------------------------------------------------------
  function renderHead() {
    nameEl.textContent = who.name || 'Someone friendly';
    for (const chip of [...nameRow.querySelectorAll('.pf-chip')]) chip.remove();
    if (isSelf) nameRow.appendChild(elm('span', 'pf-chip is-self', 'You'));
    else if (who.bot) nameRow.appendChild(elm('span', 'pf-chip', 'Cove local'));
    else if (who.isFriend) nameRow.appendChild(elm('span', 'pf-chip is-friend', 'Friend'));
    titleEl.textContent = flavorTitle(who.bests, who.bot, isSelf);

    const roomName = who.room && Object.prototype.hasOwnProperty.call(ROOM_INFO, who.room)
      ? ROOM_INFO[who.room].name : null;
    whereEl.textContent = '';
    if (roomName) {
      whereEl.appendChild(elm('span', null, 'Hanging out in '));
      whereEl.appendChild(elm('b', null, roomName));
    } else if (who.online === false) {
      whereEl.textContent = 'Off exploring somewhere else right now.';
    } else if (who.loaded) {
      whereEl.textContent = 'Somewhere around the cove.';
    } else {
      whereEl.textContent = 'Looking them up...';
    }

    const c = who.color ?? 0xb08a5a;
    outfitDot.style.background = `#${(c >>> 0).toString(16).padStart(6, '0')}`;
    const hatName = who.hat && who.hat !== 'none' ? HATS[who.hat]?.name : null;
    outfitTxt.textContent = hatName ? `Wearing the ${hatName}` : 'No hat, all confidence';
  }

  function renderMedals() {
    medalsEl.textContent = '';
    Object.keys(MEDAL_TIERS).forEach((gid, i) => {
      const meta = Object.prototype.hasOwnProperty.call(MINIGAMES, gid) ? MINIGAMES[gid] : null;
      const best = bestOf(who.bests, gid);
      const tier = medalTier(gid, best);
      const next = nextCut(gid, best);

      const row = elm('div', 'pf-row');
      row.style.setProperty('--i', String(i));
      row.title = MEDAL_BLURB[gid] || meta?.name || gid;
      const medal = elm('div', `pf-medal ${TIER_CLASS[tier]}`);
      medal.title = `${TIER_LABEL[tier]}${next != null ? ` : ${next} for the next one` : ' : maxed out'}`;
      const txt = elm('div', 'pf-row-txt');
      txt.appendChild(elm('div', 'pf-row-name', meta?.name || gid));
      txt.appendChild(elm('div', 'pf-row-sub', medalSub(best, tier, next)));
      const score = elm('div', `pf-row-score${best == null ? ' is-empty' : ''}`, best == null ? '-' : String(best));
      row.append(medal, txt, score);
      medalsEl.appendChild(row);
    });
  }

  function note(text) {
    const n = elm('div', 'pf-note', text);
    n.title = text;
    return n;
  }

  let busy = false;

  function renderActions() {
    actionsEl.textContent = '';
    if (isSelf) {
      actionsEl.appendChild(note('This is you. Looking good out there.'));
      return;
    }
    if (who.bot) return; // bots keep no address book, and that is fine
    if (!who.loaded) {
      if (!game.net?.connected) {
        actionsEl.appendChild(note('Friends need a connection to the cove. Yours will come back on its own.'));
        return;
      }
      const b = elm('button', 'pf-fbtn', 'Checking...');
      b.type = 'button';
      b.disabled = true;
      actionsEl.appendChild(b);
      return;
    }
    if (!game.state.registered) {
      actionsEl.appendChild(note('Friends stick around only with an account. Make one from the title screen and you can keep them.'));
      return;
    }
    if (who.registered === false) {
      actionsEl.appendChild(note(`${who.name || 'They'} is visiting as a guest, so there is nobody to add yet. Say hi instead.`));
      return;
    }

    const isFriend = who.isFriend === true;
    const b = elm('button', `pf-fbtn${isFriend ? ' is-remove' : ''}`, isFriend ? 'Remove friend' : 'Add friend');
    b.type = 'button';
    b.disabled = busy || !game.net?.connected;
    b.title = isFriend
      ? `Take ${who.name || 'them'} off your friends list`
      : `Add ${who.name || 'them'} to your friends list`;
    b.addEventListener('click', () => toggleFriend(isFriend));
    actionsEl.appendChild(b);
    if (!game.net?.connected) actionsEl.appendChild(note('Offline right now, so the friend book is closed.'));
  }

  function toggleFriend(wasFriend) {
    if (busy || !game.net?.connected) return;
    busy = true;
    who.isFriend = !wasFriend;
    // both keys: the server resolves the connection id, and falls back to the
    // account name if that session has already gone (see friendTarget())
    game.net.send({ t: wasFriend ? 'friend-remove' : 'friend-add', id: who.id, name: who.name || undefined });
    game.net.send({ t: 'friends' });
    game.audio?.play?.(wasFriend ? 'click' : 'success');
    game.toast(wasFriend
      ? `${who.name || 'They'} left your friends list. No hard feelings.`
      : `${who.name || 'They'} is on your friends list now!`);
    if (!wasFriend) stage?.celebrate();
    renderHead();
    renderActions();
    // the server has the last word; unlock once it answers (or shortly after)
    setTimeout(() => { busy = false; renderActions(); }, 700);
  }

  function renderAll() {
    renderHead();
    renderMedals();
    renderActions();
  }

  renderAll();

  // ---- live data -----------------------------------------------------------
  const unsubs = [
    game.events.on('profile-data', (payload, extra) => {
      // tolerate both emit(payload) and emit(id, payload)
      const keyed = extra && typeof extra === 'object'
        && (typeof payload === 'string' || typeof payload === 'number');
      const raw = keyed ? { id: payload, ...extra } : payload;
      const p = normalizeProfile(raw);
      if (!p) return;
      if (p.id != null && p.id !== who.id) return; // someone else's card
      if (p.name) who.name = p.name;
      if (p.color != null) who.color = p.color;
      if (p.hat != null) who.hat = p.hat;
      if (p.bot) who.bot = true;
      if (p.registered != null) who.registered = p.registered;
      if (p.room != null) who.room = p.room;
      if (p.online != null) who.online = p.online;
      if (p.isFriend != null) who.isFriend = p.isFriend;
      who.bests = { ...who.bests, ...p.bests };
      who.loaded = true;
      stage?.setLook(who.color, who.hat);
      renderAll();
    }),
    game.events.on('friends-data', (payload) => {
      if (isSelf || who.bot) return;
      const list = normalizeFriends(payload);
      // an offline friend has no connection id, so the name is the only key left
      who.isFriend = list.some((f) => (f.id != null && f.id === who.id)
        || (!!who.name && f.name === who.name));
      busy = false;
      renderHead();
      renderActions();
    }),
  ];

  // ask the server for the real record (bests, account status, friendship)
  if (!isSelf) {
    game.net?.send?.({ t: 'inspect', id: who.id });
    if (game.state.registered) game.net?.send?.({ t: 'friends' });
  }
  // never leave the card stuck on "Checking..."
  const settle = setTimeout(() => {
    if (who.loaded) return;
    who.loaded = true;
    renderAll();
  }, 5000);

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close(silent = false) {
    if (closed) return;
    closed = true;
    if (openInstance?.id === id) openInstance = null;
    clearTimeout(settle);
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    try { stage?.dispose(); } catch { /* context may already be lost */ }
    stage = null;
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    if (!silent) game.audio?.play?.('click');
  }

  function onBackdrop(e) { if (e.target === root) close(); }
  function onKey(e) {
    // the card owns the keyboard while it is up (no walking off mid-chat)
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.pf-x').addEventListener('click', () => close());
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('whoosh');

  openInstance = { id, close };
}
