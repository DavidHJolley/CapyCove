import { GAME_NAME } from '../../shared/constants.js';

/**
 * Legal surface + the recovery-code reveal card (wave 10E, N-15 and the client
 * half of N-08).
 *
 * OWNER DECISION 2026-08-14: there is NO age gate and NO under-13 tier. Capy
 * Cove is an all-ages world aimed at an adult nostalgia audience, so this file
 * ships the policy pages and the recovery card and nothing else. Do not add a
 * date-of-birth screen here without the owner saying so.
 *
 * Public API (everything else in this file is private):
 *
 *   openLegal(id, opts?)        open /privacy or /terms as an in-game overlay
 *   closeLegal()                close it (Escape and the backdrop do this too)
 *   mountLegalFooter(parent)    the "Privacy . Terms" footer row, wired up
 *   showRecoveryCodes(opts)     the reveal card; resolves when the gate is met
 *   legalDocIds()               ['privacy', 'terms']
 *   legalDoc(id)                the document as data
 *   renderLegalHtml(id)         a complete standalone HTML page, as a string
 *   ensureLegalStyles()         inject the <style> tag (idempotent)
 *   LEGAL_UPDATED, LEGAL_LINKS, SUPPORT_CONTACT, OPERATOR, GOVERNING_LAW
 *
 * NO import-time side effects: nothing here touches document until a function
 * is called, and the only import is shared/constants.js. That is deliberate --
 * `renderLegalHtml` is meant to be callable from Node (see below) as well as
 * from the browser.
 *
 * ---------------------------------------------------------------------------
 * STATIC PAGES. `public/privacy.html` and `public/terms.html` are GENERATED
 * from this file. Vite copies public/ verbatim into dist/, and the server's
 * express.static(dist) serves them before the SPA catch-all, so they work with
 * zero server changes and they work with JavaScript switched off. Regenerate
 * after ANY edit to the document data below, from the repo root:
 *
 *   node -e "import('./src/ui/legal.js').then(async m => { const fs = await import('node:fs'); for (const id of m.legalDocIds()) fs.writeFileSync('public/' + id + '.html', m.renderLegalHtml(id)); })"
 *
 * The pages are checked in so the build needs no extra step. If the
 * orchestrator adds the two clean-URL routes to server/index.js, /privacy and
 * /terms serve the same bytes; until then they live at /privacy.html and
 * /terms.html and every link in this file uses those paths.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// the three things a human has to fill in
// ---------------------------------------------------------------------------

/** !!! OWNER: the out-of-band support channel (accounts-admin.md 5.2 delivers
 *  admin-issued reset codes here and nowhere else). One string, used by both
 *  documents and by the recovery card. */
export const SUPPORT_CONTACT = 'the Capy Cove Discord (link on the title screen once it exists)';

/** !!! OWNER: who runs the service. A privacy policy with no named operator is
 *  not a privacy policy. */
export const OPERATOR = 'the Capy Cove team';

/** !!! OWNER + LAWYER: jurisdiction for the terms. Left vague on purpose so it
 *  is obvious it has not been decided. */
export const GOVERNING_LAW = 'the laws of the operator\'s home jurisdiction';

/** Shown at the top of both pages and diffed by nothing: bump it by hand when
 *  the text changes materially, and say so on the title screen. */
export const LEGAL_UPDATED = '15 August 2026';

// ---------------------------------------------------------------------------
// the documents, as data
// ---------------------------------------------------------------------------
//
// A section body is a list of blocks:
//   'a string'            -> a paragraph
//   { list: [...] }       -> a bulleted list ('**lead**: rest' bolds the lead)
//   { table: { head, rows } } -> the retention table
//   { note: '...' }       -> a highlighted callout
// Both renderers (DOM and HTML string) walk exactly this shape, so the overlay
// and the static page can never say different things.

