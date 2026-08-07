import { BOT_ZONES, HATS, BODY_COLORS, ROOM_IDS, WALK_SPEED } from '../shared/constants.js';

// Ambient capybaras: server-simulated players so rooms never feel empty.
// They wander their room's guaranteed-walkable zone, chat, emote, and
// occasionally migrate to another room.
//
// Wave 7 (docs/LIVING-COVE.md section B) demotes them on purpose: the citizens
// exist for ONE reason, which is that an empty room at 2am kills a small social
// game, because nobody stays where nobody is. They are set dressing that keeps
// the world breathing at low population. What they gained: fixed identities
// (the same capy every restart) and a daily schedule read off the world clock,
// so the cafe is busy at breakfast, the club fills in the evening, the lounge
// hosts the nightlife after dark, and somebody is always at the bonfire.
// What they deliberately did NOT gain: memory, gossip, dialogue grammar. That
// effort went to the human-to-human systems instead.

const NAMES = [
  'Mango', 'Pebble', 'Sprout', 'Waffles', 'Biscuit', 'Nori', 'Tofu', 'Maple',
  'Clover', 'Pudding', 'Ziggy', 'Bubbles', 'Chai', 'Mochi', 'Sunny', 'Dew',
];

const CHAT = {
  any: ['hi hi!', 'love this place', 'anyone up for a game?', 'brb snacks', ':)', 'nice hat!', 'follow me!', 'yesss', 'this is the spot'],
  plaza: ['the fountain is so sparkly', 'meet at the plaza!', 'shop got new hats!'],
  beach: ['the water is perfect today', 'caught a huge fish earlier', 'sandcastle time'],
  peak: ['race you down the hill!', 'brrr cozy though', 'the view up here!!'],
  cafe: ['smoothies on me', 'try the mango one', 'it smells amazing in here'],
  club: ['DANCE PARTY', 'dj turn it up', 'these lights tho'],
  lounge: ['anyone for chess?', 'best of three at pong??', 'the fireplace is so warm', 'i almost beat Grandmaster Pebble once'],
  mine: ['just parking here, the walls pay rent', 'found a gem yesterday!!', 'my pickaxe is tiny but mighty', 'shhh i think that barrel moved', 'hunters on the board, who is in?'],
  jungle: ['my doodles are museum quality', 'is that a toucan or a leaf', 'the waterfall is so loud and so nice', 'i drew a smoothie and nobody guessed it', 'vines make the best swings'],
};

// Said only around the fire, and only after dark.
const FIRESIDE = [
  'this is the best seat on the island',
  'someone tell a story',
  'i can see the whole sky from here',
  'warm paws, happy capy',
  'ten more minutes then bed, promise',
];

// The day, in cove phase (0.0 dawn, 0.25 noon, 0.5 dusk, 0.75 midnight).
// PLAYTESTER DIRECTION 2026-08-07: citizens do NOT sleep: a real-time clock
// means night lasts real hours, and a dormitory made the whole cove boring
// after dark. Nights are for dancing instead.
const BREAKFAST = { from: 0.02, to: 0.10, room: 'cafe' };
const EVENING = { from: 0.55, to: 0.70, room: 'club' };
const NIGHTLIFE = { from: 0.70, to: 0.95, room: 'club' };
// The bonfire lights at dusk and dies at dawn; its keepers cover the whole of
// it, so the circle is never empty (they skip the club and the dormitory).
const FIRE_FROM = 0.50;
const FIRE_TO = 0.95;
// Up to 3 minutes of a 40-minute day, re-rolled nightly. It delays the START of
// a window only: a citizen dawdles a few minutes before heading over, so the
// cafe fills over a few minutes instead of sixteen capys marching in at once.
// (Jittering both edges instead would let a capy whose roll exceeded the window
// miss breakfast entirely, which is not the same thing as being late for it.)
const JITTER_T = 3 / 40;
const SCHEDULE_CHECK_S = 8; // how often a citizen thinks about where it should be

