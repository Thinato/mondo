/**
 * Shared primitives for the pairing formats (docs/06-tournaments.md §6.2).
 * Pure (NFR-8). `tournament.ts` holds the stored shapes and the presets; this
 * holds the arithmetic every pairing format needs, written once so that
 * single elimination, Swiss and double elimination (slices 4–6) add a pairing
 * function and nothing else.
 *
 * The design doc calls this file `lib/tournament/core.ts`. `lib/` is flat —
 * sixteen sibling modules, no directories — so it is flat here too.
 *
 * Everything below assumes **D-38**: everyone still in a round plays the
 * identical card, so a "match" is a comparison of two scores drawn from the
 * same questions. That is what makes a pairing cost nothing and a bye trivial.
 */

import { mondoError } from "./errors";
import type { Format, RoundResultRow, Tiebreak } from "./tournament";

/**
 * A league is not a mailing list. Round robin plays n−1 rounds, so a group of
 * 200 would schedule 199 of them — a tournament lasting most of a year, one
 * round per day. The pairing formats are lunch-sized on purpose (§6.2).
 */
export const MAX_PAIRED_PARTICIPANTS = 12;

/** 3 / 1 / 0, the football default; `matchPoints` on the config overrides it. */
export const DEFAULT_MATCH_POINTS: MatchPoints = { win: 3, draw: 1, loss: 0 };

export interface MatchPoints {
  win: number;
  draw: number;
  loss: number;
}

/**
 * One fixture. `b === null` is a bye: the circle method's ghost player (§7),
 * not an opponent who failed to turn up. `outcome` is null while the round is
 * open — pairings are published in advance, results are not (FR-5.6).
 */
export interface Pairing {
  a: string;
  b: string | null;
  outcome: "a" | "b" | "draw" | null;
  /**
   * Which half of a double-elimination bracket this fixture belongs to:
   * `w` winners, `l` losers, `gf` grand final. Absent for every other format,
   * which has only one bracket and therefore nothing to say.
   *
   * Stored rather than recomputed because the losers bracket is defined in
   * terms of "who dropped out of winners round r", and that question is only
   * answerable if the fixtures remember which bracket they were.
   */
  bracket?: "w" | "l" | "gf";
}

/**
 * Who won a pairing, given both players' card results and the tiebreak chain.
 *
 * **Turning up beats not turning up, before any comparator runs.** A forfeit
 * is stored as 0 points in 0 ms (FR-5.7), and 0 ms is the *best* possible time
 * — so a chain ending in "time" would hand the win to the player who never
 * opened the card, over an opponent who played and scored 0 in a minute. That
 * is the single nastiest edge in this file, it is unreachable from the tests
 * that only feed it played rows, and it is why `played` is checked first.
 */
export function cardWinner(a: RoundResultRow, b: RoundResultRow, chain: Tiebreak["chain"]): "a" | "b" | "draw" {
  if (a.played !== b.played) return a.played ? "a" : "b";

  for (const key of chain) {
    if (key === "points" && a.points !== b.points) return a.points > b.points ? "a" : "b";
    // Lower is better, and only among players who actually finished the card.
    if (key === "time" && a.elapsedMs !== b.elapsedMs) return a.elapsedMs < b.elapsedMs ? "a" : "b";
  }
  return "draw";
}

/**
 * Competition ranks (1, 2, 2, 4) over an ordered vector of keys, each compared
 * descending — pass a negated value for "lower is better", the way total
 * elapsed time is passed.
 *
 * `rankBy` in lib/standings.ts does exactly this for the daily board, over
 * exactly two keys, and it is left alone: it is D-24's live, argued-over
 * arithmetic and the board has no third key. The match regime does — match
 * points, then card points, then time — so it gets its own n-key sibling
 * rather than a signature change to shipped code.
 */
export function competitionRanks<T>(rows: readonly T[], keys: (row: T) => readonly number[]): number[] {
  const order = rows.map((row, i) => ({ i, k: keys(row) }))
    .sort((x, y) => {
      for (let d = 0; d < x.k.length; d++) if (x.k[d] !== y.k[d]) return y.k[d]! - x.k[d]!;
      return 0;
    });
  const same = (x: readonly number[], y: readonly number[]) => x.every((v, d) => v === y[d]);
  const ranks = new Array<number>(rows.length);
  let rank = 0;
  order.forEach((o, pos) => {
    const prev = order[pos - 1];
    if (!prev || !same(prev.k, o.k)) rank = pos + 1;
    ranks[o.i] = rank;
  });
  return ranks;
}

