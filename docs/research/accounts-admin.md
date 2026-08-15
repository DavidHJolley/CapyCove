# Capy Cove: accounts, roles and administration

**Author:** platform designer (research pass, 2026-08-14)
**Status:** specification. Nothing here is implemented; no file outside this one was touched.
**Reads:** `server/auth.js`, `server/db.js`, `server/index.js`, `server/progress.js`, `shared/constants.js`, `src/main.js`, `src/net/client.js`, `src/core/game.js`, `src/ui/title.js`, `docs/AUDIT.md`.
**Scope:** the service layer — who someone *is*, what they are *allowed to do*, how an operator sees and changes it, and how any of it survives a restart. The trust & safety **policy** layer (chat filter, report button UX, age gate, block lists) is tasked separately (AUDIT F-21..F-26); this document specifies the **machinery** those features will call into, and marks the seams.

Every recommendation below is either grounded in a file:line citation or explicitly marked **[judgment]**.

---

## 0. The one-paragraph version

Capy Cove has accounts but no *account system*. A record is a bare object in a `Map` keyed by its own lowercase username (`server/db.js:101`), there is no identifier that survives a rename, no role field, no revocation, no recovery, no deletion, no audit trail, and the only administrative surface in the product is a regex on a display name (`src/main.js:183`). Everything an operator will need on day one — see who is online, mute someone, take a crown back, undo a mural raid, find out what happened last night — currently requires SSH and a text editor. This spec adds: an immutable `uid`, a `role` field with a server-side capability gate, a `server/admin.js` module that plugs into the existing first-refusal message hook (`server/index.js:2178`), an `a-*` protocol family, a self-contained `/admin` web panel with its own session auth, recovery codes plus owner-assisted reset (no email infrastructure anywhere), an append-only hash-chained audit log, and a `server/store.js` seam that makes the eventual SQLite move a one-file change instead of a rewrite.

Sizing, using the audit's scale (**S** ≤ 2 days, **M** ≤ 2 weeks): phase 1 (roles + in-game mod ops + audit log) is **M**; phase 2 (the web panel) is **M**; phase 3 (lifecycle: recovery, deletion, rename) is **M**; phase 4 (SQLite) is **M** and should not start until a trigger fires (§6.5).

---

## 1. The foundational problem: the record has no identity

This is the finding that constrains everything else, and the audit does not name it.

```js
export const users = new Map(); // usernameLower -> record          server/db.js:101
```

The account's *primary key is its display name*, and that key is copied by value into every cross-account reference in the game:

| Reference | Stored as | Site |
|---|---|---|
| Friend lists | lowercase username strings | `server/db.js:25-37` (`ensureFriends`, `normalizeFriends`) |
| Den guest lists | lowercase username strings | `server/db.js:42,89` (`HOUSE_INVITE_CAP`, `normalizeHouse`) |
| Den room ids | `house:<usernameLower>` | `server/index.js:510-517` |
| Session tokens | `HMAC(username.expiry)` | `server/auth.js:13-18` |
| Party host identity | `p.username.toLowerCase()` | `server/index.js:1727` |
| Mural attribution | `by: p.name` (display name) | `server/index.js:2020,2023` |
| Mural cooldown ledger | account key | `server/index.js:2012-2018` |

Consequences, all of which land on this spec's desk:

1. **Rename is a cross-record migration**, not a field write. Renaming `mango` → `mangolord` orphans every friend list containing `mango`, every den invite, and any live `house:mango` room set.
2. **Deletion is worse.** Deleting the key leaves dangling names in other people's friends lists (`friendsPayload` already degrades gracefully — `server/index.js:487-491` falls back to the raw key — but the name is now free for anyone to claim and *impersonate*).
3. **Ban cannot be expressed durably against an identity** that the banned player can change by making a new account with a similar name; there is nothing stable to correlate.
4. **The audit log would be unreadable in six months**, because every entry would name an account by a string that may since have been reassigned to a different human.

**Fix, phase 1, cheap:** add an immutable `uid` at signup and to every existing record at load. Format: `u_` + 16 hex chars from `crypto.randomBytes(8)` — short enough to eyeball in a log line, wide enough not to collide.

```js
// server/db.js, in the load loop at :102-110 (backfill) and server/auth.js signup()
rec.uid ||= 'u_' + crypto.randomBytes(8).toString('hex');
```

**Rule from here on: every NEW subsystem references accounts by `uid` only.** Bans, mutes, audit entries, reports, chat retention, coin adjustments, mural attribution. The legacy name-keyed references (friends, invites, den room ids) stay as they are and get swept on rename (§5.4) until the SQLite migration normalises them (§6.4). Do not attempt a big-bang re-key of the flat file; it is not worth the risk, and SQLite makes it free.

Also add at the same time, because everything in §3 and §7 wants them and none exist today:

| Field | Type | Why |
|---|---|---|
| `uid` | string | above |
| `role` | `'player' \| 'mod' \| 'admin'` | §2 |
| `tokenV` | integer, starts 1 | revocation (§5.5) |
| `lastSeen` | ms epoch | account search, dormancy, purge |
| `lastIp` | HMAC-hashed, see §3.6 | abuse correlation without storing IPs |
| `mute` | `{until, by, reason} \| null` | §3.2 |
| `ban` | `{until, by, reason, at} \| null` | `until: 0` = permanent |
| `recovery` | `{salt, hash, issuedAt, usedAt}` | §5.1 |
| `deletedAt` | ms epoch or null | §5.3 tombstone |
| `renamedAt` | ms epoch | rename cooldown (§5.4) |

All optional-by-absence, all backfilled lazily, matching the existing `ensureFriends`/`ensureHouse` idiom (`server/db.js:25,53`) which already handles "records written before this field existed". Follow that idiom exactly — write `ensureAccount(rec)` in `db.js` and call it from the load loop and from `signup()`.

---

## 2. Roles

### 2.1 Model

One field, `rec.role`, one of three ordered values. **Not booleans.** `isAdmin`/`isMod`/`isHelper` booleans multiply combinatorially and every call site then has to know the precedence; an ordered enum has exactly one comparison:

```js
// server/admin.js
const RANK = { player: 0, mod: 1, admin: 2 };
export const rankOf = (rec) => RANK[rec?.role] ?? 0;
export const atLeast = (p, role) => rankOf(recordFor(p)) >= RANK[role];
```

Guests (`p.registered === false`, `server/index.js:2217`) are permanently rank 0 and can never be otherwise: there is no record to hold the flag. That is a feature — it means a stolen guest session can never be privileged.

### 2.2 Capability matrix

