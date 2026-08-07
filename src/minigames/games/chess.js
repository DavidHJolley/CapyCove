import { Minigame } from '../minigame.js';
import { clampCoinsForGame } from '../../../shared/constants.js';

/**
 * Grand Capy Chess : a full game of chess against Grandmaster Pebble, the
 * monocled capybara who runs the back table of the Game Den.
 *
 * Everything is here and legal: castling, en passant, promotion (with a choice
 * dialog), check / checkmate / stalemate, threefold repetition, the fifty-move
 * rule and dead positions. Pebble thinks with alpha-beta minimax (depth 3 plus
 * a capture-only quiescence search) over material + piece-square tables +
 * mobility, and he warms up over the first few moves before playing his best.
 *
 * Board and pieces are drawn procedurally on a 2D canvas; the portrait uses the
 * same face language as the Smoothie Shack customers.
 *
 * TABLE MATCHES: if `game.__matchCtx` is set at mount ({game, players, youAre,
 * seed}) the very same board becomes a two-capy duel instead. Seat 0 plays the
 * cream pieces and moves first; seat 1 gets the board flipped so their own
 * capys are at the bottom. Our moves go out as {move:{from,to,promo}} and every
 * move that comes back in is replayed through this file's own legal-move
 * generator, so an illegal or out-of-turn packet freezes the board with an
 * apology instead of quietly desyncing the two games. Draw offers, resignations
 * and the shared result ride the same channel. No clocks (this is a cozy den):
 * the board just pulses gold when it is your move. Solo play against
 * Grandmaster Pebble is untouched by any of it.
 *
 * ===========================================================================
 * PART 1 - the chess engine (pure functions, no DOM, unit-testable in node)
 * ===========================================================================
 */

export const EMPTY = 0;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const BLACK_BIT = 8;

const typeOf = (p) => p & 7;
const colorOf = (p) => ((p & BLACK_BIT) ? 1 : 0); // only meaningful when p !== 0
const mk = (t, c) => (c === 1 ? t | BLACK_BIT : t);

// Moves are packed into one int so search never allocates:
//   bits 0-5 from | 6-11 to | 12-14 promotion type | 15-17 flag
// Bits 18+ are borrowed by the move orderer for its sort key and masked off.
const FLAG_NONE = 0, FLAG_DOUBLE = 1, FLAG_EP = 2, FLAG_CASTLE = 3;
const MOVE_MASK = 0x3ffff;
const mkMove = (from, to, promo = 0, flag = 0) => from | (to << 6) | (promo << 12) | (flag << 15);
export const mFrom = (m) => m & 63;
export const mTo = (m) => (m >> 6) & 63;
export const mPromo = (m) => (m >> 12) & 7;
export const mFlag = (m) => (m >> 15) & 7;

const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const BISHOP_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const KING_D = [...BISHOP_D, ...ROOK_D];

// Castling rights: 1 = white O-O, 2 = white O-O-O, 4 = black O-O, 8 = black O-O-O.
// Any move touching one of these squares kills the matching right.
const CASTLE_MASK = new Int8Array(64).fill(15);
CASTLE_MASK[60] = 15 & ~3;  // e1
CASTLE_MASK[56] = 15 & ~2;  // a1
CASTLE_MASK[63] = 15 & ~1;  // h1
CASTLE_MASK[4] = 15 & ~12;  // e8
CASTLE_MASK[0] = 15 & ~8;   // a8
CASTLE_MASK[7] = 15 & ~4;   // h8

const CHAR_PIECE = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
const PIECE_CHAR = ['', '', 'N', 'B', 'R', 'Q', 'K'];
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const fileChar = (sq) => 'abcdefgh'[sq & 7];
const rankChar = (sq) => `${8 - (sq >> 3)}`;
export const sqName = (sq) => fileChar(sq) + rankChar(sq);
const sqFromName = (s) => (8 - Number(s[1])) * 8 + (s.charCodeAt(0) - 97);
const sqIsDark = (sq) => (((sq >> 3) + (sq & 7)) & 1) === 1;

/** Parse a FEN into a mutable position. Also used by the perft tests. */
export function fromFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const b = new Int8Array(64);
  let sq = 0;
  for (const ch of parts[0]) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') { sq += Number(ch); continue; }
    const low = ch.toLowerCase();
    const t = CHAR_PIECE[low];
    if (t) b[sq++] = mk(t, ch === low ? 1 : 0);
  }
  const rights = parts[2] || '-';
  const st = {
    b,
    turn: parts[1] === 'b' ? 1 : 0,
    castle: (rights.includes('K') ? 1 : 0) | (rights.includes('Q') ? 2 : 0)
      | (rights.includes('k') ? 4 : 0) | (rights.includes('q') ? 8 : 0),
    ep: parts[3] && parts[3] !== '-' ? sqFromName(parts[3]) : -1,
    half: Number(parts[4]) || 0,
    full: Number(parts[5]) || 1,
    k: [60, 4],
  };
  for (let i = 0; i < 64; i++) {
    if (typeOf(b[i]) === KING) st.k[colorOf(b[i])] = i;
  }
  return st;
}

/** Exact position identity for threefold repetition (board + turn + rights + ep). */
export function posKey(st) {
  let s = '';
  for (let i = 0; i < 64; i++) s += String.fromCharCode(48 + st.b[i]);
  return `${s}|${st.turn}|${st.castle}|${st.ep}`;
}

// ---------------------------------------------------------------------------
// move generation
// ---------------------------------------------------------------------------

/** Is `sq` attacked by any piece of colour `by`? */
export function attacked(st, sq, by) {
  const b = st.b, r = sq >> 3, f = sq & 7;
  // pawns: a white pawn sits one row below (r+1) the square it attacks
  const pr = r + (by === 0 ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    for (const df of [-1, 1]) {
      const nf = f + df;
      if (nf < 0 || nf > 7) continue;
      const p = b[pr * 8 + nf];
      if (p && typeOf(p) === PAWN && colorOf(p) === by) return true;
    }
  }
  for (const [df, dr] of KNIGHT_D) {
    const nf = f + df, nr = r + dr;
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
    const p = b[nr * 8 + nf];
    if (p && typeOf(p) === KNIGHT && colorOf(p) === by) return true;
  }
  for (const [df, dr] of KING_D) {
    const nf = f + df, nr = r + dr;
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
    const p = b[nr * 8 + nf];
    if (p && typeOf(p) === KING && colorOf(p) === by) return true;
  }
  for (let i = 0; i < 8; i++) {
    const diag = i < 4;
    const [df, dr] = diag ? BISHOP_D[i] : ROOK_D[i - 4];
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = b[nr * 8 + nf];
      if (p) {
        const t = typeOf(p);
        if (colorOf(p) === by && (t === QUEEN || t === (diag ? BISHOP : ROOK))) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }
  return false;
}

export const inCheck = (st, color = st.turn) => attacked(st, st.k[color], color ^ 1);

function pushPawn(out, from, to, promo, flag) {
  if (promo) {
    out.push(mkMove(from, to, QUEEN, flag), mkMove(from, to, ROOK, flag),
      mkMove(from, to, BISHOP, flag), mkMove(from, to, KNIGHT, flag));
  } else {
    out.push(mkMove(from, to, 0, flag));
  }
}

/** Pseudo-legal moves for the side to move. capsOnly also keeps promotions. */
export function genMoves(st, capsOnly = false) {
  const out = [];
  const b = st.b, us = st.turn;
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (!p || colorOf(p) !== us) continue;
    const t = typeOf(p), r = sq >> 3, f = sq & 7;

    if (t === PAWN) {
      const dir = us === 0 ? -1 : 1;
      const startRow = us === 0 ? 6 : 1;
      const lastRow = us === 0 ? 0 : 7;
      const nr = r + dir;
      if (nr < 0 || nr > 7) continue; // unreachable in a legal position
      const one = nr * 8 + f;
      if (!b[one]) {
        if (!capsOnly || nr === lastRow) pushPawn(out, sq, one, nr === lastRow, FLAG_NONE);
        if (!capsOnly && r === startRow) {
          const two = (r + dir * 2) * 8 + f;
          if (!b[two]) out.push(mkMove(sq, two, 0, FLAG_DOUBLE));
        }
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const to = nr * 8 + nf;
        const tp = b[to];
        if (tp) {
          if (colorOf(tp) !== us) pushPawn(out, sq, to, nr === lastRow, FLAG_NONE);
        } else if (to === st.ep) {
          out.push(mkMove(sq, to, 0, FLAG_EP));
        }
      }
    } else if (t === KNIGHT || t === KING) {
      for (const [df, dr] of (t === KNIGHT ? KNIGHT_D : KING_D)) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf, tp = b[to];
        if (tp && colorOf(tp) === us) continue;
        if (capsOnly && !tp) continue;
        out.push(mkMove(sq, to, 0, FLAG_NONE));
      }
      if (t === KING && !capsOnly) {
        // castling: rights, empty path, king not in or through check
        const them = us ^ 1;
        if (us === 0 && sq === 60) {
          if ((st.castle & 1) && !b[61] && !b[62] && b[63] === ROOK
            && !attacked(st, 60, them) && !attacked(st, 61, them)) out.push(mkMove(60, 62, 0, FLAG_CASTLE));
          if ((st.castle & 2) && !b[59] && !b[58] && !b[57] && b[56] === ROOK
            && !attacked(st, 60, them) && !attacked(st, 59, them)) out.push(mkMove(60, 58, 0, FLAG_CASTLE));
        } else if (us === 1 && sq === 4) {
          const bRook = mk(ROOK, 1);
          if ((st.castle & 4) && !b[5] && !b[6] && b[7] === bRook
            && !attacked(st, 4, them) && !attacked(st, 5, them)) out.push(mkMove(4, 6, 0, FLAG_CASTLE));
          if ((st.castle & 8) && !b[3] && !b[2] && !b[1] && b[0] === bRook
            && !attacked(st, 4, them) && !attacked(st, 3, them)) out.push(mkMove(4, 2, 0, FLAG_CASTLE));
        }
      }
    } else {
      const dirs = t === BISHOP ? BISHOP_D : t === ROOK ? ROOK_D : KING_D;
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf, tp = b[to];
          if (tp) {
            if (colorOf(tp) !== us) out.push(mkMove(sq, to, 0, FLAG_NONE));
            break;
          }
          if (!capsOnly) out.push(mkMove(sq, to, 0, FLAG_NONE));
          nf += df; nr += dr;
        }
      }
    }
  }
  return out;
}

/** Apply a move, returning the record needed to take it back. */
export function makeMove(st, m) {
  const b = st.b, us = st.turn;
  const from = mFrom(m), to = mTo(m), flag = mFlag(m), promo = mPromo(m);
  const p = b[from];
  const u = { piece: p, cap: 0, capSq: -1, castle: st.castle, ep: st.ep, half: st.half, full: st.full };

  let capSq = -1;
  if (flag === FLAG_EP) capSq = to + (us === 0 ? 8 : -8);
  else if (b[to]) capSq = to;
  if (capSq >= 0) { u.cap = b[capSq]; u.capSq = capSq; b[capSq] = 0; }

  b[from] = 0;
  b[to] = promo ? mk(promo, us) : p;

  if (typeOf(p) === KING) {
    st.k[us] = to;
    if (flag === FLAG_CASTLE) {
      if (to === 62) { b[61] = b[63]; b[63] = 0; }
      else if (to === 58) { b[59] = b[56]; b[56] = 0; }
      else if (to === 6) { b[5] = b[7]; b[7] = 0; }
      else if (to === 2) { b[3] = b[0]; b[0] = 0; }
    }
  }

  st.castle &= CASTLE_MASK[from] & CASTLE_MASK[to];
  st.ep = flag === FLAG_DOUBLE ? (from + to) >> 1 : -1;
  st.half = (typeOf(p) === PAWN || capSq >= 0) ? 0 : st.half + 1;
  if (us === 1) st.full++;
  st.turn = us ^ 1;
  return u;
}

export function unmakeMove(st, m, u) {
  const b = st.b;
  const from = mFrom(m), to = mTo(m), flag = mFlag(m);
  const us = st.turn ^ 1;
  st.turn = us;
  st.castle = u.castle; st.ep = u.ep; st.half = u.half; st.full = u.full;

  b[from] = u.piece;
  b[to] = 0;
  if (u.capSq >= 0) b[u.capSq] = u.cap;

  if (typeOf(u.piece) === KING) {
    st.k[us] = from;
    if (flag === FLAG_CASTLE) {
      if (to === 62) { b[63] = b[61]; b[61] = 0; }
      else if (to === 58) { b[56] = b[59]; b[59] = 0; }
      else if (to === 6) { b[7] = b[5]; b[5] = 0; }
      else if (to === 2) { b[0] = b[3]; b[3] = 0; }
    }
  }
}

/** Fully legal moves: pseudo-legal filtered by "does my king survive it". */
export function legalMoves(st, capsOnly = false) {
  const us = st.turn;
  const res = [];
  for (const m of genMoves(st, capsOnly)) {
    const u = makeMove(st, m);
    if (!attacked(st, st.k[us], us ^ 1)) res.push(m);
    unmakeMove(st, m, u);
  }
  return res;
}

/** Node count of the legal move tree: the move generator's unit test. */
export function perft(st, depth) {
  if (depth <= 0) return 1;
  const moves = legalMoves(st);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    const u = makeMove(st, m);
    n += perft(st, depth - 1);
    unmakeMove(st, m, u);
  }
  return n;
}

/** Draw by dead position (K v K, K+minor v K, K+B v K+B on one colour). */
export function insufficientMaterial(st) {
  const bishops = [];
  let knights = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = st.b[sq];
    if (!p) continue;
    const t = typeOf(p);
    if (t === PAWN || t === ROOK || t === QUEEN) return false;
    if (t === BISHOP) bishops.push(sq * 2 + colorOf(p));
    else if (t === KNIGHT) knights++;
  }
  const minors = bishops.length + knights;
  if (minors <= 1) return true;
  if (minors === 2 && bishops.length === 2) {
    const [a, b] = bishops;
    return (a & 1) !== (b & 1) && sqIsDark(a >> 1) === sqIsDark(b >> 1);
  }
  return false;
}

