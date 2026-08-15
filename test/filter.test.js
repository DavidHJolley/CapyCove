/**
 * server/filter.js: the three tier decisions, the folding that defeats
 * evasion, and the contract every name refusal carries — a suggestion that is
 * itself a legal name.
 *
 *   node --test test/
 *
 * filter.js imports nothing, reads no clock and touches no disk, so this file
 * needs no sandbox, no fakes and no fixtures. Anything that fails here is a
 * change to the wordlist or to the scanner, never to the environment.
 *
 * tests/filter.test.mjs (wave 10) is the wordlist's own regression net and goes
 * wider on false positives. This file is the wave-11 baseline: it pins the
 * DECISIONS the rest of the server depends on — that mild text is delivered
 * byte-identical, that a block is refused with a message, and that every
 * refusal a player can hit hands back something they can click.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../server/filter.js');
const {
  check, checkName, suggestName, fold, TIER, SEVERITY, stats, NAME_SHAPE_RE,
} = F;

/* ── module surface ─────────────────────────────────────────────────────── */

test('filter exports the surface the server calls', () => {
  for (const fn of ['check', 'checkName', 'suggestName', 'fold']) {
    assert.equal(typeof F[fn], 'function', fn);
  }
  const s = stats();
  assert.ok(s.terms > 150, `only ${s.terms} terms registered`);
  assert.equal(s.rejected, 0, 'a wordlist entry was dropped at registration');
  for (const tier of Object.values(TIER)) assert.ok(s.byTier[tier] > 0, `tier ${tier} is empty`);
});

/* ── tier decisions ─────────────────────────────────────────────────────── */

test('clean text comes back byte-identical and unflagged', () => {
  for (const line of [
    'anyone up for a sled race at the peak?',
    'i saw a raccoon by the cocoa stand',
    'my best smoothie run was 0.45s off the record',
    '',
  ]) {
    const r = check(line);
    assert.equal(r.ok, true, line);
    assert.equal(r.severity, SEVERITY.NONE, `${line} -> ${JSON.stringify(r.hits)}`);
    assert.equal(r.cleaned, line, line);
    assert.equal(r.changed, false, line);
    assert.deepEqual(r.hits, [], line);
  }
});

test('MILD is delivered exactly as typed (the owner decision)', () => {
  // Swearing is not abuse. If a wordlist edit ever starts masking these, the
  // game gets meaner without anybody deciding to make it meaner.
  for (const line of ['damn that was close', 'oh shit i fell off the ramp',
    'this hill is fucking steep', 'what the hell was that']) {
    const r = check(line);
    assert.equal(r.ok, true, line);
    assert.equal(r.severity, SEVERITY.MILD, line);
    assert.equal(r.cleaned, line, line);
    assert.equal(r.changed, false, line);
    assert.ok(r.hits.length >= 1, line);
    assert.equal(r.msg, null, line);
  }
});

test('MASK is delivered with stars, keeping length and surrounding text', () => {
  const r = check('Wow, CUNT! ok');
  assert.equal(r.ok, true);
  assert.equal(r.severity, SEVERITY.MASK);
  assert.equal(r.cleaned, 'Wow, ****! ok');
  assert.equal(r.changed, true);
});

test('BLOCK is refused with a message and never delivered', () => {
  for (const line of ['you are a nigger', 'kys loser', 'kill yourself']) {
    const r = check(line);
    assert.equal(r.ok, false, line);
    assert.equal(r.severity, SEVERITY.BLOCK, line);
    assert.ok(typeof r.msg === 'string' && r.msg.length > 0, line);
    assert.ok(!r.cleaned.includes('nigger'), line);
  }
});

test('the worst hit on a line wins', () => {
  const r = check('damn you nigger');
  assert.equal(r.severity, SEVERITY.BLOCK);
  assert.equal(r.ok, false);
  const r2 = check('damn that slut');
  assert.equal(r2.severity, SEVERITY.MASK);
  assert.equal(r2.ok, true);
});

test('strict masks the mild tier, mask:false returns the raw text', () => {
  assert.equal(check('oh shit', { strict: true }).cleaned, 'oh ****');
  assert.equal(check('you are a slut', { mask: false }).cleaned, 'you are a slut');
  assert.equal(check('kill yourself', { mask: false }).cleaned, '');
});

test('check never throws and never returns undefined fields', () => {
  for (const junk of [undefined, null, 42, {}, []]) {
    const r = check(junk);
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(typeof r.cleaned, 'string');
    assert.ok(Array.isArray(r.hits));
  }
});

/* ── folding (the evasion layer) ────────────────────────────────────────── */

test('fold normalises leet, case, fullwidth and homoglyphs', () => {
  assert.equal(fold('N1GG3R'), 'nigger');
  assert.equal(fold('Sh1t'), 'shit');
  assert.equal(fold('ｆａｇ'), 'fag');       // fullwidth
  assert.equal(fold('сock'), 'cock');               // cyrillic es
  // digits alone are not letters: a lap time must survive the fold
  assert.equal(fold('1488'), '1488');
});