/**
 * The circle method. `seeds` is the seed order; the returned fixtures are for
 * round `n` (1-based) and every unordered pair meets exactly once across the
 * full schedule.
 *
 * Odd fields cost nothing here, which is why this is the cheapest odd-count
 * handling in the phase (§7): a ghost is appended, the player drawn against it
 * has the bye that round, and over the schedule every player draws the ghost
 * exactly once. Paulo's "must accommodate odd player numbers" needs no policy
 * for this format at all.
 *
 * Mechanics: position 0 is pinned and the remaining m−1 positions rotate by
 * one each round. Pair position i with position m−1−i.
 */
export function roundRobinPairings(seeds: readonly string[], n: number): Pairing[] {
  const total = roundRobinRounds(seeds.length);
  if (!Number.isInteger(n) || n < 1 || n > total) throw new RangeError(`round ${n} outside 1..${total}`);

  // The ghost sits at the end of the wheel and is never the pinned player.
  const wheel: (string | null)[] = seeds.length % 2 === 0 ? [...seeds] : [...seeds, null];
  const m = wheel.length;

  const rot = (n - 1) % (m - 1);
  const tail = wheel.slice(1);
  const rotated = [wheel[0]!, ...tail.slice(tail.length - rot), ...tail.slice(0, tail.length - rot)];

  const pairings: Pairing[] = [];
  for (let i = 0; i < m / 2; i++) {
    const x = rotated[i]!;
    const y = rotated[m - 1 - i]!;
    // A pairing always names a real player first, so `b === null` is the bye.
    if (x === null) pairings.push({ a: y as string, b: null, outcome: null });
    else pairings.push({ a: x as string, b: y, outcome: null });
  }
  return pairings;
}

/** n−1 rounds for an even field, n for an odd one — the ghost costs a round. */
export function roundRobinRounds(players: number): number {
  return players % 2 === 0 ? players - 1 : players;
}

/**
 * How many rounds a tournament of `players` will actually run. Free-for-all
 * takes it from the preset; the pairing formats derive it from the field, which
 * is why it can only be known at start, once the participant list is frozen.
 */
export function roundCountFor(format: Format, configuredRounds: number, players: number): number {
  if (format === "round_robin") return roundRobinRounds(players);
  if (format === "single_elim") return singleElimRounds(players);
  if (format === "swiss") return swissRounds(configuredRounds, players);
  if (format === "double_elim") return doubleElimRounds(players);
  return configuredRounds;
}

/**
 * Pairings for round `n`, or [] for a format that pairs nobody.
 *
 * `prior` is every earlier round's fixtures, oldest first. Round robin ignores
 * it — the circle method knows the whole schedule up front — but a knockout
 * cannot be drawn before the previous round has produced its winners, and a
 * Swiss needs the entire history: who has met whom, and who has sat out.
 *
 * `standing` is best-first with match points, and only Swiss reads it.
 */
export function pairingsFor(
  format: Format,
  seeds: readonly string[],
  n: number,
  prior: readonly (readonly Pairing[])[] = [],
  standing: readonly SwissStanding[] = [],
): Pairing[] {
  if (format === "round_robin") return roundRobinPairings(seeds, n);
  if (format === "single_elim") return singleElimPairings(seeds, n, prior);
  if (format === "double_elim") return doubleElimPairings(seeds, n, prior);
  if (format === "swiss") {
    // Round one has no table yet, so seed order stands in for it: everyone is
    // on zero, which makes the whole field one score group and the fold the
    // conventional "seed 1 against the middle".
    const table = standing.length > 0 ? standing : seeds.map((uid) => ({ uid, matchPoints: 0 }));
    return swissPairings(table, prior);
  }
  return [];
}

/**
 * The outcome of every fixture in a closed round, from the round's results.
 * A bye is credited without an opponent (§7); the bye player still plays the
 * card when `byePlay` is on, so their score still counts toward card-points
 * tiebreaks — the "real advantage" the odd player gets.
 */