/** Stable per-name hash, so a restart hands every citizen back its own look. */
function hashName(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

let nextBotId = 1;

export class BotManager {
  /**
   * hooks: {broadcastToRoom(roomId, msg), snapshotFor(bot)} provided by index.js
   * opts.bonfire: the beach bonfire {room, x, z, r} index.js validates against,
   * passed in rather than duplicated so there is exactly one source of truth.
   */
  constructor(hooks, { perRoom = 2, bonfire = null } = {}) {
    this.hooks = hooks;
    this.bots = new Map(); // id -> bot
    this.bonfire = bonfire;
    this.clock = { day: -1, dayT: 0 };
    let n = 0;
    let keepers = 0;
    for (const room of ROOM_IDS) {
      if (!BOT_ZONES[room]) continue; // rooms with no zone (The Drift) get no bots
      for (let i = 0; i < perRoom; i++) {
        const bot = this.spawn(NAMES[n++ % NAMES.length], room);
        // the beach's own two keep the fire: at dusk they walk twenty paces
        // instead of crossing the island, so the circle fills every night
        if (bonfire && room === bonfire.room && keepers < 2) { bot.keeper = true; keepers++; }
      }
    }
  }

  /** Called from index.js's clock tick: the citizens run on cove time. */
  setClock(clock) {
    if (!clock) return;
    this.clock = { day: clock.day, dayT: clock.dayT };
  }

  spawn(name, room) {
    const zone = BOT_ZONES[room];
    const id = `bot-${nextBotId++}`;
    // Fixed identity: the same name always wears the same coat and the same
    // hat, whatever order the rooms were built in, so regulars stay recognisable
    // across restarts (LIVING-COVE section B).
    const h = hashName(name);
    // Milestone hats are the stamp album's proof of play (docs/LIVING-COVE.md
    // section D): coins cannot buy them, so a wander-bot must not be born in
    // one either. `milestone: true` in shared/constants.js is the flag the shop
    // hides on, and it is the flag we skip on.
    const hatPool = Object.keys(HATS).filter((id) => !HATS[id].milestone);
    const bot = {
      id,
      bot: true,
      name,
      home: room,
      room,
      keeper: false,
      x: zone.x + (Math.random() - 0.5) * zone.r,
      z: zone.z + (Math.random() - 0.5) * zone.r,
      rot: Math.random() * Math.PI * 2,
      anim: 'idle',
      // unsigned shifts throughout: `h >> 9` on a hash past 2^31 goes negative
      // and indexes the hat catalog straight off the end
      color: BODY_COLORS[h % BODY_COLORS.length],
      hat: (h >>> 8) % 2 ? hatPool[(h >>> 9) % hatPool.length] : 'none',
      target: null,
      post: null, // a spot outside the wander zone (the bonfire ring)
      waitT: Math.random() * 4,
      chatT: 6 + Math.random() * 20,
      moveT: 0,
      schedT: Math.random() * SCHEDULE_CHECK_S,
      jitter: 0,
      jitterDay: -1,
      asleep: false,
    };
    this.bots.set(id, bot);
    return bot;
  }

  /** Where this citizen should be right now, or null for "wherever it likes". */
  schedule(bot) {
    const t = this.clock.dayT;
    if (bot.jitterDay !== this.clock.day) {
      bot.jitterDay = this.clock.day;
      bot.jitter = Math.random() * JITTER_T;
    }
    const j = bot.jitter;
    const inWindow = (win) => t >= win.from + j && t < win.to;
    // A keeper's evening belongs to the fire: no club, no dormitory.
    if (bot.keeper && this.bonfire && t >= FIRE_FROM + j && t < FIRE_TO) {
      return { room: this.bonfire.room, post: true };
    }
    if (inWindow(NIGHTLIFE)) return { room: NIGHTLIFE.room };
    if (inWindow(EVENING)) return { room: EVENING.room };
    if (inWindow(BREAKFAST)) return { room: BREAKFAST.room };
    return null;
  }

  update(dt) {
    for (const bot of this.bots.values()) {
      const zone = BOT_ZONES[bot.room];
      const plan = this.schedule(bot);

      // ---- keeping to the timetable
      bot.schedT -= dt;
      if (bot.schedT <= 0) {
        bot.schedT = SCHEDULE_CHECK_S * (0.6 + Math.random() * 0.8);
        if (plan && plan.room !== bot.room) {
          this.migrate(bot, plan.room);
          continue; // they arrive facing the room; next tick settles them in
        }
      }
      const atPost = !!(plan && plan.post && this.bonfire && bot.room === this.bonfire.room);
      bot.post = atPost ? this.firePost(bot) : null;
      // nobody sleeps (playtester direction): the flag stays for the pjoin
      // snapshot shape but can only ever be false now
      if (bot.asleep) { bot.asleep = false; if (bot.anim === 'sit') bot.anim = 'idle'; }

      // ---- chatter (the asleep guards below are inert now: nobody sleeps)
      bot.chatT -= dt;
      if (bot.chatT <= 0) {
        bot.chatT = 14 + Math.random() * 30;
        if (!bot.asleep) {
          const pool = atPost ? [...FIRESIDE, ...CHAT.any] : [...CHAT.any, ...(CHAT[bot.room] || [])];
          const text = pool[Math.floor(Math.random() * pool.length)];
          this.hooks.broadcastToRoom(bot.room, { t: 'chat', id: bot.id, name: bot.name, text });
        }
      }

      if (bot.asleep) continue; // a sleeping capy does nothing else at all

      // in the club, mostly dance
      if (bot.room === 'club' && bot.anim !== 'dance' && Math.random() < dt * 0.2) {
        bot.anim = 'dance';
        bot.target = null;
        this.hooks.broadcastToRoom(bot.room, { t: 'emote', id: bot.id, kind: 'dance' });
        continue;
      }

      if (bot.target) {
        const dx = bot.target.x - bot.x, dz = bot.target.z - bot.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.2) {
          bot.target = null;
          // arriving at the fire means settling in, not standing over it
          bot.anim = atPost ? 'sit' : 'idle';
          bot.waitT = atPost ? 8 + Math.random() * 20 : 1.5 + Math.random() * 5;
        } else {
          const sp = WALK_SPEED * 0.55 * dt;
          bot.x += (dx / d) * sp;
          bot.z += (dz / d) * sp;
          bot.rot = Math.atan2(dx, dz);
          bot.anim = 'walk';
        }
      } else {
        bot.waitT -= dt;
        if (bot.waitT <= 0 && bot.anim !== 'dance') {
          if (bot.post) {
            // shuffle around the fire ring rather than wandering off it
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 0.8;
            bot.target = { x: bot.post.x + Math.cos(a) * r, z: bot.post.z + Math.sin(a) * r };
            bot.anim = 'walk';
          } else if (Math.random() < 0.06 && !plan) {
            // free hours only: a citizen with somewhere to be stays there
            this.migrate(bot);
          } else {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * zone.r * 0.9;
            bot.target = { x: zone.x + Math.cos(a) * r, z: zone.z + Math.sin(a) * r };
          }
        }
        // club dancers must be able to stop too (rarely), otherwise dancing is an
        // absorbing state: every bot ends up parked on the club floor forever
        // and the other four rooms empty out.
        if (bot.anim === 'dance' && Math.random() < dt * (bot.room === 'club' ? 0.03 : 0.1)) bot.anim = 'idle';
      }
    }
  }

  /**
   * A seat on the bonfire ring, one per keeper, so the two of them sit across
   * from each other instead of inside the flames. The ring stays walkable by
   * contract with the beach room (see BONFIRE in server/index.js).
   */
  firePost(bot) {
    const seat = (hashName(bot.name) % 5) / 5; // stable seat per citizen
    const a = seat * Math.PI * 2;
    const r = Math.max(1.4, this.bonfire.r * 0.6);
    return { x: this.bonfire.x + Math.cos(a) * r, z: this.bonfire.z + Math.sin(a) * r };
  }

  /** Move a citizen to `dest` (or somewhere random, for the idle wander). */
  migrate(bot, dest = null) {
    const to = dest || ROOM_IDS[Math.floor(Math.random() * ROOM_IDS.length)];
    if (to === bot.room || !BOT_ZONES[to]) return;
    const oldRoom = bot.room;
    this.hooks.broadcastToRoom(oldRoom, { t: 'pleave', id: bot.id });
    const zone = BOT_ZONES[to];
    bot.room = to;
    // every citizen owns a personal spot in each room, hash-scattered inside
    // the zone: arrivals used to land on the exact zone centre, so the whole
    // night shift slept in one capybara-totem stack in the Den
    const h = [...`${bot.id}|${to}`].reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 7);
    const ang = (h % 360) * (Math.PI / 180);
    const rad = zone.r * (0.25 + ((h >>> 9) % 60) / 100);
    bot.x = zone.x + Math.cos(ang) * rad;
    bot.z = zone.z + Math.sin(ang) * rad;
    bot.anim = 'idle';
    bot.target = null;
    bot.post = null;
    bot.asleep = false;
    this.hooks.broadcastToRoom(to, { t: 'pjoin', p: this.hooks.snapshotFor(bot) });
  }

  inRoom(roomId) {
    return [...this.bots.values()].filter((b) => b.room === roomId);
  }
}