const PRIVACY = {
  id: 'privacy',
  nav: 'Privacy',
  title: 'Privacy Policy',
  lede: `${GAME_NAME} is a small game that tries to know as little about you as possible. `
    + 'There is no email address, no real name, no advertising and no third-party tracking in it anywhere. '
    + 'This page says exactly what is stored, for how long, and who can see it.',
  sections: [
    {
      h: 'The short version',
      body: [
        { list: [
          '**Play as a guest** and nothing about you is stored on our server after you close the tab. Your capybara lives in your own browser.',
          '**Make an account** and we store a username you chose, a hash of your password, and your game progress. That is all.',
          'We never ask for an email address, a real name, a birthday, a phone number or a payment card, because we never want to hold any of them.',
          'Chat is kept for **7 days** so moderators can answer reports. Moderation actions are kept for **90 days**.',
          'We do not store your IP address. We store a one-way hash of it so we can tell two connections apart without knowing where either one is.',
          'Nothing is sold, shared or handed to advertisers. There are none.',
        ] },
      ],
    },
    {
      h: 'What we collect',
      body: [
        'Only what the game itself needs to work.',
        { list: [
          '**If you play as a guest**: nothing on our server that outlives your connection. Your nickname, colour, coins and progress are saved by your own browser, on your own device, in local storage. Guests cannot use full chat, only emotes and the phrase menu.',
          '**If you make an account**: the username you picked (it is public and floats over your capybara), a scrypt hash of your password (never the password), hashes of your recovery codes (never the codes), and your game data. Game data means coins, colour, hat, items you own, best scores, friends list, den layout, stamps, quests, titles and the dates you were last seen.',
          '**Things you type, draw or place**: chat and whisper messages, mural pixels, doodle drawings, den and party names, and any report you file.',
          '**Connection data**: a truncated, keyed hash of your IP address, kept with your session so an operator can tell a raid from a coincidence. The address itself is never written down. Your session token is stored by your browser, not by us.',
          '**Moderation records**: if a moderator warns, mutes, kicks or bans an account, that action is recorded with the account it was aimed at.',
        ] },
      ],
    },
    {
      h: 'What we do not collect',
      body: [
        { list: [
          'No email addresses. There is no email in this game at all, which is why account recovery uses written-down codes instead (see the Terms).',
          'No real names, dates of birth, phone numbers, addresses or payment details.',
          'No advertising identifiers, no ad networks, no third-party analytics, no social media pixels, no fingerprinting scripts.',
          'No tracking cookies. The game uses your browser\'s local storage for your session token, your settings and a guest save. Nothing in there is sent anywhere except your own login token, which goes only to our server.',
          'No microphone, no camera, no location, no contacts, no files.',
        ] },
      ],
    },
    {
      h: 'How long we keep it',
      body: [
        { table: {
          head: ['What', 'How long'],
          rows: [
            ['Your account record (name, password hash, game progress)', 'Until you ask us to delete it'],
            ['Chat and whisper messages', '7 days'],
            ['Moderation and administration actions (the audit log)', '90 days'],
            ['Reports, and the evidence attached to them', 'While the report is open, then up to 90 days'],
            ['Pixels you paint on the plaza mural', 'Kept, as part of the shared wall'],
            ['Backups of the account file', 'Hourly copies for 24 hours, daily copies for 7 days'],
            ['Anything saved in your own browser', 'Until you clear your browser storage'],
          ],
        } },
        'The 7 day chat window is deliberately short. It is long enough to answer a report, which almost always arrives within minutes, and short enough that we are not sitting on a pile of other people\'s conversations.',
        'Anything a guest sends through the phrase menu is relayed to the room and may appear in that 7 day log, attached to a temporary session number rather than to an account.',
      ],
    },
    {
      h: 'Who can see what',
      body: [
        { list: [
          '**Everyone in the cove** sees your name, your capybara\'s colour and hat, any title you have earned, the room you are in, your profile card (stamps, medals, best scores), the pixels you paint, and your den if you have set it to open.',
          '**Moderators and admins** can see chat and whispers within the 7 day window, reports, and an account\'s moderation history. Reading a specific player\'s chat log is itself recorded in the audit log, so the people who watch are watched too.',
          '**Nobody else.** The only third party involved is the hosting company whose computer the server runs on, and the only reason they hold anything is that the file lives on their disk.',
        ] },
      ],
    },
    {
      h: 'Your choices',
      body: [
        { list: [
          '**Play as a guest.** You do not have to make an account to play. You lose progress between devices, and you get emotes and the phrase menu instead of full chat.',
          `**Delete your account.** Ask us at ${SUPPORT_CONTACT}. We remove the record and everything attached to it, and keep only a name reservation so that nobody can take your name and pretend to be you.`,
          '**Get a copy of your data.** Ask, and we will send you the account record in plain JSON.',
          '**Log out everywhere.** Changing your password ends every other session on every device, immediately.',
          '**Clear your browser storage** to remove the guest save, the settings and the login token from your device.',
        ] },
        'Two honest caveats. Deleting an account does not erase the pixels you painted on the plaza mural, because the mural is a shared artwork and unpicking one player\'s pixels would let anyone vandalise it by deleting an account. Deleting an account also does not erase the moderation record of a ban, which is kept against a meaningless account id (not your name) for the 90 day window.',
      ],
    },
    {
      h: 'Children',
      body: [
        `${GAME_NAME} is meant for players aged 13 and over. It is not directed at children under 13, and we do not knowingly hold information about them.`,
        `If you believe a child under 13 has made an account, tell us at ${SUPPORT_CONTACT} and we will remove it.`,
      ],
    },
    {
      h: 'Keeping it safe',
      body: [
        'Passwords are stored as scrypt hashes with a per-account salt, so the file cannot be read back into passwords. Session tokens are signed and can be revoked in one action. Recovery codes are stored as hashes and shown to you exactly once.',
        'No small game can promise perfect security, and this one will not. If something goes wrong that affects your data, we will say so on the title screen rather than quietly hoping nobody notices.',
      ],
    },
    {
      h: 'Changes, and how to reach us',
      body: [
        'If this policy changes in a way that matters, the date at the top changes and the title screen says so. Small corrections happen quietly.',
        `${GAME_NAME} is run by ${OPERATOR}. Questions, deletion requests and complaints all go to ${SUPPORT_CONTACT}.`,
      ],
    },
  ],
};

