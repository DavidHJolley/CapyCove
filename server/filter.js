/**
 * server/filter.js — the wordlist filter (wave 10A, N-09 / AUDIT F-21 + F-26).
 *
 * ONE job: decide what a piece of player-authored text is allowed to be. It is
 * called on `chat`, `whisper`, doodle guesses, and — through checkName() — on
 * signup, on rename, and on the forced-rename admin op.
 *
 * PURE MODULE. Zero imports: no other server file, no shared/constants.js, no
 * node builtins, no filesystem, no clock, no state that survives a call. That
 * is deliberate and load-bearing:
 *   - it can be unit-tested with `node --test` and nothing else running,
 *   - it can never be the reason a boot order breaks,
 *   - and it cannot leak the thing it is filtering into a log by accident.
 * The only mutable state in the file is the term registry, and it only moves
 * when an operator calls addTerms()/removeTerms().
 *
 * ---------------------------------------------------------------------------
 * THE API (this is the contract; everything else here is implementation)
 *
 *   check(text, opts?) -> {
 *     ok:       boolean   false = do not deliver this message, at all
 *     severity: 'none' | 'mild' | 'mask' | 'block'
 *     cleaned:  string    ALWAYS present. The text to deliver when ok is true.
 *     changed:  boolean   true when cleaned !== the input (something was
 *                         masked). Use this, not the presence of `cleaned`,
 *                         to decide whether a moderation event is worth
 *                         recording — `cleaned` is present on every result.
 *     hits:     [{ term, tier, at:[start,end] }]   spans index the INPUT
 *     msg:      string|null   player-facing line for a `toast`, or null
 *   }
 *   opts: { strict?:boolean, mask?:boolean }
 *     strict  – treat the mild tier as maskable too (default false; see the
 *               owner decision below). checkName() defaults it to TRUE.
 *     mask    – set false to skip building `cleaned` when the caller only
 *               wants the verdict (default true).
 *
 *   checkName(name, opts?) -> {
 *     ok, severity, code, msg, cleaned, suggestion?, hits
 *   }
 *   code: 'clean' | 'shape' | 'reserved' | 'blocked' | 'masked' | 'mild'
 *   `suggestion` is present only when ok is false: a clean, shape-valid name
 *   the caller can offer (forced rename) or assign. It is deterministic for a
 *   given (name, seed) so the same player is offered the same name twice.
 *   opts: { strict?:boolean = true, shape?:boolean = true,
 *           seed?:string|number, suggest?:boolean = true }
 *     shape – set FALSE for the guest hello path, whose display names may
 *             legally contain spaces and hyphens (index.js:401 cleanName).
 *
 *   suggestName(seedText?, opts?) -> string     always shape-valid and clean
 *   fold(text) -> string                        the normalised form, for tests
 *   listTerms(tier?) -> [{ term, tier, loose }]
 *   addTerms(tier, terms) / removeTerms(terms)  runtime tuning, not persisted
 *   stats() -> counts
 *
 * ---------------------------------------------------------------------------
 * OWNER DECISION baked in here (wave 10 brief): the audience is all-ages but
 * adult-nostalgia. **Slurs and harassment die; mild profanity lives.** So a
 * "fuck" in the plaza is delivered untouched and merely reported as severity
 * 'mild' (useful context for the report queue, nothing more), while a slur is
 * dropped on the floor and never reaches another player's screen. Three tiers,
 * one rule each:
 *
 *   TIER.MILD  -> delivered as typed. severity 'mild'. Swearing is not abuse.
 *   TIER.MASK  -> delivered with the word starred out. severity 'mask'.
 *                 Crude sexual and degrading-gendered vocabulary: not a hate
 *                 crime, not something a cozy world should print either.
 *   TIER.BLOCK -> not delivered. severity 'block'. Slurs, hate sloganeering,
 *                 sexual content involving minors, and self-harm directives.
 *   TIER.NAME  -> allowed in chat, refused in a NAME. Impersonation of staff,
 *                 and reserved words. checkName() applies it; check() ignores
 *                 it entirely.
 *
 * Names are held to a stricter standard than chat on purpose: a chat line is
 * gone in thirty seconds, a name is rendered over that player's head in every
 * room, forever, to everybody. checkName() therefore refuses the mild tier too
 * (strict defaults to true) and runs the aggressive substring pass.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CONTAINS THE WORDS IT BLOCKS
 *
 * A wordlist filter is a list of words. There is no way to write one that does
 * not contain them, and an incomplete list is the actual harm — it produces a
 * filter that looks like protection and is not. The list below is tiered,
 * commented, and meant to be edited by the operator: adding a term is one
 * string in one array, and every derived structure rebuilds from it.
 *
 * ---------------------------------------------------------------------------
 * HOW IT MATCHES (the interesting half)
 *
 * Naive `text.includes(word)` fails in both directions: it misses `n1gg3r`,
 * `f a g g o t` and `ｎｉｇｇｅｒ`, and it flags Scunthorpe, assassin and
 * raccoon. Four stages fix both:
 *
 *  1. FOLD. Unicode NFKD, combining marks dropped (so `ｎ`, `ń` and `ⁿ` all
 *     become `n`), a homoglyph table for the Cyrillic/Greek lookalikes that
 *     survive NFKD (`а е о р с у х` are NOT Latin letters), lowercase, and
 *     every remaining non-alphanumeric collapsed to a single space. A parallel
 *     index map is built at the same time so a match found in the folded form
 *     can be starred out of the ORIGINAL string, punctuation and capitals
 *     intact.
 *  2. LEET, but only where it means something. `@ $ ! | + ( )` fold to letters
 *     only when they sit INSIDE a run of alphanumerics (`f@ck` yes, `hello!`
 *     no, `@everyone` no). Digits fold to letters only inside a token that
 *     already contains a letter (`n1gg3r` yes, `1488` stays numeric, so a
 *     numeric hate code can still be listed as digits).
 *  3. NEUTRALISE. Every word on the false-positive allowlist (assassin, class,
 *     analysis, cocktail, raccoon, Scunthorpe, Pakistan, snigger, spice…) is
 *     overwritten IN PLACE with NULs before any term is looked for. Same
 *     length, so the index map stays valid; NUL is in no character class, so
 *     nothing can match across it. This is why `raccoon` is not a slur and
 *     `Grassy` is a legal name.
 *  4. SCAN. Each term compiles to a regex where every letter carries `+`
 *     (`fuuuuck`), a small affix group is allowed on the end (`-s -es -ed -er
 *     -ers -ing -in -y -ies -z`), and the whole thing is fenced by
 *     `(?<![a-z0-9])` / `(?![a-z0-9])` so it must be a whole word. Terms of
 *     three or more letters ALSO accept the spaced-out spelling — but only the
 *     fully spaced one, a separator between EVERY letter (`f u c k`,
 *     `k.y.s`). Allowing *one* optional space between letters instead
 *     would be strictly worse: it matches "wet back" in a game with a
 *     swimming room. Consistent separation is the evasion; a single space is
 *     usually just English.
 *     A short curated set of unambiguous slurs is ALSO matched against the
 *     "squeezed" form (all separators removed) with no word boundary at all,
 *     which is what catches `xXfaggotXx`. That second pass is opt-in per term
 *     precisely because it is the one that generates false positives — it is
 *     why `shemale` and `wetback` are NOT in it ("is she male", "wet back") —
 *     and checkName() widens it to every term of four-plus letters, because a
 *     name is one token where word boundaries barely exist (`Fuck123`,
 *     `Shitlord`) and a false reject costs one retry with a suggestion.
 *
 * Cost: two combined regexes per tier run first as a cheap reject; the ~200
 * individual patterns only run on a line that already tripped one. A clean
 * 120-character chat line therefore costs a handful of regex executions.
 */