| Capability | player | mod | admin | Notes |
|---|:-:|:-:|:-:|:-:|
| Play, chat, buy, build | ● | ● | ● | |
| See mod badge on other mods | ● | ● | ● | deterrence is the point |
| `a-who` (live player list, rooms) | | ● | ● | |
| `a-inspect` (full account view) | | ● | ● | coins, bests, ban/mute state, recent chat |
| `a-warn` (in-game warning card) | | ● | ● | |
| `a-mute` / `a-unmute` (≤ 24 h) | | ● | ● | mod capped at 24 h; admin unbounded |
| `a-kick` | | ● | ● | disconnect, no state change |
| `a-tp` (teleport self to player) | | ● | ● | |
| `a-summon` (teleport player to me) | | | ● | moving someone else's body is admin-only **[judgment]** |
| `a-ban` (temporary, ≤ 7 days) | | ● | ● | mod capped at 7 days |
| `a-ban` (permanent) | | | ● | |
| `a-unban` | | | ● | reversing another mod's call is a supervisor act |
| `a-say` (room announcement) | | ● | ● | |
| `a-say` (island-wide) | | | ● | |
| `a-mural-clear` / `a-mural-revert` | | ● | ● | revert-by-account is the useful one (§3.4) |
| `a-coins` (adjust balance) | | | ● | always audited, always reason-required |
| `a-role` (grant/revoke mod) | | | ● | cannot grant `admin`; see §2.5 |
| `a-rename` (forced) | | | ● | offensive names |
| `a-reset` (issue recovery token) | | | ● | §5.2 |
| `a-purge` (force-delete account) | | | ● | §5.3 |
| Web panel `/admin` login | | ● | ● | panel shows only what the role may do |
| Layout editor (Ctrl+E) | | | ● | replaces `src/main.js:183` |

**[judgment]** Mods get destructive-but-reversible powers and time-boxed bans; admins get irreversible and economic powers. The split exists so that "trusted community member" is a role you can actually hand out. If the cove never grows past one operator, `mod` costs nothing to carry.

### 2.3 How the client learns its role

Through the existing welcome frame, which already carries the profile (`server/index.js:2235`) and is already the thing `game.applyProfile` consumes (`src/net/client.js:129`). Add to `publicProfile()` (`server/auth.js:36-53`):

```js
role: rec.role === 'mod' || rec.role === 'admin' ? rec.role : 'player',
```

`publicProfile` is used in three places — signup/login responses (`auth.js:75,86`), `/api/me` (`index.js:204`), and hello (`index.js:2188`) — all of which are "this is *you*". It is **not** used by `inspect` (`index.js:2377-2389`, which builds its own object), so adding `role` here does not leak anyone's role to anyone else. Good.

Welcome frame gains three fields:

```jsonc
{ "t":"welcome", "id":"p7", "profile": {
    "...": "existing fields",
    "role": "mod",            // 'player' | 'mod' | 'admin'
    "muteUntil": 0,           // ms epoch, 0 = not muted; the HUD greys the chat box
    "caps": ["who","warn","mute","kick","tp","say-room","mural"]  // see below
}}
```

**Ship `caps` as well as `role`.** It costs ~60 bytes once per session and it means the client never hard-codes the matrix in §2.2; when mods gain a power the client does not need redeploying to show the button. The server derives `caps` from `role` in exactly one function, and that same function is the gate on every op (§3.1) — so the UI can never offer a button the server will refuse, and vice versa.

### 2.4 How the client gates UI

Three gates, all cosmetic; **the server is the only authority**.

1. **`src/main.js:183` — delete `isAdmin()` outright.** Replace with `game.state.caps?.includes('editor')`, gated on the `editor` cap (admin-only). This closes the deployment blocker at `CLAUDE.md:141-153` and task #13 with the mechanism the blocker note itself asks for.
2. **New `src/ui/admin.js`** (own file, own owner, lifecycle copied from `src/ui/quests.js:440,462-466` which does teardown correctly): the in-game mod panel, opened with `Ctrl+Shift+A`, lazy-imported only when `caps` is non-empty. Vite will emit it as its own chunk; the chunk existing on the CDN is harmless because every op is re-authorised server-side.
3. **`src/ui/profile.js`** gains a "Moderate" section on the player card when `caps` allows — Warn / Mute / Kick / Ban / Inspect — sitting alongside the existing Message / Add friend / Visit den row (`src/ui/profile.js:1448-1506`). This is the ergonomic win: moderation happens *where you already clicked the player*, not in a separate console. **[judgment]** This is how Club Penguin moderators actually worked and it is why they were fast.

Plus a world badge: `snapshotFor` (`server/index.js:239-255`) gains `if (p.mod) snap.mod = 1` using the same "only present on the handful of accounts that have it" reasoning already written for `title` at `index.js:250-253`. `src/net/client.js` renders it as a small shield next to the name tag, reusing `addTagTitle`'s pattern (`client.js:16-24`). **[judgment]** Visible authority prevents more incidents than invisible authority catches. Give admins a `stealth` toggle (`a-stealth`) that suppresses the flag when they want to observe.

### 2.5 Bootstrapping the first admin

Chicken-and-egg: no admin exists to promote the first admin, and a flag hand-edited into `users.json` will be lost by the first bad write (AUDIT F-1).

**Use an environment variable, applied idempotently at boot:**

```js
// server/index.js, after db load
const seed = String(process.env.COVE_ADMIN || '').toLowerCase();
if (seed) {
  const rec = users.get(seed);
  if (rec && rec.role !== 'admin') { rec.role = 'admin'; saveSoon(); audit('role.seed', null, rec, { role: 'admin' }); }
  else if (!rec) console.warn(`[admin] COVE_ADMIN=${seed} has no account yet`);
}
```

Properties: survives a database restore, is visible in the host's config UI (Fly secrets / Render env), cannot be set by anyone without deploy access, and is logged every time it fires. `a-role` then promotes everyone else. **Never** add a `/api/claim-admin` endpoint, and never gate on a name pattern again.

---

## 3. Administration in-game

### 3.1 Where the code goes

**`server/admin.js`, a new module following the `server/progress.js` contract exactly.** That contract is already proven and already wired:

```js
if (p && progress.handleMessage(p, m)) return;   // server/index.js:2178
```

`progress.js`'s header (`server/progress.js:6-11`) documents the shape: `install(ctx)` once at boot, `handleMessage(p, m)` gets first refusal on every frame and returns `true` to consume it. `admin.js` uses the same shape and `server/index.js` changes by **one line**:

```js
if (p && admin.handleMessage(p, m)) return;      // BEFORE the progress call
if (p && progress.handleMessage(p, m)) return;
```

Admin must be first because it does two jobs in that hook:

1. **Claim every `a-*` frame** (§3.3).
2. **Enforce mutes and bans on frames it does not own.** A muted player's `chat` / `whisper` / `mural` / `dd-guess` / `ph-msg` frame is consumed by `admin.handleMessage` — it returns `true` after sending the player a private "you are muted until …" notice — and never reaches index.js's handler at all. **This is the single most valuable structural property of the design: mute enforcement requires zero edits to any of the ~60 existing message handlers**, which is exactly the kind of change that breaks a 2,877-line switch statement.

`install(ctx)` needs from index.js: `{ users, saveSoon, sendTo, broadcastToRoom, broadcastAll, sessionsFor, recordFor, findEntity, world, grantCoins, joinRoom, mural, has }`. All exist today (`index.js:257,261,272,459,371,446,233,400,308,1910`) — none are currently exported, so index.js gains an `admin.install({...})` call listing them, mirroring `progress.install` at `index.js:418`.

### 3.2 Enforcement semantics

| State | Effect | Where enforced |
|---|---|---|
| **muted** | `chat`, `whisper`, `mural`, `dd-guess`, `ph-msg`, `emote`(no), name changes blocked. Player still plays, earns, walks. Others see nothing. | `admin.handleMessage` pre-empt |
| **kicked** | `{t:'denied', msg}` then `ws.close(4001)`. No record change. Reconnect allowed immediately. | `a-kick` handler |
| **banned** | Cannot log in (`auth.login`), cannot hello (token path), all live sessions closed with `denied`, `tokenV` bumped so every issued token dies. | 3 points, §3.5 |
| **shadow-muted** | **[judgment] Do not build this.** It is tempting and it is a trap: it produces players who think they are talking and operators who forget the state exists. Mute openly, with a duration and a reason. |

Mute is a *silent* failure to the room and a *loud* one to the muted player: they get a persistent HUD banner with the expiry, because a player who does not know they are muted files a bug report instead of changing behaviour.

### 3.3 Protocol: the `a-*` family

All client→server frames require `caps`; a frame from an unauthorised player is answered with **nothing at all** (not an error) and logged — an unauthorised `a-ban` is a probe, and probes deserve silence plus an audit line. All admin frames are rate-limited through the existing `socialLimited(p, now)` budget (`server/index.js:438-441`, 5/sec) except `a-who` which gets its own 1/2s budget because it is a scan.

`target` in every frame is `{id}` (a live connection id, what a player card knows), `{name}` (a username), or `{uid}`. Resolution order: `uid` → `name` → `id`, via one `resolveTarget(m)` helper modelled on `friendTarget` (`server/index.js:478-483`). Bots (`p.bot`, `index.js:446-456`) resolve but every mutating op refuses them with `a-ack{ok:false}`.

**Client → server**

```jsonc
{"t":"a-who","room":"plaza","q":"mang"}                  // both optional filters
{"t":"a-inspect","uid":"u_ab12…"}
{"t":"a-warn","uid":"…","text":"Keep it friendly, please."}
{"t":"a-mute","uid":"…","mins":60,"reason":"slurs in plaza"}
{"t":"a-unmute","uid":"…"}
{"t":"a-kick","uid":"…","reason":"spam"}
{"t":"a-ban","uid":"…","mins":1440,"reason":"…"}         // mins:0 = permanent (admin only)
{"t":"a-unban","uid":"…"}
{"t":"a-tp","id":"p7"}                                   // move ME to them
{"t":"a-summon","uid":"…"}                               // move THEM to me (admin)
{"t":"a-say","text":"Party in the club in 5!","scope":"room"}   // 'room' | 'world'
{"t":"a-mural-clear","x":10,"y":4,"w":12,"h":8}
{"t":"a-mural-revert","uid":"…","sinceMins":180}
{"t":"a-coins","uid":"…","delta":-800,"reason":"refund reversal #14"}
{"t":"a-role","uid":"…","role":"mod"}
{"t":"a-stealth","on":true}
```

**Server → client (the actor)**

```jsonc
{"t":"a-ack","op":"a-mute","ok":true,"msg":"mango muted for 60m"}
{"t":"a-who-list","players":[
  {"id":"p7","uid":"u_…","name":"mango","room":"plaza","registered":true,
   "role":"player","muted":0,"banned":0,"coins":430,"idleMs":4100,"sessions":2,"ipH":"3f9a…"}
]}
{"t":"a-account","uid":"u_…","name":"mango","created":…,"lastSeen":…,"coins":430,
 "role":"player","mute":null,"ban":null,"bests":{…},"stamps":12,"friends":8,
 "alts":[{"uid":"u_…","name":"mango2","why":"ipH"}],       // same hashed IP in the last 7d
 "recentChat":[{"at":…,"room":"plaza","text":"…"}]}
```

**Server → client (the subject)**

```jsonc
{"t":"moderated","action":"mute","until":1755200000000,"reason":"…","by":"caretaker"}
{"t":"moderated","action":"warn","text":"…","by":"caretaker"}
{"t":"denied","msg":"You are banned until 15 Aug (spam). Contact …"}   // existing frame, index.js:2186
```

**Server → room / world**

```jsonc
{"t":"announce","text":"Party in the club in 5!","from":"caretaker","scope":"world"}
```

`announce` is a new frame the HUD renders as a full-width banner distinct from `toast` (`src/ui/hud.js:521`) — announcements must not look like a coin popup. **Do not reuse `chat`** for announcements: it would be filtered, rate-limited and mistakable for a player impersonating staff.

Register all of the above in the `CLAUDE.md` protocol registry when the wave ships, per `CLAUDE.md:102-104`.

### 3.4 The mural, specifically

The audit is right that the data for undo already exists and has no consumer (`AUDIT.md:257`). `mural.ops` is a 50,000-entry rolling log of `{x,y,c,by,at}` (`server/index.js:1912,2020-2021`).

Two ops, both small:

- **`a-mural-clear{x,y,w,h}`** — fill the rect with palette index 0 (cream), `saveMuralSoon()`, broadcast the region. Cheapest possible response to a raid in progress: paint over it in one call.
- **`a-mural-revert{uid, sinceMins}`** — walk `mural.ops` backwards, and for every op by that account inside the window, restore the *previous* value at that cell. `ops` does not currently store the previous value, so either (a) add `prev` to the op record (2 bytes per op, 50k cap → negligible), or (b) replay the whole op log from a blank grid skipping the offender's ops. **Take (a)** — replaying 50k ops is fine at 50k but the cap will grow.

While here, fix the attribution: ops store `by: p.name` (a display name, `index.js:2020`). Store `byUid` as well. Without it, revert-after-rename silently reverts the wrong player's art.