const TERMS = {
  id: 'terms',
  nav: 'Terms',
  title: 'Terms of Use',
  lede: `These are the rules for playing ${GAME_NAME}. They are short, they are in plain English, `
    + 'and the important half is the house rules: be kind, and do not make the cove worse for the person standing next to you.',
  sections: [
    {
      h: 'Who can play',
      body: [
        `${GAME_NAME} is for players aged 13 and over. By playing, you are telling us you are 13 or older.`,
        'You can play as a guest with no account at all. An account is free, and it is what unlocks full chat, progress that follows you between devices, and the ability for a moderator to deal with anyone who is bothering you.',
        'One person per account. Do not share your password with anyone, including people claiming to work on the game. Nobody from Capy Cove will ever ask you for it.',
      ],
    },
    {
      h: 'Your account and your recovery codes',
      body: [
        'There is no email address attached to your account, on purpose. That means we cannot email you a password reset, and it means the eight recovery codes shown to you once at signup are the only self-serve way back into your account.',
        { note: 'Write your recovery codes down and keep them somewhere real. Each one works once. If you lose your password and your codes, the only route left is asking a human, and a human has no way to prove you are you.' },
        `If that happens anyway, ask at ${SUPPORT_CONTACT}. An operator may issue a single-use reset code out of band, at their discretion, after whatever identity questions they think are fair. This is a favour, not a guarantee.`,
        'You are responsible for what happens on your account. If you hand your password to a friend and your friend gets the account banned, the account is banned.',
      ],
    },
    {
      h: 'House rules',
      body: [
        'The cove is meant to be a calm place. These are the things that will get you muted or removed.',
        { list: [
          '**Be kind.** No harassment, no pile-ons, no following someone around the island to bother them.',
          '**No slurs and no hate.** Racist, sexist, homophobic, transphobic or otherwise hateful language is not a grey area here. It ends the conversation and usually the account.',
          '**No threats**, no encouraging anyone to hurt themselves, and no violent content.',
          '**Nothing sexual.** Not in chat, not in whispers, not on the mural, not in a doodle, not in a name.',
          '**No personal information**, yours or anyone else\'s. Do not post real names, addresses, schools, workplaces, phone numbers or photos of people.',
          '**No spam, advertising, scams or begging**, and no links to somewhere else.',
          '**Do not impersonate** another player, a moderator or the operator.',
          '**Do not cheat.** No bots, macros, autoclickers, modified clients, exploiting a bug for coins, or organising fake matches to farm rewards. If a bug pays you, tell us instead.',
          '**Do not attack the service.** No attempts to break, overload, reverse into or gain access to anything that is not yours.',
          '**Keep the shared surfaces clean.** The mural and the doodle canvas are public and permanent-ish. Draw something a stranger would be happy to walk past.',
          '**Report rather than retaliate.** Use the report button on the player card. Fighting fire with fire usually gets both accounts muted.',
        ] },
        'Mild swearing in passing is fine. This is a game for grown-ups who remember these places. Aiming any of it at a person is not.',
      ],
    },
    {
      h: 'Moderation',
      body: [
        'We can warn, mute, kick or ban an account that breaks the house rules, with or without notice, and we can do it because of something you did somewhere else in the game rather than only in the room you are standing in. Every one of those actions is logged.',
        `If you think a decision was wrong, say so at ${SUPPORT_CONTACT}. We will look again. We will not always explain the evidence in detail, because doing that reliably tells people how to avoid being caught next time.`,
        'Filing deliberately false reports is itself a rule break.',
      ],
    },
    {
      h: 'Coins, hats and everything else in the shop',
      body: [
        'Coins and items are numbers in a save file. They have no real world value, they are not property, they cannot be bought or sold for money, and they cannot be transferred out of the game. There is nothing to purchase in Capy Cove and no currency changes hands anywhere.',
        'We can adjust, remove or reset coins and items, in particular when they were obtained through a bug or by cheating, and when the economy needs rebalancing. We will try very hard not to take anything you earned honestly.',
      ],
    },
    {
      h: 'What you make in the cove',
      body: [
        'The pixels you paint, the doodles you draw, the dens you build, the names you choose and the things you say stay yours. By putting them in the game you give us permission to store them, show them to other players, include them in a screenshot of the cove and keep them in the game\'s history.',
        'The plaza mural is a single shared artwork. Individual pixels cannot be pulled back out of it, including when an account is deleted.',
        'Everything else in the game, meaning the code, the world, the capybaras and the name, belongs to the operator. Capy Cove is an original game and is not affiliated with, endorsed by or connected to any other game, studio or franchise.',
      ],
    },
    {
      h: 'The game is free, and it is a hobby',
      body: [
        `${GAME_NAME} is provided as it is, with no warranty of any kind. It is a small project run by a small number of people.`,
        'That means: the server will sometimes be down. An update will sometimes break something. Progress can be lost, despite backups. Features can change or be removed. The game can be shut down entirely, and if that happens we will give as much notice as we can.',
        `To the fullest extent the law allows, ${OPERATOR} is not liable for lost progress, lost coins, lost time, or anything else that follows from using or not being able to use the game. Nothing in these terms takes away rights you have that cannot be signed away.`,
      ],
    },
    {
      h: 'Ending it',
      body: [
        `You can stop playing at any time, and you can ask us to delete your account at ${SUPPORT_CONTACT}. See the Privacy Policy for what deletion does and does not remove.`,
        'We can suspend or end access to an account that breaks these terms.',
      ],
    },
    {
      h: 'Changes, law, and how to reach us',
      body: [
        'If these terms change materially, the date at the top changes and the title screen says so. Continuing to play after that means the new version applies.',
        `These terms are governed by ${GOVERNING_LAW}.`,
        `Questions go to ${SUPPORT_CONTACT}.`,
      ],
    },
  ],
};

const DOCS = { privacy: PRIVACY, terms: TERMS };

/** The order they appear in the footer and in each page's own nav. */
export const LEGAL_LINKS = [
  { id: 'privacy', label: PRIVACY.nav, href: '/privacy.html' },
  { id: 'terms', label: TERMS.nav, href: '/terms.html' },
];

/** @returns {string[]} */
export function legalDocIds() { return LEGAL_LINKS.map((l) => l.id); }

/** The document as data, or null. Never mutate the result. */
export function legalDoc(id) { return DOCS[String(id)] || null; }

// ---------------------------------------------------------------------------
// shared block walking
// ---------------------------------------------------------------------------

/**
 * The one piece of markup the document data is allowed: `**bold**`, anywhere
 * in a string, any number of times. Both renderers walk this, so the overlay
 * and the static page emphasise exactly the same words.
 * @returns {{b:boolean, t:string}[]}
 */