/* ────────────────────────────── tiers & severity ───────────────────────── */

/** Term tiers. Editing a term's tier is the whole tuning knob. */
export const TIER = Object.freeze({
  MILD: 'mild',
  MASK: 'mask',
  BLOCK: 'block',
  NAME: 'name',
});

/** Result severities, worst-wins. */
export const SEVERITY = Object.freeze({
  NONE: 'none',
  MILD: 'mild',
  MASK: 'mask',
  BLOCK: 'block',
});

/** Ordering for "worst hit wins". Higher is worse. */
const SEV_RANK = Object.freeze({ none: 0, mild: 1, mask: 2, block: 3 });

/** Name shape. Mirrors shared/constants.js NAME_MIN_LEN / NAME_MAX_LEN. */
export const NAME_MIN = 3;
export const NAME_MAX = 16;
/** The shape auth.js enforces, restated so this module needs no import. */
export const NAME_SHAPE_RE = /^[A-Za-z0-9_]{3,16}$/;

/** Most hits reported on one line. A spammer does not get an unbounded array. */
export const MAX_HITS = 8;

/* ──────────────────────────────── the wordlist ─────────────────────────── */
/*
 * Rules for editing:
 *  - lowercase, letters/digits/single spaces only (anything else is dropped
 *    at registration, loudly, via stats().rejected).
 *  - a multi-word entry matches with or without the spaces, so "kill yourself"
 *    also catches "killyourself".
 *  - do NOT add inflections: -s -es -ed -er -ers -ing -in -y -ies -z are free.
 *  - do NOT add leet spellings: n1gg3r, ｆａｇ and f-a-g are already covered.
 *  - if a term of four or more characters can appear inside an innocent
 *    English word, put that word in ALLOW below instead of dropping the term.
 */

/** Tier 1 — MILD. Delivered as typed. Swearing is not abuse. */
const WORDS_MILD = [
  'damn', 'dammit', 'damnit', 'goddamn', 'hell', 'crap', 'bloody', 'bugger',
  'ass', 'arse', 'asshole', 'arsehole', 'jackass', 'dumbass', 'badass',
  'piss', 'pissed', 'shit', 'bullshit', 'shite',
  'fuck', 'fuk', 'fuq', 'motherfucker', 'clusterfuck', 'frick', 'feck',
  'bastard', 'bitch', 'bollocks', 'wanker', 'tosser', 'git', 'prat', 'sod',
  'dick', 'dickhead', 'prick', 'knob', 'jerk', 'douche', 'douchebag',
  'wtf', 'stfu', 'omfg', 'ffs', 'af',
];

/** Tier 2 — MASK. Delivered starred out. Crude, degrading, or explicit. */
const WORDS_MASK = [
  // degrading, gendered
  'cunt', 'twat', 'whore', 'slut', 'skank', 'slag',
  // explicit sexual
  'cock', 'pussy', 'penis', 'vagina', 'boobs', 'tits', 'titties',
  'blowjob', 'handjob', 'rimjob', 'cum', 'jizz', 'jerkoff', 'masturbate',
  'orgasm', 'horny', 'milf', 'dildo', 'buttplug', 'anal', 'creampie',
  'gangbang', 'deepthroat', 'cunnilingus', 'fellatio', 'porn', 'porno',
  'hentai', 'nudes', 'sexting',
  // violence / accusation used as an insult
  'rape', 'molest', 'pedo', 'pedophile', 'paedophile',
  // dated racial term: not slur-tier, still not printing it
  'negro',
];