test('folding catches the evasions players actually try', () => {
  for (const line of ['n1gg3r', 'f@ggot', 'f a g g o t', 'f-a-g-g-o-t',
    'niiiigger', 'N I G G E R', 'killyourself', 'k.y.s',
    'n​i​g​g​e​r', 'xXfaggotXx']) {
    assert.equal(check(line).ok, false, line);
  }
});

test('the allowlist is load-bearing: innocent words stay innocent', () => {
  for (const line of ['assassin', 'a raccoon in the jungle', 'Scunthorpe',
    'Pakistan', 'a snigger escaped me', 'cocktail hour', 'the analysis',
    'shiitake mushrooms', 'wet back from the drift', 'is she male or female']) {
    assert.equal(check(line).severity, SEVERITY.NONE, `${line} -> ${JSON.stringify(check(line).hits)}`);
  }
});

/* ── checkName ──────────────────────────────────────────────────────────── */

test('checkName enforces the account name shape', () => {
  for (const bad of ['xx', 'a'.repeat(17), 'has space', 'punct!', '']) {
    const r = checkName(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.code, 'shape', bad);
  }
  assert.equal(checkName('MossyOtter').ok, true);
  assert.equal(checkName('capy_42').ok, true);
});

test('shape:false is the guest path: spaces allowed, content still judged', () => {
  // server/index.js builds a guest display name with cleanName(), which permits
  // spaces and hyphens, so the shape gate has to come off there and only there.
  assert.equal(checkName('Sandy Paws', { shape: false }).ok, true);
  const r = checkName('Kill Yourself', { shape: false, suggest: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'blocked');
  assert.ok(r.suggestion, 'a refused guest name must offer an alternative');
});

test('names are judged harder than chat', () => {
  // 'shit' is MILD in chat and delivered; as a name it is refused.
  assert.equal(check('sh1tlord').ok, true);
  const n = checkName('Sh1tlord');
  assert.equal(n.ok, false);
  assert.equal(n.code, 'mild');
  // ...unless the caller opts out of strict, which nothing in the server does
  assert.equal(checkName('Sh1tlord', { strict: false }).ok, true);
});

test('impersonation names are reserved, ordinary words are not', () => {
  for (const bad of ['Admin', 'AdminGuy', 'Moderator', 'CoveStaff', 'SYSTEM']) {
    const r = checkName(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.code, 'reserved', bad);
  }
  // The repeat-and-affix tolerance that catches MOOOD-style evasion must not
  // eat a cozy game's worth of Moods.
  for (const fine of ['Mood', 'Modes', 'ModTeam', 'Staffy', 'Beetroot']) {
    assert.equal(checkName(fine).ok, true, fine);
  }
});

test('reserved words do not swallow ordinary English names', () => {
  // Reserved terms block as the WHOLE name or (impersonation cores only)
  // anywhere inside one; common fragments like root/support/owner stay
  // available to honest names. Fixed in the wave-11 wiring pass.
  for (const fine of ['Rootbeer', 'Grassroots', 'Supporter', 'Ownership',
    'Consoles', 'Officially', 'Servername', 'Nullify']) {
    assert.equal(checkName(fine).ok, true, fine);
  }
});

test('every refusal hands back a suggestion that itself passes', () => {
  const seen = new Set();
  for (const bad of ['Nigger1', 'Faggot', 'AdminGuy', 'CuntFace', 'Sh1tlord',
    'xx', 'has space', 'a'.repeat(20)]) {
    const r = checkName(bad);
    assert.equal(r.ok, false, bad);
    const s = r.suggestion;
    assert.equal(typeof s, 'string', bad);
    assert.ok(NAME_SHAPE_RE.test(s), `${bad} -> ${s} is not a legal name shape`);
    assert.equal(checkName(s).ok, true, `${bad} -> ${s} would be refused too`);
    seen.add(s);
  }
  assert.ok(seen.size > 1, 'every refusal offered the same name');
});

test('a salvageable name is salvaged rather than replaced', () => {
  // "Mossy_x" is a smaller punishment than a whole new identity.
  assert.equal(checkName('AdminGuy').suggestion, 'Guy');
  assert.equal(checkName('CuntFace').suggestion, 'Face');
});

test('suggest:false costs nothing and returns no suggestion', () => {
  const r = checkName('Faggot', { suggest: false });
  assert.equal(r.ok, false);
  assert.equal(r.suggestion, undefined);
});

test('suggestName is deterministic in (seedText, seed) and always legal', () => {
  assert.equal(suggestName('nigger', { seed: 1 }), suggestName('nigger', { seed: 1 }));
  assert.notEqual(suggestName('nigger', { seed: 1 }), suggestName('nigger', { seed: 2 }));
  for (let i = 0; i < 40; i++) {
    const s = suggestName(`seed-${i}`, { seed: i });
    assert.ok(NAME_SHAPE_RE.test(s), s);
    assert.equal(checkName(s).ok, true, s);
  }
});