export function resolvePairings(
  pairings: readonly Pairing[],
  results: Record<string, RoundResultRow>,
  chain: Tiebreak["chain"],
  byeCredit: "win" | "draw",
): Pairing[] {
  const blank: RoundResultRow = { points: 0, elapsedMs: 0, guessCount: 0, played: false };
  return pairings.map((p) => {
    if (p.b === null) return { ...p, outcome: byeCredit === "win" ? ("a" as const) : ("draw" as const) };
    return { ...p, outcome: cardWinner(results[p.a] ?? blank, results[p.b] ?? blank, chain) };
  });
}

export interface MatchRecord {
  matchPoints: number;
  won: number;
  drawn: number;
  lost: number;
  byes: number;
}

export const EMPTY_RECORD: MatchRecord = { matchPoints: 0, won: 0, drawn: 0, lost: 0, byes: 0 };

/**
 * Fold the closed rounds' pairings into a win/draw/loss record per player.
 * A bye counts as whatever it was credited as *and* is reported separately, so
 * a table can show "won 4 (1 bye)" rather than quietly inflating a record.
 */
export function matchRecords(
  uids: readonly string[],
  roundPairings: readonly (readonly Pairing[])[],
  points: MatchPoints,
): Map<string, MatchRecord> {
  const out = new Map(uids.map((u) => [u, { ...EMPTY_RECORD }]));
  const credit = (uid: string, r: "won" | "drawn" | "lost") => {
    const rec = out.get(uid);
    if (!rec) return; // a uid not in the field: ignore rather than invent a row
    rec[r]++;
    rec.matchPoints += r === "won" ? points.win : r === "drawn" ? points.draw : points.loss;
  };
  for (const pairings of roundPairings) {
    for (const p of pairings) {
      if (p.outcome === null) continue; // an open round decides nothing
      if (p.b === null) {
        const rec = out.get(p.a);
        if (rec) rec.byes++;
        credit(p.a, p.outcome === "draw" ? "drawn" : "won");
        continue;
      }
      if (p.outcome === "draw") { credit(p.a, "drawn"); credit(p.b, "drawn"); continue; }
      credit(p.outcome === "a" ? p.a : p.b, "won");
      credit(p.outcome === "a" ? p.b : p.a, "lost");
    }
  }
  return out;
}

/** Guard for the pairing formats, which cannot be run at group scale. */
export function assertPairableSize(format: Format, players: number): void {
  if (format === "free_for_all") return;
  if (players > MAX_PAIRED_PARTICIPANTS) {
    throw mondoError("invalid-argument", `This format takes at most ${MAX_PAIRED_PARTICIPANTS} players.`);
  }
}

// ---------------------------------------------------------------------------
// Single elimination (§6.3) — slice 4
// ---------------------------------------------------------------------------

/** The next power of two at or above `players`: the bracket has that many slots. */
export function bracketSize(players: number): number {
  let s = 1;
  while (s < players) s *= 2;
  return s;
}

/** log2 of the bracket, i.e. how many rounds it takes to get to one player. */
export function singleElimRounds(players: number): number {
  return Math.log2(bracketSize(players));
}

/**
 * The standard recursive bracket order for `size` slots, as seed numbers.
 *
 *   2  → [1, 2]
 *   4  → [1, 4, 2, 3]
 *   8  → [1, 8, 4, 5, 2, 7, 3, 6]
 *
 * Read in consecutive pairs it gives round one, and the property that matters
 * is that the top two seeds can only meet in the final, the top four only in
 * the semis, and so on. Seeding well is the reward for having seeded well.
 */
export function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const x of order) next.push(x, n + 1 - x);
    order = next;
  }
  return order;
}

/**
 * Round one. Slots past the end of the field are empty, and because the order
 * above puts the top seeds against the *bottom* slots, the `S − n` empty ones
 * land on the top seeds — the conventional reward, and the "advantage" Paulo
 * was willing to hand the odd player out (§7).
 */
