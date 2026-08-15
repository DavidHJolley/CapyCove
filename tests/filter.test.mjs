/**
 * Headless test for server/filter.js (wave 10A, N-09): the wordlist filter
 * driven through its two real entry points, check() and checkName().
 *
 *   node --test tests/filter.test.mjs
 *
 * filter.js is a PURE module — zero imports, no filesystem, no clock, no
 * sockets — so this needs no COVE_DATA_DIR, no fakes and no fixtures. Nothing
 * here can touch the real data directory because the module under test cannot.
 *
 * The three things worth knowing when editing the wordlist, all asserted below:
 *  - mild profanity must stay DELIVERED (the owner's call for an adult
 *    audience); if a change starts masking "damn", a test here fails;
 *  - the false-positive allowlist is load-bearing — assassin, raccoon,
 *    Scunthorpe, Pakistan and snigger each have a test;
 *  - names are judged harder than chat, and every refusal must hand back a
 *    suggestion that itself passes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../server/filter.js');
const { check, checkName, suggestName, fold, TIER, SEVERITY, stats, listTerms,
  addTerms, removeTerms, NAME_SHAPE_RE } = F;

const ok = (t, o) => check(t, o).ok;
const sev = (t, o) => check(t, o).severity;

/* ── 1. import shape ───────────────────────────────────────────────────── */
test('module surface', () => {
  for (const fn of ['check', 'checkName', 'suggestName', 'fold', 'addTerms',
    'removeTerms', 'listTerms', 'stats']) assert.equal(typeof F[fn], 'function');
  assert.equal(typeof F.default.check, 'function');
  const s = stats();
  assert.ok(s.terms > 150, `term count ${s.terms}`);
  assert.equal(s.rejected, 0);
  for (const t of Object.values(TIER)) assert.ok(s.byTier[t] > 0, t);
});

/* ── 2. clean text is untouched ────────────────────────────────────────── */
test('clean chat passes through byte-identical', () => {
  const lines = [
    'hey! anyone want to race at the peak?',
    'i found a raccoon in the jungle :)',
    'my capy is wearing the Golden Pickaxe',
    'Class of assassins passed the analysis, cocktail time',
    'the cocoa is at the bonfire, come sit',
    'Scunthorpe is a real place and so is Penistone',
    'wet back from the drift, brb',
    'is she male or female? cant tell with hats on',
    'shall we play badminton in the plaza',
    '',
    '   ',
  ];
  for (const l of lines) {
    const r = check(l);
    assert.equal(r.ok, true, l);
    assert.equal(r.severity, SEVERITY.NONE, `${l} -> ${JSON.stringify(r.hits)}`);
    assert.equal(r.cleaned, l, l);
    assert.equal(r.changed, false, l);
  }
});

/* ── 3. owner decision: mild profanity LIVES ───────────────────────────── */
test('mild profanity is delivered untouched, flagged mild', () => {
  for (const l of ['that boss fight was fucking hard', 'oh shit i fell off',
    'damn that was close', 'what the hell', 'this game is crap sometimes',
    'get your ass over here']) {
    const r = check(l);
    assert.equal(r.ok, true, l);
    assert.equal(r.cleaned, l, l);
    assert.equal(r.changed, false, l);
    assert.equal(r.severity, SEVERITY.MILD, l);
    assert.ok(r.hits.length >= 1, l);
  }
});