function boldParts(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*/gs;
  const s = String(text);
  let at = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > at) out.push({ b: false, t: s.slice(at, m.index) });
    out.push({ b: true, t: m[1] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ b: false, t: s.slice(at) });
  return out;
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// styles (one injected tag: this file must not touch src/styles.css, which no
// wave-10 agent owns)
// ---------------------------------------------------------------------------

const STYLE_ID = 'capy-legal-styles';

const CSS = `
.lg-overlay {
  position: absolute; inset: 0; z-index: 60; padding: 16px; display: flex;
  align-items: center; justify-content: center;
  background: rgba(20, 32, 44, 0.58); backdrop-filter: blur(7px) saturate(1.12);
  animation: lg-fade 0.18s ease;
}
.lg-overlay.is-closing { opacity: 0; transition: opacity 0.15s ease; pointer-events: none; }
.lg-card {
  position: relative; width: min(680px, 95vw); max-height: 92vh; display: flex; flex-direction: column;
  background: var(--cream, #fff6e3); border: 4px solid #fff; border-radius: 26px;
  box-shadow: var(--shadow, 0 6px 24px rgba(45, 36, 23, 0.28)), 0 0 0 3px rgba(45, 36, 23, 0.08);
  animation: lg-rise 0.3s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.lg-card:focus { outline: none; }
.lg-head { flex: none; padding: 20px 22px 12px; border-bottom: 3px solid rgba(45, 36, 23, 0.08); }
.lg-head h2 { margin: 0; font-size: 25px; color: var(--accent, #e8657a); letter-spacing: 0.02em; padding-right: 46px; }
.lg-when {
  display: inline-block; margin-top: 6px; font-size: 10.5px; font-weight: 900;
  letter-spacing: 0.08em; text-transform: uppercase; color: #8a6a1f;
  background: rgba(242, 182, 74, 0.28); padding: 4px 11px; border-radius: 999px;
}
.lg-x {
  position: absolute; top: 13px; right: 14px; z-index: 2; width: 34px; height: 34px;
  border: 0; border-radius: 50%; cursor: pointer; background: rgba(45, 36, 23, 0.08);
  font-family: var(--font, sans-serif); font-size: 17px; font-weight: 900; color: var(--ink, #2d2417);
  transition: background 0.16s ease, scale 0.12s ease;
}
.lg-x:hover { background: rgba(45, 36, 23, 0.16); scale: 1.08; }
.lg-x:active { scale: 0.93; }
.lg-x:focus-visible { outline: 3px solid var(--accent2, #4fb3e8); outline-offset: 2px; }
.lg-body {
  flex: 1; min-height: 0; overflow: auto; padding: 14px 22px 18px;
  -webkit-user-select: text; user-select: text;
}
.lg-lede { font-size: 13.5px; font-weight: 700; line-height: 1.6; color: #6b5b3c; margin-bottom: 4px; }
.lg-sec { margin-top: 18px; }
.lg-sec h3 { font-size: 16px; margin: 0 0 6px; color: var(--ink, #2d2417); }
.lg-sec p { font-size: 13px; font-weight: 600; line-height: 1.62; color: #55492f; margin: 0 0 8px; }
.lg-sec ul { margin: 0 0 8px; padding-left: 19px; }
.lg-sec li { font-size: 13px; font-weight: 600; line-height: 1.6; color: #55492f; margin-bottom: 6px; }
.lg-sec li b, .lg-sec p b { color: var(--ink, #2d2417); font-weight: 900; }
.lg-note {
  margin: 4px 0 10px; padding: 11px 14px; border-radius: 15px; font-size: 13px;
  font-weight: 700; line-height: 1.55; color: #6b4f18;
  background: rgba(242, 182, 74, 0.2); box-shadow: inset 0 0 0 2px rgba(242, 182, 74, 0.4);
}
.lg-table { width: 100%; border-collapse: collapse; margin: 2px 0 10px; }
.lg-table th, .lg-table td {
  text-align: left; padding: 7px 10px; font-size: 12.5px; line-height: 1.45;
  border-bottom: 2px solid rgba(45, 36, 23, 0.08); vertical-align: top;
}
.lg-table th { font-weight: 900; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #8a7a5a; }
.lg-table td { font-weight: 600; color: #55492f; }
.lg-table td:last-child { font-weight: 800; color: var(--ink, #2d2417); white-space: nowrap; }
.lg-foot {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 11px 18px 13px; border-top: 3px solid rgba(45, 36, 23, 0.08);
}
.lg-swap { display: flex; gap: 6px; }

/* the small print row under the title card */
.title-legal { margin-top: 12px; font-size: 11.5px; font-weight: 700; color: var(--muted, #8a7a5a); line-height: 1.5; }
.title-legal a, .lg-link {
  background: none; border: 0; padding: 0; cursor: pointer; font: inherit;
  color: #b06a78; font-weight: 900; text-decoration: underline; text-underline-offset: 2px;
}
.title-legal a:hover, .lg-link:hover { color: var(--accent, #e8657a); }
.title-legal a:focus-visible, .lg-link:focus-visible { outline: 3px solid var(--accent2, #4fb3e8); outline-offset: 2px; border-radius: 4px; }
.title-legal .lg-dot { margin: 0 6px; opacity: 0.55; }

/* ---------- the recovery-code reveal card ---------- */
.rc-overlay {
  position: absolute; inset: 0; z-index: 62; padding: 16px; display: flex;
  align-items: center; justify-content: center;
  background: rgba(20, 32, 44, 0.66); backdrop-filter: blur(8px) saturate(1.12);
  animation: lg-fade 0.2s ease;
}
.rc-card {
  width: min(520px, 95vw); max-height: 94vh; overflow: auto; text-align: center;
  padding: 24px 24px 20px; background: var(--cream, #fff6e3); border: 4px solid #fff;
  border-radius: 28px; box-shadow: var(--shadow, 0 6px 24px rgba(45, 36, 23, 0.28)), 0 0 0 3px rgba(45, 36, 23, 0.08);
  animation: lg-rise 0.34s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.rc-card:focus { outline: none; }
.rc-card h2 { font-size: 23px; margin: 0 0 4px; color: var(--accent, #e8657a); }
.rc-sub { font-size: 13px; font-weight: 700; line-height: 1.55; color: #6b5b3c; margin-bottom: 12px; }
.rc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 12px; }
@media (max-width: 420px) { .rc-grid { grid-template-columns: 1fr; } }
.rc-code {
  padding: 9px 8px; border-radius: 13px; background: #fffdf6; border: 2px solid #eadfc8;
  font-family: ui-monospace, "Cascadia Mono", "Consolas", monospace; font-size: 13px; font-weight: 700;
  color: var(--ink, #2d2417); overflow-wrap: anywhere; line-height: 1.3;
  -webkit-user-select: text; user-select: text;
  animation: lg-pop 0.34s backwards var(--spring, cubic-bezier(0.2, 1.35, 0.4, 1));
  animation-delay: calc(var(--i) * 45ms);
}
.rc-code i { font-style: normal; color: #bcae94; }
.rc-warn {
  padding: 11px 14px; border-radius: 15px; text-align: left; font-size: 12.5px; font-weight: 700;
  line-height: 1.5; color: #6b4f18; margin-bottom: 12px;
  background: rgba(242, 182, 74, 0.22); box-shadow: inset 0 0 0 2px rgba(242, 182, 74, 0.42);
}
.rc-tools { display: flex; gap: 8px; justify-content: center; margin-bottom: 14px; flex-wrap: wrap; }
.rc-btn {
  border: 0; cursor: pointer; font-family: var(--font, sans-serif); font-weight: 900; font-size: 13px;
  padding: 9px 18px; border-radius: 999px; color: var(--ink, #2d2417);
  background: linear-gradient(180deg, #ffd98a 0%, var(--gold, #f2b64a) 100%);
  box-shadow: 0 4px 0 rgba(158, 111, 20, 0.3);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.rc-btn.is-ghost { background: rgba(45, 36, 23, 0.07); box-shadow: none; color: #6b5b3c; }
.rc-btn:hover:not(:disabled) { scale: 1.05; filter: brightness(1.05); }
.rc-btn:active:not(:disabled) { scale: 0.95; }
.rc-btn:disabled { background: #ece0c4; color: #93815f; cursor: not-allowed; box-shadow: none; scale: 1; }
.rc-btn:focus-visible { outline: 3px solid var(--accent2, #4fb3e8); outline-offset: 3px; }
.rc-go { width: 100%; font-size: 16px; padding: 13px 18px; }
.rc-gate {
  display: flex; align-items: flex-start; gap: 10px; text-align: left; cursor: pointer;
  padding: 11px 13px; border-radius: 15px; background: #fffdf6; margin-bottom: 12px;
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.1); transition: box-shadow 0.16s ease, background 0.16s ease;
}
.rc-gate:hover { box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.2); }
.rc-gate.is-on { background: #f4fbe9; box-shadow: inset 0 0 0 2px rgba(122, 199, 79, 0.5); }
.rc-gate input { flex: none; width: 20px; height: 20px; margin-top: 1px; accent-color: #6fcf5f; cursor: pointer; }
.rc-gate span { font-size: 13px; font-weight: 800; line-height: 1.4; color: var(--ink, #2d2417); }
.rc-said { min-height: 16px; font-size: 11.5px; font-weight: 800; color: #5a9b3f; margin-bottom: 8px; }

@keyframes lg-fade { from { opacity: 0; } }
@keyframes lg-rise { from { opacity: 0; transform: translateY(16px) scale(0.95); } }
@keyframes lg-pop { from { opacity: 0; transform: translateY(7px) scale(0.94); } }
@media (prefers-reduced-motion: reduce) {
  .lg-overlay, .lg-card, .rc-overlay, .rc-card, .rc-code { animation: none; }
}
`;