function firstRoundPairings(seeds: readonly string[]): Pairing[] {
  const size = bracketSize(seeds.length);
  const order = bracketOrder(size);
  const pairings: Pairing[] = [];
  for (let i = 0; i < size; i += 2) {
    const a = seeds[order[i]! - 1] ?? null;
    const b = seeds[order[i + 1]! - 1] ?? null;
    if (a === null && b === null) continue; // both slots empty: no fixture at all
    if (a === null) pairings.push({ a: b!, b: null, outcome: null });
    else if (b === null) pairings.push({ a, b: null, outcome: null });
    else pairings.push({ a, b, outcome: null });
  }
  return pairings;
}

/** Who came out of each fixture, in fixture order. Null where it is undecided. */
export function winnersOf(pairings: readonly Pairing[]): (string | null)[] {
  return pairings.map((p) => {
    if (p.outcome === null || p.outcome === "draw") return p.b === null ? p.a : null;
    return p.outcome === "a" ? p.a : p.b;
  });
}

/**
 * Round `n` of a knockout: round one from the seeding, every later round by
 * pairing the previous round's winners in the order they came out. The bracket
 * is therefore never stored — it is a fold over the round log, like everything
 * else here (D-41).
 */
export function singleElimPairings(seeds: readonly string[], n: number, prior: readonly (readonly Pairing[])[]): Pairing[] {
  if (n === 1) return firstRoundPairings(seeds);

  const previous = prior[n - 2];
  if (!previous) throw new RangeError(`round ${n} needs round ${n - 1} to have been played`);
  const winners = winnersOf(previous);
  if (winners.some((w) => w === null)) throw new Error(`round ${n - 1} has an undecided fixture; a knockout cannot pair past it`);

  const pairings: Pairing[] = [];
  for (let i = 0; i < winners.length; i += 2) {
    const a = winners[i]!;
    const b = winners[i + 1] ?? null;
    pairings.push({ a, b, outcome: null });
  }
  return pairings;
}

/**
 * Everyone not yet knocked out. A fold, never a stored flag.
 *
 * `livesLost` is how many defeats end a tournament for you: one in single
 * elimination, two in double — which is the entire difference between the two
 * formats, and the reason this takes a parameter instead of assuming.
 */
export function alive(
  uids: readonly string[],
  roundPairings: readonly (readonly Pairing[])[],
  livesLost = 1,
): Set<string> {
  const gone = eliminationRound(uids, roundPairings, livesLost);
  return new Set(uids.filter((u) => gone.get(u) === null));
}

/**
 * The round in which each player was knocked out, or null if they never were.
 *
 * Two ways to go out. The ordinary one is running out of lives. The other is
 * **losing the last grand final**, which ends the tournament for you whatever
 * your record: with `grandFinalReset` off, the losers-bracket champion who wins
 * the final leaves both finalists on one defeat, and without this rule the
 * table would show two survivors and no champion. Only the LAST grand final
 * counts, so that a reset — where the first one is deliberately not final —
 * still works.
 */
function eliminationRound(
  uids: readonly string[],
  roundPairings: readonly (readonly Pairing[])[],
  livesLost: number,
): Map<string, number | null> {
  let lastGrandFinal = -1;
  roundPairings.forEach((pairings, i) => {
    if (pairings.some((p) => p.bracket === "gf" && p.b !== null)) lastGrandFinal = i;
  });

  const spent = new Map<string, number>(uids.map((u) => [u, 0]));
  const out = new Map<string, number | null>(uids.map((u) => [u, null]));
  roundPairings.forEach((pairings, i) => {
    for (const p of pairings) {
      if (p.b === null || p.outcome === null || p.outcome === "draw") continue;
      const loser = p.outcome === "a" ? p.b : p.a;
      const n = (spent.get(loser) ?? 0) + 1;
      spent.set(loser, n);
      const fatal = n >= livesLost || (p.bracket === "gf" && i === lastGrandFinal);
      if (fatal && out.get(loser) === null) out.set(loser, i);
    }
  });
  return out;
}

/**
 * How many rounds each player got through: the number of closed rounds they
 * were still in at the end of. Losing in round 3 means surviving 2.
 */
export function survivedRounds(
  uids: readonly string[],
  roundPairings: readonly (readonly Pairing[])[],
  livesLost = 1,
): Map<string, number> {
  const gone = eliminationRound(uids, roundPairings, livesLost);
  return new Map(uids.map((u) => [u, gone.get(u) ?? roundPairings.length]));
}