test('strict mode masks the mild tier for callers who want it', () => {
  const r = check('oh shit', { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.severity, SEVERITY.MASK);
  assert.equal(r.cleaned, 'oh ****');
});

/* ── 4. mask tier ──────────────────────────────────────────────────────── */
test('crude vocabulary is starred but still delivered', () => {
  const r = check('you are such a slut');
  assert.equal(r.ok, true);
  assert.equal(r.severity, SEVERITY.MASK);
  assert.equal(r.cleaned, 'you are such a ****');
  assert.equal(r.changed, true);
  const r2 = check('send me your nudes please');
  assert.equal(r2.cleaned, 'send me your ***** please');
});

test('masking preserves length, capitals and punctuation around it', () => {
  const r = check('Wow, CUNT! ok');
  assert.equal(r.ok, true);
  assert.equal(r.cleaned, 'Wow, ****! ok');
});

/* ── 5. block tier ─────────────────────────────────────────────────────── */
test('slurs and harassment are refused outright', () => {
  const bad = [
    'you are a nigger',
    'shut up you faggot',
    'kys loser',
    'kill yourself',
    'go and hang yourself',
    'retard',
    'heil hitler',
    'send nudes',
  ];
  for (const l of bad) {
    const r = check(l);
    assert.equal(r.ok, false, l);
    assert.equal(r.severity, SEVERITY.BLOCK, l);
    assert.ok(r.msg, l);
  }
});

/* ── 6. evasion ────────────────────────────────────────────────────────── */
test('leetspeak folds', () => {
  for (const l of ['n1gg3r', 'f@ggot', 'ph', 'n1663r', 'fa990t', 'k y s']) {
    if (l === 'ph') continue;
    assert.equal(ok(l), false, l);
  }
});

test('repeats, spacing and punctuation between every letter', () => {
  for (const l of ['niiiigger', 'f a g g o t', 'f-a-g-g-o-t', 'k.y.s',
    'N I G G E R', 'kill  yourself', 'killyourself']) {
    assert.equal(ok(l), false, l);
  }
});

test('ambiguous leet: 1 reads as both i and l (AUDIT F-21 names both)', () => {
  assert.equal(check('k1llyourself').ok, false, 'k1ll -> kill');
  assert.equal(check('s1ut').severity, SEVERITY.MASK, 's1ut -> slut');
  assert.equal(check('n1gg3r').ok, false);
  // and the variant pass must not invent hits in ordinary text
  for (const l of ['the a1 sauce', 'hello!', 'meet at 1pm', 'i won 1st place']) {
    assert.equal(check(l).severity, SEVERITY.NONE, l);
  }
});

test('digit folding needs two real letters, so 0.45s is not a swear', () => {
  assert.equal(check('the sled run took 0.45s').severity, SEVERITY.NONE);
  assert.equal(fold('1488'), '1488');
});

test('kkkk is laughter, not a hate symbol', () => {
  assert.equal(check('kkkkk that was funny').ok, true);
  assert.equal(check('const k = kk * kk * (3 - 2 * kk);').severity, SEVERITY.NONE);
});

test('unicode: fullwidth, accents and cyrillic homoglyphs', () => {
  assert.equal(ok('ｆａｇｇｏｔ'), false, 'fullwidth');
  assert.equal(ok('fággót'), false, 'accents');
  assert.equal(ok('niggеr'), false, 'cyrillic e');   // U+0435
  assert.equal(ok('nіgger'), false, 'ukrainian i');  // U+0456
});

test('hidden inside another token (the loose pass)', () => {
  assert.equal(ok('xXfaggotXx'), false);
  assert.equal(ok('supernigger123'), false);
});

test('zero-width and combining junk does not smuggle a slur', () => {
  assert.equal(ok('n\u200bi\u200bg\u200bg\u200be\u200br'), false, 'ZWSP');
  assert.equal(ok('n\u0301igger'), false, 'combining acute');
});

/* ── 7. false positives, the whole point of the allowlist ──────────────── */
test('Scunthorpe and friends survive', () => {
  const innocent = [
    'assassin', 'assess the assets', 'a class act', 'green grass',
    'the analysis of the canal', 'cocktail at the cockpit', 'peacock',
    'raccoon', 'cocoon', 'a tycoon', 'Pakistan', 'Nigeria', 'a snigger',
    'shiitake mushrooms', 'documents', 'cucumber', 'circumstance',
    'Essex and Sussex', 'fire retardant', 'titmouse', 'the constitution',
    'Dickens', 'arsenal', 'sparse', 'spice and spicy food', 'password',
    'compassion', 'a grasshopper', 'beetroot', 'an observer', 'ecosystem',
  ];
  for (const l of innocent) {
    const r = check(l);
    assert.equal(r.severity, SEVERITY.NONE, `${l} -> ${JSON.stringify(r.hits)}`);
  }
});

test('a single space is not evasion: ordinary English is not a slur', () => {
  for (const l of ['my wet back', 'is she male', 'the flag got wet',
    'he is a fine mod erator']) {
    assert.equal(check(l).severity, SEVERITY.NONE, l);
  }
});

/* ── 8. hits and spans ─────────────────────────────────────────────────── */
test('hits carry term, tier and a span into the ORIGINAL string', () => {
  const src = 'ugh, SLUT.';
  const r = check(src);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].term, 'slut');
  assert.equal(r.hits[0].tier, TIER.MASK);
  const [a, b] = r.hits[0].at;
  assert.equal(src.slice(a, b), 'SLUT');
});

