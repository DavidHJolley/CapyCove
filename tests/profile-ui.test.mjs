import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAMP_SECTIONS,
  SHOWCASE_MAX,
  albumSections,
  daysInCove,
  equippedFlair,
  favoriteGame,
  foundThisWeek,
  normalizeCharms,
  normalizeShowcase,
  stampCatalog,
} from '../src/ui/profile.js';

/**
 * Profile card v2, the parts that can be wrong quietly (wave AAA-C2).
 *
 * These run WITHOUT a DOM on purpose: importing src/ui/profile.js must never
 * touch document, and every helper below decides what the card says about
 * somebody. A shelf that silently swallows a stamp, or a "found it" that is
 * really "we could not tell", is exactly the kind of bug a screenshot passes.
 */

// ---------------------------------------------------------------------------
// album shelves
// ---------------------------------------------------------------------------

test('every stamp in the live catalog lands on exactly one shelf', () => {
  const cat = stampCatalog();
  const secs = albumSections(cat, []);
  const seen = new Set();
  let total = 0;
  for (const s of secs) {
    total += s.stamps.length;
    for (const st of s.stamps) {
      assert.ok(!seen.has(st.id), `${st.id} is on two shelves`);
      seen.add(st.id);
    }
  }
  assert.equal(total, cat.length, 'a shelf swallowed a stamp');
  assert.equal(seen.size, cat.length);
});

test('the catch-all shelf is not drawn when nothing needs it', () => {
  const keys = albumSections(stampCatalog(), []).map((s) => s.key);
  assert.ok(!keys.includes('odds'), 'every shipped stamp should be filed by name');
  // ...but an unknown id still gets a home rather than vanishing
  const odd = albumSections([{ id: 'mystery_thing', sect: 'nope' }], []);
  assert.equal(odd.length, 1);
  assert.equal(odd[0].key, 'odds');
});

test('shelf completion counts only what was earned, and rounds for display', () => {
  const cat = [
    { id: 'a', sect: 'play' }, { id: 'b', sect: 'play' }, { id: 'c', sect: 'play' },
    { id: 'd', sect: 'cove' },
  ];
  const secs = albumSections(cat, ['a', 'b', 'zzz']);
  const play = secs.find((s) => s.key === 'play');
  const cove = secs.find((s) => s.key === 'cove');
  assert.equal(play.got, 2);
  assert.equal(play.total, 3);
  assert.equal(play.pct, 67);
  assert.equal(cove.got, 0);
  assert.equal(cove.pct, 0);
});

test('albumSections survives junk instead of dropping the whole album', () => {
  assert.deepEqual(albumSections(null, null), []);
  assert.deepEqual(albumSections([null, 7, {}, { id: 5 }], null), []);
  // a Set and an array of ids mean the same thing
  const cat = [{ id: 'a', sect: 'play' }];
  assert.equal(albumSections(cat, new Set(['a']))[0].got, 1);
  assert.equal(albumSections(cat, ['a'])[0].got, 1);
});

test('the shelf list is stable and every shelf has a name and a blurb', () => {
  for (const s of STAMP_SECTIONS) {
    assert.equal(typeof s.key, 'string');
    assert.ok(s.name.length > 2, s.key);
    assert.ok(s.blurb.length > 8, s.key);
  }
});

// ---------------------------------------------------------------------------
// the charm board
// ---------------------------------------------------------------------------

test('normalizeCharms reads the profile ride-along and the charm frame alike', () => {
  const ride = normalizeCharms({
    charms: [{ id: 'compass', name: 'Salt-Worn Compass', week: '2026-W33', at: 5 }],
    charmCount: 4,
  });
  assert.equal(ride.found.length, 1);
  assert.equal(ride.found[0].name, 'Salt-Worn Compass');
  // the ride-along is capped, the count is not: the card says "and 3 more"
  assert.equal(ride.count, 4);

  const frame = normalizeCharms({ t: 'charm', mine: [{ id: 'a', week: '2026-W30' }], charmCount: 1 });
  assert.equal(frame.found[0].name, 'a', 'a nameless charm falls back to its id');
  assert.equal(frame.count, 1);
});

test('a count smaller than the list is never trusted over the list', () => {
  const b = normalizeCharms({ charms: [{ id: 'a' }, { id: 'b' }], charmCount: 0 });
  assert.equal(b.count, 2);
});

test('normalizeCharms is total: junk is an empty board, never a throw', () => {
  for (const junk of [null, undefined, 7, 'no', {}, { charms: 'nope' }, [null, 3, { id: 5 }]]) {
    const b = normalizeCharms(junk);
    assert.deepEqual(b.found, [], JSON.stringify(junk));
    assert.equal(b.count, 0);
  }
});

