import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIssue, parseIndex, courierUnread } from '../src/ui/courier.js';

/**
 * The reader's wire tolerance (wave 14B). These run without a DOM on purpose:
 * importing src/ui/courier.js must never touch document, and the parsers are
 * the part of the module that can be wrong quietly.
 */

/** The frame server/courier.js actually ships. */
const REAL = {
  t: 'courier',
  week: '2026-W33',
  issueN: 7,
  headline: "Last week's charm: the Salt-Worn Compass",
  printedAt: 1786000000000,
  nextPrintAt: 1786604800000,
  articles: [
    { k: 'editorial', h: 'From the desk', body: 'A short human sentence.' },
    { k: 'charm', h: "Last week's charm: the Salt-Worn Compass", body: 'It spent the week in the mine.' },
    { k: 'play', h: 'The week in play', body: '1,204 games played.' },
    { k: 'whatson', h: 'What is on', body: 'Next up is Golden Hour, on Friday.' },
    { k: 'filler:sunset', h: 'The sunset report', body: 'Still good.' },
  ],
};

test('parseIssue reads the shipped frame and places the three special kinds', () => {
  const iss = parseIssue(REAL);
  assert.equal(iss.id, '2026-W33');
  assert.equal(iss.n, 7);
  assert.equal(iss.at, 1786000000000);
  assert.equal(iss.nextAt, 1786604800000);
  assert.equal(iss.headline, "Last week's charm: the Salt-Worn Compass");

  // editorial -> the lead, charm -> the teaser, whatson -> the gutter
  assert.equal(iss.lead.title, 'From the desk');
  assert.ok(iss.charm.body.includes('mine'));
  assert.equal(iss.whatson.title, 'What is on');

  // everything else flows into the columns, in order, including unknown kinds
  assert.deepEqual(iss.articles.map((a) => a.k), ['play', 'filler:sunset']);
  assert.equal(iss.articles[1].kind, 'filler');
});

test('an issue with no articles at all is still an issue', () => {
  const iss = parseIssue({ week: '2026-W34', issueN: 8, articles: [] });
  assert.equal(iss.id, '2026-W34');
  assert.equal(iss.lead, null);
  assert.deepEqual(iss.articles, []);
  assert.equal(iss.charm, null);
});

test('junk is null, so a stray frame can never blank a paper on screen', () => {
  for (const junk of [null, undefined, 7, 'no', [], {}, { articles: 'nope' }]) {
    assert.equal(parseIssue(junk), null, JSON.stringify(junk));
  }
});

test('articles missing every readable field are dropped, not rendered empty', () => {
  const iss = parseIssue({ week: 'w', articles: [{ k: 'x' }, { k: 'y', h: 'Real', body: 'Yes.' }] });
  assert.deepEqual(iss.articles.map((a) => a.k), ['y']);
});

test('the older sections/lines/items shape still reads', () => {
  const iss = parseIssue({
    id: 'w1',
    n: 2,
    editorial: { headline: 'Hello', body: 'Hi.' },
    sections: [{
      title: 'Top of the board',
      items: [{ name: 'Mango', score: 940, game: 'sled' }, ['Pip', 720], 'Bo'],
      lines: ['one', 'two'],
    }],
  });
  assert.equal(iss.lead.title, 'Hello');
  const s = iss.articles[0];
  assert.equal(s.title, 'Top of the board');
  assert.deepEqual(s.lines, ['one', 'two']);
  assert.deepEqual(s.items[0], { name: 'Mango', value: '940', note: 'sled' });
  assert.equal(s.items[1].value, '720');
  assert.equal(s.items[2].name, 'Bo');
});

test('long strings are clipped rather than trusted', () => {
  const iss = parseIssue({ week: 'w', headline: 'h'.repeat(500), articles: [{ k: 'a', h: 'x', body: 'b'.repeat(4000) }] });
  assert.ok(iss.headline.length <= 140);
  assert.ok(iss.articles[0].body.length <= 1400);
});

test('parseIndex sorts newest first and survives a server that sends nothing', () => {
  assert.deepEqual(parseIndex({}), []);
  assert.deepEqual(parseIndex(null), []);
  const idx = parseIndex({
    issues: [
      { week: 'a', issueN: 1, printedAt: 100 },
      { week: 'c', issueN: 3, printedAt: 300 },
      { week: 'b', issueN: 2, printedAt: 200 },
      { nope: true },
    ],
  });
  assert.deepEqual(idx.map((r) => r.id), ['c', 'b', 'a']);
});

test('unread is false until the server has named an issue', () => {
  // no frame has arrived and there is no localStorage in node: the stall must
  // not glow at a player the paper has never spoken to
  assert.equal(courierUnread(), false);
});