/** Tier 3 — BLOCK. Never delivered. Slurs, hate, minors, self-harm. */
const WORDS_BLOCK = [
  // racial / ethnic slurs
  'nigger', 'nigga', 'niglet', 'sandnigger', 'coon', 'darkie', 'spic',
  'wetback', 'beaner', 'chink', 'gook', 'jap', 'chinaman', 'kike', 'yid',
  'paki', 'raghead', 'towelhead', 'redskin', 'squaw', 'porch monkey',
  'jungle bunny',
  // homophobic / transphobic slurs
  'faggot', 'faggy', 'fag', 'dyke', 'tranny', 'shemale', 'ladyboy',
  // ableist slurs
  'retard', 'mongoloid', 'window licker',
  // hate sloganeering
  'heil hitler', 'sieg heil', 'white power', 'gas the jews', 'holohoax',
  '1488',
  // NOT 'kkk': `kkkk` is how Brazilian players laugh, and this tier drops the
  // message. The hate use is caught by the phrases above. A three-letter
  // BLOCK term whose letters repeat is not worth one silenced player.
  // sexual content involving minors, and solicitation
  'child porn', 'childporn', 'jailbait', 'loli porn', 'send nudes',
  'send nudez',
  // harassment and self-harm directives
  'kys', 'kill yourself', 'kill urself', 'kill your self', 'neck yourself',
  'hang yourself', 'end yourself', 'unalive yourself', 'drink bleach',
  'slit your wrists', 'i hope you die', 'you should die', 'go die',
];

/**
 * Tier 4 — NAME. Fine in a sentence, refused as a name. Impersonating staff
 * is the single most effective social-engineering move in this genre: "hi im
 * a mod, whats your password" works because the name tag says it.
 */
const WORDS_NAME = [
  'admin', 'administrator', 'mod', 'mods', 'moderator', 'staff', 'official',
  'system', 'server', 'console', 'owner', 'developer', 'dev', 'support',
  'capycove', 'capy cove', 'covestaff', 'cove staff', 'sysop', 'root',
  'everyone', 'null', 'undefined', 'deleted', 'anonymous',
];

/**
 * Terms that ALSO get the boundary-free "squeezed" pass in check(): the ones
 * whose whole evasion strategy is to hide inside another token. Keep this set
 * SHORT and unambiguous — it is the pass that manufactures false positives,
 * and every entry here needs its innocent collisions listed in ALLOW.
 * checkName() widens this to all BLOCK and NAME terms of four-plus characters.
 */
const LOOSE_TERMS = new Set([
  'nigger', 'nigga', 'sandnigger', 'faggot', 'tranny',
  'childporn', 'child porn', 'kill yourself', 'kill urself', 'heil hitler',
]);
// Deliberately NOT loose: 'shemale' ("is she male or female"), 'wetback'
// ("wet back" in a game with a swimming room), 'coon' ("raccoon"), 'spic'
// ("spice"), 'paki' ("Pakistan"). Word mode still catches all of them.

/**
 * checkName() widens the boundary-free pass to EVERY term of at least this
 * many letters. A name is one token with no spaces, so word boundaries barely
 * exist there: `Fuck123` and `Shitlord` both survive a word-mode pass. Four is
 * the floor because three-letter terms (`ass`, `fag`, `mod`) inside a longer
 * name are a false-positive machine — `Bassett`, `Modest`, `Grassy`.
 */
const NAME_LOOSE_MIN = 4;

/**
 * The Scunthorpe list. Every entry is overwritten with NULs before any term is
 * looked for, so nothing inside it can match. Add to this rather than deleting
 * a term. (`snigger` and `raccoon` are the two that bite hardest here, and
 * `raccoon` in a game about capybaras is not hypothetical.)
 */
const ALLOW = [
  // -ass-
  'assassin', 'assassinate', 'assess', 'assessment', 'asset', 'assets',
  'assign', 'assignment', 'assist', 'assistant', 'associate', 'association',
  'assume', 'assumption', 'assure', 'assorted', 'assemble', 'assembly',
  'bass', 'basset', 'bassett', 'class', 'classic', 'glass', 'grass', 'grassy',
  'brass', 'mass', 'massive', 'pass', 'passage', 'passion', 'password',
  'compass', 'embassy', 'harass', 'cassette', 'casserole', 'molasses',
  'sassafras', 'lass', 'morass', 'potassium', 'carcass',
  // -anal-
  'analysis', 'analyse', 'analyze', 'analyst', 'analytics', 'analog',
  'analogue', 'canal', 'banal',
  // -cock-
  'cocktail', 'cockatoo', 'cockpit', 'cockroach', 'peacock', 'shuttlecock',
  'woodcock', 'hancock', 'haycock', 'cocky',
  // -tit-
  'titan', 'titanic', 'titmouse', 'tittle', 'title', 'constitution',
  'substitute', 'competition', 'appetite', 'petition', 'entitled',
  // -dick- / -prick-
  'dickens', 'dickinson', 'benedict', 'addicted', 'predict', 'apricot',
  // -arse- / -ars-
  'arsenal', 'arsenic', 'parse', 'sparse', 'coarse', 'hoarse', 'horse',
  // -cum-
  'cumin', 'cumulus', 'accumulate', 'circumstance', 'cucumber', 'document',
  'documents', 'incumbent', 'cumbria', 'cumberland', 'succumb', 'scum',
  // -sex-
  'sextant', 'sextet', 'essex', 'sussex', 'middlesex', 'unisex', 'sexton',
  // -shit- / -shag-
  'shiitake', 'shitake',
  // -nigg-
  'snigger', 'sniggering', 'niggle', 'niggling', 'nigeria', 'nigerian',
  'niger', 'niggardly',
  // -coon-
  'raccoon', 'racoon', 'cocoon', 'tycoon',
  // -spic- / -paki- / -jap- / -retard-
  'spice', 'spicy', 'spices', 'auspicious', 'suspicious', 'conspicuous',
  'pakistan', 'pakistani', 'japan', 'japanese', 'jape',
  'retardant', 'retarder', 'retardation',
  // -hell-
  'shell', 'shellfish', 'seashell', 'bombshell', 'hello', 'helle', 'hellenic',
  'michelle', 'othello', 'hellebore', 'shelly', 'rachelle',
  // -rape- / -crap- / -pedo- / -horny- / -prick- / -jerk- / -knob-
  'grape', 'grapes', 'drape', 'drapes', 'scrape', 'trapeze', 'scrap',
  'scrappy', 'scrapbook', 'torpedo', 'speedo', 'thorn', 'thorny', 'prickle',
  'prickly', 'jerky', 'doorknob',
  // place names and the classics
  'scunthorpe', 'penistone', 'lightwater', 'clitheroe',
  // cove vocabulary that brushes the list
  'bassinet', 'crass', 'cutlass', 'compassion', 'grasshopper', 'squawk',
  // collisions with the boundary-free name pass (checkName only)
  'badminton', 'staffordshire', 'ecosystem', 'subsystem', 'observer',
  'downer', 'landowner', 'homeowner', 'beetroot', 'uproot', 'moderate',
  'modest', 'model', 'modern', 'commode', 'staffy',
];