test('foundThisWeek says "cannot tell" rather than guessing "no"', () => {
  const week = '2026-W33';
  assert.equal(foundThisWeek(normalizeCharms({ charms: [{ id: 'a', week }] }), week), true);
  assert.equal(foundThisWeek(normalizeCharms({ charms: [{ id: 'a', week: '2026-W20' }] }), week), false);
  // an empty board really has not found it
  assert.equal(foundThisWeek(normalizeCharms({ charms: [] }), week), false);
  // a board whose entries carry no week at all cannot answer, and must not lie
  assert.equal(foundThisWeek(normalizeCharms({ charms: [{ id: 'a' }] }), week), null);
  assert.equal(foundThisWeek(normalizeCharms({}), null), null);
  assert.equal(foundThisWeek(null, week), null);
});

// ---------------------------------------------------------------------------
// best-of
// ---------------------------------------------------------------------------

test('plays win the best-of line whenever the server volunteers them', () => {
  const fav = favoriteGame({ fishing: 90, sled: 4000 }, { fishing: 2, kart: 11 });
  assert.deepEqual(fav, { id: 'kart', n: 11, why: 'plays' });
});

test('without plays, the ladder answers, and says so', () => {
  // 4200 is gold on the sled ladder; 40 is bronze-ish on fishing
  const fav = favoriteGame({ fishing: 40, sled: 4200 }, null);
  assert.equal(fav.id, 'sled');
  assert.equal(fav.why, 'medal');
  assert.equal(fav.n, 4200);
});

test('a player with nothing on the board gets no best-of line at all', () => {
  assert.equal(favoriteGame({}, null), null);
  assert.equal(favoriteGame({ fishing: 0 }, { fishing: 0 }), null);
  assert.equal(favoriteGame(null, null), null);
  // a plays map full of zeroes falls through to the ladder rather than lying
  assert.equal(favoriteGame({ sled: 900 }, { sled: 0 }).why, 'medal');
});

// ---------------------------------------------------------------------------
// header facts
// ---------------------------------------------------------------------------

test('days in the cove counts the first day as day one', () => {
  const now = 1_800_000_000_000;
  assert.equal(daysInCove(now, now), 1);
  assert.equal(daysInCove(now - 86_400_000 * 41, now), 42);
});

test('an absent or impossible join date draws no pill', () => {
  const now = 1_800_000_000_000;
  for (const junk of [null, undefined, 0, -5, 'no', {}, now + 86_400_000 * 3]) {
    assert.equal(daysInCove(junk, now), null, JSON.stringify(junk));
  }
});

// ---------------------------------------------------------------------------
// showcase
// ---------------------------------------------------------------------------

test('a showcase is deduped, capped, and null when the server did not say', () => {
  assert.equal(normalizeShowcase({}), null, 'absent is not the same as empty');
  assert.deepEqual(normalizeShowcase({ showcase: [] }), []);
  assert.deepEqual(normalizeShowcase(['a', 'a', 'b', 'c', 'd']), ['a', 'b', 'c']);
  assert.equal(SHOWCASE_MAX, 3);
});

test('a pin for a stamp they do not own is dropped, not drawn as a mystery', () => {
  assert.deepEqual(normalizeShowcase({ showcase: ['a', 'b'] }, new Set(['b'])), ['b']);
  assert.deepEqual(normalizeShowcase({ showcase: ['a'] }, ['a']), ['a']);
});

// ---------------------------------------------------------------------------
// the trail / aura slot (fleet C1's cosmetic; this card only renders it)
// ---------------------------------------------------------------------------

test('an equipped trail renders from its id alone', () => {
  const f = equippedFlair({ trail: 'aurora_wake' });
  assert.equal(f.kind, 'Trail');
  assert.equal(f.id, 'aurora_wake');
  assert.equal(f.name, 'Aurora wake', 'an id with no catalog is still readable');
  assert.equal(f.color, null);
});

test('nothing equipped, and no slot at all, both draw nothing', () => {
  for (const junk of [null, undefined, {}, { trail: '' }, { trail: 'none' }, { aura: 'none' }, 7]) {
    assert.equal(equippedFlair(junk), null, JSON.stringify(junk));
  }
});

test('an object-shaped slot keeps its own colour', () => {
  const f = equippedFlair({ aura: { id: 'moonlit', color: 0x9b6bd4 } });
  assert.equal(f.kind, 'Aura');
  assert.equal(f.id, 'moonlit');
  assert.equal(f.color, 0x9b6bd4);
});