// ---------------------------------------------------------------------------
// Ties that the clock cannot settle (§6.4, D-50)
// ---------------------------------------------------------------------------

/** Whether a format's standing can hold a drawn fixture at all. */
export function allowsDraws(format: Format): boolean {
  return format === "round_robin" || format === "swiss";
}

/** The fixtures still level after the comparator chain ran out. */
export function drawnPairs(pairings: readonly Pairing[]): [string, string][] {
  return pairings
    .filter((p): p is Pairing & { b: string } => p.b !== null && p.outcome === "draw")
    .map((p) => [p.a, p.b]);
}

/**
 * Re-decide the drawn fixtures from a sudden-death card, leaving every other
 * fixture exactly as it was.
 *
 * `seedOf` is the last resort: after `suddenDeathMaxItems` challenges two
 * players who have matched each other every single time are separated by
 * seeding rather than by a card that keeps coming back level. That is the
 * safety valve in D-50, not a preference — without it a knockout can hang.
 */
export function applyTieResults(
  pairings: readonly Pairing[],
  results: Record<string, RoundResultRow>,
  chain: Tiebreak["chain"],
  opts: { exhausted: boolean; seedOf: (uid: string) => number },
): Pairing[] {
  const blank: RoundResultRow = { points: 0, elapsedMs: 0, guessCount: 0, played: false };
  return pairings.map((p) => {
    if (p.b === null || p.outcome !== "draw") return p;
    const decided = cardWinner(results[p.a] ?? blank, results[p.b] ?? blank, chain);
    if (decided !== "draw") return { ...p, outcome: decided };
    if (!opts.exhausted) return p; // still level: another challenge follows
    // Lower seed number is the better seed.
    return { ...p, outcome: opts.seedOf(p.a) <= opts.seedOf(p.b) ? ("a" as const) : ("b" as const) };
  });
}

// ---------------------------------------------------------------------------
// Swiss (§6.3) — slice 5
// ---------------------------------------------------------------------------

/** One row of the table, as the pairing engine needs it: who, and on how much. */
export interface SwissStanding {
  uid: string;
  matchPoints: number;
}

const pairKey = (a: string, b: string) => [a, b].sort().join("|");

/**
 * How many rounds a Swiss actually runs.
 *
 * Capped at `players − 1`, which is the number of distinct opponents anybody
 * has. Without the cap a 4-player Swiss configured for 4 rounds would reach a
 * round where every legal pairing is a rematch, and "no repeats" would quietly
 * stop being true in the one place people would notice.
 */
export function swissRounds(configured: number, players: number): number {
  return Math.max(1, Math.min(configured, players - 1));
}

/**
 * Pair a Swiss round: sort by standing, pair the top half of each score group
 * against its bottom half, float the odd player down, and never repeat a
 * fixture if any legal alternative exists (§6.3).
 *
 * `standing` is best-first and carries each player's match points, which is
 * what defines the score groups. `prior` supplies both halves of the memory
 * this format needs: who has already met whom, and who has already sat out.
 *
 * The search is exhaustive rather than the "bounded swap-and-retry" the design
 * sketched, and that is a simplification rather than a shortcut: the pairing
 * formats are capped at 12 players (MAX_PAIRED_PARTICIPANTS), so the worst case
 * is 11!! = 10,395 candidate pairings — small enough to enumerate outright.
 * Enumeration cannot fail to find a repeat-free pairing that exists, which is
 * exactly the failure mode risk T-3 is about; a heuristic can.
 */