/* ─────────────────────── suggestion vocabulary (forced rename) ─────────── */
/*
 * A forced rename hands the player a name; the name it hands them should sound
 * like it came from the cove, not from a database. Both halves are at most
 * seven characters so ADJ+NOUN+two digits always fits NAME_MAX.
 */
const SUGGEST_ADJ = [
  'Cozy', 'Mossy', 'Sleepy', 'Toasty', 'Snowy', 'Amber', 'Misty', 'Sunny',
  'Fuzzy', 'Chunky', 'Cheery', 'Plump', 'Drowsy', 'Quiet', 'Merry', 'Nutty',
  'Jolly', 'Brave', 'Tidy', 'Wobbly', 'Sandy', 'Golden', 'Frosty', 'Breezy',
];
const SUGGEST_NOUN = [
  'Capy', 'Otter', 'Cocoa', 'Pebble', 'Fern', 'Willow', 'Acorn', 'Muffin',
  'Turnip', 'Puddle', 'Mango', 'Bramble', 'Nibble', 'Splash', 'Sprout',
  'Lantern', 'Biscuit', 'Truffle', 'Reed', 'Clover', 'Pine', 'Marsh',
];

/* ─────────────────────────────── normalisation ─────────────────────────── */

/**
 * Homoglyphs NFKD does not fix, because these are genuinely different letters
 * in Unicode's eyes. This is the cheapest evasion there is (`nіgger` with a
 * Ukrainian і renders identically) and the cheapest to close.
 */
const HOMOGLYPH = Object.freeze({
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p',
  ѕ: 's', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ɡ: 'g', ʟ: 'l',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', υ: 'u',
  χ: 'x', ν: 'v', γ: 'y', σ: 's', ø: 'o', đ: 'd', ł: 'l', ß: 'ss', æ: 'ae',
  œ: 'oe', þ: 'th', ð: 'd', ı: 'i', ǝ: 'e', ʀ: 'r',
});

/** Symbols that stand in for letters — but only inside a word (see foldCells). */
const LEET_SYMBOL = Object.freeze({
  '@': 'a', $: 's', '!': 'i', '|': 'i', '¡': 'i', '+': 't', '(': 'c',
  ')': 'c', '<': 'c', '{': 'c', '[': 'c', '*': '', '¢': 'c', '€': 'e',
  '£': 'l', '§': 's', '?': '',
});

/** Digits that stand in for letters — only in a token that has two letters. */
const LEET_DIGIT = Object.freeze({
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g',
});

/**
 * `1` and `|` are the only genuinely AMBIGUOUS substitutions: `k1ll` wants
 * `i`, `s1ut` wants `l`, and the audit cites `s1ut` and `k1llyourself` as two
 * evasions that both work today (AUDIT.md, F-21). One folding cannot serve
 * both, and making every `i`/`l` in every pattern an `[il]` class would flag
 * `Anais`. So the fold emits a SECOND variant with these read as `l`, and the
 * scan runs over both — which costs nothing on the ~99% of lines that contain
 * no `1`, `|` or `!` at all.
 */
const LEET_ALT = Object.freeze({ 1: 'l', '|': 'l', '!': 'l', '¡': 'l' });

const isAlnum = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
const isLetter = (c) => c >= 'a' && c <= 'z';

/**
 * The workhorse. Returns the folded string plus `map`, where map[i] is the
 * index in the ORIGINAL string that folded[i] came from. The map is what makes
 * masking possible without destroying the player's punctuation and capitals.
 *
 * Separator runs collapse to exactly one space, so "f...u...c...k" folds to
 * "f u c k" and the one-space allowance in the patterns is enough.
 */