Pair every `a-mural-*` with a ban in one panel click ("revert + ban", §4.3) — that is the actual operator workflow and making it two buttons means it gets done half as often.

### 3.5 Ban enforcement points (all three are required)

1. **`server/auth.js login()` (:78-87)** — after the password check, before minting a token: `if (banActive(rec)) return { ok:false, msg: banMessage(rec) }`. Returning a *distinct* message here is correct: a banned player who cannot tell they are banned will keep making accounts.
2. **`server/index.js` hello, token path (:2184-2191)** — `verifyToken` returns a username, then `users.get()`; add the ban check there and answer with the existing `denied` frame.
3. **Live sessions** — `a-ban` immediately walks `sessionsFor(key)` (`index.js:459-465`) and closes each with `denied`. Without this a banned player stays in the world until they disconnect.

Plus `tokenV` (§5.5), so a token minted before the ban cannot be replayed after an unban-then-rebán cycle or a token leak.

**IP bans: [judgment] do not build them.** They punish households and libraries, are trivially defeated with a phone hotspot, and the hashed-IP correlation in `a-account.alts` gives the operator the *signal* without the collateral. Revisit only if there is an actual repeat-raider problem.

### 3.6 Connection metadata (required, currently missing)

`wss.on('connection', (ws) => {` (`server/index.js:2154`) discards the request object, so **the server does not know any player's IP**. Kick/ban correlation, abuse investigation and the panel's player list all need it:

```js
wss.on('connection', (ws, req) => {
  ws._ipH = ipHash(req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress);
```

`ipHash = HMAC-SHA256(secret, ip).slice(0,16)` using the existing `getSecret()` (`server/db.js:125`). **Store the hash, never the address.** It supports every operational use (are these two accounts the same person? is this a burst from one host?) and it means a leaked database or a leaked log leaks no addresses — which materially shortens the privacy-policy conversation the audit flags at F-25. Requires `app.set('trust proxy', 1)` (AUDIT F-4, already tasked) or the header is forgeable.

---

## 4. The web admin panel

### 4.1 Why a separate surface at all

The in-game panel handles *live* moderation (someone is being awful right now, in this room). The web panel handles everything with a *time axis*: the report queue, account search, audit review, economy stats, and acting on players who are offline. They are different jobs and cramming the second into a 3D game client is how you end up with neither.

### 4.2 Serving and auth

**Mount before the SPA catch-all.** `server/index.js:227` installs `app.get(/^\/(?!api|ws).*/, …)` which would swallow `/admin` entirely. Two changes, belt and braces: register the admin router above the `if (fs.existsSync(DIST))` block at `:225`, **and** extend the lookahead to `/^\/(?!api|ws|admin).*/`.

- **Page:** one self-contained `server/admin/panel.html` — inline CSS and JS, no build step, no npm dependency, no external asset. This honours `CLAUDE.md:108` and it means the panel keeps working when the client build is broken, which is exactly when you need it.
- **Login:** `POST /admin/login {username, password}` → reuses `auth.login()` (`server/auth.js:78`) then requires `rank >= mod`. On success, mint a random 32-byte session id, store it server-side in a `Map` (`sid → {uid, role, at, ipH}`), set `Set-Cookie: cove_admin=<sid>; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=28800`.
  - Server-side session storage (not a signed cookie) because **revocation must be instant**: demoting a mod has to log them out, and a stateless cookie cannot be recalled.
  - 8-hour expiry, sliding on activity, hard cap 24 h.
  - `SameSite=Strict` + `Path=/admin` + a double-submit CSRF token on every mutating request. The game's own WebSocket never sees this cookie.
- **Brute force:** per-IP and per-account limiter, 5 attempts / 15 min, exponential backoff, **every failure audited**. The existing `authLimited` (`index.js:184-190`) is global-per-`req.ip` and known-broken behind a proxy (AUDIT F-4); the admin limiter must not share that fate — key it on the hashed IP after `trust proxy` is set.
- **Kill switch:** `COVE_ADMIN_PANEL=0` disables the whole router. Ship with it **off** until phase 2 is reviewed.
- **[judgment] Do not add TOTP/2FA in phase 2.** One operator, a strong password, a short session and a full audit trail is proportionate. Add it when there are five mods, not before — half-built 2FA is worse than none.

### 4.3 Screens

Every mutating endpoint funnels into **the same op vocabulary as the ws frames** (§3.3) via one shared `performOp(actor, op, args)` in `server/admin.js`. The panel and the in-game panel must never be able to diverge in what they permit or what they log.

**1. Overview** — CCU, per-room populations (from `world.rooms`, `index.js:235`), uptime, heap, tick p95, sockets, coins granted per hour (from the audit log, §7), errors in the last hour, save latency, accounts total / active 24 h / new 24 h. This is also the natural home for the extended `/api/health` the audit asks for (F-45).

**2. Players (live)** — the `a-who` payload as a sortable table; click a row → the account drawer. Actions inline: warn / mute / kick / ban.

**3. Account search** — by name prefix, uid, or hashed IP. Result drawer shows everything in `a-account` plus: purchase history, coin grants over time (from the audit log), friends, den access mode, stamp count, ban/mute history, and the `alts` correlation. Actions: everything in §2.2 the role allows, plus **Issue reset code** (§5.2) and **Purge account** (§5.3).

**4. Report queue** — the surface the T&S wave will feed. States: `open → actioned | dismissed`, with the actioning mod and a note. Each report renders its context inline: the reported player's last 20 chat lines (§7.4), the room, the time, and — for doodle reports — the canvas snapshot the T&S wave will attach. One-click "Revert mural + ban" and "Mute 24 h + dismiss" compound actions, because the queue only gets worked if working it is fast.

> **Seam:** the *client* report button, its categories and the doodle canvas snapshot are AUDIT F-21/F-23 and belong to the T&S wave. This document owns the **store, the queue states and the review UI**. Agreed record shape:
> ```jsonc
> {"id":"r_01J…","at":1755,"kind":"chat|whisper|mural|doodle|name|den",
>  "byUid":"u_…","targetUid":"u_…","room":"plaza","reason":"language",
>  "note":"","evidence":{"lines":[…]|"rle":"…"|"png":"data/reports/blobs/…"},
>  "state":"open","actorUid":null,"resolvedAt":null,"resolution":null}
> ```
> `data/reports/YYYY-MM-DD.jsonl`, one line per report, appended atomically. The existing `reportMural` (`index.js:2033-2050`) — which writes one bespoke file per report into `data/mural-reports/` — is migrated into this format and its writes become queue entries. It is currently the only report path in the game and nothing consumes it.

