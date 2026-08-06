import { BOT_ZONES, HATS, BODY_COLORS, ROOM_IDS, WALK_SPEED } from '../shared/constants.js';

// Ambient capybaras: server-simulated players so rooms never feel empty.
// They wander their room's guaranteed-walkable zone, chat, emote, and
// occasionally migrate to another room.

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
};

let nextBotId = 1;

export class BotManager {
  /** hooks: {broadcastToRoom(roomId, msg), snapshotFor(bot)} provided by index.js */
  constructor(hooks, { perRoom = 2 } = {}) {
    this.hooks = hooks;
    this.bots = new Map(); // id -> bot
    const shuffled = [...NAMES].sort(() => Math.random() - 0.5);
    let n = 0;
    for (const room of ROOM_IDS) {
      for (let i = 0; i < perRoom; i++) this.spawn(shuffled[n++ % shuffled.length], room);
    }
  }

  spawn(name, room) {
    const zone = BOT_ZONES[room];
    const id = `bot-${nextBotId++}`;
    const hatPool = Object.keys(HATS);
    const bot = {
      id,
      bot: true,
      name,
      room,
      x: zone.x + (Math.random() - 0.5) * zone.r,
      z: zone.z + (Math.random() - 0.5) * zone.r,
      rot: Math.random() * Math.PI * 2,
      anim: 'idle',
      color: BODY_COLORS[Math.floor(Math.random() * BODY_COLORS.length)],
      hat: Math.random() < 0.5 ? hatPool[Math.floor(Math.random() * hatPool.length)] : 'none',
      target: null,
      waitT: Math.random() * 4,
      chatT: 6 + Math.random() * 20,
      moveT: 0,
    };
    this.bots.set(id, bot);
    return bot;
  }

  update(dt) {
    for (const bot of this.bots.values()) {
      const zone = BOT_ZONES[bot.room];

      // chatter
      bot.chatT -= dt;
      if (bot.chatT <= 0) {
        bot.chatT = 14 + Math.random() * 30;
        const pool = [...CHAT.any, ...(CHAT[bot.room] || [])];
        const text = pool[Math.floor(Math.random() * pool.length)];
        this.hooks.broadcastToRoom(bot.room, { t: 'chat', id: bot.id, name: bot.name, text });
      }

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
          bot.anim = 'idle';
          bot.waitT = 1.5 + Math.random() * 5;
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
          // occasionally migrate rooms, otherwise wander the zone
          if (Math.random() < 0.06) {
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

  migrate(bot) {
    const dest = ROOM_IDS[Math.floor(Math.random() * ROOM_IDS.length)];
    if (dest === bot.room) return;
    const oldRoom = bot.room;
    this.hooks.broadcastToRoom(oldRoom, { t: 'pleave', id: bot.id });
    const zone = BOT_ZONES[dest];
    bot.room = dest;
    bot.x = zone.x;
    bot.z = zone.z;
    bot.anim = 'idle';
    bot.target = null;
    this.hooks.broadcastToRoom(dest, { t: 'pjoin', p: this.hooks.snapshotFor(bot) });
  }

  inRoom(roomId) {
    return [...this.bots.values()].filter((b) => b.room === roomId);
  }
}