function foldCells(input) {
  const src = String(input ?? '');
  /** @type {{c:string, kind:string, i:number}[]} kind: a|d|l|s */
  const cells = [];

  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    // NFKD then drop combining marks: handles ｆｕｌｌｗｉｄｔｈ, accents,
    // superscripts, and the circled/parenthesised letter blocks.
    let expanded;
    try {
      expanded = raw.normalize('NFKD').replace(/\p{M}/gu, '');
    } catch {
      expanded = raw;
    }
    if (!expanded) continue;
    for (const ch0 of expanded) {
      const lower = ch0.toLowerCase();
      const mapped = Object.prototype.hasOwnProperty.call(HOMOGLYPH, lower)
        ? HOMOGLYPH[lower]
        : lower;
      for (const ch of mapped) {
        if (isLetter(ch)) cells.push({ c: ch, kind: 'a', i });
        else if (ch >= '0' && ch <= '9') cells.push({ c: ch, kind: 'd', i });
        else if (Object.prototype.hasOwnProperty.call(LEET_SYMBOL, ch)) {
          const v = LEET_SYMBOL[ch];
          // '' means "invisible padding" (the * in f*ck): it becomes a
          // separator on its own but never blocks a word-internal match,
          // because the one-space allowance covers it.
          cells.push({ c: v || ' ', kind: v ? 'l' : 's', i, alt: LEET_ALT[ch] || null });
        } else cells.push({ c: ' ', kind: 's', i });
      }
    }
  }

  // Resolve leet SYMBOLS: only word-internal ones become letters.
  for (let k = 0; k < cells.length; k++) {
    if (cells[k].kind !== 'l') continue;
    const prev = cells[k - 1];
    const next = cells[k + 1];
    const inside =
      prev && next &&
      (prev.kind === 'a' || prev.kind === 'd' || prev.kind === 'l') &&
      (next.kind === 'a' || next.kind === 'd' || next.kind === 'l');
    if (inside) cells[k].kind = 'a';
    else { cells[k].c = ' '; cells[k].kind = 's'; }
  }

  // Resolve leet DIGITS per token: a token carrying at least TWO letters is a
  // word being spelled with numbers (`n1gg3r`, `5h1t`); a token with one or
  // none is a number or a measurement, and folding it invents words — `0.45s`
  // becomes `ass` at one letter. Pure-digit tokens survive intact, which is
  // why '1488' can be listed as digits and still match.
  let t = 0;
  while (t < cells.length) {
    if (cells[t].kind === 's') { t++; continue; }
    let end = t;
    let letters = 0;
    while (end < cells.length && cells[end].kind !== 's') {
      if (cells[end].kind === 'a') letters++;
      end++;
    }
    if (letters >= 2) {
      for (let k = t; k < end; k++) {
        if (cells[k].kind !== 'd') continue;
        const raw = cells[k].c;
        const v = LEET_DIGIT[raw];
        if (v) { cells[k].c = v; cells[k].kind = 'a'; cells[k].alt = LEET_ALT[raw] || null; }
      }
    }
    t = end;
  }

  // Collapse separator runs to a single space, and build the ambiguous-leet
  // variant alongside (null when nothing ambiguous survived as a letter).
  const out = [];
  const alt = [];
  const map = [];
  let lastWasSep = false;
  let hasAlt = false;
  for (const cell of cells) {
    const sep = cell.kind === 's';
    if (sep && lastWasSep) continue;
    out.push(cell.c);
    const a = cell.kind === 'a' && cell.alt ? cell.alt : cell.c;
    if (a !== cell.c) hasAlt = true;
    alt.push(a);
    map.push(cell.i);
    lastWasSep = sep;
  }
  return { text: out.join(''), alt: hasAlt ? alt.join('') : null, map };
}

/** Public, for tests and for eyeballing why something did or did not match. */
export function fold(text) {
  return foldCells(text).text;
}

/**
 * The squeezed form: folded with every separator removed, so `f a g g o t`
 * and `xX.faggot.Xx` both become contiguous. NULs from the allowlist pass are
 * KEPT, because their whole job is to break contiguity.
 */
function squeeze(folded, map) {
  const out = [];
  const smap = [];
  for (let i = 0; i < folded.length; i++) {
    const c = folded[i];
    if (isAlnum(c) || c === '\0') { out.push(c); smap.push(map[i]); }
  }
  return { text: out.join(''), map: smap };
}

/* ──────────────────────────── pattern compilation ──────────────────────── */

/** Free inflections. Adding a plural to the wordlist is always a mistake. */
const AFFIX = '(?:e?s|ed|er|ers|ing|ings|in|y|ies|z)?';

/**
 * One spelling of a term. `sep` goes between adjacent letters; `rep` decides
 * whether each letter tolerates repeats. A space inside the term (a phrase)
 * becomes `[ ]*`, so "kill yourself" also matches "killyourself".
 *
 * The dense spelling takes repeats (`fuuuck`). The spaced one does NOT: with
 * both, `k k k` and `k kk kk` become the same string, and a three-letter term
 * starts matching arithmetic.
 */
function spell(term, sep, rep = true) {
  let body = '';
  let atStart = true;
  for (const ch of term) {
    if (ch === ' ') { body += '[ ]*'; atStart = true; continue; }
    if (!atStart) body += sep;
    body += rep ? `${ch}+` : ch;
    atStart = false;
  }
  return body;
}

/**
 * The body of a term pattern. Two spellings, never a mixture: dense
 * ("faggot", "fuuuck") and — for terms of four or more letters — fully
 * spaced ("f a g g o t"). See the header for why "one optional space" is the
 * wrong middle ground.
 */
function buildBody(term, { spaced }) {
  const dense = spell(term, '');
  if (!spaced) return dense;
  return `(?:${spell(term, '[ ]', false)}|${dense})`;
}

/**
 * Which terms accept the fully spaced spelling. Three letters, so `k y s` and
 * `k.y.s` are caught; two would be reckless (`a f` is two ordinary words).
 */
const isSpaced = (term) => term.replace(/ /g, '').length >= 3;

/**
 * Allowlist spelling: LITERAL, no repeat tolerance. This is not a nicety —
 * `niger` (an allowlist entry protecting Nigeria) spelled with `+` on every
 * letter matches `nigger`, which would exempt the worst word in the file from
 * the whole filter. An allowlist entry may only ever exempt exactly itself.
 */
function spellLiteral(term) {
  let body = '';
  for (const ch of term) body += ch === ' ' ? '[ ]*' : ch;
  return body;
}

function compileWord(term) {
  const body = buildBody(term, { spaced: isSpaced(term) });
  return new RegExp(`(?<![a-z0-9])${body}${AFFIX}(?![a-z0-9])`, 'g');
}