**5. Economy** — coin volume by source (the `reason` string already passed to `grantCoins`, `index.js:400,413`), top earners in 24 h, outliers above a threshold, purchase counts by item. **This is the anti-cheat detector the audit says does not exist** (F-11, F-45): a script farming 12,000/hour is invisible today and obvious on this screen.

**6. Audit** — tailed, filterable by actor / op / target / date (§7).

**7. Server** — read-only diagnostics plus three buttons: force save, rotate backup now, and **broadcast + drain** (announce a restart, stop accepting connections, flush, exit) which is the operator-facing half of the SIGTERM work in AUDIT F-2.

### 4.4 What the panel must not do

No SQL console, no arbitrary record editor, no "run script" box, no raw file browser. Every write goes through a named op that is validated, capped and audited. The moment the panel can do something the audit log cannot describe, the audit log is a decoration.

---

## 5. Account lifecycle

The constraint that shapes this whole section: **there is no email infrastructure and there should not be.** Signup collects a username and a password and nothing else (`server/auth.js:55-76`, `src/ui/title.js:92-96`), and the audit correctly identifies that data minimisation as an asset (`AUDIT.md:266`). Adding an email server to solve password reset would import a spam problem, a deliverability problem, a PII problem and a COPPA problem to fix a support problem.

### 5.1 Recovery codes at signup

**Recommended primary mechanism.** At signup, generate one recovery code, store only its scrypt hash, show it once.

- **Format:** `CAPY-<4 words>` from a 1,024-word cove-flavoured wordlist (10 bits/word → 40 bits, plus the fixed prefix). Words beat base32 for a written-down secret: people transcribe `CAPY-otter-lantern-cocoa-drift` correctly and `7QF3-K2M9-XR4P` incorrectly. 40 bits is ample given the reset endpoint is rate-limited to 5 attempts/hour/account with lockout.
- **Storage:** `rec.recovery = { salt, hash: scryptHash(code, salt), issuedAt, usedAt: null }`. Same primitives as the password (`auth.js:9-11`); never stored in plaintext, never logged, never shown in the admin panel.
- **Presentation:** a blocking step in `src/ui/title.js` after a successful signup — the code in a big monospace card, a Copy button, a "I've written it down" checkbox that gates the Enter World button. **[judgment]** Yes, this adds friction to the funnel. It is the cheapest possible substitute for an entire email subsystem, and a player who loses their crown and cannot recover it churns permanently.
- **Reset:** `POST /api/recover { username, code, newPassword }` → verify with `timingSafeEqual` under the byte-length guard the codebase already knows to use (`auth.js:27-31,83`), set the new hash, **bump `tokenV`**, mark the old code used and issue a fresh one in the response. Audited. Never reveals whether the username exists.
- **Rotation:** one code at a time; using it issues the next. A "show me a new code" action (requires current password) lets a player who has lost the paper get a fresh one.

### 5.2 Owner-assisted reset (the fallback that will actually get used)

Most players will lose the code too. The admin panel therefore offers **Issue reset code**:

- Admin clicks it on an account → server generates a single-use token, **valid 30 minutes**, one outstanding per account, stored hashed on the record as `rec.resetToken = {salt, hash, exp}`.
- The panel displays it **once** to the admin, who delivers it out-of-band (Discord DM, the same channel the community already lives in). The server never transmits it to the player.
- The player enters it on the title screen's "Forgot password" tab; on success, password set, `tokenV` bumped, token consumed.
- Audited on both sides: `account.reset.issued` (actor = admin) and `account.reset.used` (actor = the account).

**[judgment]** This is a deliberate manual step. Identity verification without email *is* a human judgment ("are you the person who played this account?"), and pretending otherwise is how accounts get stolen. It scales to hundreds of accounts, which is the honest launch ambition. If the cove ever reaches thousands, add optional email *then*, opt-in, for recovery only.

### 5.3 Deletion

Required by the "right to erasure" conversation the audit raises (F-25), and by basic decency.

- **Self-serve:** `POST /api/account/delete { password }` from the settings menu. Enters a **24-hour cooling-off**: `deletedAt` set, `tokenV` bumped, all sessions closed, login refused with "This account is scheduled for deletion — log in before <time> to cancel." Logging in during the window cancels it. **[judgment]** Rage-deletes are real and irreversible deletion of a 40-hour save is a support ticket you cannot answer.
- **Purge (after the window, on a daily sweep, or immediately via `a-purge`):** the record is replaced by a **tombstone**:
  ```jsonc
  {"uid":"u_…","username":"mango","usernameLower":"mango","deleted":1755200000000,"tokenV":9}
  ```
  Everything else — hash, salt, coins, hats, bests, friends, house, stamps, recovery, IP hash — is gone.
- **Why keep the tombstone:** it reserves the name. Without it, a departed player's name is immediately claimable and impersonation is free — worse for a social game than the storage cost of a 5-field object. Reserve for **12 months**, then release. Names are 3-16 chars (`shared/constants.js:116-117`) so the namespace is not scarce.
- **Cascade:** sweep `friends` arrays and `house.invites` for the name (both already normalised on load, `db.js:32-37,86-99`), delete any live `house:<name>` room set (`index.js:305,510-517`), close sessions, and rewrite mural op attribution to `[deleted]` while **keeping the pixels** — the mural is a shared artefact and unpicking it would let anyone vandalise history by deleting their account.
- **Audit:** the audit log keeps the `uid` and the op forever. That is the point of pseudonymous uids: the operational record survives erasure without retaining personal data.

### 5.4 Rename policy

Renaming is expensive today for the reasons in §1. Policy:

- **Self-serve rename: one per 30 days, costs 200 coins.** **[judgment]** Two birds: it is the recurring coin sink the audit says the economy completely lacks (F-27), and the cooldown prevents name-hopping to escape a reputation.
- **The old name is reserved to that uid for 30 days** (tombstone-style entry) so nobody can grab it and impersonate.
- **Forced rename (`a-rename`, admin)** for offensive names, which the audit flags as unfiltered and world-visible (F-26). Forced renames are free and do not touch the cooldown, and they push the player through a name-picker on next login rather than assigning a random name.
- **Implementation, flat file:** rekey `users`, then sweep every record's `friends` array and `house.invites` (O(accounts) — at the flat file's own ~5-10k ceiling this is milliseconds and happens rarely), rewrite any live `house:<old>` room set, bump `tokenV` (the token embeds the username, `auth.js:15`), and audit before/after. Write this as one function `renameAccount(rec, newName)` in `db.js` so the SQLite migration replaces one implementation, not five call sites.
- **The long-term fix** is separating login handle from display name; fold it into the SQLite schema (§6.4) rather than doing it twice.