export function swissPairings(
  standing: readonly SwissStanding[],
  prior: readonly (readonly Pairing[])[],
): Pairing[] {
  const met = new Set<string>();
  const hadBye = new Set<string>();
  for (const round of prior) {
    for (const p of round) {
      if (p.b === null) hadBye.add(p.a);
      else met.add(pairKey(p.a, p.b));
    }
  }

  const points = new Map(standing.map((s) => [s.uid, s.matchPoints]));
  let pool = standing.map((s) => s.uid);

  // §7: the bye goes to the lowest-standing player who has not already had one.
  let bye: string | null = null;
  if (pool.length % 2 === 1) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!hadBye.has(pool[i]!)) { bye = pool[i]!; break; }
    }
    // Everyone has sat out once already: the bottom of the table takes a second.
    bye ??= pool[pool.length - 1]!;
    pool = pool.filter((u) => u !== bye);
  }

  // Repeat-free if one exists at all; a rematch only when the field leaves no
  // choice, which the round cap above is designed to prevent.
  const paired = solveSwiss(pool, points, met, false) ?? solveSwiss(pool, points, met, true) ?? [];
  const pairings: Pairing[] = paired.map(([a, b]) => ({ a, b, outcome: null }));
  if (bye !== null) pairings.push({ a: bye, b: null, outcome: null });
  return pairings;
}

/** Exhaustive pairing of a standing-ordered pool, best candidate first. */
function solveSwiss(
  pool: readonly string[],
  points: ReadonlyMap<string, number>,
  met: ReadonlySet<string>,
  allowRepeats: boolean,
): [string, string][] | null {
  if (pool.length === 0) return [];
  const a = pool[0]!;
  const rest = pool.slice(1);
  for (const b of swissPreference(a, rest, points)) {
    if (!allowRepeats && met.has(pairKey(a, b))) continue;
    const sub = solveSwiss(rest.filter((x) => x !== b), points, met, allowRepeats);
    if (sub) return [[a, b], ...sub];
  }
  return null;
}

/**
 * Who `a` should ideally play, best first: the fold within their own score
 * group (top half against bottom half), then outwards through the group, then
 * players from other groups — the float.
 */
function swissPreference(a: string, rest: readonly string[], points: ReadonlyMap<string, number>): string[] {
  const mine = points.get(a) ?? 0;
  const same = rest.filter((x) => (points.get(x) ?? 0) === mine);
  const others = rest.filter((x) => (points.get(x) ?? 0) !== mine);
  // `a` heads its group, so the fold partner is the top of the bottom half.
  const ideal = Math.floor((same.length + 1) / 2) - 1;
  const distance = (x: string) => Math.abs(same.indexOf(x) - ideal);
  const byFold = [...same].sort((x, y) => distance(x) - distance(y) || same.indexOf(x) - same.indexOf(y));
  return [...byFold, ...others];
}

// ---------------------------------------------------------------------------
// Double elimination (§6.3) — slice 6
//
// The schedule, worked out by hand before any of this was written (risk T-2):
//
//   t          1     2       3       4     5     6
//   S=8,k=3    W1    W2      W3      -     -     GF
//              -     L1      L2      L3    L4    -
//
// Under D-38 one card per round is shared by everyone still in, so a winners
// round and a losers round run in the SAME tournament round. That is what makes
// the whole thing 2k rounds rather than 3k−1, and it is the one place where
// duplicate scoring buys something a conventional bracket cannot have.
// ---------------------------------------------------------------------------

/** 2·log2(S). A grand-final reset, if enabled and needed, adds one more. */
export function doubleElimRounds(players: number): number {
  return 2 * singleElimRounds(players);
}

export interface DoubleElimSlot {
  /** Winners-bracket round to play this tournament round, if any. */
  wb: number | null;
  /** Losers-bracket round to play this tournament round, if any. */
  lb: number | null;
  grandFinal: boolean;
}

/** What tournament round `n` consists of, for a bracket of `2^k`. */
export function doubleElimSlot(k: number, n: number): DoubleElimSlot {
  return {
    wb: n <= k ? n : null,
    lb: n >= 2 && n <= 2 * k - 1 ? n - 1 : null,
    // 2k+1 is the reset: only reached when `grandFinalReset` is on AND the
    // losers champion won the first one, which is what extends `roundCount`.
    grandFinal: n === 2 * k || n === 2 * k + 1,
  };
}

/**
 * Which winners round drops into losers round `j`, or null when `j` is a
 * "minor" round in which the survivors simply play each other.
 *
 *   j = 1      ← winners round 1
 *   j even     ← winners round j/2 + 1
 *   j odd ≥ 3  ← nothing
 */
export function dropdownSource(j: number): number | null {
  if (j === 1) return 1;
  return j % 2 === 0 ? j / 2 + 1 : null;
}

