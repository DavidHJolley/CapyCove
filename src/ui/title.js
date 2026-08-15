import { BODY_COLORS, GAME_NAME, NAME_MAX_LEN, NAME_MIN_LEN } from '../../shared/constants.js';
import { mountLegalFooter, showRecoveryCodes, SUPPORT_CONTACT } from './legal.js';

/**
 * Title / auth screen. Calls onEnter({token, guestName}) once the player is in.
 *
 * Auth endpoints, all POST, all answering {ok, ...} or {ok:false, msg}:
 *   /api/signup   {username, password, color, hat}
 *                 -> {ok, token, profile, recoveryCodes:string[]}   REQUIRED
 *   /api/login    {username, password}
 *                 -> {ok, token, profile, mustReset?, noRecovery?}  REQUIRED
 *   /api/recover  {username, code, newPassword}
 *                 -> {ok, token, profile, remaining}                OPTIONAL
 *   /api/recovery {username, password}
 *                 -> {ok, codes:string[]}                           OPTIONAL
 *
 * The two OPTIONAL routes are wave 10E contract requests against
 * server/index.js (orchestrator-owned); server/auth.js already exports
 * `recover()` and `issueRecoveryCodes()` for them. Until they exist this file
 * degrades quietly: a missing route answers with the SPA's index.html, the JSON
 * parse throws, and the player is told to ask a human instead of being stuck.
 *
 * Wave 10E (N-15, N-08 client half) adds, and nothing else:
 *   * the Privacy / Terms footer, which opens src/ui/legal.js as an overlay
 *   * the recovery-code reveal card after signup, gated on "I have written
 *     these down" -- entry into the world waits on that checkbox
 *   * a "Lost your password?" path that spends a code, because a reveal card
 *     for codes that can never be redeemed is a lie
 * There is NO age gate here: owner decision, 2026-08-14. Do not add one back
 * without the owner asking for it.
 */
