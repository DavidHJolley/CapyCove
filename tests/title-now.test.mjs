import { strict as assert } from 'node:assert';
import test from 'node:test';

import { coveNowLines } from '../src/ui/title.js';

/**
 * The title screen's "This week in the cove" ticker reads GET /api/now, which
 * answers with server/events.js frame() verbatim. These tests pin the two
 * things that matter about that read:
 *
 *  1. it never throws, whatever shape the calendar hands it (a calendar one
 *     version ahead of this client must still let a player log in), and
 *  2. it says nothing rather than something empty, so the ticker falls back to
 *     its evergreen lines instead of flashing a blank strip.
 */

test('coveNowLines survives every missing-field shape', () => {
  for (const bad of [undefined, null, {}, { active: null }, { active: 'nope' },
    { active: [null, 1, 'x'] }, { next: 5 }, { active: [{}], next: {} }]) {
    assert.deepEqual(coveNowLines(bad), [], `empty for ${JSON.stringify(bad)}`);
  }
});

test('an active event reads as a sentence with its time left', () => {
  const [line] = coveNowLines({
    active: [{ id: 'friday-fete', name: 'Friday Fete', blurb: 'Bunting in the plaza.', endsIn: 2640 }],
  });
  assert.match(line, /^Friday Fete is on right now\./);
  assert.match(line, /Bunting in the plaza\./);
  assert.match(line, /44 minutes left\./);
});

test('a one-minute tail is singular and a zero tail is omitted', () => {
  const [a] = coveNowLines({ active: [{ name: 'Sunday Splash', endsIn: 60 }] });
  assert.match(a, /One minute left\./);
  const [b] = coveNowLines({ active: [{ name: 'Sunday Splash', endsIn: 0 }] });
  assert.equal(b, 'Sunday Splash is on right now.');
});

test('at most two active events are quoted, plus the next one', () => {
  const out = coveNowLines({
    active: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    next: { name: 'D', startsIn: 3600 * 5 },
  });
  assert.equal(out.length, 3);
  assert.match(out[2], /^Coming up: D, in about 5 hours\./);
});

test('the countdown phrasing steps through minutes, hours and days', () => {
  const at = (startsIn) => coveNowLines({ next: { name: 'X', startsIn } })[0];
  assert.match(at(0), /any minute now/);
  assert.match(at(45), /in a minute/);
  assert.match(at(60 * 40), /in 40 minutes/);
  assert.match(at(3600), /in 60 minutes/); // still minutes below 90
  assert.match(at(3600 * 2), /in about 2 hours/);
  assert.match(at(3600 * 9), /in about 9 hours/);
  assert.match(at(3600 * 26), /tomorrow/);
  assert.match(at(86400 * 4), /in 4 days/);
});

test('operator copy is flattened and length-capped, never passed through raw', () => {
  const [line] = coveNowLines({
    active: [{ name: `Party${'!'.repeat(80)}`, blurb: 'a\n\n  b\tc' }],
  });
  assert.ok(line.length <= 150, `line was ${line.length} chars`);
  assert.ok(!/[\n\t]/.test(line), 'no raw whitespace control chars');
  assert.match(line, /a b c/);
});