/** How many fixtures each player has lost, folded over the round log. */
export function lossesOf(uids: readonly string[], prior: readonly (readonly Pairing[])[]): Map<string, number> {
  const out = new Map(uids.map((u) => [u, 0]));
  for (const round of prior) {
    for (const p of round) {
      if (p.b === null || p.outcome === null || p.outcome === "draw") continue;
      const loser = p.outcome === "a" ? p.b : p.a;
      out.set(loser, (out.get(loser) ?? 0) + 1);
    }
  }
  return out;
}

const winnerOf = (p: Pairing): string | null =>
  p.b === null ? p.a : p.outcome === "a" ? p.a : p.outcome === "b" ? p.b : null;
const loserOf = (p: Pairing): string | null =>
  p.b === null || p.outcome === null || p.outcome === "draw" ? null : p.outcome === "a" ? p.b : p.a;

const inBracket = (round: readonly Pairing[] | undefined, half: "w" | "l" | "gf") =>
  (round ?? []).filter((p) => p.bracket === half);

/**
 * Pair a double-elimination round. Every bracket question is answered by
 * folding `prior` rather than by stored bookkeeping (D-41), which is why each
 * fixture carries the half it belonged to.
 */
export function doubleElimPairings(seeds: readonly string[], n: number, prior: readonly (readonly Pairing[])[]): Pairing[] {
  const k = singleElimRounds(seeds.length);
  const slot = doubleElimSlot(k, n);
  const met = metSet(prior);
  const seedRank = new Map(seeds.map((u, i) => [u, i]));
  const bySeed = (list: readonly string[]) => [...list].sort((x, y) => (seedRank.get(x) ?? 0) - (seedRank.get(y) ?? 0));

  const pairings: Pairing[] = [];

  // --- winners bracket: exactly the single-elimination bracket ---
  if (slot.wb !== null) {
    const wbPrior = prior.map((round) => inBracket(round, "w"));
    const wb = slot.wb === 1
      ? singleElimPairings(seeds, 1, [])
      : singleElimPairings(seeds, slot.wb, wbPrior);
    pairings.push(...wb.map((p) => ({ ...p, bracket: "w" as const })));
  }

  // --- losers bracket ---
  if (slot.lb !== null) {
    const j = slot.lb;
    const source = dropdownSource(j);
    // Survivors of the previous losers round; for j = 1 there is no previous one.
    const survivors = j === 1 ? [] : inBracket(prior[n - 2], "l").map(winnerOf).filter((u): u is string => u !== null);
    const drops = source === null ? [] : bySeed(inBracket(prior[source - 1], "w").map(loserOf).filter((u): u is string => u !== null));

    const lb = pairLosersRound(bySeed(survivors), drops, met, seedRank);
    pairings.push(...lb.map((p) => ({ ...p, bracket: "l" as const })));
  }

  // --- grand final ---
  if (slot.grandFinal && n === 2 * k + 1) {
    // The reset: the same two players, one more time, with the bracket's
    // memory of who was unbeaten now spent.
    const first = (prior[2 * k - 1] ?? []).find((p) => p.bracket === "gf" && p.b !== null);
    if (first) pairings.push({ a: first.a, b: first.b, outcome: null, bracket: "gf" });
    return pairings;
  }
  if (slot.grandFinal) {
    const losses = lossesOf(seeds, prior);
    const wbChampion = seeds.find((u) => (losses.get(u) ?? 0) === 0) ?? null;
    // Whoever came through the LAST losers round, which is tournament round
    // 2k−1 and therefore index 2k−2. With k = 1 there are no losers rounds at
    // all, and the beaten finalist is simply the other player.
    const lbChampion = inBracket(prior[2 * k - 2], "l").map(winnerOf).find((u): u is string => u !== null)
      ?? seeds.find((u) => (losses.get(u) ?? 0) === 1) ?? null;
    if (wbChampion && lbChampion) pairings.push({ a: wbChampion, b: lbChampion, outcome: null, bracket: "gf" });
    else if (wbChampion) pairings.push({ a: wbChampion, b: null, outcome: null, bracket: "gf" });
  }

  return pairings;
}