/** Inject the one <style> tag this module needs. Safe to call any number of
 *  times, and a no-op outside a browser. */
export function ensureLegalStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function elm(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Title screen first (z 50), then the HUD, then the body. */
function mountPoint() {
  return document.getElementById('overlay-root')
    || document.getElementById('hud-root')
    || document.body;
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

/** `**bold**` becomes a <b>, everything else a text node. No HTML is parsed
 *  anywhere in this module, so a policy edit can never become markup. */
function textInto(node, text) {
  for (const part of boldParts(text)) {
    node.appendChild(part.b ? elm('b', null, part.t) : document.createTextNode(part.t));
  }
  return node;
}

function blockToDom(block, into) {
  if (typeof block === 'string') { into.appendChild(textInto(elm('p'), block)); return; }
  if (block && Array.isArray(block.list)) {
    const ul = elm('ul');
    for (const item of block.list) ul.appendChild(textInto(elm('li'), item));
    into.appendChild(ul);
    return;
  }
  if (block && block.note) { into.appendChild(elm('div', 'lg-note', block.note)); return; }
  if (block && block.table) {
    const t = elm('table', 'lg-table');
    const thead = elm('thead');
    const hr = elm('tr');
    for (const h of block.table.head) hr.appendChild(elm('th', null, h));
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = elm('tbody');
    for (const row of block.table.rows) {
      const tr = elm('tr');
      for (const cell of row) tr.appendChild(elm('td', null, cell));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    into.appendChild(t);
  }
}

/** The document body as DOM, shared by the overlay and by anything else that
 *  wants to embed a policy (a settings panel, say). */
function docToDom(doc) {
  const wrap = elm('div');
  wrap.appendChild(elm('p', 'lg-lede', doc.lede));
  for (const sec of doc.sections) {
    const s = elm('section', 'lg-sec');
    s.appendChild(elm('h3', null, sec.h));
    for (const b of sec.body) blockToDom(b, s);
    wrap.appendChild(s);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// the overlay
// ---------------------------------------------------------------------------

let openEl = null;      // the live overlay, or null
let lastFocus = null;   // what to give focus back to

/** Close the legal overlay if one is up. Idempotent. */
export function closeLegal() {
  const el = openEl;
  if (!el) return;
  openEl = null;
  document.removeEventListener('keydown', onKey, true);
  el.classList.add('is-closing');
  setTimeout(() => el.remove(), 160);
  const back = lastFocus;
  lastFocus = null;
  try { back?.focus?.(); } catch { /* the button may be gone with the title card */ }
}

function onKey(e) {
  if (e.key === 'Escape' && openEl) { e.stopPropagation(); e.preventDefault(); closeLegal(); }
}

/**
 * Open /privacy or /terms as an overlay over whatever is on screen.
 * @param {'privacy'|'terms'} id
 * @param {{mount?:HTMLElement}} [opts]
 * @returns {HTMLElement|null} the overlay, for tests
 */
export function openLegal(id, opts = {}) {
  if (typeof document === 'undefined') return null;
  const doc = legalDoc(id);
  if (!doc) return null;
  ensureLegalStyles();
  // A second call swaps the document rather than stacking two overlays.
  const hadFocus = lastFocus;
  closeLegal();
  lastFocus = hadFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const el = elm('div', 'lg-overlay');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `${doc.title}, ${GAME_NAME}`);

  const card = elm('div', 'lg-card');
  card.tabIndex = -1;

  const head = elm('div', 'lg-head');
  head.appendChild(elm('h2', null, doc.title));
  head.appendChild(elm('div', 'lg-when', `Last updated ${LEGAL_UPDATED}`));
  card.appendChild(head);

  const x = elm('button', 'lg-x', '✕');
  x.type = 'button';
  x.title = 'Close';
  x.setAttribute('aria-label', 'Close');
  x.onclick = closeLegal;
  card.appendChild(x);

  const body = elm('div', 'lg-body');
  body.appendChild(docToDom(doc));
  card.appendChild(body);

  const foot = elm('div', 'lg-foot');
  const swap = elm('div', 'lg-swap');
  for (const link of LEGAL_LINKS) {
    if (link.id === doc.id) continue;
    const b = elm('button', 'lg-link', link.label);
    b.type = 'button';
    b.onclick = () => openLegal(link.id, opts);
    swap.appendChild(b);
  }
  foot.appendChild(swap);
  const open = elm('a', 'lg-link', 'Open as a page');
  open.href = LEGAL_LINKS.find((l) => l.id === doc.id).href;
  open.target = '_blank';
  open.rel = 'noopener';
  foot.appendChild(open);
  card.appendChild(foot);

  el.appendChild(card);
  el.addEventListener('pointerdown', (e) => { if (e.target === el) closeLegal(); });
  (opts.mount || mountPoint()).appendChild(el);
  openEl = el;
  document.addEventListener('keydown', onKey, true);
  try { card.focus(); } catch { /* nothing to do */ }
  return el;
}

/**
 * The "By waddling in you agree..." row with its two links, wired to the
 * overlay. Appended to `parent` and returned.
 * @param {HTMLElement} parent
 * @param {{consent?:boolean}} [opts] consent copy on by default; pass false for
 *        a bare link row (a settings panel, say).
 */
export function mountLegalFooter(parent, opts = {}) {
  ensureLegalStyles();
  const row = elm('div', 'title-legal');
  if (opts.consent !== false) {
    row.appendChild(document.createTextNode('By waddling in you agree to the '));
  }
  LEGAL_LINKS.forEach((link, i) => {
    if (i) row.appendChild(elm('span', 'lg-dot', '·'));
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = opts.consent === false ? link.label : (link.id === 'terms' ? 'Terms of Use' : 'Privacy Policy');
    // A real href so middle-click and "open in new tab" reach the static page,
    // but a plain click stays in the game and opens the overlay.
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      openLegal(link.id);
    };
    row.appendChild(a);
  });
  if (opts.consent !== false) row.appendChild(document.createTextNode('.'));
  parent.appendChild(row);
  return row;
}

// ---------------------------------------------------------------------------
// the recovery-code reveal card (N-08, client half)
// ---------------------------------------------------------------------------

/** Codes are shown with this prefix, which is what the wordlist spec calls for
 *  and what `normalizeRecoveryCode` in server/auth.js strips back off. */
const CODE_PREFIX = 'CAPY-';

/**
 * Show the one and only sight of a player's recovery codes, behind an
 * "I've written them down" gate.
 *
 * The codes exist in exactly one place in this process (the array the caller
 * passes) and this function does not copy them anywhere except into the DOM
 * nodes it removes on resolve. Never log them, never put them in localStorage,
 * never send them anywhere.
 *
 * @param {{codes:string[], username?:string, mount?:HTMLElement, reissued?:boolean}} opts
 * @returns {Promise<void>} resolves once the player has ticked the box and
 *          pressed the button. Resolves immediately if there are no codes, so
 *          the caller can always await it.
 */
export function showRecoveryCodes(opts = {}) {
  const codes = (Array.isArray(opts.codes) ? opts.codes : [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => c.trim());
  if (typeof document === 'undefined' || !codes.length) return Promise.resolve();
  ensureLegalStyles();

  return new Promise((resolve) => {
    const el = elm('div', 'rc-overlay');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Your account recovery codes');

    const card = elm('div', 'rc-card');
    card.tabIndex = -1;
    card.appendChild(elm('h2', null, opts.reissued ? 'Your new recovery codes' : 'Write these down'));
    card.appendChild(elm('div', 'rc-sub',
      `${GAME_NAME} has no email address for you${opts.username ? `, ${opts.username}` : ''}, on purpose. `
      + `These ${codes.length} codes are how you get back in if you forget your password. `
      + 'This is the only time they will ever be shown.'));

    const grid = elm('div', 'rc-grid');
    codes.forEach((code, i) => {
      const c = elm('div', 'rc-code');
      c.style.setProperty('--i', String(i));
      c.appendChild(elm('i', null, CODE_PREFIX));
      c.appendChild(document.createTextNode(code));
      grid.appendChild(c);
    });
    card.appendChild(grid);

    card.appendChild(elm('div', 'rc-warn',
      'Each code works once. Keep them somewhere that is not this computer: a notes app, '
      + 'a password manager, or an actual piece of paper. If you lose your password and these codes, '
      + `nobody can prove the account is yours, and asking ${SUPPORT_CONTACT} is the only route left.`));

    const tools = elm('div', 'rc-tools');
    const said = elm('div', 'rc-said');
    const copy = elm('button', 'rc-btn is-ghost', 'Copy all');
    copy.type = 'button';
    const dl = elm('button', 'rc-btn is-ghost', 'Save as a file');
    dl.type = 'button';
    tools.appendChild(copy);
    tools.appendChild(dl);
    card.appendChild(tools);
    card.appendChild(said);

    const asText = () => [
      `${GAME_NAME} recovery codes${opts.username ? ` for ${opts.username}` : ''}`,
      'Each code works once. Keep them somewhere safe and private.',
      '',
      ...codes.map((c) => `${CODE_PREFIX}${c}`),
      '',
    ].join('\n');

    copy.onclick = async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(asText()); ok = true; } catch { ok = false; }
      if (!ok) {
        // No clipboard permission (or no https): select the grid so Ctrl+C works.
        try {
          const r = document.createRange();
          r.selectNodeContents(grid);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          ok = true;
          said.textContent = 'Selected. Press Ctrl+C to copy.';
        } catch { /* fall through to the failure copy */ }
      } else {
        said.textContent = 'Copied. Now put them somewhere that is not the clipboard.';
      }
      if (!ok) said.textContent = 'Could not copy. Write them down by hand.';
    };

    dl.onclick = () => {
      let url = null;
      try {
        const blob = new Blob([asText()], { type: 'text/plain' });
        url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `capy-cove-recovery-codes${opts.username ? `-${opts.username}` : ''}.txt`;
        a.click();
        said.textContent = 'Saved to your downloads folder.';
      } catch {
        said.textContent = 'Your browser blocked the download. Copy them instead.';
      } finally {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    };

    const gate = elm('label', 'rc-gate');
    const box = document.createElement('input');
    box.type = 'checkbox';
    gate.appendChild(box);
    gate.appendChild(elm('span', null, 'I have written these down somewhere safe.'));
    card.appendChild(gate);

    const go = elm('button', 'rc-btn rc-go', 'Into the cove');
    go.type = 'button';
    go.disabled = true;
    card.appendChild(go);

    box.onchange = () => {
      go.disabled = !box.checked;
      gate.classList.toggle('is-on', box.checked);
      if (box.checked) { try { go.focus(); } catch { /* nothing to do */ } }
    };

    // The gate is a gate: Escape, the backdrop and Enter-before-ticking all do
    // nothing. This is the single most valuable 3 seconds of friction in the
    // whole signup funnel, and a player who skips it churns permanently.
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); }
    };
    document.addEventListener('keydown', key, true);

    go.onclick = () => {
      if (!box.checked) return;
      document.removeEventListener('keydown', key, true);
      el.classList.add('is-closing');
      grid.textContent = ''; // the codes leave the DOM before the animation does
      setTimeout(() => el.remove(), 160);
      resolve();
    };

    el.appendChild(card);
    (opts.mount || mountPoint()).appendChild(el);
    try { card.focus(); } catch { /* nothing to do */ }
  });
}