test('hits are capped but masking is NOT', () => {
  const r = check(Array(40).fill('slut').join(' '));
  assert.ok(r.hits.length <= F.MAX_HITS, 'report list capped');
  assert.equal(/slut/i.test(r.cleaned), false, 'every occurrence starred');
  assert.equal(r.cleaned, Array(40).fill('****').join(' '));
});

/* ── 9. robustness ─────────────────────────────────────────────────────── */
test('never throws, whatever it is handed', () => {
  for (const v of [null, undefined, 0, 1, {}, [], true, NaN,
    'x'.repeat(5000), '\u0000\u0000', '😀🐹', '%s%s%n', '../../etc/passwd',
    '<script>alert(1)</script>', 'a'.repeat(300) + 'fuck']) {
    const r = check(v);
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(typeof r.cleaned, 'string');
    assert.ok(Array.isArray(r.hits));
    assert.ok(SEVERITY[r.severity.toUpperCase()] !== undefined);
  }
});

test('catastrophic backtracking does not happen on adversarial input', () => {
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) check('f'.repeat(60) + ' ' + 'a b c d e '.repeat(6));
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, `200 adversarial lines took ${dt}ms`);
});

test('throughput is sane for a 10Hz server', () => {
  const line = 'hey! anyone want to race at the peak? my capy has a new hat';
  const t0 = Date.now();
  for (let i = 0; i < 5000; i++) check(line);
  const dt = Date.now() - t0;
  assert.ok(dt < 2000, `5000 clean lines took ${dt}ms`);
  console.log(`      clean-line cost: ${(dt / 5000).toFixed(4)} ms`);
});

/* ── 10. checkName ─────────────────────────────────────────────────────── */
test('good names pass', () => {
  for (const n of ['Mango', 'capy_lord', 'Racoon', 'Grassy', 'Bassett',
    'Spice', 'Analyst', 'Titan', 'Cocoa99', 'x_x_x', 'Badminton', 'Squawk']) {
    const r = checkName(n);
    assert.equal(r.ok, true, `${n} -> ${r.code} ${JSON.stringify(r.hits)}`);
    assert.equal(r.code, 'clean', n);
  }
});

test('shape is enforced before content', () => {
  for (const n of ['ab', 'a'.repeat(17), 'has space', 'emoji😀', 'semi;colon', '']) {
    const r = checkName(n);
    assert.equal(r.ok, false, n);
    assert.equal(r.code, 'shape', n);
    assert.ok(NAME_SHAPE_RE.test(r.suggestion), `${n} -> ${r.suggestion}`);
  }
});

test('names are stricter than chat: mild profanity is refused in a name', () => {
  const r = checkName('shitlord');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'mild');
  assert.equal(check('shitlord').ok, true, 'same word is fine in chat');
});

test('short reserved words must BE the whole name', () => {
  for (const n of ['Mood', 'Modes', 'Moody', 'Model', 'Devon', 'Modest', 'Staffy']) {
    assert.equal(checkName(n).ok, true, `${n} -> ${checkName(n).code}`);
  }
  for (const n of ['mod', 'MOD', 'dev']) assert.equal(checkName(n).ok, false, n);
});

test('staff impersonation is reserved', () => {
  for (const n of ['admin', 'xX_admin_Xx', 'CapyCove', 'Moderator', 'ADM1N',
    'staff', 'server', 'sysop', 'coveSTAFF']) {
    const r = checkName(n);
    assert.equal(r.ok, false, n);
    assert.equal(r.code, 'reserved', `${n} -> ${r.code}`);
  }
});