### 5.5 Session and token revocation

Today: `HMAC(username.expiry)`, 30-day TTL, verified against signature + expiry + account existence (`server/auth.js:13-34`). **There is no way to invalidate a token** (AUDIT F-16). Fix:

```js
// auth.js — body becomes 3 parts, token 4
const body = `${username}.${rec.tokenV|0}.${exp}`;
// verifyToken: parts.length !== 4 -> null; compare Number(v) === (rec.tokenV|0)
```

`verifyToken` currently hard-requires `parts.length !== 3` (`auth.js:22`), so all existing tokens are invalidated by this change — everyone logs in once more. Acceptable pre-launch; do it before there are users, not after.

`tokenV++` on: password change, recovery use, ban, unban, forced rename, self-serve rename, deletion request, role change, and an explicit "log out everywhere" button in settings. Cheap (`|0` compare per hello) and it turns "leaked token, nothing we can do for 30 days" into "click a button".

Also shorten the TTL: **30 days → 14** with a silent refresh whenever a session is more than 7 days old at hello. Same convenience, half the exposure window.

---

## 6. Durability

### 6.1 Now: fix the flat file, do not migrate

The audit is right that the migration is not urgent and the atomic write is (F-1, F-2, tasked as #15). Restating only what this spec adds:

- Atomic write is `tmp → fsync(file) → rename → fsync(dir)`. The last step is the one everybody skips; without it the rename itself can be lost on power failure.
- `saveSoon` (`db.js:113-123`) is a **leading-edge, fixed-window** debounce — `if (saveTimer) return` means a busy server writes at most every 500 ms and can never be starved. That is correct and worth preserving through the migration.
- **Backups:** hourly snapshot to `data/backups/users-<ISO>.json.gz` (zlib is built in), keep 24 hourly + 7 daily, plus one on every clean shutdown and one before every schema migration. Write the **restore procedure** into `README.md` and *run it once* — an untested restore is not a backup.
- The audit log (§7) and the report queue are separate append-only files and must not share the users.json write path; a corrupt user database must never take the evidence with it.

### 6.2 Introduce the seam now, migrate later

The single highest-leverage cheap move: **`server/store.js`**, a ~15-method interface that `db.js` implements over the `Map` today.

```js
// getUser(key) putUser(rec) allUsers() findByUid(uid) searchUsers(prefix, limit)
// createUser(rec) deleteUser(key) tx(fn) flush() stats()
```

Everything new in this spec (admin ops, audit, reports, panel search) calls `store.*`, never `users.get`. Existing call sites migrate opportunistically. When SQLite arrives it is a second implementation behind the same interface, and the diff touches one file plus an importer instead of every handler in a 2,877-line server.

### 6.3 `node:sqlite` vs `better-sqlite3` — verified, not remembered

Measured on this machine, 2026-08-14:

```
$ node -v                    → v24.18.0
$ node -e "…require('node:sqlite')…"
exports: [ 'DatabaseSync', 'StatementSync', 'Session', 'constants', 'backup' ]
DatabaseSync methods: open, close, prepare, exec, function, createTagStore, location,
                      aggregate, createSession, applyChangeset, enableLoadExtension,
                      enableDefensive, loadExtension, serialize, deserialize, setAuthorizer
StatementSync methods: iterate, all, get, run, columns, setAllowBareNamedParameters,
                      setAllowUnknownNamedParameters, setReadBigInts, setReturnArrays
process.versions.sqlite → 3.53.1
```

A prepare/insert/select round-trip works with no flag. Everything this schema needs is present: synchronous prepared statements (the same shape `better-sqlite3` made popular), user-defined functions and aggregates, an **async `backup()`** for hot snapshots, and session/changeset support if replication is ever wanted.

| | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| New npm dependency | **none** | yes — violates `CLAUDE.md:108` outright |
| Native build | none (in the runtime) | prebuilt binaries, or node-gyp; **musl/Alpine** is the historical pain point and the Dockerfile is Alpine (`Dockerfile:1,8`) |
| API | `DatabaseSync` / `StatementSync`, sync | `Database` / `Statement`, sync — near-identical ergonomics |
| Node version | unflagged from Node 23.4 / 24; **flagged (`--experimental-sqlite`) on Node 22** | any |
| Stability | still marked experimental / release-candidate in Node docs; API has been additive, not breaking, across 22→24 | mature, widely deployed |
| Perf | same engine (SQLite 3.53.1); both are synchronous C bindings | same |

**Recommendation: `node:sqlite`.** The no-new-dependency rule is a stated project constraint, not a preference, and the alternative drags a native toolchain into an Alpine image. **Two conditions:**

1. **Bump the Dockerfile to `node:24-alpine`** (both stages, `Dockerfile:1,8`). On the pinned `node:22-alpine`, `node:sqlite` needs `--experimental-sqlite` and is a materially older API — do not ship a flagged experimental module.
2. **All SQLite access lives behind `server/store.js` (§6.2).** If the API does churn, the escape hatch is a ~60-line adapter, because `better-sqlite3`'s surface is the same shape.

Pin the Node major in `package.json` `engines` so the deploy cannot silently drop back.

### 6.4 Target schema (when the trigger fires)

Normalise the things that are queried; keep JSON blobs for the things that are only ever read whole. Over-normalising a den layout buys nothing.

```sql
PRAGMA journal_mode = WAL;      -- readers never block the writer
PRAGMA synchronous  = NORMAL;   -- with WAL, durable to process crash; fsync on checkpoint
PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  uid TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE,
  salt TEXT, hash TEXT, token_v INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'player',
  coins INTEGER NOT NULL DEFAULT 0, color INTEGER, hat TEXT,
  title TEXT, created INTEGER, last_seen INTEGER, last_ip_h TEXT,
  mute_until INTEGER DEFAULT 0, mute_reason TEXT, mute_by TEXT,
  ban_until INTEGER DEFAULT 0, ban_reason TEXT, ban_by TEXT, ban_at INTEGER,
  rec_salt TEXT, rec_hash TEXT, rec_issued INTEGER, rec_used INTEGER,
  renamed_at INTEGER, deleted_at INTEGER
);
CREATE INDEX idx_accounts_lastseen ON accounts(last_seen);
CREATE INDEX idx_accounts_iph      ON accounts(last_ip_h);

CREATE TABLE owned_hats  (uid TEXT, hat  TEXT, PRIMARY KEY (uid, hat));
CREATE TABLE owned_furn  (uid TEXT, furn TEXT, n INTEGER, PRIMARY KEY (uid, furn));
CREATE TABLE bests       (uid TEXT, game TEXT, score INTEGER, PRIMARY KEY (uid, game));
CREATE TABLE friends     (uid TEXT, other TEXT, at INTEGER, PRIMARY KEY (uid, other));
CREATE TABLE house       (uid TEXT PRIMARY KEY, access TEXT, layout TEXT /*JSON*/);
CREATE TABLE house_invites (uid TEXT, guest TEXT, PRIMARY KEY (uid, guest));
CREATE TABLE stamps      (uid TEXT, stamp TEXT, at INTEGER, PRIMARY KEY (uid, stamp));
CREATE TABLE progress    (uid TEXT PRIMARY KEY, blob TEXT /*JSON quest board*/);
CREATE TABLE mural       (x INTEGER, y INTEGER, c INTEGER, uid TEXT, at INTEGER,
                          PRIMARY KEY (x, y));
CREATE TABLE mural_ops   (id INTEGER PRIMARY KEY AUTOINCREMENT,
                          x INTEGER, y INTEGER, c INTEGER, prev INTEGER, uid TEXT, at INTEGER);
CREATE INDEX idx_mural_ops_uid ON mural_ops(uid, at);
CREATE TABLE reports     (id TEXT PRIMARY KEY, at INTEGER, kind TEXT, by_uid TEXT,
                          target_uid TEXT, room TEXT, reason TEXT, evidence TEXT,
                          state TEXT, actor_uid TEXT, resolved_at INTEGER, resolution TEXT);
CREATE INDEX idx_reports_state ON reports(state, at);
```

Note `friends` and `house_invites` still store *names* on the right-hand side to match today's data; the migration is the moment to switch them to uids and drop the rename sweep from §5.4 entirely. Do it in the importer.

**Audit log and chat retention stay as files** (§7), not tables: append-only, rotated, independently backed up, and readable with `tail` when the database is the thing that is broken.

**Migration procedure:** (1) importer reads `users.json` → writes `cove.db` in one transaction; (2) run both stores in parallel for a week with a nightly diff job; (3) flip `store.js`'s implementation; (4) keep the last JSON snapshot forever as the pre-migration backup. Every step reversible until (3).

### 6.5 Migration triggers (pick one, write it on the wall)

Migrate when **any** of these is true — not before, and not later:

- accounts > 2,000, or `users.json` > 4 MB (whole-map re-serialise, `db.js:118`);
- a `saveSoon` write exceeds 50 ms p95 (it blocks the 10 Hz tick, `index.js:2810`);
- the first time a feature genuinely needs a query (leaderboards over `bests`, "accounts sharing an IP hash", "coin grants by hour") rather than a scan.

The audit's estimated flat-file ceiling is ~5-10k accounts (`AUDIT.md:92`); these triggers fire comfortably before it.

---

## 7. Audit log

### 7.1 Principle

**If a privileged action happened and the log does not describe it, the feature is not finished.** The log is the only thing that makes handing out `mod` safe, and the only way to answer "why does this account have 40,000 coins" three weeks later.

### 7.2 What is logged

**Always** — every op in §2.2 that mutates anything: `mod.mute`, `mod.unmute`, `mod.kick`, `mod.ban`, `mod.unban`, `mod.warn`, `mod.summon`, `mod.say`, `mural.clear`, `mural.revert`, `econ.coins`, `role.grant`, `role.revoke`, `role.seed`, `account.rename`, `account.reset.issued`, `account.reset.used`, `account.purge`, `panel.login`, `panel.login.fail`, `panel.logout`.

**Also** — lifecycle and anomalies, no actor: `account.create`, `account.delete.request`, `account.delete.cancel`, `account.password.change`, `econ.grant.large` (any `grantCoins` above a threshold, ~500 — this is the F-11 farming detector the audit says does not exist), `econ.hourly.capped` (the backstop at `index.js:405` silently returning 0, which today is invisible), `server.start`, `server.stop`, `server.uncaught`, `db.save.fail`, `db.restore`.

**Never** — chat contents (they live in the separate, shorter-retention chat log, §7.4), passwords, recovery codes, reset tokens, raw IPs.

### 7.3 Shape, location, rotation

- **Location:** `data/audit/audit-YYYY-MM-DD.jsonl`, one JSON object per line, opened append-only (`fs.createWriteStream(..., {flags:'a'})`), `fsync` batched every 250 ms. Volume is tiny (tens of lines/day, thousands during a raid), so never buffer more than that.
- **Never inside `users.json`.** Different write pattern, different retention, different failure mode.
- **Shape:**
  ```jsonc
  {"seq":1042,"at":1755200000000,"id":"a_01J8…",
   "actor":{"uid":"u_ab12…","name":"caretaker","role":"admin","ipH":"3f9a…","via":"panel"},
   "op":"econ.coins",
   "target":{"uid":"u_cd34…","name":"mango"},
   "args":{"delta":-800,"reason":"reversal of duplicate refund"},
   "before":{"coins":1230},"after":{"coins":430},
   "ok":true,"prev":"9c1f…"}
  ```
  `via` is `"panel" | "ingame" | "system"`. `before`/`after` carry only the fields the op touched. `prev` is the SHA-256 of the previous line — **a hash chain, ~5 lines of code**, which makes after-the-fact tampering by anyone with disk access *detectable*. The threat model here is a compromised or rogue operator, and that is precisely who has disk access. **[judgment]** Worth it; cheap and it never needs maintaining.
- **Rotation:** new file at UTC midnight; gzip files older than 7 days (`node:zlib`, built in); **retain 90 days** for admin actions. Delete on a daily sweep and at boot.
- **Reading:** the panel tails backwards from the newest file with a byte-offset cursor; never load a whole day into memory. Filters (actor, op, target, range) are applied per line.

### 7.4 Chat retention (adjacent, deliberately separate)

The report queue is useless without context — the audit's sharpest T&S point is that whispers are unlogged so an operator has literally nothing to look at (F-22). Minimum viable:

- **In memory:** a ring of the last 30 lines *per connected player* (`chat`, `whisper` both directions, `dd-guess`), ~4 KB/player, dropped on disconnect. This alone answers 90% of reports, because reports arrive seconds after the offence.
- **On disk:** `data/chatlog/chat-YYYY-MM-DD.jsonl`, `{at, uid, room, kind, to, text}`, **retained 7 days**, purged by the same sweep. Short retention is the privacy-conscious choice and it is enough for the report queue.
- **Access:** only through the panel, only role ≥ mod, and **reading a specific player's chat log is itself an audited op** (`mod.chatlog.read`). Watching the watchers costs one line.
- **Disclose the 7-day window in the privacy policy** the T&S wave writes (F-25). It is a much easier sentence to write than an unbounded one.

---

## 8. File-by-file engineering plan

Sizes per the audit's scale. Ownership follows `CLAUDE.md:25-43` — one file, one owner.

### Phase 1 — identity, roles, in-game moderation, audit (M)

| File | Change | Size |
|---|---|---|
| `server/db.js` | `ensureAccount(rec)` (uid, role, tokenV, mute, ban, lastSeen backfill) following the `ensureFriends`/`ensureHouse` idiom (:25,53); call from the load loop (:104) ; `renameAccount()`; atomic write + backups (task #15); export `store`-shaped helpers | S |
| **`server/audit.js`** (new) | append-only JSONL writer, hash chain, daily rotation, gzip + purge sweep, `readBack(filter, cursor)` | S |
| **`server/admin.js`** (new) | `install(ctx)` / `handleMessage(p,m)` per the `progress.js` contract (:6-11); `RANK`/`capsFor`/`requireCap`; mute+ban pre-empt; every `a-*` op; **one `performOp()` shared with the panel** | M |
| `server/auth.js` | `role` in `publicProfile()` (:36-53); `tokenV` in `makeToken`/`verifyToken` (:13-34); ban check in `login()` (:78-87); recovery-code hashing helpers; async scrypt while here (AUDIT F-5) | S |
| `server/index.js` | 4 edits only: `admin.install({…})` beside `progress.install` (:418); `admin.handleMessage` line before :2178; `(ws, req)` + `ipH` at :2154; ban check in the hello token path (:2184-2191). Plus `mod` in `snapshotFor` (:239) and `prev`/`byUid` on mural ops (:2020) | S |
| `shared/constants.js` | `ROLES`, `CAPS`, mute/ban duration presets, `ANNOUNCE_MAX_LEN` | S |
| `src/main.js` | **delete `isAdmin()` (:183)**; gate Ctrl+E on `game.state.caps.includes('editor')` (:194) — closes task #13 and the `CLAUDE.md:141` blocker | S |
| `src/core/game.js` | carry `role`/`caps`/`muteUntil` in `state`; **never** persist them via `saveLocal` (:53-56) — a guest could otherwise edit localStorage into a fake mod badge | S |
| `src/net/client.js` | `moderated`, `announce`, `a-*` responses → `game.events`; mod badge in the name tag beside `addTagTitle` (:16-24) | S |
| **`src/ui/admin.js`** (new) | in-game panel (Ctrl+Shift+A): player list, warn/mute/kick/ban, announce, teleport, mural clear. Lazy-imported only when `caps` is non-empty; lifecycle copied from `src/ui/quests.js:440,462-466` | M |
| `src/ui/profile.js` | Moderate section on the player card next to the existing action row (:1448-1506) | S |
| `src/ui/hud.js` | `announce` banner (distinct from `toast`, :521); muted-state chat box with expiry | S |
| `docs/`/`CLAUDE.md` | register the `a-*` family in the protocol registry (:44-104) | S |

### Phase 2 — the web panel (M)

| File | Change |
|---|---|
| **`server/adminPanel.js`** (new) | Express router mounted **before** the static/catch-all block (`index.js:224-228`); cookie sessions in a `Map`; CSRF; per-IP login limiter; all `/admin/api/*` endpoints delegating to `admin.performOp` |
| **`server/admin/panel.html`** (new) | one self-contained page, inline CSS+JS, no dependency, no build step |
| **`server/reports.js`** (new) | report store + queue states; absorb `reportMural` (`index.js:2033-2050`) into the common format |
| **`server/chatlog.js`** (new) | per-player ring + 7-day JSONL + purge |
| `server/index.js` | extend `/api/health` (:209) with the panel's overview metrics; `admin` in the catch-all lookahead (:227) |
| `Dockerfile` / `fly.toml` | `COVE_ADMIN`, `COVE_ADMIN_PANEL` env; ensure `data/` volume covers `audit/`, `reports/`, `chatlog/`, `backups/` |

### Phase 3 — lifecycle (M)

| File | Change |
|---|---|
| `server/auth.js` | `recover()`, `changePassword()`, `issueResetToken()`, `consumeResetToken()`; `tokenV++` on all of them |
| `server/index.js` | `POST /api/recover`, `/api/password`, `/api/account/delete`, `/api/account/rename` — all rate-limited, all audited |
| `server/db.js` | tombstones, cascade sweep, 24 h cooling-off sweep, name reservation |
| `src/ui/title.js` | recovery-code reveal after signup (:92-108); "Forgot password" tab |
| `src/ui/menu.js` | change password, log out everywhere, rename (200 coins), delete account |

### Phase 4 — SQLite (M, trigger-gated by §6.5)

| File | Change |
|---|---|
| **`server/store.js`** (new — **write the interface in phase 1**, implement over the `Map`) | the seam |
| **`server/store.sqlite.js`** (new) | `node:sqlite` implementation, WAL, prepared-statement cache, `tx()` |
| **`server/migrate.js`** (new) | `users.json` → `cove.db` importer; name→uid rewrite for friends and invites; verification diff |
| `Dockerfile` | `node:22-alpine` → `node:24-alpine` (both stages); `engines` in `package.json` |

---

## 9. Judgment calls, stated plainly

1. **Guests should not be able to chat or whisper.** Nothing durable can be attached to a guest — no mute record, no ban, no history, no report target beyond a connection id that dies on refresh — and `whisper` does not check `p.registered` at all (`index.js:2288-2302`). Making chat an account feature converts every moderation problem from unsolvable to solvable, costs a 15-second signup, and gives signup an obvious *reason*. **Coordinate with the T&S wave; this is their call to make, but the platform layer cannot moderate what it cannot name.**
2. **No shadow-mutes, no IP bans, no 2FA in v1.** Each is a plausible-sounding feature whose cost lands on innocent people or on the operator's future self.
3. **Recovery codes are worth the signup friction.** Displayed once, four words, one checkbox. The alternative is a support queue you answer by hand forever, or an email server you do not want.
4. **Rename costs coins.** It is the only recurring sink this spec can honestly justify adding, and the audit is unambiguous that the economy has none (F-27).
5. **The admin panel gets no escape hatch.** No SQL box, no script runner, no raw editor. Every write is a named, audited op or it does not exist.
6. **Hash the IP, keep the correlation.** Every operational use of an IP is a comparison; almost none require the address itself.
7. **`node:sqlite` over `better-sqlite3`,** but only on Node 24 and only behind `store.js`. Verified working locally on v24.18.0 with SQLite 3.53.1 (§6.3).
8. **Do not migrate to SQLite yet.** Atomic writes plus backups plus the `store.js` seam buys a year, and every hour spent on the database now is an hour not spent on the moderation tooling that actually blocks launch.