// ---------------------------------------------------------------------------
// static page rendering (Node-safe: no document, no window)
// ---------------------------------------------------------------------------

function inline(text) {
  return boldParts(text).map((p) => (p.b ? `<b>${esc(p.t)}</b>` : esc(p.t))).join('');
}

/** Trim to a whole word, for the <meta description>. */
function clip(text, max) {
  const s = String(text).trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}...`;
}

function blockToHtml(block) {
  if (typeof block === 'string') return `      <p>${inline(block)}</p>`;
  if (block && Array.isArray(block.list)) {
    return `      <ul>\n${block.list.map((i) => `        <li>${inline(i)}</li>`).join('\n')}\n      </ul>`;
  }
  if (block && block.note) return `      <div class="lg-note">${esc(block.note)}</div>`;
  if (block && block.table) {
    const head = block.table.head.map((h) => `<th>${esc(h)}</th>`).join('');
    const rows = block.table.rows
      .map((r) => `        <tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
      .join('\n');
    return `      <table class="lg-table">\n        <thead><tr>${head}</tr></thead>\n        <tbody>\n${rows}\n        </tbody>\n      </table>`;
  }
  return '';
}

/** Palette and type stack follow DESIGN.md and public/landing.html. Everything
 *  is inline: these pages make no external request of any kind. */
