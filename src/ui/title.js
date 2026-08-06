import { BODY_COLORS, GAME_NAME, NAME_MAX_LEN, NAME_MIN_LEN } from '../../shared/constants.js';

/**
 * Title / auth screen. Calls onEnter({token, guestName}) once the player is in.
 * Auth endpoints: POST /api/signup, /api/login with {username, password}.
 * Both return {ok, token, profile} or {ok:false, msg}.
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
        <input id="t-pass" type="password" placeholder="Password" autocomplete="current-password" class="hidden" />
        <div class="swatches" id="t-colors"></div>
        <div class="title-err hidden" id="t-err"></div>
        <button type="submit" class="mg-btn" id="t-go">Waddle in</button>
      </form>
      <div class="title-note">Guests keep progress on this device. Sign up to keep coins and hats anywhere.</div>
    </div>`;
  root.appendChild(el);

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

  el.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      mode = t.dataset.tab;
      el.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      el.querySelector('#t-pass').classList.toggle('hidden', mode === 'guest');
      el.querySelector('#t-go').textContent = mode === 'signup' ? 'Create account' : mode === 'login' ? 'Log in' : 'Waddle in';
      err('');
    };
  });

  el.querySelector('#title-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (entered || busy) return; // double click / held Enter
    const raw = el.querySelector('#t-name').value.trim();
    const pass = el.querySelector('#t-pass').value;
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
    busy = true;
    goBtn.disabled = true;
    try {
      const res = await fetch(`/api/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password: pass, color, hat: game.state.hat }),
      });
      const data = await res.json();
      if (!data.ok) return err(data.msg || 'That did not work, try again');
      try { localStorage.setItem('capycove-token', data.token); } catch {}
      game.applyProfile({ ...data.profile, registered: true });
      finish({ token: data.token });
    } catch {
      err('Server unreachable. Try "Play now" for offline mode.');
    } finally {
      busy = false;
      goBtn.disabled = entered; // a failed login can be retried
    }
  });

  function finish(auth) {
    if (entered) return;
    entered = true;
    goBtn.disabled = true;
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 450);
    onEnter(auth);
  }
}