export function showTitle(game, onEnter) {
  const root = document.getElementById('overlay-root');
  const el = document.createElement('div');
  el.className = 'title-screen';
  el.innerHTML = `
    <div class="title-card">
      <div class="title-logo">${GAME_NAME}</div>
      <div class="title-tag">splash in * hang out * play</div>
      <div class="title-tabs">
        <button class="tab on" data-tab="guest">Play now</button>
        <button class="tab" data-tab="login">Log in</button>
        <button class="tab" data-tab="signup">Sign up</button>
      </div>
      <form id="title-form">
        <input id="t-name" placeholder="Pick a nickname" maxlength="${NAME_MAX_LEN}" autocomplete="username" />
        <input id="t-code" placeholder="Recovery code (CAPY-otter-lantern-742)" autocomplete="one-time-code" maxlength="48" class="hidden" />
        <input id="t-pass" type="password" placeholder="Password" autocomplete="current-password" class="hidden" />
        <div class="swatches" id="t-colors"></div>
        <div class="title-err hidden" id="t-err"></div>
        <button type="submit" class="mg-btn" id="t-go">Waddle in</button>
      </form>
      <div class="title-note" id="t-note">Guests play with emotes and the phrase menu, and keep progress on this device only. An account unlocks full chat and carries your coins and hats anywhere.</div>
      <div class="title-note hidden" id="t-lost"><button type="button" class="lg-link" id="t-lost-btn">Lost your password?</button></div>
    </div>`;
  root.appendChild(el);

  // N-15: the policy pages are one click from the first screen anyone sees, and
  // the consent sentence carries the whole gate now that there is no age screen
  // and no checkbox. legal.js injects its own <style>, so nothing here needs
  // src/styles.css (which no wave-10 agent owns).
  mountLegalFooter(el.querySelector('.title-card'));

  let mode = 'guest';
  let entered = false; // finish() must never run twice: it opens a second socket
  let busy = false;
  let color = BODY_COLORS[Math.floor(Math.random() * BODY_COLORS.length)];
  const goBtn = el.querySelector('#t-go');

  const colorsEl = el.querySelector('#t-colors');
  for (const c of BODY_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch${c === color ? ' on' : ''}`;
    b.style.background = `#${c.toString(16).padStart(6, '0')}`;
    b.onclick = () => {
      color = c;
      colorsEl.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
      b.classList.add('on');
      game.setColor(c);
    };
    colorsEl.appendChild(b);
  }

  const err = (msg) => {
    const e = el.querySelector('#t-err');
    e.textContent = msg;
    e.classList.toggle('hidden', !msg);
  };

  // Four modes over one form: guest, login, signup, and 'recover' (spend a
  // recovery code and pick a new password). Recover has no tab of its own -- it
  // is a link under the login form, because it is the rarest path in the game
  // and a fourth chip would crowd the three that matter.
  const passEl = el.querySelector('#t-pass');
  const codeEl = el.querySelector('#t-code');
  const noteEl = el.querySelector('#t-note');
  const lostEl = el.querySelector('#t-lost');
  const GUEST_NOTE = noteEl.textContent;

  function setMode(m) {
    mode = m;
    const tabFor = m === 'recover' ? 'login' : m;
    el.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.dataset.tab === tabFor));
    passEl.classList.toggle('hidden', m === 'guest');
    passEl.placeholder = m === 'guest' ? 'Password' : m === 'login' ? 'Password' : 'New password';
    passEl.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    codeEl.classList.toggle('hidden', m !== 'recover');
    lostEl.classList.toggle('hidden', m !== 'login');
    goBtn.textContent = m === 'signup' ? 'Create account'
      : m === 'login' ? 'Log in'
        : m === 'recover' ? 'Set a new password' : 'Waddle in';
    noteEl.textContent = m === 'recover'
      ? `Type one of the recovery codes you wrote down at signup. Each works once. If they are gone too, ask ${SUPPORT_CONTACT}.`
      : GUEST_NOTE;
    err('');
  }

  el.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setMode(t.dataset.tab); });
  el.querySelector('#t-lost-btn').onclick = () => setMode('recover');

  el.querySelector('#title-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (entered || busy) return; // double click / held Enter
    const raw = el.querySelector('#t-name').value.trim();
    const pass = passEl.value;
    // Match the server's own name cleaning (server/index.js cleanName), which is
    // ASCII-only: a nickname that survives here but not there gets silently
    // denied and leaves the player alone in the world with no explanation.
    const name = raw.replace(/[^\w \-]/g, '').trim();
    if (name.length < NAME_MIN_LEN) {
      return err(`Name needs at least ${NAME_MIN_LEN} letters, numbers or _`);
    }

    game.state.color = color;
    if (mode === 'guest') {
      game.state.name = name;
      finish({ guestName: name });
      return;
    }
    if (pass.length < 6) return err('Password needs at least 6 characters');
    if (mode === 'recover' && !codeEl.value.trim()) return err('Type one of your recovery codes');
    busy = true;
    goBtn.disabled = true;
    try {
      const body = mode === 'recover'
        ? { username: name, code: codeEl.value.trim(), newPassword: pass }
        : { username: name, password: pass, color, hat: game.state.hat };
      const res = await fetch(`/api/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) return err(data.msg || 'That did not work, try again');

      // An operator reset this account out of band: the password just typed is
      // no longer the way in, so route the player at the code they were given
      // rather than letting them into the world half-authorised. Nothing is
      // persisted here -- storing the token would let the next page load walk
      // straight past the reset via /api/me.
      if (mode === 'login' && data.mustReset) {
        setMode('recover');
        return err('This account was reset. Enter the code you were given and pick a new password.');
      }

      try { localStorage.setItem('capycove-token', data.token); } catch {}
      game.applyProfile({ ...data.profile, registered: true });

      // THE GATE. `recoveryCodes` exists exactly once, in the signup response
      // (server/auth.js signup()), and this is the only place it is ever shown.
      // Entering the world waits on the checkbox: awaiting here is the whole
      // point of the feature.
      if (Array.isArray(data.recoveryCodes) && data.recoveryCodes.length) {
        await showRecoveryCodes({ codes: data.recoveryCodes, username: name, mount: el });
      } else if (mode === 'login' && data.noRecovery) {
        // Pre-wave-9 account, or one that has spent all eight. Mint a set with
        // the password already in hand. Optional route: if it is not wired up
        // yet the player simply goes straight in, exactly as before.
        const codes = await mintRecoveryCodes(name, pass);
        if (codes) await showRecoveryCodes({ codes, username: name, mount: el, reissued: true });
      } else if (mode === 'recover') {
        // A toast emitted now would be shouted into an empty room: the HUD's
        // listener is not installed until enterWorld runs, which is inside
        // onEnter. Hand it over a beat later, where main.js's toast holder
        // catches it and releases it after the arrival swoop.
        const left = Number(data.remaining);
        const msg = Number.isFinite(left)
          ? `Password changed. ${left} recovery ${left === 1 ? 'code' : 'codes'} left.`
          : 'Password changed.';
        setTimeout(() => game.toast?.(msg, 4600), 800);
      }
      finish({ token: data.token });
    } catch {
      err(mode === 'recover'
        ? `Recovery is not available right now. Ask ${SUPPORT_CONTACT}.`
        : 'Server unreachable. Try "Play now" for offline mode.');
    } finally {
      busy = false;
      goBtn.disabled = entered; // a failed login can be retried
    }
  });

  /** POST /api/recovery, the optional re-issue route. Returns the codes, or
   *  null for every failure including "the route does not exist yet". Never
   *  blocks entry into the world and never surfaces an error: an account with
   *  no recovery codes is exactly as playable as one with eight. */
  async function mintRecoveryCodes(username, password) {
    try {
      const res = await fetch('/api/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      return data?.ok && Array.isArray(data.codes) && data.codes.length ? data.codes : null;
    } catch {
      return null; // no such route: the SPA catch-all answers with HTML
    }
  }

  function finish(auth) {
    if (entered) return;
    entered = true;
    goBtn.disabled = true;
    // 0.3s press-confirm (squash -> pop + gold glow) before the fade, so the
    // handoff into the arrival swoop reads as an authored beat, not a cut.
    // WAAPI keeps this self-contained; if it is unavailable, fall through now.
    let delay = 0;
    try {
      goBtn.animate([
        { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(242, 182, 74, 0)' },
        { transform: 'scale(0.9)', boxShadow: '0 0 18px 4px rgba(242, 182, 74, 0.9)', offset: 0.35 },
        { transform: 'scale(1.12)', boxShadow: '0 0 30px 8px rgba(242, 182, 74, 0.95)', offset: 0.7 },
        { transform: 'scale(1.04)', boxShadow: '0 0 22px 6px rgba(242, 182, 74, 0.55)' },
      ], { duration: 300, easing: 'cubic-bezier(0.2, 1.35, 0.4, 1)', fill: 'forwards' });
      delay = 300;
    } catch { /* no WAAPI: skip straight to the fade */ }
    setTimeout(() => {
      el.classList.add('fade-out');
      setTimeout(() => el.remove(), 450);
      onEnter(auth);
    }, delay);
  }
}