/**
 * One losers-bracket round: survivors against the players who just dropped out
 * of the winners bracket, then whatever is left over folded among itself.
 *
 * The design sketched a fixed index mapping with a reversal on alternating
 * rounds. That is the thing T-2 says is subtly wrong in most implementations,
 * and it stops being defined at all once byes make the two sides uneven — which
 * happens for every field that is not a power of two. So the pairing is chosen
 * by search instead: prefer survivor-against-dropdown and the conventional
 * fold, and reject any fixture that repeats one already played, unless the pool
 * leaves no alternative.
 *
 * A rematch at the losers final or the grand final is normal and expected — the
 * beaten winners-bracket finalist has to enter somewhere. It is the EARLY
 * rematch, where the player who just knocked you down is handed to you again,
 * that this exists to prevent.
 */
function pairLosersRound(
  survivors: readonly string[],
  drops: readonly string[],
  met: ReadonlySet<string>,
  seedRank: ReadonlyMap<string, number>,
): Pairing[] {
  const pool = [...survivors, ...drops];
  if (pool.length === 0) return [];

  const survivorSet = new Set(survivors);
  const cross = (a: string, b: string) => survivorSet.has(a) !== survivorSet.has(b);
  const attempt = (playing: readonly string[], allowRepeat: boolean) =>
    solveBracket(playing, allowRepeat ? new Set() : met, cross, true) ??
    solveBracket(playing, allowRepeat ? new Set() : met, cross, false);

  if (pool.length % 2 === 0) {
    return (attempt(pool, false) ?? attempt(pool, true) ?? []).map(([a, b]) => ({ a, b, outcome: null }));
  }

  // An odd pool means a bye upstream. The best seed left is the conventional
  // choice, but taking it can strand two players who have already met — which
  // is what happened the first time this ran on a five-player bracket. So the
  // candidates are tried in seed order and the first one that leaves a
  // repeat-free draw wins; only if none does, the convention stands.
  const candidates = [...pool].sort((x, y) => (seedRank.get(x) ?? 0) - (seedRank.get(y) ?? 0));
  for (const bye of candidates) {
    const solved = attempt(pool.filter((u) => u !== bye), false);
    if (!solved) continue;
    const out: Pairing[] = solved.map(([a, b]) => ({ a, b, outcome: null }));
    out.push({ a: bye, b: null, outcome: null });
    return out;
  }

  const bye = candidates[0]!;
  const solved = attempt(pool.filter((u) => u !== bye), true) ?? [];
  const out: Pairing[] = solved.map(([a, b]) => ({ a, b, outcome: null }));
  out.push({ a: bye, b: null, outcome: null });
  return out;
}

/**
 * Exhaustive pairing of a losers-bracket pool. `preferCross` asks for
 * survivor-against-dropdown first; dropping it is the fallback when the two
 * sides are uneven. Pools here are at most six a side, so enumeration is free.
 */
function solveBracket(
  pool: readonly string[],
  met: ReadonlySet<string>,
  cross: (a: string, b: string) => boolean,
  requireCross: boolean,
): [string, string][] | null {
  if (pool.length === 0) return [];
  const a = pool[0]!;
  const rest = pool.slice(1);
  // Conventional fold first: top of the pool against the top of its other half.
  const half = Math.floor(rest.length / 2);
  const order = [...rest].sort((x, y) => Math.abs(rest.indexOf(x) - half) - Math.abs(rest.indexOf(y) - half));
  for (const b of order) {
    if (requireCross && !cross(a, b)) continue;
    if (met.has(pairKey(a, b))) continue;
    const sub = solveBracket(rest.filter((x) => x !== b), met, cross, requireCross);
    if (sub) return [[a, b], ...sub];
  }
  return null;
}

/** Every fixture already played, as unordered keys. */
function metSet(prior: readonly (readonly Pairing[])[]): Set<string> {
  const met = new Set<string>();
  for (const round of prior) for (const p of round) if (p.b !== null) met.add(pairKey(p.a, p.b));
  return met;
}

/** How many defeats end a tournament for you under `format`. */
export function livesFor(format: Format): number {
  return format === "double_elim" ? 2 : 1;
}

/** Whether a format knocks players out at all. */
export function isKnockout(format: Format): boolean {
  return format === "single_elim" || format === "double_elim";
}