/** Boundary-free, against the squeezed form (which has no separators left). */
function compileLoose(term) {
  return new RegExp(spell(term.replace(/ /g, ''), ''), 'g');
}

/* ───────────────────────────── the term registry ───────────────────────── */

const VALID_TERM = /^[a-z0-9]+(?: [a-z0-9]+)*$/;

/** term -> { term, tier, loose, word, looseRe } */
const TERMS = new Map();
let rejected = 0;

function register(term, tier) {
  const t = String(term || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!t || !VALID_TERM.test(t)) { rejected++; return false; }
  const letters = t.replace(/ /g, '');
  const loose = LOOSE_TERMS.has(t) || LOOSE_TERMS.has(letters);
  TERMS.set(t, {
    term: t,
    tier,
    loose,
    letters,
    word: compileWord(t),
    looseRe: loose ? compileLoose(t) : null,
    // checkName widens the boundary-free pass to every term long enough to be
    // unambiguous; compile that one lazily, on the first name check.
    nameLoose: null,
  });
  return true;
}

for (const w of WORDS_MILD) register(w, TIER.MILD);
for (const w of WORDS_MASK) register(w, TIER.MASK);
for (const w of WORDS_BLOCK) register(w, TIER.BLOCK);
for (const w of WORDS_NAME) register(w, TIER.NAME);

/**
 * Two allowlist regexes. `ALLOW_RE` is word-fenced and runs on every scan.
 * `ALLOW_LOOSE_RE` drops the fences and runs only for checkName(), because the
 * name pass drops word boundaries too: without it, `Seashell` fails on `hell`
 * (the fenced `shell` entry never fires inside `seashell`).
 * Both are LITERAL — see spellLiteral. Longest first, so `snigger` claims the
 * span before `niger` can.
 */
let ALLOW_RE = null;
let ALLOW_LOOSE_RE = null;
function buildAllowRe() {
  const bodies = ALLOW
    .map((w) => String(w).toLowerCase().trim().replace(/\s+/g, ' '))
    .filter((w) => VALID_TERM.test(w))
    .sort((a, b) => b.length - a.length)
    .map(spellLiteral);
  ALLOW_RE = new RegExp(`(?<![a-z0-9])(?:${bodies.join('|')})${AFFIX}(?![a-z0-9])`, 'g');
  ALLOW_LOOSE_RE = new RegExp(`(?:${bodies.join('|')})`, 'g');
}
buildAllowRe();

/**
 * Two combined regexes per tier, used as a cheap reject: on a clean line these
 * fail and no per-term pattern ever runs. `word` is tested against the folded
 * text, `loose` against the squeezed text.
 */
const COMBINED = new Map();
function buildCombined() {
  COMBINED.clear();
  for (const tier of Object.values(TIER)) {
    const words = [];
    const looses = [];
    for (const e of TERMS.values()) {
      if (e.tier !== tier) continue;
      words.push(buildBody(e.term, { spaced: isSpaced(e.term) }));
      if (e.loose) looses.push(spell(e.letters, ''));
    }
    COMBINED.set(tier, {
      word: words.length
        ? new RegExp(`(?<![a-z0-9])(?:${words.join('|')})${AFFIX}(?![a-z0-9])`, 'g')
        : null,
      loose: looses.length ? new RegExp(`(?:${looses.join('|')})`, 'g') : null,
    });
  }
}
buildCombined();

/* ──────────────────────────────── scanning ─────────────────────────────── */

function neutralise(text, re) {
  re.lastIndex = 0;
  return text.replace(re, (m) => '\0'.repeat(m.length));
}

function toOriginalSpan(map, start, end, srcLen) {
  if (!map.length) return [0, 0];
  const a = map[Math.min(start, map.length - 1)];
  const b = map[Math.min(Math.max(end - 1, 0), map.length - 1)] + 1;
  return [Math.max(0, Math.min(a, srcLen)), Math.max(0, Math.min(b, srcLen))];
}

function runRe(re, hay, onMatch) {
  re.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(hay)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    onMatch(m.index, m.index + m[0].length);
    if (++guard > 64) break;
  }
}

/**
 * Core scan. `tiers` is the set of tiers to look for; `wideLoose` turns on the
 * boundary-free pass for every term of NAME_LOOSE_MIN-plus letters, and the
 * matching boundary-free allowlist (checkName only). Returns { hits, worst }
 * with every hit's span in ORIGINAL string coordinates.
 */
