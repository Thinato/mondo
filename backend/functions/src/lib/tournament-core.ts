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
 * takes it from the preset; round robin derives it from the field, which is
 * why it can only be known at start, once the participant list is frozen.
 */
export function roundCountFor(format: Format, configuredRounds: number, players: number): number {
  return format === "round_robin" ? roundRobinRounds(players) : configuredRounds;
}

/** Pairings for round `n`, or [] for a format that pairs nobody. */
export function pairingsFor(format: Format, seeds: readonly string[], n: number): Pairing[] {
  return format === "round_robin" ? roundRobinPairings(seeds, n) : [];
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