/** Standard algebraic notation for a move in position `st` (before the move). */
export function toSan(st, m) {
  const from = mFrom(m), to = mTo(m), flag = mFlag(m), promo = mPromo(m);
  const p = st.b[from], t = typeOf(p);
  const capture = st.b[to] !== 0 || flag === FLAG_EP;
  let san;

  if (flag === FLAG_CASTLE) {
    san = (to & 7) === 6 ? 'O-O' : 'O-O-O';
  } else if (t === PAWN) {
    san = (capture ? `${fileChar(from)}x` : '') + sqName(to);
    if (promo) san += `=${PIECE_CHAR[promo]}`;
  } else {
    let file = false, rank = false, need = false;
    for (const o of legalMoves(st)) {
      const of = mFrom(o);
      if (mTo(o) !== to || of === from || typeOf(st.b[of]) !== t) continue;
      need = true;
      if ((of & 7) === (from & 7)) file = true;
      if ((of >> 3) === (from >> 3)) rank = true;
    }
    const dis = !need ? '' : !file ? fileChar(from) : !rank ? rankChar(from) : sqName(from);
    san = PIECE_CHAR[t] + dis + (capture ? 'x' : '') + sqName(to);
  }

  const u = makeMove(st, m);
  const opp = st.turn;
  const check = attacked(st, st.k[opp], opp ^ 1);
  const stuck = legalMoves(st).length === 0;
  unmakeMove(st, m, u);
  if (check) san += stuck ? '#' : '+';
  return san;
}
// ---------------------------------------------------------------------------
// evaluation: material + piece-square tables + mobility + a few shape terms
// ---------------------------------------------------------------------------

const VAL = [0, 100, 320, 330, 500, 900, 0];
export const POINTS = [0, 1, 3, 3, 5, 9, 0]; // human-readable material score

// Tables are written from white's point of view with index 0 = a8, which is
// exactly this board's indexing. Black reads the same table mirrored (sq ^ 56).
const PST_PAWN = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
]);
const PST_KNIGHT = new Int8Array([
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
]);
const PST_BISHOP = new Int8Array([
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
]);
const PST_ROOK = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
]);
const PST_QUEEN = new Int8Array([
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
]);
const PST_KING_MID = new Int8Array([
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
]);
const PST_KING_END = new Int8Array([
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
]);
const PST = [null, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, PST_KING_MID];

/** Static evaluation in centipawns, positive = white is better. */
export function evaluate(st) {
  const b = st.b;
  let score = 0, heavy = 0, bishopW = 0, bishopB = 0;
  const pawnsW = [0, 0, 0, 0, 0, 0, 0, 0];
  const pawnsB = [0, 0, 0, 0, 0, 0, 0, 0];

  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (!p) continue;
    const t = typeOf(p), c = colorOf(p);
    if (t === KING) continue;
    const sign = c === 0 ? 1 : -1;
    const idx = c === 0 ? sq : sq ^ 56;
    score += sign * (VAL[t] + PST[t][idx]);

    if (t === PAWN) { (c === 0 ? pawnsW : pawnsB)[sq & 7]++; continue; }
    if (t === BISHOP) { if (c === 0) bishopW++; else bishopB++; }
    if (t !== PAWN) heavy += VAL[t];

    // mobility: cheap ray/hop count for the pieces that care about space
    let moves = 0;
    const r = sq >> 3, f = sq & 7;
    if (t === KNIGHT) {
      for (const [df, dr] of KNIGHT_D) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const tp = b[nr * 8 + nf];
        if (!tp || colorOf(tp) !== c) moves++;
      }
    } else {
      const dirs = t === BISHOP ? BISHOP_D : t === ROOK ? ROOK_D : KING_D;
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const tp = b[nr * 8 + nf];
          if (tp) { if (colorOf(tp) !== c) moves++; break; }
          moves++;
          nf += df; nr += dr;
        }
      }
    }
    score += sign * moves * 2;
  }

  // kings: hide in the middlegame, march in the endgame
  const endgame = heavy <= 1300;
  const kt = endgame ? PST_KING_END : PST_KING_MID;
  score += kt[st.k[0]] - kt[st.k[1] ^ 56];

  if (bishopW >= 2) score += 30;
  if (bishopB >= 2) score -= 30;

  for (let f = 0; f < 8; f++) {
    if (pawnsW[f] > 1) score -= (pawnsW[f] - 1) * 14;
    if (pawnsB[f] > 1) score += (pawnsB[f] - 1) * 14;
    const lw = f > 0 ? pawnsW[f - 1] : 0, rw = f < 7 ? pawnsW[f + 1] : 0;
    const lb = f > 0 ? pawnsB[f - 1] : 0, rb = f < 7 ? pawnsB[f + 1] : 0;
    if (pawnsW[f] && !lw && !rw) score -= 14;
    if (pawnsB[f] && !lb && !rb) score += 14;
  }
  return score;
}

/** Material balance in pawns-and-pieces points, positive = white ahead. */
export function materialLead(st) {
  let lead = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = st.b[sq];
    if (!p) continue;
    lead += (colorOf(p) === 0 ? 1 : -1) * POINTS[typeOf(p)];
  }
  return lead;
}

// ---------------------------------------------------------------------------
// search: alpha-beta minimax with a capture-only quiescence extension
// ---------------------------------------------------------------------------

const MATE = 100000;
const ORDER_SHIFT = 18;
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Sort key packed into the spare high bits, so ordering allocates nothing. */
function orderMoves(st, moves) {
  const b = st.b;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const from = mFrom(m), to = mTo(m), flag = mFlag(m), promo = mPromo(m);
    const victim = b[to];
    let s;
    if (promo) s = 6000 + POINTS[promo] * 20;
    else if (victim) s = 3000 + POINTS[typeOf(victim)] * 60 - POINTS[typeOf(b[from])] * 4;
    else if (flag === FLAG_EP) s = 3060;
    else if (flag === FLAG_CASTLE) s = 900;
    else {
      const t = typeOf(b[from]), c = colorOf(b[from]);
      const tbl = t === KING ? PST_KING_MID : PST[t];
      const i0 = c === 0 ? from : from ^ 56;
      const i1 = c === 0 ? to : to ^ 56;
      s = 400 + tbl[i1] - tbl[i0];
    }
    moves[i] = m | (Math.max(0, Math.min(8191, s)) << ORDER_SHIFT);
  }
  moves.sort((a, b2) => b2 - a);
  for (let i = 0; i < moves.length; i++) moves[i] &= MOVE_MASK;
  return moves;
}

const evalFor = (st) => (st.turn === 0 ? evaluate(st) : -evaluate(st));