function scan(srcText, tiers, wideLoose) {
  const src = String(srcText ?? '');
  const folded0 = foldCells(src);

  /** One scannable pair (folded + squeezed) from one folding of the source. */
  const prepare = (text) => {
    const folded = { text: neutralise(text, ALLOW_RE), map: folded0.map };
    const squeezed = squeeze(folded.text, folded.map);
    // The name pass has no word boundaries, so its allowlist must not either.
    if (wideLoose) squeezed.text = neutralise(squeezed.text, ALLOW_LOOSE_RE);
    return { folded, squeezed };
  };
  const variants = [prepare(folded0.text)];
  if (folded0.alt) variants.push(prepare(folded0.alt));

  const hits = [];   // reported to the caller, capped
  const spans = [];  // every span, uncapped: MASKING reads this one
  let worst = SEVERITY.NONE;
  const seen = new Set();

  const push = (entry, start, end, hay) => {
    const span = toOriginalSpan(hay.map, start, end, src.length);
    const key = `${entry.term}:${span[0]}:${span[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rec = { term: entry.term, tier: entry.tier, at: span };
    // hits is capped so a spammer cannot hand the report queue a 500-entry
    // array; spans is NOT, because masking off the capped list would deliver
    // the 9th slur in clear. Only the hard ceiling below bounds it.
    if (spans.length < 512) spans.push(rec);
    if (hits.length < MAX_HITS) hits.push(rec);
    const sev = entry.tier === TIER.NAME ? SEVERITY.BLOCK : entry.tier;
    if (SEV_RANK[sev] > SEV_RANK[worst]) worst = sev;
  };

  const hit = (re, hay) => { if (!re) return false; re.lastIndex = 0; return re.test(hay); };

  for (const { folded, squeezed } of variants) {
    for (const tier of tiers) {
      const combined = COMBINED.get(tier) || {};
      const trippedWord = hit(combined.word, folded.text);
      const trippedLoose = hit(combined.loose, squeezed.text);
      if (!trippedWord && !trippedLoose && !wideLoose) continue;

      for (const entry of TERMS.values()) {
        if (entry.tier !== tier) continue;
        if (trippedWord) runRe(entry.word, folded.text, (a, b) => push(entry, a, b, folded));
        if (trippedLoose && entry.looseRe) {
          runRe(entry.looseRe, squeezed.text, (a, b) => push(entry, a, b, squeezed));
        }
        if (wideLoose && !entry.loose && entry.letters.length >= NAME_LOOSE_MIN) {
          if (!entry.nameLoose) entry.nameLoose = compileLoose(entry.term);
          runRe(entry.nameLoose, squeezed.text, (a, b) => push(entry, a, b, squeezed));
        }
      }
    }
  }

  return { hits, spans, worst };
}

/** Star out the given original-coordinate spans, keeping length. */
function maskSpans(src, spans) {
  if (!spans.length) return src;
  const merged = [...spans].sort((a, b) => a[0] - b[0]).reduce((acc, s) => {
    const last = acc[acc.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else acc.push([s[0], s[1]]);
    return acc;
  }, []);
  let out = '';
  let cur = 0;
  for (const [a, b] of merged) {
    out += src.slice(cur, a);
    // Star the letters and digits, keep spaces and punctuation: "f u c k"
    // becomes "* * * *", which reads as censorship rather than corruption.
    out += src.slice(a, b).replace(/[^\s]/g, '*');
    cur = b;
  }
  return out + src.slice(cur);
}

/* ────────────────────────────────── check ──────────────────────────────── */

const BLOCK_MSG = 'That one stays out of the cove.';
const MASK_MSG = null; // the stars are the message; a toast would be nagging

/**
 * Filter a line of player text: chat, whisper, a doodle guess, a party name.
 * Never throws. Never returns undefined fields.
 *
 * @param {string} text
 * @param {{strict?:boolean, mask?:boolean}} [opts]
 */
export function check(text, opts = {}) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const strict = opts.strict === true;
  const wantMask = opts.mask !== false;

  const base = { ok: true, severity: SEVERITY.NONE, cleaned: src, changed: false, hits: [], msg: null };
  if (!src.trim()) return base;

  const tiers = [TIER.BLOCK, TIER.MASK, TIER.MILD];
  const { hits, spans, worst } = scan(src, tiers, false);
  if (!hits.length) return base;

  if (worst === SEVERITY.BLOCK) {
    return {
      ok: false,
      severity: SEVERITY.BLOCK,
      cleaned: wantMask ? maskSpans(src, spans.map((h) => h.at)) : '',
      changed: true,
      hits,
      msg: BLOCK_MSG,
    };
  }

  // Mask the mask tier; mask the mild tier only when the caller asked (names).
  const maskable = spans.filter(
    (h) => h.tier === TIER.MASK || (strict && h.tier === TIER.MILD),
  );
  if (!maskable.length) {
    return { ok: true, severity: SEVERITY.MILD, cleaned: src, changed: false, hits, msg: null };
  }
  const cleaned = wantMask ? maskSpans(src, maskable.map((h) => h.at)) : src;
  return {
    ok: true,
    severity: SEVERITY.MASK,
    cleaned,
    changed: cleaned !== src,
    hits,
    msg: MASK_MSG,
  };
}

/* ──────────────────────────────── checkName ────────────────────────────── */

const NAME_MSG = Object.freeze({
  shape: `Names are ${NAME_MIN}-${NAME_MAX} letters, numbers or _`,
  reserved: 'That name is reserved. Pick another one.',
  blocked: 'That name will not fly in the cove. Pick another one.',
  masked: 'That name will not fly in the cove. Pick another one.',
  mild: 'Keep the name clean, please. Pick another one.',
});

/**
 * Judge a NAME: signup, self-serve rename, and the `a-rename` forced-rename
 * op all go through here. Stricter than check() by design (see the header),
 * and it hands back a clean `suggestion` so a forced rename is one call.
 *
 * `shape:false` skips the `^[A-Za-z0-9_]{3,16}$` gate and content-checks only.
 * That is for the GUEST hello path, which builds its display name with
 * `cleanName` (server/index.js:401) and legitimately allows spaces and
 * hyphens — the audit's example of an unfiltered name is literally the guest
 * name "Kill Yourself". Registered names keep the gate.
 *
 * @param {string} name
 * @param {{strict?:boolean, shape?:boolean, seed?:string|number,
 *          suggest?:boolean}} [opts]
 */
export function checkName(name, opts = {}) {
  const raw = typeof name === 'string' ? name : String(name ?? '');
  const src = raw.trim();
  const strict = opts.strict !== false;
  const wantSuggest = opts.suggest !== false;

  // `list` is the full span list — salvage() needs all of it to strip the name
  // clean — while the caller only ever sees MAX_HITS of it.
  const fail = (code, list, severity) => {
    const out = {
      ok: false,
      severity,
      code,
      msg: NAME_MSG[code] || NAME_MSG.blocked,
      cleaned: src,
      hits: list.slice(0, MAX_HITS),
    };
    if (wantSuggest) out.suggestion = suggestFor(src, list, opts.seed);
    return out;
  };

  if (opts.shape !== false && !NAME_SHAPE_RE.test(src)) return fail('shape', [], SEVERITY.BLOCK);
  if (!src) return fail('shape', [], SEVERITY.BLOCK);

  const tiers = [TIER.BLOCK, TIER.MASK, TIER.NAME, TIER.MILD];
  const all = scan(src, tiers, true).spans;
  // A reserved word shorter than the loose floor has to be the WHOLE name,
  // spelled exactly. `mod` is three letters with a repeated one, so the
  // repeat-and-affix tolerance that catches `MOOOD`-style evasion elsewhere
  // rejects `Mood` (m+o+o+d) and `Modes` (mod + the -es affix) here.
  // Impersonation is "Mod"; a cozy game is full of Moods.
  const key = fold(src).replace(/[^a-z0-9]/g, '');
  const hits = all.filter((h) => (
    h.tier !== TIER.NAME
    || h.term.replace(/ /g, '').length >= NAME_LOOSE_MIN
    || key === h.term.replace(/ /g, '')
  ));
  if (!hits.length) {
    return { ok: true, severity: SEVERITY.NONE, code: 'clean', msg: null, cleaned: src, hits: [] };
  }

  const has = (tier) => hits.some((h) => h.tier === tier);
  if (has(TIER.BLOCK)) return fail('blocked', hits, SEVERITY.BLOCK);
  if (has(TIER.NAME)) return fail('reserved', hits, SEVERITY.BLOCK);
  if (has(TIER.MASK)) return fail('masked', hits, SEVERITY.MASK);
  if (strict) return fail('mild', hits, SEVERITY.MILD);
  return {
    ok: true, severity: SEVERITY.MILD, code: 'mild', msg: null, cleaned: src,
    hits: hits.slice(0, MAX_HITS),
  };
}

/* ─────────────────────────── forced-rename suggestion ──────────────────── */

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * First try to SALVAGE the player's name — strip the offending run and keep
 * the rest, because "Mossy_x" is a smaller punishment than a new identity.
 * Only when nothing usable survives do we mint a cove name.
 */
function salvage(src, hits) {
  if (!hits.length) return '';
  let out = '';
  const spans = hits.map((h) => h.at).sort((a, b) => a[0] - b[0]);
  let cur = 0;
  for (const [a, b] of spans) {
    if (a >= cur) { out += src.slice(cur, a); cur = b; }
    else cur = Math.max(cur, b);
  }
  out += src.slice(cur);
  out = out.replace(/[^A-Za-z0-9_]/g, '').replace(/^_+|_+$/g, '').slice(0, NAME_MAX);
  return out;
}

function suggestFor(src, hits, seed) {
  const kept = salvage(src, hits);
  if (kept.length >= NAME_MIN && NAME_SHAPE_RE.test(kept)) {
    const r = checkName(kept, { suggest: false });
    if (r.ok) return kept;
  }
  return suggestName(src, { seed });
}

/**
 * Mint a clean, shape-valid cove name. Deterministic in (seedText, seed) so a
 * player offered "MossyOtter42" once is offered it again on retry, and so the
 * function is testable.
 */
export function suggestName(seedText = '', opts = {}) {
  let h = fnv1a(`${String(seedText)}|${String(opts.seed ?? '')}`);
  for (let i = 0; i < 32; i++) {
    const adj = SUGGEST_ADJ[h % SUGGEST_ADJ.length];
    const noun = SUGGEST_NOUN[(h >>> 8) % SUGGEST_NOUN.length];
    const num = ((h >>> 16) % 90) + 10;
    let cand = adj + noun;
    if (cand.length + 2 <= NAME_MAX) cand += String(num);
    if (cand.length >= NAME_MIN && cand.length <= NAME_MAX && NAME_SHAPE_RE.test(cand)) {
      const r = checkName(cand, { suggest: false });
      if (r.ok) return cand;
    }
    h = (Math.imul(h ^ (i + 1), 0x01000193) >>> 0);
  }
  // Unreachable with the vocabulary above; still, never return an invalid name.
  return `Capy${(h % 9000) + 1000}`;
}

/* ─────────────────────────── runtime tuning (ops) ──────────────────────── */

/**
 * Add terms at runtime. Not persisted: the file is the source of truth, and a
 * term added here disappears on restart on purpose — an operator who wants it
 * permanently edits the list above, which is the thing they can review later.
 */
export function addTerms(tier, terms) {
  if (!Object.values(TIER).includes(tier)) return 0;
  let n = 0;
  for (const t of [].concat(terms || [])) if (register(t, tier)) n++;
  if (n) buildCombined();
  return n;
}

/** Remove terms at runtime (same non-persistence caveat). */
export function removeTerms(terms) {
  let n = 0;
  for (const t of [].concat(terms || [])) {
    const key = String(t || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (TERMS.delete(key)) n++;
  }
  if (n) buildCombined();
  return n;
}

/** The list, for a test or an operator readback. */
export function listTerms(tier) {
  const out = [];
  for (const e of TERMS.values()) {
    if (tier && e.tier !== tier) continue;
    out.push({ term: e.term, tier: e.tier, loose: e.loose });
  }
  return out;
}

/** Counters, for `/api/health` or a test asserting the list did not shrink. */
export function stats() {
  const byTier = {};
  for (const t of Object.values(TIER)) byTier[t] = 0;
  for (const e of TERMS.values()) byTier[e.tier]++;
  return {
    terms: TERMS.size,
    byTier,
    loose: [...TERMS.values()].filter((e) => e.loose).length,
    allow: ALLOW.length,
    rejected,
  };
}

export default {
  TIER, SEVERITY, NAME_MIN, NAME_MAX, NAME_SHAPE_RE, MAX_HITS,
  check, checkName, suggestName, fold, addTerms, removeTerms, listTerms, stats,
};