const PAGE_CSS = `
:root{
  --cream:#fff6e3; --card:#fffdf6; --ink:#2d2417; --muted:#8a7a5a;
  --accent:#e8657a; --accent2:#4fb3e8; --gold:#f2b64a;
  --font:"Trebuchet MS","Lucida Grande","Lucida Sans Unicode",Tahoma,Verdana,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--font);color:var(--ink);line-height:1.6;
  background:linear-gradient(180deg,#4fb0e6 0%,#7ecbee 22%,#bfe6f5 42%,#f3e2ae 62%,#f0dca0 100%) fixed;
  padding:clamp(16px,4vw,48px) clamp(12px,4vw,24px);
}
.wrap{max-width:760px;margin:0 auto}
header.top{text-align:center;margin-bottom:20px}
header.top a.brand{
  display:inline-block;font-size:clamp(28px,6vw,40px);font-weight:900;color:var(--accent);
  text-decoration:none;text-shadow:0 3px 0 rgba(45,36,23,.12);letter-spacing:.02em;
}
header.top p{font-weight:700;color:#4a6b7d;font-size:14px;letter-spacing:.05em}
main{
  background:var(--cream);border:4px solid #fff;border-radius:26px;
  padding:clamp(20px,4vw,34px);box-shadow:0 14px 34px rgba(45,36,23,.22),0 0 0 3px rgba(45,36,23,.07);
}
h1{font-size:clamp(24px,5vw,32px);color:var(--accent);margin-bottom:6px}
.when{
  display:inline-block;font-size:10.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;
  color:#8a6a1f;background:rgba(242,182,74,.28);padding:4px 11px;border-radius:999px;margin-bottom:12px;
}
.lede{font-size:15px;font-weight:700;color:#6b5b3c;line-height:1.62;margin-bottom:6px}
section{margin-top:22px}
h2{font-size:19px;margin-bottom:7px}
p,li{font-size:14.5px;font-weight:600;color:#55492f;margin-bottom:9px}
ul{padding-left:21px}
li{margin-bottom:7px}
b{color:var(--ink);font-weight:900}
.lg-note{
  padding:12px 15px;border-radius:15px;font-weight:700;color:#6b4f18;margin:2px 0 11px;
  background:rgba(242,182,74,.2);box-shadow:inset 0 0 0 2px rgba(242,182,74,.4);
}
.lg-table{width:100%;border-collapse:collapse;margin:4px 0 12px}
.lg-table th,.lg-table td{text-align:left;padding:8px 10px;border-bottom:2px solid rgba(45,36,23,.09);vertical-align:top}
.lg-table th{font-size:10.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.lg-table td{font-size:13.5px;font-weight:600;color:#55492f}
.lg-table td:last-child{font-weight:800;color:var(--ink)}
nav.pages{margin-top:26px;padding-top:16px;border-top:3px solid rgba(45,36,23,.09);font-weight:800;font-size:14px}
nav.pages a{color:#b06a78;font-weight:900}
nav.pages a:hover{color:var(--accent)}
footer.small{text-align:center;margin-top:18px;font-size:12px;font-weight:700;color:#4a6b7d}
@media(prefers-color-scheme:dark){body{background:linear-gradient(180deg,#1d3a4d 0%,#28506a 40%,#3b5a5a 100%) fixed}
header.top p,footer.small{color:#cfe6f2}}
`;