test('slur names are blocked and evasion in a name is caught', () => {
  for (const n of ['nigger', 'FaGgOt', 'n1gg3r', 'xXfaggotXx', 'kys_now',
    'wetback', 'shemale420', 'retard']) {
    const r = checkName(n);
    assert.equal(r.ok, false, n);
    assert.ok(['blocked', 'masked'].includes(r.code), `${n} -> ${r.code}`);
    assert.equal(r.severity, SEVERITY.BLOCK, n);
  }
});

test('guest names (spaces allowed) content-check with shape off', () => {
  // AUDIT F-26's own example: the guest name path allows spaces.
  const r = checkName('Kill Yourself', { shape: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'blocked');
  assert.ok(NAME_SHAPE_RE.test(r.suggestion), r.suggestion);
  assert.equal(checkName('Sleepy Capy', { shape: false }).ok, true);
  assert.equal(checkName('', { shape: false }).ok, false, 'still refuses empty');
  // the same name through the registered path fails on shape first
  assert.equal(checkName('Sleepy Capy').code, 'shape');
});

/* ── 11. forced rename ─────────────────────────────────────────────────── */
test('every refusal carries a usable suggestion', () => {
  for (const n of ['nigger', 'admin', 'shitlord', 'ab', 'slut_queen',
    'xXfaggotXx', 'kys', 'CUNT']) {
    const r = checkName(n);
    assert.equal(r.ok, false, n);
    assert.ok(typeof r.suggestion === 'string', n);
    assert.ok(NAME_SHAPE_RE.test(r.suggestion), `${n} -> ${r.suggestion}`);
    const again = checkName(r.suggestion);
    assert.equal(again.ok, true, `${n} -> ${r.suggestion} -> ${again.code}`);
  }
});

test('suggestions salvage the innocent half of a name when they can', () => {
  const r = checkName('slut_queen');
  assert.equal(r.ok, false);
  assert.ok(/queen/i.test(r.suggestion), r.suggestion);
});

test('suggestions are deterministic and seedable', () => {
  const a = checkName('nigger').suggestion;
  const b = checkName('nigger').suggestion;
  assert.equal(a, b);
  const c = checkName('nigger', { seed: 2 }).suggestion;
  assert.notEqual(a, c);
});

test('suggestName always returns a clean, shape-valid cove name', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const n = suggestName(`player${i}`, { seed: i });
    assert.ok(NAME_SHAPE_RE.test(n), n);
    assert.equal(checkName(n).ok, true, n);
    seen.add(n);
  }
  assert.ok(seen.size > 300, `only ${seen.size} distinct names in 500 draws`);
});

test('suggest can be switched off (no recursion, cheap path)', () => {
  const r = checkName('admin', { suggest: false });
  assert.equal(r.ok, false);
  assert.equal(r.suggestion, undefined);
});

/* ── 12. operator tuning ───────────────────────────────────────────────── */
test('addTerms / removeTerms retune at runtime', () => {
  assert.equal(check('bananaslug').ok, true);
  assert.equal(addTerms(TIER.BLOCK, ['bananaslug']), 1);
  assert.equal(check('you bananaslug').ok, false);
  assert.equal(removeTerms(['bananaslug']), 1);
  assert.equal(check('you bananaslug').ok, true);
  assert.equal(addTerms('nonsense-tier', ['x']), 0);
  assert.equal(addTerms(TIER.MILD, ['bad word!!', '  ']), 0, 'garbage rejected');
});

test('listTerms filters by tier', () => {
  const block = listTerms(TIER.BLOCK);
  assert.ok(block.length > 40);
  assert.ok(block.every((t) => t.tier === TIER.BLOCK));
  assert.ok(block.some((t) => t.loose));
});

/* ── 13. fold is exported for debugging ────────────────────────────────── */
test('fold exposes the normalised form', () => {
  assert.equal(fold('Hello, World!'), 'hello world ');
  assert.equal(fold('N1GG3R'), 'nigger');
  assert.equal(fold('1488'), '1488', 'pure-digit tokens stay numeric');
  assert.equal(fold('ＣＡＰＹ'), 'capy');
});