function quiesce(st, alpha, beta, ply, qd, ctx) {
  ctx.nodes++;
  if (inCheck(st)) {
    // never stand pat while in check: search every escape or admit the mate
    const evasions = legalMoves(st);
    if (!evasions.length) return -(MATE - ply);
    if (qd <= 0 || ctx.nodes > ctx.budget) return evalFor(st);
    orderMoves(st, evasions);
    let best = -Infinity;
    for (const m of evasions) {
      const u = makeMove(st, m);
      const s = -quiesce(st, -beta, -alpha, ply + 1, qd - 1, ctx);
      unmakeMove(st, m, u);
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  const stand = evalFor(st);
  if (stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  if (qd <= 0 || ctx.nodes > ctx.budget) return stand;

  let best = stand;
  const caps = orderMoves(st, legalMoves(st, true));
  for (const m of caps) {
    const u = makeMove(st, m);
    const s = -quiesce(st, -beta, -alpha, ply + 1, qd - 1, ctx);
    unmakeMove(st, m, u);
    if (s > best) best = s;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function negamax(st, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if (st.half >= 100 || insufficientMaterial(st)) return 0;
  if (depth <= 0) return quiesce(st, alpha, beta, ply, 5, ctx);

  const moves = orderMoves(st, legalMoves(st));
  if (!moves.length) return inCheck(st) ? -(MATE - ply) : 0;

  let best = -Infinity;
  for (const m of moves) {
    const u = makeMove(st, m);
    const s = -negamax(st, depth - 1, -beta, -alpha, ply + 1, ctx);
    unmakeMove(st, m, u);
    if (s > best) best = s;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
    if (ctx.nodes > ctx.budget) break;
  }
  return best;
}

/**
 * Pick a move for the side to move.
 * `slack` lets Pebble warm up: he picks at random among moves within that many
 * centipawns of his best instead of always playing the sharpest one.
 * Returns { move, score, best, nodes, ms } with score from HIS point of view.
 */
export function bestMove(st, { depth = 3, slack = 0, timeMs = 900, budget = 400000 } = {}) {
  const moves = orderMoves(st, legalMoves(st));
  if (!moves.length) return null;
  const ctx = { nodes: 0, budget };
  const t0 = now();
  const deadline = t0 + timeMs;
  const scored = [];
  let best = -Infinity;

  for (const m of moves) {
    // window: anything more than `slack` worse than the current best can fail
    // low, we would never pick it anyway
    const alpha = best === -Infinity ? -Infinity : best - slack - 1;
    const u = makeMove(st, m);
    const s = -negamax(st, depth - 1, -Infinity, -alpha, 1, ctx);
    unmakeMove(st, m, u);
    scored.push({ m, s });
    if (s > best) best = s;
    if (now() > deadline || ctx.nodes > ctx.budget) break;
  }

  const pool = scored.filter((x) => x.s >= best - slack);
  const pick = pool[Math.floor(Math.random() * pool.length)] || scored[0];
  return { move: pick.m, score: pick.s, best, nodes: ctx.nodes, ms: now() - t0 };
}
/**
 * ===========================================================================
 * PART 2 - the art: chunky capy pieces and Pebble's portrait, drawn on canvas
 * ===========================================================================
 */

const OUTLINE = '#2d2417';
const LIGHT_SQ = '#efd6a4';
const DARK_SQ = '#b08a5a';

function rgbOf(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexFrom(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mixHex(a, b, t) {
  const A = rgbOf(a), B = rgbOf(b);
  return hexFrom(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
/** amt > 0 lightens toward cream, amt < 0 darkens toward the outline ink. */
const shade = (h, amt) => (amt >= 0 ? mixHex(h, '#fff3dc', amt) : mixHex(h, OUTLINE, -amt));
const hexOf = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function ink(ctx, w = 4) {
  ctx.lineWidth = w; ctx.strokeStyle = OUTLINE; ctx.stroke();
}

/** The shared capybara face, used by every piece at whatever size it needs. */
function capyHead(ctx, cx, cy, r, body, opts = {}) {
  const dark = shade(body, -0.22);
  const light = shade(body, 0.2);
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * r * 0.84, cy - r * 0.56, r * 0.33, r * 0.29, s * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, r * 0.2);
  }
  rrect(ctx, cx - r, cy - r * 0.8, r * 2, r * 1.6, r * 0.58);
  ctx.fillStyle = body; ctx.fill(); ink(ctx, r * 0.24);
  rrect(ctx, cx - r * 0.58, cy + r * 0.02, r * 1.16, r * 0.68, r * 0.28);
  ctx.fillStyle = light; ctx.fill(); ink(ctx, r * 0.18);
  ctx.fillStyle = OUTLINE;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * r * 0.2, cy + r * 0.3, r * 0.07, r * 0.11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + s * r * 0.44, cy - r * 0.3, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  if (opts.whiskers) {
    ctx.lineWidth = r * 0.09; ctx.strokeStyle = OUTLINE; ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cx + s * r * 0.5, cy + r * 0.3 + i * r * 0.16);
        ctx.lineTo(cx + s * r * 1.15, cy + r * 0.16 + i * r * 0.34);
        ctx.stroke();
      }
    }
  }
}

/** One chess piece, designed on a 100x100 grid with its feet at y=90. */
function drawPiece(ctx, type, black) {
  const body = black ? '#5b4130' : '#fff4dc';
  const dark = shade(body, -0.22);
  const gold = black ? '#d99a3c' : '#f2b64a';
  const accent = black ? '#c9566b' : '#4fb3e8';
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.ellipse(50, 89, 29, 6.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(45,36,23,.22)'; ctx.fill();

  const foot = (w) => {
    rrect(ctx, 50 - w / 2, 76, w, 13, 6);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, 4);
  };

  if (type === PAWN) {
    foot(40);
    ctx.beginPath();
    ctx.moveTo(37, 77);
    ctx.quadraticCurveTo(39, 60, 50, 57);
    ctx.quadraticCurveTo(61, 60, 63, 77);
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill(); ink(ctx, 4);
    capyHead(ctx, 50, 40, 16, body);
  } else if (type === KNIGHT) {
    ctx.save();
    ctx.translate(62, 50);
    ctx.rotate(-0.75);
    ctx.beginPath();
    ctx.ellipse(0, 0, 36, 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = accent; ctx.fill(); ink(ctx, 4);
    ctx.beginPath();
    ctx.moveTo(-26, 0); ctx.lineTo(26, 0);
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff6e3'; ctx.stroke();
    ctx.restore();
    foot(44);
    ctx.beginPath();
    ctx.moveTo(34, 77);
    ctx.quadraticCurveTo(36, 58, 48, 55);
    ctx.quadraticCurveTo(60, 58, 62, 77);
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill(); ink(ctx, 4);
    capyHead(ctx, 45, 39, 17, body);
    // a curl of wave at the tail of the board
    ctx.beginPath();
    ctx.moveTo(74, 74);
    ctx.quadraticCurveTo(86, 68, 84, 78);
    ctx.quadraticCurveTo(82, 84, 72, 82);
    ctx.fillStyle = '#8fd3f0'; ctx.fill(); ink(ctx, 3);
  } else if (type === BISHOP) {
    foot(44);
    ctx.beginPath();
    ctx.moveTo(35, 77);
    ctx.quadraticCurveTo(37, 60, 50, 57);
    ctx.quadraticCurveTo(63, 60, 65, 77);
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill(); ink(ctx, 4);
    capyHead(ctx, 50, 46, 16, body);
    // pointed straw sun hat
    ctx.beginPath();
    ctx.ellipse(50, 33, 31, 8.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = gold; ctx.fill(); ink(ctx, 4);
    ctx.beginPath();
    ctx.moveTo(31, 32);
    ctx.quadraticCurveTo(50, -4, 69, 32);
    ctx.closePath();
    ctx.fillStyle = shade(gold, 0.16); ctx.fill(); ink(ctx, 4);
    rrect(ctx, 36, 24, 28, 7, 3.5);
    ctx.fillStyle = accent; ctx.fill(); ink(ctx, 3);
  } else if (type === ROOK) {
    foot(52);
    for (const x of [26, 44, 62]) {
      rrect(ctx, x, 20, 12, 14, 3);
      ctx.fillStyle = body; ctx.fill(); ink(ctx, 4);
    }
    rrect(ctx, 25, 30, 50, 48, 7);
    ctx.fillStyle = body; ctx.fill(); ink(ctx, 4);
    ctx.lineWidth = 2.6; ctx.strokeStyle = shade(body, -0.14);
    for (const y of [44, 58, 70]) {
      ctx.beginPath(); ctx.moveTo(28, y); ctx.lineTo(72, y); ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(50, 52, 14, 0, Math.PI * 2);
    ctx.fillStyle = shade(body, -0.3); ctx.fill(); ink(ctx, 3.5);
    capyHead(ctx, 50, 52, 9.5, shade(body, 0.08));
  } else if (type === QUEEN) {
    foot(50);
    ctx.beginPath();
    ctx.moveTo(31, 77);
    ctx.quadraticCurveTo(33, 58, 50, 54);
    ctx.quadraticCurveTo(67, 58, 69, 77);
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill(); ink(ctx, 4);
    // scalloped collar
    ctx.beginPath();
    for (let i = 0; i < 5; i++) ctx.arc(34 + i * 8, 62, 5.4, Math.PI, Math.PI * 2);
    ctx.fillStyle = shade(body, -0.14); ctx.fill(); ink(ctx, 3);
    capyHead(ctx, 50, 44, 17, body);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(50 + Math.cos(a) * 13, 22 + Math.sin(a) * 9, 7, 6, a, 0, Math.PI * 2);
      ctx.fillStyle = accent; ctx.fill(); ink(ctx, 3);
    }
    ctx.beginPath();
    ctx.arc(50, 22, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = gold; ctx.fill(); ink(ctx, 3);
  } else if (type === KING) {
    foot(52);
    ctx.beginPath();
    ctx.moveTo(30, 77);
    ctx.quadraticCurveTo(32, 57, 50, 53);
    ctx.quadraticCurveTo(68, 57, 70, 77);
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill(); ink(ctx, 4);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) ctx.arc(34 + i * 8, 62, 5.4, Math.PI, Math.PI * 2);
    ctx.fillStyle = shade(body, -0.14); ctx.fill(); ink(ctx, 3);
    capyHead(ctx, 50, 46, 17.5, body, { whiskers: true });
    ctx.beginPath();
    ctx.moveTo(31, 26);
    ctx.lineTo(35, 8); ctx.lineTo(43, 20);
    ctx.lineTo(50, 5); ctx.lineTo(57, 20);
    ctx.lineTo(65, 8); ctx.lineTo(69, 26);
    ctx.closePath();
    ctx.fillStyle = gold; ctx.fill(); ink(ctx, 4);
    rrect(ctx, 30, 24, 40, 9, 4);
    ctx.fillStyle = shade(gold, -0.16); ctx.fill(); ink(ctx, 3.5);
    ctx.beginPath();
    ctx.arc(50, 3, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = accent; ctx.fill(); ink(ctx, 3);
  }
  ctx.restore();
}

const PIECE_LORE = [
  null,
  { name: 'Pebble Pup', how: 'shuffles one square forward, bonks diagonally, and turns royal on the far shore' },
  { name: 'Surf Capy', how: 'hops an L-shape and rides clean over anyone in the way' },
  { name: 'Sunhat Sage', how: 'glides along the diagonals for as far as it likes' },
  { name: 'Tide Tower', how: 'rolls in straight lines, and castles with the Elder' },
  { name: 'Bloom Queen', how: 'straight lines AND diagonals. absolutely terrifying' },
  { name: 'Crowned Elder', how: 'one careful step at a time. keep them safe' },
];

/**
 * Grandmaster Pebble himself, on a 200x200 grid.
 * expr: idle | think | smug | worried | beaten | blink
 */
function drawPebble(ctx, size, expr, cfg = {}) {
  const s = size / 200;
  const body = cfg.color || '#a8825a';
  const dark = shade(body, -0.24);
  const muzzle = shade(body, 0.22);
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  rrect(ctx, 48, 150, 104, 60, 30);
  ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);

  for (const ex of [46, 154]) {
    ctx.beginPath();
    ctx.ellipse(ex, 48, 20, 17, ex < 100 ? 0.3 : -0.3, 0, Math.PI * 2);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);
    ctx.beginPath();
    ctx.ellipse(ex, 50, 9, 7, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e2a3a8'; ctx.fill();
  }

  rrect(ctx, 38, 36, 124, 104, 42);
  ctx.fillStyle = body; ctx.fill(); ink(ctx, 5.5);
  rrect(ctx, 58, 96, 84, 58, 26);
  ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 4.5);

  ctx.fillStyle = OUTLINE;
  for (const nx of [86, 114]) {
    ctx.save(); ctx.translate(nx, 116); ctx.rotate(nx < 100 ? 0.5 : -0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // mouth
  ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
  if (expr === 'smug') {
    ctx.beginPath();
    ctx.moveTo(84, 132); ctx.quadraticCurveTo(100, 130, 116, 122); ctx.stroke();
  } else if (expr === 'worried') {
    ctx.beginPath();
    ctx.moveTo(86, 134); ctx.quadraticCurveTo(93, 140, 100, 134);
    ctx.quadraticCurveTo(107, 128, 114, 134); ctx.stroke();
  } else if (expr === 'beaten') {
    ctx.beginPath();
    ctx.ellipse(100, 132, 13, 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
  } else if (expr === 'think') {
    ctx.beginPath();
    ctx.moveTo(88, 132); ctx.lineTo(110, 129); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(88, 130); ctx.quadraticCurveTo(100, 140, 112, 130); ctx.stroke();
  }

  // eyes
  const eyes = [70, 130];
  for (let i = 0; i < 2; i++) {
    const ex = eyes[i];
    ctx.lineWidth = 5; ctx.strokeStyle = OUTLINE;
    if (expr === 'beaten') {
      ctx.beginPath();
      ctx.moveTo(ex - 9, 68); ctx.lineTo(ex + 9, 84);
      ctx.moveTo(ex + 9, 68); ctx.lineTo(ex - 9, 84);
      ctx.stroke();
    } else if (expr === 'blink') {
      ctx.beginPath();
      ctx.moveTo(ex - 11, 78); ctx.quadraticCurveTo(ex, 88, ex + 11, 78); ctx.stroke();
    } else if (expr === 'smug') {
      ctx.beginPath();
      ctx.ellipse(ex, 78, 10, 6, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ex - 12, 80); ctx.lineTo(ex + 12, 80); ctx.stroke();
    } else {
      const r = expr === 'worried' ? 8 : 10;
      const dx = expr === 'think' ? -3 : 0;
      const dy = expr === 'think' ? -3 : 0;
      ctx.beginPath();
      ctx.ellipse(ex, 76, r, r + 1.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.beginPath();
      ctx.arc(ex - 3.4 + dx, 72 + dy, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    // brows
    ctx.lineWidth = 5; ctx.strokeStyle = OUTLINE;
    if (expr === 'think') {
      ctx.beginPath();
      if (i === 1) { ctx.moveTo(ex - 13, 56); ctx.lineTo(ex + 13, 50); }
      else { ctx.moveTo(ex - 13, 58); ctx.lineTo(ex + 13, 58); }
      ctx.stroke();
    } else if (expr === 'worried') {
      ctx.beginPath();
      ctx.moveTo(ex + (i ? 12 : -12), 60); ctx.lineTo(ex + (i ? -5 : 5), 55); ctx.stroke();
    } else if (expr === 'smug') {
      ctx.beginPath();
      ctx.moveTo(ex + (i ? 13 : -13), 58); ctx.lineTo(ex + (i ? -6 : 6), 52); ctx.stroke();
    }
  }

  if (expr === 'smug' || expr === 'idle') {
    ctx.fillStyle = 'rgba(232,101,122,0.3)';
    ctx.beginPath(); ctx.ellipse(52, 106, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(148, 106, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (expr === 'worried' || expr === 'beaten') {
    ctx.beginPath();
    ctx.moveTo(170, 58); ctx.quadraticCurveTo(181, 74, 170, 80);
    ctx.quadraticCurveTo(159, 74, 170, 58); ctx.closePath();
    ctx.fillStyle = '#9ed9f2'; ctx.fill(); ink(ctx, 3.5);
  }

  if (cfg.monocle !== false) {
    ctx.save();
    if (expr === 'beaten') { ctx.translate(130, 118); ctx.rotate(0.5); ctx.translate(-130, -76); }
    ctx.beginPath();
    ctx.arc(130, 76, 25, 0, Math.PI * 2);
    ctx.lineWidth = 6; ctx.strokeStyle = '#f2b64a'; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath(); ctx.arc(130, 76, 18, Math.PI * 1.05, Math.PI * 1.5); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(152, 88);
    ctx.quadraticCurveTo(168, 108, 158, 140);
    ctx.lineWidth = 3.4; ctx.strokeStyle = '#d9a33f'; ctx.stroke();
    ctx.restore();
  }

  if (cfg.bowtie !== false) {
    ctx.beginPath();
    ctx.moveTo(100, 160); ctx.lineTo(76, 148); ctx.lineTo(76, 172); ctx.closePath();
    ctx.moveTo(100, 160); ctx.lineTo(124, 148); ctx.lineTo(124, 172); ctx.closePath();
    ctx.fillStyle = '#e8657a'; ctx.fill(); ink(ctx, 4.5);
    ctx.beginPath(); ctx.arc(100, 160, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#f2b64a'; ctx.fill(); ink(ctx, 3.5);
  }
  ctx.restore();
}

function paintCanvas(canvas, cssW, cssH, draw) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  draw(ctx);
  return ctx;
}

/** A little standalone canvas showing one piece (splash legend, trays, promo). */
function pieceCanvas(type, black, size) {
  const c = document.createElement('canvas');
  paintCanvas(c, size, size, (ctx) => {
    ctx.scale(size / 100, size / 100);
    drawPiece(ctx, type, black);
  });
  return c;
}
/**
 * ===========================================================================
 * PART 3 - the stylesheet
 * ===========================================================================
 */
const STYLE = `
.mg-chess-root{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#2d2417;user-select:none;
  -webkit-user-select:none;cursor:default;}
.mg-chess-root *{box-sizing:border-box;}
.mg-chess-bg{position:absolute;inset:0;z-index:0;
  background:
    radial-gradient(ellipse 60% 45% at 50% 8%, rgba(255,226,160,.5), rgba(255,226,160,0) 70%),
    radial-gradient(ellipse 90% 80% at 50% 55%, rgba(0,0,0,0) 45%, rgba(28,16,6,.55) 100%),
    repeating-linear-gradient(90deg, rgba(60,34,10,.13) 0 4px, rgba(0,0,0,0) 4px 92px),
    linear-gradient(180deg,#6b4426 0%,#54331d 55%,#3d2415 100%);}
.mg-chess-lamp{position:absolute;top:-70px;left:50%;width:220px;height:180px;margin-left:-110px;z-index:0;
  background:radial-gradient(ellipse 50% 60% at 50% 100%, rgba(255,214,130,.5), rgba(255,214,130,0) 72%);
  pointer-events:none;}

/* ---- hud ---- */
.mg-chess-hud{position:relative;z-index:6;display:flex;align-items:center;gap:9px;
  padding:10px clamp(10px,1.6vw,18px);flex-wrap:wrap;flex:none;}
.mg-chess-chip{background:#fffdf6;border-radius:999px;padding:6px 15px;font-weight:900;font-size:14px;
  box-shadow:0 4px 0 rgba(30,16,4,.35),0 8px 16px rgba(0,0,0,.28);display:flex;align-items:center;gap:8px;
  white-space:nowrap;}
.mg-chess-chip small{font-size:10.5px;letter-spacing:.12em;opacity:.5;font-weight:800;}
.mg-chess-chip b{color:#c9506a;}
.mg-chess-chip.mg-chess-theirs b{color:#7a5a3d;}
.mg-chess-chip.mg-chess-bump{animation:mg-chess-bump .32s ease;}
@keyframes mg-chess-bump{50%{transform:scale(1.14) rotate(-2deg)}}
.mg-chess-title{background:linear-gradient(90deg,#e8657a,#f2b64a);color:#fff;letter-spacing:.1em;
  text-shadow:0 2px 0 rgba(120,40,60,.35);}
.mg-chess-spacer{flex:1;}
.mg-chess-quit{border:0;background:rgba(28,16,6,.6);color:#fff6e3;font-family:inherit;font-weight:900;
  font-size:12.5px;letter-spacing:.1em;padding:9px 18px;border-radius:999px;cursor:pointer;transition:.14s;}
.mg-chess-quit:hover{background:#c94a3e;transform:scale(1.06);}

/* ---- layout ---- */
.mg-chess-main{position:relative;z-index:4;flex:1;min-height:0;display:flex;align-items:stretch;
  gap:clamp(8px,1.2vw,16px);padding:0 clamp(8px,1.6vw,18px) clamp(10px,1.6vh,16px);}
.mg-chess-side{width:clamp(148px,17vw,224px);flex:none;display:flex;flex-direction:column;
  gap:clamp(6px,1vh,10px);min-height:0;}
.mg-chess-card{background:linear-gradient(180deg,#fffdf6,#ffeed2);border-radius:20px;
  padding:10px 12px;box-shadow:0 8px 0 rgba(30,16,4,.3),0 14px 26px rgba(0,0,0,.3);
  display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;}
.mg-chess-card canvas{display:block;}
.mg-chess-pcard{padding-top:6px;}
.mg-chess-pname{font-weight:900;font-size:clamp(11px,1.1vw,14px);letter-spacing:.02em;text-align:center;
  line-height:1.15;}
.mg-chess-mood{font-size:11px;font-weight:800;color:#9a8461;letter-spacing:.06em;text-align:center;
  min-height:14px;text-transform:uppercase;}
.mg-chess-face{transition:transform .2s ease;}
.mg-chess-card.mg-chess-active{outline:4px solid #f2b64a;outline-offset:-2px;}
.mg-chess-card.mg-chess-active .mg-chess-face{animation:mg-chess-breathe 2.4s ease-in-out infinite;}
@keyframes mg-chess-breathe{50%{transform:translateY(-4px) scale(1.03)}}
.mg-chess-bubble{position:absolute;left:50%;top:-6px;transform:translate(-50%,-100%) scale(.5);
  background:#fffdf6;border-radius:16px;padding:8px 13px;font-size:12px;font-weight:800;line-height:1.35;
  width:max-content;max-width:min(230px,44vw);box-shadow:0 8px 18px rgba(0,0,0,.35);opacity:0;
  transition:opacity .2s ease,transform .28s cubic-bezier(.2,1.6,.4,1);pointer-events:none;z-index:9;
  text-align:center;}
.mg-chess-bubble.mg-chess-on{opacity:1;transform:translate(-50%,-100%) scale(1);}
.mg-chess-bubble::after{content:"";position:absolute;bottom:-11px;left:50%;margin-left:-9px;
  border:9px solid transparent;border-top-color:#fffdf6;border-bottom:0;}
.mg-chess-dots{display:inline-flex;gap:4px;vertical-align:middle;}
.mg-chess-dots i{width:6px;height:6px;border-radius:50%;background:#c9506a;display:block;
  animation:mg-chess-dot 1s ease-in-out infinite;}
.mg-chess-dots i:nth-child(2){animation-delay:.16s}
.mg-chess-dots i:nth-child(3){animation-delay:.32s}
@keyframes mg-chess-dot{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-5px);opacity:1}}

.mg-chess-tray{display:flex;flex-wrap:wrap;justify-content:center;gap:1px;min-height:20px;width:100%;
  padding-top:2px;border-top:2px dashed rgba(120,74,32,.22);}
.mg-chess-tray canvas{margin:-2px;animation:mg-chess-pop .3s cubic-bezier(.2,1.6,.4,1);}
@keyframes mg-chess-pop{from{transform:scale(0) rotate(-40deg);opacity:0}}
.mg-chess-lead{font-size:11px;font-weight:900;color:#3f8f2c;letter-spacing:.06em;min-height:13px;}
.mg-chess-lead.mg-chess-down{color:#c9506a;}

.mg-chess-boardwrap{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;position:relative;}
.mg-chess-board{position:relative;border-radius:16px;
  box-shadow:0 12px 0 rgba(30,16,4,.45),0 22px 44px rgba(0,0,0,.45);}
.mg-chess-board.mg-chess-quake{animation:mg-chess-quake .38s ease;}
@keyframes mg-chess-quake{0%,100%{transform:translate(0,0)}25%{transform:translate(-7px,4px)}
  55%{transform:translate(6px,-4px)}80%{transform:translate(-3px,2px)}}
/* no clocks in a match, so the board itself does the nudging: a slow warm halo
   that only breathes while the move is yours */
.mg-chess-board.mg-chess-nudge{animation:mg-chess-nudge 2.8s ease-in-out infinite;}
@keyframes mg-chess-nudge{
  0%,100%{box-shadow:0 12px 0 rgba(30,16,4,.45),0 22px 44px rgba(0,0,0,.45),0 0 0 0 rgba(242,182,74,0)}
  50%{box-shadow:0 12px 0 rgba(30,16,4,.45),0 22px 44px rgba(0,0,0,.45),0 0 0 7px rgba(242,182,74,.34)}}
.mg-chess-canvas{display:block;border-radius:16px;cursor:pointer;touch-action:none;}
.mg-chess-fx{position:absolute;inset:0;pointer-events:none;overflow:visible;}
.mg-chess-float{position:absolute;transform:translate(-50%,-50%);font-weight:900;white-space:nowrap;
  animation:mg-chess-float 1.1s ease-out forwards;text-shadow:0 3px 0 rgba(30,16,4,.4);color:#fff6e3;
  font-size:clamp(15px,2vw,24px);letter-spacing:.06em;}
@keyframes mg-chess-float{0%{opacity:0;transform:translate(-50%,-30%) scale(.5)}
  25%{opacity:1;transform:translate(-50%,-60%) scale(1.15)}
  55%{transform:translate(-50%,-72%) scale(1)}
  100%{opacity:0;transform:translate(-50%,-160%) scale(.95)}}
.mg-chess-float.mg-chess-warn{color:#ff9d8f;}
.mg-chess-float.mg-chess-good{color:#ffe08a;}

.mg-chess-moves{flex:1;min-height:0;align-items:stretch;padding:10px 6px 10px 10px;}
.mg-chess-moves h4{font-size:10.5px;letter-spacing:.16em;color:#9a8461;margin-bottom:6px;flex:none;}
.mg-chess-moves ol{list-style:none;overflow-y:auto;flex:1;min-height:0;font-size:12.5px;font-weight:800;
  padding-right:6px;scrollbar-width:thin;}
.mg-chess-moves li{display:flex;gap:6px;padding:2px 4px;border-radius:6px;}
.mg-chess-moves li:nth-child(odd){background:rgba(120,74,32,.07);}
.mg-chess-moves li i{font-style:normal;color:#9a8461;width:22px;flex:none;font-size:11px;padding-top:1px;}
.mg-chess-moves li span{flex:1;}
.mg-chess-moves li.mg-chess-latest span:last-child:not(:empty),
.mg-chess-moves li.mg-chess-latest.mg-chess-half span:nth-child(2){color:#c9506a;}
.mg-chess-resign{flex:none;border:3px solid #fff;border-radius:999px;background:#8a6642;color:#fff6e3;
  font-family:inherit;font-weight:900;font-size:12.5px;letter-spacing:.1em;padding:10px 8px;cursor:pointer;
  box-shadow:0 5px 0 rgba(30,16,4,.4);transition:.12s;}
.mg-chess-resign:hover{background:#c94a3e;transform:translateY(-2px);}
.mg-chess-resign:active{transform:translateY(3px);box-shadow:0 2px 0 rgba(30,16,4,.4);}
.mg-chess-offer{background:#4f8fb0;}
.mg-chess-offer:hover{background:#4fb3e8;}
.mg-chess-offer:disabled{background:#9c8f7c;opacity:.55;cursor:default;transform:none;}
.mg-chess-offer[hidden]{display:none;}

/* ---- overlays ---- */
.mg-chess-over{position:absolute;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;
  background:rgba(30,17,6,.74);backdrop-filter:blur(3px);padding:18px;text-align:center;overflow-y:auto;}
.mg-chess-over.mg-chess-gone{display:none;}
.mg-chess-modal{background:linear-gradient(180deg,#fffdf6,#ffeed2);border-radius:26px;padding:22px 26px;
  width:min(620px,94vw);box-shadow:0 18px 50px rgba(0,0,0,.5);
  animation:mg-chess-card .34s cubic-bezier(.2,1.5,.4,1);margin:auto;}
@keyframes mg-chess-card{from{transform:scale(.84) translateY(20px);opacity:0}}
.mg-chess-modal h1{font-size:clamp(26px,4.2vw,42px);color:#e8657a;line-height:1.05;}
.mg-chess-modal h2{font-size:clamp(21px,3.2vw,32px);color:#e8657a;line-height:1.1;}
.mg-chess-sub{font-weight:800;color:#9a8461;font-size:13px;margin:6px 0 14px;letter-spacing:.04em;}
.mg-chess-hero{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:6px;}
.mg-chess-hero div{text-align:left;}
.mg-chess-hero b{display:block;font-size:15px;}
.mg-chess-hero span{font-size:12px;font-weight:700;color:#9a8461;}
.mg-chess-legend{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;text-align:left;}
.mg-chess-legend div{display:flex;align-items:center;gap:8px;background:#fff6e3;border-radius:12px;
  padding:5px 9px;font-size:11.5px;font-weight:700;line-height:1.25;}
.mg-chess-legend b{display:block;font-size:12px;}
.mg-chess-legend span{color:#8a7757;}
.mg-chess-rules{display:flex;flex-direction:column;gap:6px;text-align:left;margin-bottom:14px;}
.mg-chess-rules div{display:flex;align-items:center;gap:10px;background:#fff6e3;border-radius:12px;
  padding:7px 12px;font-size:12.5px;font-weight:700;line-height:1.3;}
.mg-chess-rules i{flex:none;width:26px;height:26px;border-radius:50%;background:#e8657a;color:#fff;
  font-style:normal;font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;}
.mg-chess-stats{display:flex;justify-content:center;gap:9px;margin:12px 0 16px;flex-wrap:wrap;}
.mg-chess-stat{background:#fff6e3;border-radius:16px;padding:10px 18px;min-width:96px;}
.mg-chess-stat b{display:block;font-size:clamp(20px,2.8vw,30px);line-height:1.15;}
.mg-chess-stat span{font-size:10px;font-weight:900;letter-spacing:.13em;color:#9a8461;}
.mg-chess-stat.mg-chess-gold b{color:#e0982a;}
.mg-chess-ribbon{display:inline-block;background:#f2b64a;color:#fff;font-weight:900;letter-spacing:.14em;
  font-size:11.5px;padding:6px 18px;border-radius:999px;margin-bottom:8px;
  animation:mg-chess-glow 1s ease-in-out infinite;}
@keyframes mg-chess-glow{50%{transform:scale(1.07)}}
.mg-chess-btns{display:flex;gap:11px;justify-content:center;flex-wrap:wrap;}
.mg-chess-btn{border:4px solid #fff;border-radius:999px;background:#e8657a;color:#fff;font-family:inherit;
  font-weight:900;font-size:clamp(13px,1.6vw,17px);padding:11px 26px;cursor:pointer;
  box-shadow:0 6px 0 rgba(60,34,10,.3);transition:.12s;}
.mg-chess-btn:hover{transform:translateY(-2px);filter:brightness(1.05);}
.mg-chess-btn:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(60,34,10,.3);}
.mg-chess-btn.mg-chess-alt{background:#4fb3e8;}
.mg-chess-btn.mg-chess-ghost{background:transparent;border-color:rgba(58,42,28,.28);color:#7a6748;
  box-shadow:none;}
.mg-chess-promo{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:6px 0 4px;}
.mg-chess-promo button{border:0;background:#fff6e3;border-radius:18px;padding:8px 10px 6px;cursor:pointer;
  font-family:inherit;font-weight:900;font-size:11px;letter-spacing:.04em;color:#7a6748;
  box-shadow:0 6px 0 rgba(120,74,32,.28);transition:.12s;display:flex;flex-direction:column;align-items:center;}
.mg-chess-promo button:hover{transform:translateY(-3px);background:#ffe9c4;}
.mg-chess-promo button:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(120,74,32,.28);}
.mg-chess-count{font-size:clamp(72px,15vw,168px);font-weight:900;color:#fff6e3;
  text-shadow:0 8px 0 rgba(30,16,4,.4);animation:mg-chess-count .62s ease-out;}
@keyframes mg-chess-count{from{transform:scale(2.2);opacity:0}40%{opacity:1}to{transform:scale(1)}}

@media (max-width:900px){
  .mg-chess-side{width:clamp(120px,15vw,168px);}
  .mg-chess-legend{grid-template-columns:1fr;}
}
@media (max-width:720px){
  .mg-chess-right{display:none;}
}
@media (max-height:620px){
  .mg-chess-moves{display:none;}
  .mg-chess-rules div{padding:5px 10px;font-size:11.5px;}
}
/* Short windows: the splash card runs ~840px at full size (about 710px once the
   legend goes two-up above 900px wide), so on a 1366x768 laptop "TAKE A SEAT"
   lands below the fold of an overlay that shows no scrollbar affordance. Three
   steps of compaction, loosest first: 800 only tightens spacing, 700 drops the
   piece-move captions, 560 is the tiny-window fallback. Tall windows are
   untouched. */
@media (max-height:800px){
  .mg-chess-over{padding:12px;}
  .mg-chess-modal{padding:16px 20px;}
  .mg-chess-modal h1{font-size:clamp(22px,3.4vw,32px);}
  .mg-chess-hero canvas{width:64px;height:64px;}
  .mg-chess-sub{margin:4px 0 9px;font-size:12px;}
  .mg-chess-legend{gap:5px;margin-bottom:9px;}
  .mg-chess-legend div{padding:4px 8px;gap:7px;}
  .mg-chess-legend canvas{width:28px;height:28px;}
  .mg-chess-rules{gap:5px;margin-bottom:9px;}
  .mg-chess-rules div{padding:5px 9px;font-size:11.5px;}
  .mg-chess-rules i{width:22px;height:22px;font-size:12px;}
  .mg-chess-stats{margin:8px 0 10px;}
  .mg-chess-stat{padding:6px 14px;min-width:84px;}
  .mg-chess-stat b{font-size:clamp(17px,2.2vw,22px);}
  .mg-chess-btn{padding:9px 22px;}
}
@media (max-height:700px){
  .mg-chess-legend{grid-template-columns:repeat(3,1fr);}
  .mg-chess-legend div{padding:4px 7px;gap:6px;}
  .mg-chess-legend span{display:none;}
  .mg-chess-legend canvas{width:26px;height:26px;}
}
@media (max-height:560px){
  .mg-chess-over{padding:5px;}
  .mg-chess-modal{padding:11px 16px;}
  .mg-chess-modal h1{font-size:20px;}
  .mg-chess-hero{gap:10px;margin-bottom:4px;}
  .mg-chess-hero canvas{width:46px;height:46px;}
  .mg-chess-hero b{font-size:13px;}
  .mg-chess-hero span{font-size:11px;}
  .mg-chess-sub{display:none;}
  .mg-chess-legend{gap:4px;margin-bottom:7px;}
  .mg-chess-legend div{padding:3px 5px;font-size:10.5px;}
  .mg-chess-legend b{font-size:10.5px;}
  .mg-chess-legend canvas{width:20px;height:20px;}
  .mg-chess-rules{gap:4px;margin-bottom:7px;}
  .mg-chess-rules div{padding:4px 8px;font-size:10.5px;gap:7px;}
  .mg-chess-rules i{width:18px;height:18px;font-size:10.5px;}
  .mg-chess-rules div:nth-child(4){display:none;}
  .mg-chess-stats{margin:6px 0 8px;gap:7px;}
  .mg-chess-stat{padding:4px 12px;min-width:74px;}
  .mg-chess-stat b{font-size:16px;}
  .mg-chess-stat span{font-size:9px;}
  .mg-chess-btn{padding:7px 18px;font-size:12.5px;border-width:3px;}
}
`;
/**
 * ===========================================================================
 * PART 4 - the minigame
 * ===========================================================================
 */

const WIN_BONUS = 500;
const COINS = { win: 85, draw: 25, loss: 5 };
/** What the server pays the agreed winner of a table match, for the copy only. */
const MATCH_BONUS = 30;

const WIN_KINDS = new Set(['mate-win', 'resign-win', 'forfeit-win', 'match-win']);
const LOSS_KINDS = new Set(['mate-loss', 'resign-loss', 'forfeit-loss', 'match-loss']);

/** Anything from the wire that lands in innerHTML goes through here first. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Shared seed -> shared flavour: both seats read the same greeting. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MATCH_GREETS = [
  'sat down opposite you and set out the pieces.',
  'cracks their knuckles. all four of them.',
  'has brought a mug of something warm to the table.',
  'is here for a nice long think.',
  'shakes your paw across the board.',
];

const LINES = {
  greet: [
    'i have been studying openings all winter.',
    'do sit down. mind the trophy shelf.',
    'a friendly game. mostly friendly.',
  ],
  theirCheck: [
    'check. *adjusts monocle*',
    'check, and a good afternoon to you.',
    'check! oh, was that rude?',
  ],
  myCheck: ['unhand my monocle.', 'ah. yes. i saw that.', 'hmph. a lucky pebble.'],
  theyTake: ['thank you kindly.', 'i shall keep this one.', 'into the pile it goes.'],
  iTake: ['...that was my favourite.', 'oh, botheration.', 'well. rude.'],
  smug: ['the monocle sees all.', 'i have five moves planned. six now.', 'this is going nicely.'],
  worried: ['hmm. hmmmm.', 'that is inconvenient.', 'i did not budget for that.'],
  castle: ['tucked in nice and safe.', 'the tower and i have an arrangement.'],
  promo: ['a pup made it to the far shore. splendid.', 'promotion! how they grow.'],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class ChessGame extends Minigame {
  static id = 'chess';
  static name = 'Grand Capy Chess';

  constructor(game) {
    super(game);
    this._timers = new Set();
    this._raf = 0;
    this._dead = false;
    this._onKey = null;
    this._onResize = null;
    this._ro = null;
    this.subs = [];        // game.events unsubscribers (match wiring)
    this.match = null;     // set when game.__matchCtx handed us an opponent
    this.matchRef = null;  // the exact handshake object we consumed
    this.myColor = 0;      // 0 = cream (white), 1 = cocoa (black)
    this.flip = false;     // draw the board from the cocoa side
    this.phase = 'splash';
    this.el = {};
    this.st = fromFen(START_FEN);
    this.legal = [];
    this.sprites = null;
    this.spriteCell = 0;
    this.size = 0;
    this.cell = 0;
    this.sel = -1;
    this.cursor = -1;
    this.drag = null;
    this.anim = null;
    this.parts = [];
    this.lastMove = null;
    this.expr = 'idle';
    this.blinkIn = 3;
    this._outcome = null;
    this._lastTurnMine = null;
  }

  // ---- lifecycle -----------------------------------------------------------
  mount(root) {
    super.mount(root);
    this.match = this._readMatchCtx();
    this.myColor = this.match ? this.match.youAre : 0;
    this.flip = this.myColor === 1;

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-chess-root';
    wrap.innerHTML = this._html();
    root.appendChild(wrap);

    const q = (sel) => wrap.querySelector(sel);
    this.el = {
      wrap,
      turn: q('[data-el="turn"]'),
      turnChip: q('[data-el="turnChip"]'),
      movenum: q('[data-el="movenum"]'),
      lead: q('[data-el="lead"]'),
      leadChip: q('[data-el="leadChip"]'),
      boardWrap: q('[data-el="boardWrap"]'),
      board: q('[data-el="board"]'),
      canvas: q('[data-el="canvas"]'),
      fx: q('[data-el="fx"]'),
      portrait: q('[data-el="portrait"]'),
      you: q('[data-el="you"]'),
      pcard: q('[data-el="pcard"]'),
      ycard: q('[data-el="ycard"]'),
      mood: q('[data-el="mood"]'),
      bubble: q('[data-el="bubble"]'),
      yourname: q('[data-el="yourname"]'),
      pname: q('[data-el="pname"]'),
      trayPebble: q('[data-el="trayPebble"]'),
      trayYou: q('[data-el="trayYou"]'),
      leadPebble: q('[data-el="leadPebble"]'),
      leadYou: q('[data-el="leadYou"]'),
      moves: q('[data-el="moves"]'),
      resign: q('[data-el="resign"]'),
      offer: q('[data-el="offer"]'),
      over: q('[data-el="over"]'),
    };

    this._applyIdentity();
    this.el.resign.addEventListener('click', () => this._confirmResign());
    this.el.offer.addEventListener('click', () => this._offerDraw());
    q('[data-el="quit"]').addEventListener('click', () => this._confirmQuit());

    const cv = this.el.canvas;
    cv.addEventListener('pointerdown', (e) => this._onDown(e));
    cv.addEventListener('pointermove', (e) => this._onMoveEvt(e));
    cv.addEventListener('pointerup', (e) => this._onUp(e));
    cv.addEventListener('pointercancel', () => { this.drag = null; });

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey);
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this.el.boardWrap);
    }

    this._bindMatch();
    this._newGame();
    this._resize();
    this._paintPortraits();
    this._showSplash();
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  dispose() {
    this._dead = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this._ro?.disconnect?.();
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    this._onKey = null;
    this._onResize = null;
    this._ro = null;
    this.match = null;
    this._clearCtx(); // never leak a finished match into the next mount
    this.sprites = null;
    this.parts.length = 0;
    this.el = {};
  }

  /** Chess pays for the result, not for grinding: win 85, draw 25, loss 5. */
  coinsForScore(score) {
    const outcome = this._outcome || (score >= WIN_BONUS ? 'win' : 'loss');
    return clampCoinsForGame('chess', COINS[outcome] ?? COINS.loss);
  }

  _after(ms, fn) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._dead) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  // ---- table match ---------------------------------------------------------
  /**
   * Read the handshake the lounge parked on the game object. Anything malformed
   * (wrong game, no seat, no opponent, no socket) degrades to a solo game
   * against Pebble rather than half-starting a match nobody can finish.
   */
  _readMatchCtx() {
    const ctx = this.game.__matchCtx;
    this.matchRef = ctx && typeof ctx === 'object' ? ctx : null;
    if (!this.matchRef) return null;
    if (ctx.game && ctx.game !== 'chess') return null;
    if (ctx.youAre !== 0 && ctx.youAre !== 1) return null;
    if (typeof this.game.net?.send !== 'function') return null;
    const players = Array.isArray(ctx.players)
      ? ctx.players.filter((p) => p && typeof p === 'object') : [];
    if (players.length < 2) return null;

    const youAre = ctx.youAre;
    const me = players[youAre] || {};
    const foe = players[youAre ^ 1] || {};
    const seed = (Number(ctx.seed) >>> 0) || 1;
    const rng = mulberry32(seed);
    const name = String(foe.name || 'Capy').slice(0, 16);
    return {
      youAre,
      seed,
      myId: me.id ?? this.game.net?.selfId ?? null,
      foeId: foe.id ?? null,
      foeName: name,
      foeShort: name.slice(0, 12),
      foeColor: Number.isFinite(foe.color) ? foe.color : 0xb08a5a,
      greeting: MATCH_GREETS[Math.floor(rng() * MATCH_GREETS.length)],
      queue: [],      // remote packets waiting for a quiet moment
      ended: false,   // the server has called it
      frozen: false,  // the two boards disagreed: no more play
      doneSent: false,
      offered: false, // our draw offer is on the table
    };
  }

  /** Drop the handshake we consumed, without stomping a newer one. */
  _clearCtx() {
    if (this.matchRef && this.game.__matchCtx === this.matchRef) this.game.__matchCtx = null;
    this.matchRef = null;
  }

  _bindMatch() {
    if (!this.match) return;
    const ev = this.game.events;
    if (!ev?.on) return;
    this.subs.push(ev.on('match-move', (m) => this._onMatchMove(m)));
    this.subs.push(ev.on('match-end', (m) => this._onMatchEnd(m)));
  }

  /** Leave match mode but stay in the minigame (results screen "Play Pebble"). */
  _leaveMatch() {
    if (!this.match) return;
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    this.match = null;
    this._clearCtx();
    this.myColor = 0;
    this.flip = false;
    this.el.board?.classList.remove('mg-chess-nudge');
    this._applyIdentity();
  }

  _sendData(data) {
    const M = this.match;
    if (!M || M.ended) return;
    this.game.net?.send?.({ t: 'match-move', data });
  }

  /** One match-done per player per match: winner is an id, or 'draw'. */
  _sendDone(winner, score) {
    const M = this.match;
    if (!M || M.ended || M.doneSent) return;
    if (winner !== 'draw' && (winner === null || winner === undefined)) return;
    M.doneSent = true;
    this.game.net?.send?.({
      t: 'match-done',
      result: { winner, score: Math.max(0, Math.round(score) || 0) },
    });
  }

  _reportMatch(kind, score) {
    const M = this.match;
    if (!M) return;
    if (WIN_KINDS.has(kind)) this._sendDone(M.myId, score);
    else if (LOSS_KINDS.has(kind)) this._sendDone(M.foeId, score);
    else this._sendDone('draw', score);
  }

  /** {t:'match-move', from, data}: queue it, the pump plays it when we are idle. */
  _onMatchMove(m) {
    const M = this.match;
    if (!M || this._dead || M.ended || M.frozen) return;
    if (this.phase === 'over') return; // the game is decided; nothing left to play
    const data = m?.data;
    if (!data || typeof data !== 'object') return;
    // relays only ever come from the other seat, but never trust that blindly
    if (m.from != null && M.foeId != null && String(m.from) !== String(M.foeId)) return;
    if (M.queue.length > 8) { this._desync('too many moves arrived at once'); return; }
    M.queue.push(data);
    this._pumpRemote();
  }

  /** {t:'match-end', reason, winner}: the server has the final word. */
  _onMatchEnd(m) {
    const M = this.match;
    if (!M || this._dead) return;
    M.ended = true;
    M.queue.length = 0;
    if (this.el.board) this.el.board.classList.remove('mg-chess-nudge');
    if (this.phase === 'over' || M.frozen) return; // we already showed the result

    const winner = m?.winner;
    const forfeit = m?.reason === 'forfeit';
    const mine = winner != null && M.myId != null && String(winner) === String(M.myId);
    const theirs = winner != null && M.foeId != null && String(winner) === String(M.foeId);
    if (mine) this._endGame(forfeit ? 'forfeit-win' : 'match-win');
    else if (theirs) this._endGame(forfeit ? 'forfeit-loss' : 'match-loss');
    else this._endGame('draw-agreed');
  }

  /** Play one queued remote packet, but only while the board is sitting still. */
  _pumpRemote() {
    const M = this.match;
    if (!M || this._dead || M.ended || M.frozen || !M.queue.length) return;
    if (this.phase !== 'play' || this.busy || this.anim) return;
    while (M.queue.length) {
      const d = M.queue.shift();
      if (d.move && typeof d.move === 'object') { this._applyRemoteMove(d.move); return; }
      if (d.resign) { this._oppResigned(); return; }
      if (d.draw === 'offer') { this._drawOffered(); return; }
      if (d.draw === 'accept') { this._drawAccepted(); return; }
      if (d.draw === 'decline') { this._drawDeclined(); continue; }
    }
  }

  /**
   * Replay the opponent's move through our own generator. Anything that is not
   * exactly one legal move for the side to move stops the match: two boards
   * that disagree are worse than no board at all.
   */
  _applyRemoteMove(mv) {
    const from = Number(mv.from), to = Number(mv.to);
    const promo = mv.promo == null ? 0 : Number(mv.promo);
    const okPromo = promo === 0 || (Number.isInteger(promo) && promo >= KNIGHT && promo <= QUEEN);
    const bad = !Number.isInteger(from) || from < 0 || from > 63
      || !Number.isInteger(to) || to < 0 || to > 63 || !okPromo;
    if (bad) { this._desync('a move arrived that is not on this board'); return; }
    if (this.st.turn === this.myColor) { this._desync('a move arrived out of turn'); return; }

    const opts = this.legal.filter((m) => mFrom(m) === from && mTo(m) === to);
    if (!opts.length) { this._desync(`${sqName(from)}-${sqName(to)} is not legal here`); return; }
    const wantsPromo = mPromo(opts[0]) !== 0;
    const m = wantsPromo ? opts.find((x) => mPromo(x) === promo) : (promo === 0 ? opts[0] : undefined);
    if (m === undefined) { this._desync('that promotion did not add up'); return; }
    this._applyMove(m, true);
  }

  /** The two boards drifted: freeze, apologise, and let them bow out cleanly. */
  _desync(why) {
    const M = this.match;
    if (!M || M.frozen || M.ended) return;
    M.frozen = true;
    M.queue.length = 0;
    this.busy = true;
    this.sel = -1;
    this.drag = null;
    this.el.board?.classList.remove('mg-chess-nudge');
    this.phase = 'confirm';
    this.game.audio?.play?.('fail');
    this.game.toast?.(`Chess match out of step: ${why}.`);
    const card = this._showOver(`
      <h2>The boards drifted apart</h2>
      <div class="mg-chess-sub">${esc(String(why).toUpperCase())}. RATHER THAN PLAY TWO
        DIFFERENT GAMES, THE MATCH STOPS HERE.</div>
      <div class="mg-chess-btns">
        <button class="mg-chess-btn" data-a="leave">Back to the den</button>
      </div>`);
    card.querySelector('[data-a="leave"]').addEventListener('click', () => this._forfeitAndQuit());
  }

  // ---- draw offers, resignation, forfeit -----------------------------------
  _offerDraw() {
    const M = this.match;
    if (!M || M.ended || M.frozen || M.offered || this.phase !== 'play') return;
    M.offered = true;
    if (this.el.offer) this.el.offer.disabled = true;
    this.game.audio?.play?.('click');
    this._sendData({ draw: 'offer' });
    this.game.toast?.('Draw offered. Waiting for an answer.');
  }

  _drawOffered() {
    const M = this.match;
    if (!M || M.ended || M.frozen) return;
    this.game.audio?.play?.('open');
    this._setExpr('idle', 'offers a draw');
    this._say('shall we call it even?');
    this.phase = 'confirm';
    const card = this._showOver(`
      <h2>Draw offer</h2>
      <div class="mg-chess-sub">${esc(M.foeName.toUpperCase())} OFFERS TO SHAKE PAWS
        AND CALL IT EVEN.</div>
      <div class="mg-chess-btns">
        <button class="mg-chess-btn" data-a="no">Play on</button>
        <button class="mg-chess-btn mg-chess-alt" data-a="yes">Accept the draw (${COINS.draw} coins)</button>
      </div>`);
    card.querySelector('[data-a="no"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this._hideOver();
      this.phase = 'play';
      this._sendData({ draw: 'decline' });
      this._setExpr(this.st.turn === this.myColor ? 'idle' : 'think', 'play on then');
      this._syncTurn();
      this._pumpRemote();
    });
    card.querySelector('[data-a="yes"]').addEventListener('click', () => {
      this.game.audio?.play?.('ding');
      this._hideOver();
      this.phase = 'play';
      this._sendData({ draw: 'accept' });
      this._endGame('draw-agreed');
    });
  }

  _drawAccepted() {
    const M = this.match;
    if (!M || !M.offered || M.ended || M.frozen) return;
    this._say('a draw it is.');
    this._endGame('draw-agreed');
  }

  _drawDeclined() {
    const M = this.match;
    if (!M) return;
    M.offered = false;
    this._say('not today, thank you.');
    this.game.audio?.play?.('close');
    this._after(8000, () => {
      if (this._dead || !this.match || this.match.ended) return;
      if (this.el.offer && !this.match.offered) this.el.offer.disabled = false;
    });
  }

  _oppResigned() {
    const M = this.match;
    if (!M || M.ended || M.frozen) return;
    this._setExpr('beaten', 'resigned');
    this._endGame('resign-win');
  }

  /** Walking away from a live match hands the win (and the bonus) over. */
  _forfeitAndQuit() {
    const M = this.match;
    if (M && !M.ended && !M.doneSent) {
      this._sendData({ resign: true });
      this._sendDone(M.foeId, 0);
    }
    this.quit();
  }

  /** Whose faces and names sit on the two cards: Pebble, or a real capybara. */
  _applyIdentity() {
    const M = this.match;
    const myName = this.game.state?.name || 'You';
    if (this.el.yourname) {
      this.el.yourname.textContent = `${myName} (${this.myColor === 0 ? 'cream' : 'cocoa'})`;
    }
    if (this.el.pname) {
      const plays = M ? (this.myColor === 0 ? 'plays cocoa' : 'plays cream') : 'plays cocoa';
      this.el.pname.textContent = '';
      this.el.pname.appendChild(document.createTextNode(M ? M.foeName : 'Grandmaster Pebble'));
      this.el.pname.appendChild(document.createElement('br'));
      const small = document.createElement('span');
      small.style.cssText = 'font-weight:700;font-size:10.5px;color:#9a8461';
      small.textContent = plays;
      this.el.pname.appendChild(small);
    }
    if (this.el.offer) {
      this.el.offer.hidden = !M;
      this.el.offer.disabled = !M || !!M.offered;
    }
    this._paintPortraits();
  }

  /** Material balance from OUR side of the board, in pawns-and-pieces points. */
  _myLead() {
    return materialLead(this.st) * (this.myColor === 0 ? 1 : -1);
  }

  _scoreFor(kind) {
    return Math.max(0, this._myLead()) * 10 + (WIN_KINDS.has(kind) ? WIN_BONUS : 0);
  }

  // ---- markup --------------------------------------------------------------
  _html() {
    return `
      <div class="mg-chess-bg"></div>
      <div class="mg-chess-lamp"></div>

      <div class="mg-chess-hud">
        <div class="mg-chess-chip mg-chess-title">GRAND CAPY CHESS</div>
        <div class="mg-chess-chip" data-el="turnChip"><small>TURN</small><b data-el="turn">You</b></div>
        <div class="mg-chess-chip"><small>MOVE</small><b data-el="movenum">1</b></div>
        <div class="mg-chess-chip" data-el="leadChip"><small>MATERIAL</small><b data-el="lead">even</b></div>
        <div class="mg-chess-spacer"></div>
        <button class="mg-chess-quit" data-el="quit">QUIT</button>
      </div>

      <div class="mg-chess-main">
        <div class="mg-chess-side mg-chess-left">
          <div class="mg-chess-card mg-chess-pcard" data-el="pcard">
            <div class="mg-chess-bubble" data-el="bubble"></div>
            <canvas class="mg-chess-face" data-el="portrait"></canvas>
            <div class="mg-chess-pname" data-el="pname">Grandmaster Pebble<br><span style="font-weight:700;font-size:10.5px;color:#9a8461">plays cocoa</span></div>
            <div class="mg-chess-mood" data-el="mood">polishing monocle</div>
            <div class="mg-chess-tray" data-el="trayPebble"></div>
            <div class="mg-chess-lead" data-el="leadPebble"></div>
          </div>
          <div class="mg-chess-card mg-chess-ycard" data-el="ycard">
            <canvas class="mg-chess-face" data-el="you"></canvas>
            <div class="mg-chess-pname" data-el="yourname">You (cream)</div>
            <div class="mg-chess-tray" data-el="trayYou"></div>
            <div class="mg-chess-lead" data-el="leadYou"></div>
          </div>
        </div>

        <div class="mg-chess-boardwrap" data-el="boardWrap">
          <div class="mg-chess-board" data-el="board">
            <canvas class="mg-chess-canvas" data-el="canvas"></canvas>
            <div class="mg-chess-fx" data-el="fx"></div>
          </div>
        </div>

        <div class="mg-chess-side mg-chess-right">
          <div class="mg-chess-card mg-chess-moves">
            <h4>MOVE LIST</h4>
            <ol data-el="moves"></ol>
          </div>
          <button class="mg-chess-resign mg-chess-offer" data-el="offer" hidden>OFFER DRAW</button>
          <button class="mg-chess-resign" data-el="resign">RESIGN</button>
        </div>
      </div>

      <div class="mg-chess-over" data-el="over"></div>`;
  }

  // ---- sizing and painting -------------------------------------------------
  _resize() {
    if (this._dead || !this.el.boardWrap) return;
    const w = this.el.boardWrap.clientWidth;
    const h = this.el.boardWrap.clientHeight;
    const size = Math.max(200, Math.floor(Math.min(w, h)) - 4);
    if (size === this.size) return;
    this.size = size;
    this.cell = size / 8;
    this.el.board.style.width = `${size}px`;
    this.el.board.style.height = `${size}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.canvas.width = Math.round(size * dpr);
    this.el.canvas.height = Math.round(size * dpr);
    this.el.canvas.style.width = `${size}px`;
    this.el.canvas.style.height = `${size}px`;
    this.ctx = this.el.canvas.getContext('2d');
    this.dpr = dpr;
    this._buildSprites();
  }

  /** Pre-render every piece once per board size: the loop only blits. */
  _buildSprites() {
    const cell = Math.round(this.cell);
    if (this.sprites && this.spriteCell === cell) return;
    const dpr = this.dpr || 1;
    const px = Math.max(8, Math.round(cell * dpr));
    const out = {};
    for (let t = PAWN; t <= KING; t++) {
      for (const black of [false, true]) {
        const c = document.createElement('canvas');
        c.width = px; c.height = px;
        const cx = c.getContext('2d');
        cx.scale(px / 100, px / 100);
        drawPiece(cx, t, black);
        out[(black ? 'b' : 'w') + t] = c;
      }
    }
    this.sprites = out;
    this.spriteCell = cell;
  }

  _paintPortraits() {
    if (!this.el.portrait || !this.el.you) return;
    const size = 108;
    // in a match the top card is a real capybara: their colour, no monocle
    const foe = this.match
      ? { color: hexOf(this.match.foeColor), monocle: false, bowtie: false } : {};
    paintCanvas(this.el.portrait, size, size, (ctx) => drawPebble(ctx, size, this.expr, foe));
    const mine = hexOf(this.game.state?.color ?? 0xb08a5a);
    paintCanvas(this.el.you, 72, 72, (ctx) => drawPebble(ctx, 72, this._myExpr || 'idle', {
      color: mine, monocle: false, bowtie: false,
    }));
  }

  _setExpr(expr, mood, line) {
    if (expr && expr !== this.expr) { this.expr = expr; this._paintPortraits(); }
    if (mood !== undefined) this.el.mood.textContent = mood;
    if (line) this._say(line);
  }

  _say(text, ms = 3000) {
    const b = this.el.bubble;
    if (!b) return;
    b.innerHTML = text;
    b.classList.add('mg-chess-on');
    if (this._sayTimer) clearTimeout(this._sayTimer);
    this._sayTimer = this._after(ms, () => b.classList.remove('mg-chess-on'));
  }

  // ---- screens -------------------------------------------------------------
  _showOver(html) {
    const over = this.el.over;
    over.classList.remove('mg-chess-gone');
    over.innerHTML = `<div class="mg-chess-modal">${html}</div>`;
    return over.firstElementChild;
  }

  _hideOver() {
    this.el.over.classList.add('mg-chess-gone');
    this.el.over.innerHTML = '';
  }

  _showSplash() {
    this.phase = 'splash';
    const M = this.match;
    const best = this.game.state?.bests?.chess || 0;
    const legend = [PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING].map((t) => `
      <div data-piece="${t}"><b>${PIECE_LORE[t].name}</b><span>${PIECE_LORE[t].how}</span></div>`).join('');
    const white = this.myColor === 0;
    const mySide = white ? 'CREAM' : 'COCOA';
    const first = M ? (white ? 'YOU MOVE FIRST' : `${esc(M.foeShort.toUpperCase())} MOVES FIRST`)
      : 'CREAM MOVES FIRST';

    const head = M ? `
      <h1>Table Match</h1>
      <div class="mg-chess-hero">
        <canvas data-el="heroFace"></canvas>
        <div>
          <b>${esc(M.foeName)}</b>
          <span>${esc(M.greeting)}</span>
        </div>
      </div>` : `
      <h1>Grand Capy Chess</h1>
      <div class="mg-chess-hero">
        <canvas data-el="heroFace"></canvas>
        <div>
          <b>Grandmaster Pebble</b>
          <span>undefeated back-table champion of the Game Den. probably.</span>
        </div>
      </div>`;

    const rules = M ? `
      <div><i>1</i><span>Click a piece then click where it goes, or just drag it. Dots show every legal square.</span></div>
      <div><i>2</i><span>Real chess, all of it: castling, en passant, promotion, stalemate, the lot. No takebacks.</span></div>
      <div><i>3</i><span>No clocks. Think as long as you like: the board glows gold when the move is yours.</span></div>
      <div><i>4</i><span>Win for <b>${COINS.win} coins</b> plus a <b>${MATCH_BONUS} coin</b> match bonus. Draw ${COINS.draw}, loss ${COINS.loss}. Leaving the table hands them the win.</span></div>`
      : `
      <div><i>1</i><span>Click a piece then click where it goes, or just drag it. Dots show every legal square.</span></div>
      <div><i>2</i><span>Real chess, all of it: castling, en passant, promotion, stalemate, the lot. No takebacks.</span></div>
      <div><i>3</i><span>Beat Pebble for <b>${COINS.win} coins</b>. A draw is worth ${COINS.draw}, a loss ${COINS.loss}. Resigning counts as a loss.</span></div>
      <div><i>4</i><span>He warms up for the first few moves. After that he stops being polite.</span></div>`;

    const card = this._showOver(`
      ${head}
      <div class="mg-chess-sub">YOU PLAY THE ${mySide} CAPYS. ${first}.</div>
      <div class="mg-chess-legend">${legend}</div>
      <div class="mg-chess-rules">${rules}</div>
      <div class="mg-chess-stats">
        <div class="mg-chess-stat"><b>${best}</b><span>YOUR BEST</span></div>
        <div class="mg-chess-stat mg-chess-gold"><b>${M ? `${COINS.win}+${MATCH_BONUS}` : COINS.win}</b><span>COINS TO WIN</span></div>
      </div>
      <div class="mg-chess-btns">
        <button class="mg-chess-btn" data-a="play">${M ? 'START THE MATCH' : 'TAKE A SEAT'}</button>
        ${M ? '' : '<button class="mg-chess-btn mg-chess-ghost" data-a="leave">Back to the den</button>'}
      </div>`);

    const hero = card.querySelector('[data-el="heroFace"]');
    const heroCfg = M ? { color: hexOf(M.foeColor), monocle: false, bowtie: false } : {};
    paintCanvas(hero, 88, 88, (ctx) => drawPebble(ctx, 88, M ? 'idle' : 'smug', heroCfg));
    for (const div of card.querySelectorAll('[data-piece]')) {
      div.insertBefore(pieceCanvas(Number(div.dataset.piece), this.myColor === 1, 32), div.firstChild);
    }
    card.querySelector('[data-a="play"]').addEventListener('click', () => this._countdown());
    card.querySelector('[data-a="leave"]')?.addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });
  }

  _countdown() {
    if (this.phase !== 'splash' && this.phase !== 'over') return;
    this.game.audio?.play?.('click');
    this._newGame();
    this.phase = 'countdown';
    const steps = ['3', '2', '1', 'PLAY!'];
    const show = (i) => {
      if (i >= steps.length) {
        this._hideOver();
        this.phase = 'play';
        this.busy = false;
        if (this.match) {
          const mine = this.st.turn === this.myColor;
          if (this.el.offer) this.el.offer.disabled = !!this.match.offered;
          this._setExpr(mine ? 'idle' : 'think', mine ? 'your move' : 'thinking');
          this._syncTurn();
          this._pumpRemote(); // a move may have landed while we read the rules
        } else {
          this._setExpr('idle', 'your move', pick(LINES.greet));
          this._syncTurn();
        }
        return;
      }
      const over = this.el.over;
      over.classList.remove('mg-chess-gone');
      over.innerHTML = `<div class="mg-chess-count">${steps[i]}</div>`;
      this.game.audio?.play?.(i === steps.length - 1 ? 'success' : 'ding');
      this._after(i === steps.length - 1 ? 440 : 600, () => show(i + 1));
    };
    show(0);
  }

  _confirmResign() {
    if (this.phase !== 'play' || this.match?.frozen) return;
    this.phase = 'confirm';
    this.game.audio?.play?.('click');
    const M = this.match;
    const card = this._showOver(`
      <h2>Resign the ${M ? 'match' : 'game'}?</h2>
      <div class="mg-chess-sub">${M
        ? `${esc(M.foeName.toUpperCase())} TAKES THE WIN AND THE ${MATCH_BONUS} COIN BONUS.`
        : 'PEBBLE WILL BE VERY GRACIOUS ABOUT IT. FOR HOURS.'}</div>
      <div class="mg-chess-btns">
        <button class="mg-chess-btn" data-a="no">Keep playing</button>
        <button class="mg-chess-btn mg-chess-alt" data-a="yes">Resign (${COINS.loss} coins)</button>
      </div>`);
    card.querySelector('[data-a="no"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.phase = 'play';
      this._hideOver();
      this._pumpRemote();
    });
    card.querySelector('[data-a="yes"]').addEventListener('click', () => {
      this.phase = 'play';
      this._hideOver();
      if (M) this._sendData({ resign: true });
      this._endGame('resign-loss');
    });
  }

  _confirmQuit() {
    this.game.audio?.play?.('click');
    const live = !!this.match && !this.match.ended && this.phase !== 'over';
    if (!live && this.phase !== 'play' && this.phase !== 'think') { this.quit(); return; }
    const prev = this.phase;
    this.phase = 'confirm';
    const card = this._showOver(`
      <h2>Leave the table?</h2>
      <div class="mg-chess-sub">${live
        ? `THE MATCH IS FORFEIT: ${esc(this.match.foeName.toUpperCase())} WINS IT.`
        : 'THE GAME IS ABANDONED AND NOBODY GETS PAID.'}</div>
      <div class="mg-chess-btns">
        <button class="mg-chess-btn" data-a="no">Stay</button>
        <button class="mg-chess-btn mg-chess-alt" data-a="yes">${live ? 'Forfeit and leave' : 'Back to the den'}</button>
      </div>`);
    card.querySelector('[data-a="no"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.phase = prev;
      this._hideOver();
      this._pumpRemote();
    });
    card.querySelector('[data-a="yes"]').addEventListener('click', () => {
      if (live) this._forfeitAndQuit();
      else this.quit();
    });
  }

  /** The player pushed a pup to the far shore: let them choose what it becomes. */
  _promoDialog(from, to) {
    this.phase = 'promo';
    this.game.audio?.play?.('open');
    const opts = [QUEEN, ROOK, BISHOP, KNIGHT];
    const card = this._showOver(`
      <h2>Promotion!</h2>
      <div class="mg-chess-sub">YOUR PEBBLE PUP REACHED THE FAR SHORE. WHAT DO THEY BECOME?</div>
      <div class="mg-chess-promo">${opts.map((t) => `<button data-t="${t}">${PIECE_LORE[t].name}</button>`).join('')}</div>
      <div class="mg-chess-btns" style="margin-top:12px">
        <button class="mg-chess-btn mg-chess-ghost" data-a="cancel">Take that back</button>
      </div>`);
    this._cancelPromo = () => {
      this._hideOver();
      this.phase = 'play';
      this.sel = from;
      this._cancelPromo = null;
      this.game.audio?.play?.('close');
      this._pumpRemote();
    };
    card.querySelector('[data-a="cancel"]').addEventListener('click', () => this._cancelPromo?.());
    for (const btn of card.querySelectorAll('[data-t]')) {
      const t = Number(btn.dataset.t);
      btn.insertBefore(pieceCanvas(t, this.myColor === 1, 54), btn.firstChild);
      btn.addEventListener('click', () => {
        const m = this.legal.find((x) => mFrom(x) === from && mTo(x) === to && mPromo(x) === t);
        this._hideOver();
        this.phase = 'play';
        this._cancelPromo = null;
        if (m !== undefined) {
          this.game.audio?.play?.('levelup');
          this._float('PROMOTED!', to, 'mg-chess-good');
          this._applyMove(m, false);
        }
      });
    }
  }

  _results(kind) {
    this.phase = 'over';
    const M = this.match;
    const win = WIN_KINDS.has(kind);
    const loss = LOSS_KINDS.has(kind);
    this._outcome = win ? 'win' : loss ? 'loss' : 'draw';

    const lead = this._myLead();
    const score = this._scoreFor(kind);
    const prevBest = this.game.state?.bests?.chess || 0;
    const isBest = score > prevBest;
    const coins = this.coinsForScore(score);
    this.finish(score);
    const shownBest = Math.max(prevBest, score);

    const HEAD = {
      'mate-win': ['Checkmate!', 'HIS MONOCLE IS ON THE FLOOR AND HE IS NOT LOOKING FOR IT.'],
      'resign-win': ['Pebble resigns!', 'HE TIPS THE CROWNED ELDER OVER AND SHAKES YOUR PAW.'],
      'mate-loss': ['Checkmate.', 'PEBBLE POLISHES THE MONOCLE. "A LOVELY GAME," HE SAYS.'],
      'resign-loss': ['You resigned.', 'HE BOWS. HE IS ALREADY SETTING THE PIECES BACK UP.'],
      stalemate: ['Stalemate!', 'NO LEGAL MOVES AND NO CHECK. NOBODY WINS, EVERYBODY SNACKS.'],
      fifty: ['Draw: fifty moves.', 'FIFTY MOVES WITHOUT A CAPTURE OR A PAWN. TIME FOR TEA.'],
      threefold: ['Draw: threefold.', 'THE SAME POSITION THREE TIMES. YOU ARE BOTH VERY STUBBORN.'],
      dead: ['Draw: dead position.', 'NOT ENOUGH PIECES LEFT ON THE POND TO MATE ANYONE.'],
    };
    if (M) {
      const foe = esc(M.foeName.toUpperCase());
      Object.assign(HEAD, {
        'mate-win': ['Checkmate!', `${foe} HAS NOWHERE LEFT TO GO. THE TABLE IS YOURS.`],
        'mate-loss': ['Checkmate.', `${foe} FOLDS THEIR PAWS AND LOOKS VERY PLEASED INDEED.`],
        'resign-win': [`${esc(M.foeName)} resigns!`, 'THEY TIP THE CROWNED ELDER OVER AND SHAKE YOUR PAW.'],
        'resign-loss': ['You resigned.', 'YOU TIP YOUR ELDER OVER. THE PIECES GO BACK IN THE BOX.'],
        'forfeit-win': ['They left the table!', `${foe} WANDERED OFF MID-GAME. THE WIN IS YOURS.`],
        'forfeit-loss': ['Match forfeited.', 'THE TABLE WAS EMPTY ON YOUR SIDE, SO THE MATCH WENT THE OTHER WAY.'],
        'match-win': ['You win!', `${foe} SETS THE PIECES BACK UP WITH GREAT DIGNITY.`],
        'match-loss': ['You lose.', `${foe} WINS THIS ONE. THE BACK TABLE IS ALWAYS FREE.`],
        'draw-agreed': ['Draw agreed.', 'PAWS SHAKEN OVER THE BOARD. VERY CIVIL, VERY COZY.'],
      });
    }
    const [title, sub] = HEAD[kind] || ['Game over', 'THE PIECES GO BACK IN THE BOX.'];
    const them = M ? esc(M.foeShort) : 'Pebble';
    const leadText = lead > 0 ? `+${lead} you` : lead < 0 ? `+${-lead} ${them}` : 'even';

    this.game.audio?.play?.(win ? 'success' : loss ? 'fail' : 'ding');
    if (M) {
      this._setExpr(win ? 'beaten' : loss ? 'smug' : 'idle',
        win ? 'well played' : loss ? 'good game' : 'a fair result');
    } else {
      this._setExpr(win ? 'beaten' : loss ? 'smug' : 'idle',
        win ? 'defeated' : loss ? 'insufferable' : 'a fair result');
    }

    const card = this._showOver(`
      ${isBest && score > 0 ? '<div class="mg-chess-ribbon">NEW PERSONAL BEST</div>' : ''}
      <h2>${title}</h2>
      <div class="mg-chess-sub">${sub}</div>
      <div class="mg-chess-stats">
        <div class="mg-chess-stat"><b>${score}</b><span>SCORE</span></div>
        <div class="mg-chess-stat mg-chess-gold"><b>${coins}</b><span>COINS</span></div>
        <div class="mg-chess-stat"><b>${shownBest}</b><span>BEST</span></div>
      </div>
      <div class="mg-chess-stats">
        <div class="mg-chess-stat"><b>${leadText}</b><span>MATERIAL</span></div>
        <div class="mg-chess-stat"><b>${Math.ceil(this.history.length / 2)}</b><span>MOVES</span></div>
        ${M && win ? `<div class="mg-chess-stat mg-chess-gold"><b>+${MATCH_BONUS}</b><span>MATCH BONUS</span></div>` : ''}
      </div>
      <div class="mg-chess-btns">
        ${M ? '<button class="mg-chess-btn" data-a="leave">Back to the den</button>'
    + '<button class="mg-chess-btn mg-chess-alt" data-a="pebble">Play Pebble</button>'
    : '<button class="mg-chess-btn" data-a="again">Play again</button>'
    + '<button class="mg-chess-btn mg-chess-alt" data-a="leave">Back to the den</button>'}
      </div>`);
    card.querySelector('[data-a="again"]')?.addEventListener('click', () => {
      this._done = false; // let the next game report its own result
      this._outcome = null;
      this._countdown();
    });
    card.querySelector('[data-a="pebble"]')?.addEventListener('click', () => {
      this._leaveMatch();
      this._done = false;
      this._outcome = null;
      this._countdown();
    });
    card.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  // ---- game flow -----------------------------------------------------------
  _newGame() {
    this._seq = (this._seq || 0) + 1;
    this.st = fromFen(START_FEN);
    this.curKey = posKey(this.st);
    this.keys = new Map([[this.curKey, 1]]);
    this.legal = legalMoves(this.st);
    this.history = [];
    this.sel = -1;
    this.cursor = -1;
    this.drag = null;
    this.anim = null;
    this._animDone = null;
    this.parts.length = 0;
    this.lastMove = null;
    this.busy = false;
    this.badTurns = 0;
    this._outcome = null;
    this._myExpr = 'idle';
    if (this.el.moves) this.el.moves.innerHTML = '';
    if (this.el.trayPebble) this.el.trayPebble.innerHTML = '';
    if (this.el.trayYou) this.el.trayYou.innerHTML = '';
    if (this.el.fx) this.el.fx.innerHTML = '';
    this._setExpr('idle', this.match ? 'ready when you are' : 'polishing monocle');
    this._syncTurn();
  }

  _syncTurn() {
    const M = this.match;
    const mine = this.st.turn === this.myColor;
    this.el.turn.textContent = mine ? 'You' : (M ? M.foeShort : 'Pebble');
    this.el.turnChip.classList.toggle('mg-chess-theirs', !mine);
    this.el.movenum.textContent = String(this.st.full);
    const lead = this._myLead();
    this.el.lead.textContent = lead > 0 ? `+${lead}` : lead < 0 ? `${lead}` : 'even';
    this.el.leadChip.classList.toggle('mg-chess-theirs', lead < 0);
    this.el.leadYou.textContent = lead > 0 ? `+${lead}` : '';
    this.el.leadPebble.textContent = lead < 0 ? `+${-lead}` : '';
    this.el.pcard.classList.toggle('mg-chess-active', !mine && this.phase !== 'over');
    this.el.ycard.classList.toggle('mg-chess-active', mine && this.phase !== 'over');

    // no clocks in a match: the board pulses instead, and the turn chip bumps
    // once (with a ding) the moment the move comes back to us
    const live = !!M && !M.ended && !M.frozen && this.phase === 'play';
    if (this.el.board) this.el.board.classList.toggle('mg-chess-nudge', live && mine);
    if (live && mine && this._lastTurnMine === false) {
      this.game.audio?.play?.('ding');
      const chip = this.el.turnChip;
      chip.classList.remove('mg-chess-bump');
      void chip.offsetWidth;
      chip.classList.add('mg-chess-bump');
      this._after(360, () => chip.classList.remove('mg-chess-bump'));
    }
    this._lastTurnMine = M ? mine : null;
  }

  _pushMove(san, byWhite) {
    const list = this.el.moves;
    const prev = list.querySelector('.mg-chess-latest');
    if (prev) prev.classList.remove('mg-chess-latest');
    if (byWhite) {
      const li = document.createElement('li');
      li.className = 'mg-chess-latest mg-chess-half';
      li.innerHTML = `<i>${Math.floor(this.history.length / 2) + 1}.</i><span></span><span></span>`;
      li.children[1].textContent = san;
      list.appendChild(li);
    } else {
      let li = list.lastElementChild;
      if (!li) {
        li = document.createElement('li');
        li.innerHTML = `<i>${Math.floor(this.history.length / 2) + 1}.</i><span>&hellip;</span><span></span>`;
        list.appendChild(li);
      }
      li.classList.add('mg-chess-latest');
      li.classList.remove('mg-chess-half');
      li.children[2].textContent = san;
    }
    this.history.push(san);
    list.scrollTop = list.scrollHeight;
  }

  _addCapture(piece, byOpp) {
    const tray = byOpp ? this.el.trayPebble : this.el.trayYou;
    tray.appendChild(pieceCanvas(typeOf(piece), colorOf(piece) === 1, 20));
  }

  _status() {
    if (!this.legal.length) {
      if (inCheck(this.st)) return this.st.turn === this.myColor ? 'mate-loss' : 'mate-win';
      return 'stalemate';
    }
    if (this.st.half >= 100) return 'fifty';
    if ((this.keys.get(this.curKey) || 0) >= 3) return 'threefold';
    if (insufficientMaterial(this.st)) return 'dead';
    return null;
  }

  /** Play a move on the board and start its animation. */
  _applyMove(m, byOpp) {
    const st = this.st;
    const from = mFrom(m), to = mTo(m), flag = mFlag(m), promo = mPromo(m);
    const mover = st.b[from];
    const us = colorOf(mover);
    const san = toSan(st, m);
    const capSq = flag === FLAG_EP ? to + (us === 0 ? 8 : -8) : (st.b[to] ? to : -1);
    const capPiece = capSq >= 0 ? st.b[capSq] : 0;

    // our own move goes out before we animate it: they see it as soon as possible
    if (this.match && !byOpp) this._sendData({ move: promo ? { from, to, promo } : { from, to } });

    makeMove(st, m);
    this.legal = legalMoves(st);
    this.curKey = posKey(st);
    this.keys.set(this.curKey, (this.keys.get(this.curKey) || 0) + 1);
    this._pushMove(san, us === 0);
    this.lastMove = { from, to };
    this.sel = -1;
    this.drag = null;

    const pieces = [{ piece: promo ? mk(promo, us) : mover, from, to }];
    const hide = new Set([to]);
    if (flag === FLAG_CASTLE) {
      const rookFrom = to === 62 ? 63 : to === 58 ? 56 : to === 6 ? 7 : 0;
      const rookTo = to === 62 ? 61 : to === 58 ? 59 : to === 6 ? 5 : 3;
      pieces.push({ piece: mk(ROOK, us), from: rookFrom, to: rookTo });
      hide.add(rookTo);
    }
    this.anim = {
      t: 0,
      dur: byOpp ? 0.26 : 0.18,
      pieces,
      hide,
      cap: capPiece ? { piece: capPiece, sq: capSq } : null,
    };
    this.busy = true;

    const audio = this.game.audio;
    if (capPiece) {
      audio?.play?.('pop');
      this._addCapture(capPiece, byOpp);
      this._puff(capSq, colorOf(capPiece) === 1 ? '#8a6642' : '#fff4dc');
      const worth = POINTS[typeOf(capPiece)];
      if (worth >= 3) this._shake();
      if (!byOpp) this._float(`+${worth}`, to, 'mg-chess-good');
      if (flag === FLAG_EP) this._float('EN PASSANT!', to, 'mg-chess-good');
    } else {
      audio?.play?.(flag === FLAG_CASTLE ? 'slide' : 'thud');
    }
    if (flag === FLAG_CASTLE && !byOpp) this._float('CASTLES!', to, '');
    this._syncTurn();
    this._animDone = () => this._afterMove(byOpp, capPiece, flag, promo);
  }

  _afterMove(byOpp, capPiece, flag, promo) {
    if (this._dead) return;
    this.anim = null;
    const st = this.st;
    const check = inCheck(st);
    const status = this._status();

    // the portrait belongs to whoever is sitting opposite: Pebble has opinions,
    // a real capybara just gets a face that mirrors how the board is going
    if (this.match) {
      if (check && !status) {
        this.game.audio?.play?.('ding');
        this._float('CHECK!', st.k[st.turn], 'mg-chess-warn');
        this._setExpr(byOpp ? 'smug' : 'worried', byOpp ? 'you are in check' : 'check!');
      } else if (capPiece) {
        this._setExpr(byOpp ? 'smug' : 'worried', byOpp ? 'they took one' : 'you took one');
      } else if (promo) {
        this._setExpr(byOpp ? 'smug' : 'worried', 'promotion');
      }
    } else if (check && !status) {
      this.game.audio?.play?.('ding');
      this._float('CHECK!', st.k[st.turn], 'mg-chess-warn');
      if (byOpp) this._setExpr('smug', 'check!', pick(LINES.theirCheck));
      else this._setExpr('worried', 'in check', pick(LINES.myCheck));
    } else if (!byOpp && capPiece) {
      this._setExpr('worried', 'that stung', pick(LINES.iTake));
    } else if (byOpp && capPiece) {
      this._setExpr('smug', 'thank you', pick(LINES.theyTake));
    } else if (byOpp && flag === FLAG_CASTLE) {
      this._setExpr('idle', 'tucked in', pick(LINES.castle));
    } else if (promo) {
      this._setExpr(byOpp ? 'smug' : 'worried', 'promotion', pick(LINES.promo));
    }

    if (status) { this._endGame(status); return; }

    this.busy = false;
    if (this.match) {
      const mine = st.turn === this.myColor;
      if (!check && !capPiece && !promo) this._setExpr(mine ? 'idle' : 'think', mine ? 'your move' : 'thinking');
      this._syncTurn();
      this._pumpRemote();
    } else if (st.turn === 1) this._pebbleTurn();
    else this._syncTurn();
  }

  /** Solo only: Pebble never runs during a table match. */
  _pebbleTurn() {
    if (this.phase === 'over' || this._dead || this.match) return;
    this.busy = true;
    const played = this.history.length;
    const warming = played < 8;
    this._setExpr('think', warming ? 'warming up' : 'thinking',
      '<span class="mg-chess-dots"><i></i><i></i><i></i></span>');
    this.game.audio?.play?.('tick');
    this._syncTurn();

    const seq = this._seq;
    const target = 400 + Math.random() * 500;
    const t0 = now();
    // let the thinking face paint before the search blocks the thread
    this._after(90, () => {
      if (seq !== this._seq || this._dead) return;
      const slack = played < 8 ? 55 : played < 16 ? 28 : 0;
      const res = bestMove(this.st, { depth: 3, slack, timeMs: 700 });
      if (!res) return; // no legal moves: _status already ended the game
      if (res.score <= -1250 && played >= 20) this.badTurns++;
      else this.badTurns = 0;

      const wait = Math.max(90, target - (now() - t0));
      this._after(wait, () => {
        if (seq !== this._seq || this._dead) return;
        if (this.badTurns >= 2) {
          this._setExpr('beaten', 'resigning', 'i concede. that was a thrashing.');
          this._endGame('resign-win');
          return;
        }
        if (res.score >= 220) this._setExpr('smug', 'confident', Math.random() < 0.34 ? pick(LINES.smug) : null);
        else if (res.score <= -220) this._setExpr('worried', 'rattled', Math.random() < 0.34 ? pick(LINES.worried) : null);
        else this._setExpr('idle', 'your move');
        this._applyMove(res.move, true);
      });
    });
  }

  _endGame(kind) {
    if (this.phase === 'over') return;
    this._seq++; // any queued Pebble move is now stale
    this.busy = true;
    this.phase = 'over';
    this.sel = -1;
    this.drag = null;
    this.el.pcard?.classList.remove('mg-chess-active');
    this.el.ycard?.classList.remove('mg-chess-active');
    this.el.board?.classList.remove('mg-chess-nudge');
    if (this.el.offer) this.el.offer.disabled = true;

    const win = WIN_KINDS.has(kind);
    const loss = LOSS_KINDS.has(kind);
    // report to the server before the results screen: both seats agree on the
    // winner because both ran the same rules over the same move list
    if (this.match) {
      this.match.queue.length = 0;
      this._reportMatch(kind, this._scoreFor(kind));
    }
    if (kind === 'mate-win' || kind === 'mate-loss') {
      this._float('CHECKMATE!', this.st.k[this.st.turn], win ? 'mg-chess-good' : 'mg-chess-warn');
      this._shake();
      this._puff(this.st.k[this.st.turn], win ? '#f2b64a' : '#c9506a', 18);
    } else if (!win && !loss) {
      this._float('DRAW', 36, '');
    }
    const quick = kind === 'resign-loss' || kind === 'forfeit-loss' || kind === 'forfeit-win';
    this._after(quick ? 320 : 900, () => this._results(kind));
  }

  // ---- input ---------------------------------------------------------------
  _playable() {
    if (this.match && (this.match.frozen || this.match.ended)) return false;
    return this.phase === 'play' && this.st.turn === this.myColor && !this.busy && !this.anim;
  }

  /** Board square <-> screen cell. Seat 1 sees the board from the other end,
   *  and the mapping is its own inverse, so one helper covers both ways. */
  _disp(sq) { return this.flip ? 63 - sq : sq; }

  _sqAt(e) {
    const rect = this.el.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return -1;
    const f = Math.floor((x / rect.width) * 8);
    const r = Math.floor((y / rect.height) * 8);
    return this._disp(r * 8 + f);
  }

  _movesFrom(sq) {
    return this.legal.filter((m) => mFrom(m) === sq);
  }

  _onDown(e) {
    if (!this._playable()) return;
    const sq = this._sqAt(e);
    if (sq < 0) return;
    this.cursor = -1;
    const p = this.st.b[sq];
    if (p && colorOf(p) === this.myColor) {
      if (this._movesFrom(sq).length === 0) {
        this.game.audio?.play?.('close');
        this._float('stuck!', sq, 'mg-chess-warn');
        return;
      }
      this.sel = sq;
      const rect = this.el.canvas.getBoundingClientRect();
      this.drag = { from: sq, x: e.clientX - rect.left, y: e.clientY - rect.top, moved: false };
      this.game.audio?.play?.('click');
      try { this.el.canvas.setPointerCapture(e.pointerId); } catch {}
    } else if (this.sel >= 0) {
      this._tryMove(this.sel, sq);
    }
  }

  _onMoveEvt(e) {
    if (!this.drag) return;
    const rect = this.el.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (Math.hypot(x - this.drag.x, y - this.drag.y) > 5) this.drag.moved = true;
    this.drag.x = x;
    this.drag.y = y;
  }

  _onUp(e) {
    const drag = this.drag;
    this.drag = null;
    if (!drag || !this._playable()) return;
    const sq = this._sqAt(e);
    if (sq < 0 || sq === drag.from) return; // released where it started: keep the selection
    this._tryMove(drag.from, sq);
  }

  _tryMove(from, to) {
    const options = this.legal.filter((m) => mFrom(m) === from && mTo(m) === to);
    if (!options.length) {
      const p = this.st.b[to];
      if (p && colorOf(p) === this.myColor) { this.sel = to; this.game.audio?.play?.('click'); }
      else { this.sel = -1; this.game.audio?.play?.('close'); }
      return;
    }
    if (options.length > 1 && mPromo(options[0])) { this.sel = -1; this._promoDialog(from, to); return; }
    this._applyMove(options[0], false);
  }

  _key(e) {
    if (this._dead) return;
    if (e.key === 'Escape') {
      if (this.phase === 'promo' && this._cancelPromo) { e.preventDefault(); this._cancelPromo(); }
      else if (this.phase === 'play' && this.sel >= 0) { this.sel = -1; e.preventDefault(); }
      return;
    }
    if (this.phase === 'splash' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this._countdown();
      return;
    }
    if (!this._playable()) return;

    const ARROWS = { ArrowUp: -8, ArrowDown: 8, ArrowLeft: -1, ArrowRight: 1 };
    if (Object.prototype.hasOwnProperty.call(ARROWS, e.key)) {
      e.preventDefault();
      // arrows walk the board as it LOOKS, so up is always up the screen
      if (this.cursor < 0) this.cursor = this.sel >= 0 ? this.sel : (this.myColor === 0 ? 60 : 4);
      else {
        const d = ARROWS[e.key];
        const cur = this._disp(this.cursor);
        const f = (cur & 7) + (d === -1 ? -1 : d === 1 ? 1 : 0);
        const r = (cur >> 3) + (d === -8 ? -1 : d === 8 ? 1 : 0);
        if (f >= 0 && f < 8 && r >= 0 && r < 8) this.cursor = this._disp(r * 8 + f);
      }
      this.game.audio?.play?.('hover');
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && this.cursor >= 0) {
      e.preventDefault();
      const p = this.st.b[this.cursor];
      if (this.sel >= 0 && this.sel !== this.cursor) this._tryMove(this.sel, this.cursor);
      else if (p && colorOf(p) === this.myColor && this._movesFrom(this.cursor).length) {
        this.sel = this.cursor;
        this.game.audio?.play?.('click');
      }
    }
  }

  // ---- effects -------------------------------------------------------------
  _center(sq) {
    const d = this._disp(sq);
    return { x: ((d & 7) + 0.5) * this.cell, y: ((d >> 3) + 0.5) * this.cell };
  }

  /** Top-left corner of a board square in canvas pixels. */
  _corner(sq) {
    const d = this._disp(sq);
    return { x: (d & 7) * this.cell, y: (d >> 3) * this.cell };
  }

  _float(text, sq, cls = '') {
    if (!this.el.fx) return;
    const { x, y } = this._center(sq);
    const el = document.createElement('div');
    el.className = `mg-chess-float ${cls}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.el.fx.appendChild(el);
    this._after(1200, () => el.remove());
  }

  _puff(sq, color, n = 12) {
    const { x, y } = this._center(sq);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random();
      const sp = (0.6 + Math.random() * 1.5) * this.cell;
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - this.cell * 0.5,
        r: this.cell * (0.06 + Math.random() * 0.08), life: 0, max: 0.5 + Math.random() * 0.3, color,
      });
    }
  }

  _shake() {
    const b = this.el.board;
    if (!b) return;
    b.classList.remove('mg-chess-quake');
    void b.offsetWidth;
    b.classList.add('mg-chess-quake');
    this._after(420, () => b.classList.remove('mg-chess-quake'));
  }

  // ---- loop and rendering --------------------------------------------------
  _loop(t) {
    if (this._dead) return;
    this._raf = requestAnimationFrame((tt) => this._loop(tt));
    const dt = Math.min(0.05, Math.max(0, (t - (this._lastT || t)) / 1000));
    this._lastT = t;
    this._time = (this._time || 0) + dt;

    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      if (this.expr === 'idle') { this._setExpr('blink'); this.blinkIn = 0.13; }
      else if (this.expr === 'blink') { this._setExpr('idle'); this.blinkIn = 2.4 + Math.random() * 2.6; }
      else this.blinkIn = 1.2;
    }

    if (this.anim) {
      this.anim.t += dt / this.anim.dur;
      if (this.anim.t >= 1) {
        const done = this._animDone;
        this._animDone = null;
        this.anim = null;
        if (done) done();
      }
    }
    // a packet can land in any frame: drain it as soon as the board is calm
    if (this.match?.queue.length) this._pumpRemote();

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      if (p.life >= p.max) { this.parts.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += this.cell * 3.2 * dt;
    }

    this._draw();
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx || !this.sprites) return;
    const size = this.size, cell = this.cell, st = this.st;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        ctx.fillStyle = ((r + f) & 1) ? DARK_SQ : LIGHT_SQ;
        ctx.fillRect(f * cell, r * cell, cell + 0.6, cell + 0.6);
      }
    }
    // a whisper of wood grain so the board is not two flat colours
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    for (let i = 0; i < 40; i++) {
      const y = (i / 40) * size + Math.sin(i * 2.7) * 3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y + Math.sin(i) * 2);
      ctx.stroke();
    }
    ctx.restore();

    const fill = (sq, style) => {
      const p = this._corner(sq);
      ctx.fillStyle = style;
      ctx.fillRect(p.x, p.y, cell, cell);
    };
    if (this.lastMove) {
      fill(this.lastMove.from, 'rgba(242,182,74,.42)');
      fill(this.lastMove.to, 'rgba(242,182,74,.58)');
    }
    if (this.sel >= 0) fill(this.sel, 'rgba(232,101,122,.45)');
    if (this.cursor >= 0) {
      const p = this._corner(this.cursor);
      ctx.strokeStyle = '#4fb3e8';
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.strokeRect(p.x + 2, p.y + 2, cell - 4, cell - 4);
    }
    if (inCheck(st)) {
      const k = st.k[st.turn];
      const c = this._center(k);
      const p = this._corner(k);
      const pulse = 0.55 + Math.sin(this._time * 7) * 0.2;
      const g = ctx.createRadialGradient(c.x, c.y, cell * 0.1, c.x, c.y, cell * 0.62);
      g.addColorStop(0, `rgba(232,80,100,${pulse})`);
      g.addColorStop(1, 'rgba(232,80,100,0)');
      ctx.fillStyle = g;
      ctx.fillRect(p.x, p.y, cell, cell);
    }

    // legal move hints for the selected piece
    if (this.sel >= 0) {
      for (const m of this._movesFrom(this.sel)) {
        const to = mTo(m);
        const c = this._center(to);
        if (st.b[to] || mFlag(m) === FLAG_EP) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, cell * 0.44, 0, Math.PI * 2);
          ctx.lineWidth = cell * 0.09;
          ctx.strokeStyle = 'rgba(45,36,23,.42)';
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(c.x, c.y, cell * 0.15, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(45,36,23,.34)';
          ctx.fill();
        }
      }
    }

    const sprite = (piece) => this.sprites[(colorOf(piece) === 1 ? 'b' : 'w') + typeOf(piece)];
    const anim = this.anim;
    const ease = anim ? 1 - (1 - Math.min(1, anim.t)) ** 3 : 0;

    // the piece being taken shrinks away under the incoming one
    if (anim?.cap) {
      const c = this._center(anim.cap.sq);
      const k = Math.max(0, 1 - anim.t * 1.6);
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate(c.x, c.y);
      ctx.rotate((1 - k) * 0.5);
      ctx.scale(k, k);
      ctx.drawImage(sprite(anim.cap.piece), -cell / 2, -cell / 2, cell, cell);
      ctx.restore();
    }

    for (let sq = 0; sq < 64; sq++) {
      const p = st.b[sq];
      if (!p) continue;
      if (anim && anim.hide.has(sq)) continue;
      if (this.drag && this.drag.moved && this.drag.from === sq) continue;
      const at = this._corner(sq);
      ctx.drawImage(sprite(p), at.x, at.y, cell, cell);
    }

    if (anim) {
      for (const mv of anim.pieces) {
        const a = this._center(mv.from), b = this._center(mv.to);
        const x = a.x + (b.x - a.x) * ease;
        const y = a.y + (b.y - a.y) * ease;
        const hop = Math.sin(Math.min(1, anim.t) * Math.PI) * cell * 0.12;
        ctx.save();
        ctx.translate(x, y - hop);
        const s = 1 + Math.sin(Math.min(1, anim.t) * Math.PI) * 0.08;
        ctx.scale(s, s);
        ctx.drawImage(sprite(mv.piece), -cell / 2, -cell / 2, cell, cell);
        ctx.restore();
      }
    }

    for (const p of this.parts) {
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (this.drag && this.drag.moved) {
      const p = st.b[this.drag.from];
      if (p) {
        ctx.save();
        ctx.translate(this.drag.x, this.drag.y);
        ctx.scale(1.12, 1.12);
        ctx.globalAlpha = 0.95;
        ctx.drawImage(sprite(p), -cell / 2, -cell / 2, cell, cell);
        ctx.restore();
      }
    }

    // coordinates, in the corner of the squares so they never sit under a piece
    ctx.font = `900 ${Math.max(8, cell * 0.2)}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = (i & 1) ? 'rgba(45,36,23,.42)' : 'rgba(255,246,227,.62)';
      ctx.fillText(this.flip ? `${i + 1}` : `${8 - i}`, 3, i * cell + 3);
      ctx.fillStyle = (i & 1) ? 'rgba(255,246,227,.62)' : 'rgba(45,36,23,.42)';
      ctx.fillText('abcdefgh'[this.flip ? 7 - i : i], i * cell + cell - cell * 0.22, size - cell * 0.24);
    }
  }
}