/**
 * A complete, standalone HTML page for one document. No external requests, no
 * scripts, readable with JavaScript off. This is what `public/<id>.html` holds
 * (see the regeneration command in the header of this file) and what a
 * `GET /privacy` route in server/index.js can serve directly.
 * @param {'privacy'|'terms'} id
 * @returns {string} the whole document, ending in a newline
 */
export function renderLegalHtml(id) {
  const doc = legalDoc(id);
  if (!doc) return '';
  const other = LEGAL_LINKS.filter((l) => l.id !== doc.id);
  const body = doc.sections.map((sec) => (
    `    <section>\n      <h2>${esc(sec.h)}</h2>\n${sec.body.map(blockToHtml).filter(Boolean).join('\n')}\n    </section>`
  )).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(doc.title)} - ${esc(GAME_NAME)}</title>
<meta name="description" content="${esc(clip(doc.lede, 170))}" />
<meta name="theme-color" content="#fff6e3" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A6%AB%3C/text%3E%3C/svg%3E" />
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="brand" href="/">${esc(GAME_NAME)}</a>
    <p>waddle in &middot; hang out &middot; play</p>
  </header>
  <main>
    <h1>${esc(doc.title)}</h1>
    <div class="when">Last updated ${esc(LEGAL_UPDATED)}</div>
    <p class="lede">${esc(doc.lede)}</p>
${body}
    <nav class="pages">
      ${other.map((l) => `<a href="${esc(l.href)}">Read the ${esc(l.id === 'privacy' ? 'Privacy Policy' : 'Terms of Use')}</a>`).join(' &middot; ')}
      &middot; <a href="/">Back to the cove</a>
    </nav>
  </main>
  <footer class="small">${esc(GAME_NAME)} is an original game and is not affiliated with, endorsed by or connected to any other game, studio or franchise.</footer>
</div>
</body>
</html>
`;
}
