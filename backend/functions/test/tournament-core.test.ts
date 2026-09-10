/**
 * Pairing-format primitives (docs/06-tournaments.md §6.2, §7). Pure.
 *
 * Two kinds of test here, and both matter:
 *
 *  - a **hand-checkable four-player league**, in the style of
 *    test/standings.test.ts, written out in full below so a human can redo the
 *    table on paper and argue with it;
 *  - an **exhaustive property check** of the circle method for every field size
 *    it will ever be handed, because "every pair meets exactly once" is the one
 *    claim about a round robin that is tedious to verify by eye and fatal to
 *    get wrong.
 *
 * The odd-count case gets both treatments. The roadmap's standing risk list
 * says odd counts are where these engines actually break.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsError } from "firebase-functions/v2/https";
import {
  assertPairableSize, cardWinner, competitionRanks, DEFAULT_MATCH_POINTS, matchRecords,
  MAX_PAIRED_PARTICIPANTS, pairingsFor, resolvePairings, roundCountFor, roundRobinPairings, roundRobinRounds,
  type Pairing,
} from "../src/lib/tournament-core";
import type { RoundResultRow, Tiebreak } from "../src/lib/tournament";

const POINTS_TIME: Tiebreak["chain"] = ["points", "time"];
const POINTS_ONLY: Tiebreak["chain"] = ["points"];

const res = (points: number, elapsedMs: number, played = true): RoundResultRow =>
  ({ points, elapsedMs, guessCount: 3, played });

// ---------------------------------------------------------------------------
// The circle method (§7)
// ---------------------------------------------------------------------------

/** Every fixture across the whole schedule, as unordered "x|y" keys. */
function schedule(players: string[]): { rounds: Pairing[][]; met: string[]; byes: string[] } {
  const rounds: Pairing[][] = [];
  for (let n = 1; n <= roundRobinRounds(players.length); n++) rounds.push(roundRobinPairings(players, n));
  const met: string[] = [];
  const byes: string[] = [];
  for (const r of rounds) {
    for (const p of r) {
      if (p.b === null) byes.push(p.a);
      else met.push([p.a, p.b].sort().join("|"));
    }
  }
  return { rounds, met, byes };
}

test("circle method: every pair meets exactly once, nobody plays twice in a round, for 2..12 players", () => {
  for (let n = 2; n <= MAX_PAIRED_PARTICIPANTS; n++) {
    const players = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    const { rounds, met, byes } = schedule(players);

    assert.equal(rounds.length, n % 2 === 0 ? n - 1 : n, `${n} players: round count`);

    // Every unordered pair, exactly once.
    const expected = new Set<string>();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expected.add([players[i]!, players[j]!].sort().join("|"));
    assert.equal(met.length, expected.size, `${n} players: fixture count (no repeats, none missing)`);
    assert.deepEqual(new Set(met), expected, `${n} players: the set of fixtures`);
    assert.equal(new Set(met).size, met.length, `${n} players: no pair meets twice`);

    // Within one round nobody appears twice.
    for (const r of rounds) {
      const seen = r.flatMap((p) => (p.b === null ? [p.a] : [p.a, p.b]));
      assert.equal(new Set(seen).size, seen.length, `${n} players: a player is double-booked in one round`);
    }

    // Byes: none when even, exactly one each when odd.
    if (n % 2 === 0) assert.deepEqual(byes, [], `${n} players: an even field has no byes`);
    else assert.deepEqual([...byes].sort(), [...players].sort(), `${n} players: every player gets exactly one bye`);
  }
});

// ---------------------------------------------------------------------------
// Fixture: five players, the odd case, written out (§7)
//
//   Seeds A B C D E. Five rounds, and the ghost gives one player a bye each.
//
//     round 1   A bye    B–E   C–D
//     round 2   D bye    A–E   B–C
//     round 3   B bye    A–D   E–C
//     round 4   E bye    A–C   D–B
//     round 5   C bye    A–B   D–E
//
//   Ten fixtures for ten possible pairs, five byes for five players.
// ---------------------------------------------------------------------------

test("the five-player fixture is exactly the schedule written in the comment", () => {
  const seeds = ["A", "B", "C", "D", "E"];
  const asText = (n: number) =>
    roundRobinPairings(seeds, n).map((p) => (p.b === null ? `${p.a} bye` : `${p.a}-${p.b}`)).join(" ");

  assert.equal(asText(1), "A bye B-E C-D");
  assert.equal(asText(2), "A-E D bye B-C");
  assert.equal(asText(3), "A-D E-C B bye");
  assert.equal(asText(4), "A-C D-B E bye");
  assert.equal(asText(5), "A-B C bye D-E");
});

test("a round outside 1..rounds is a programming error, not a silent empty draw", () => {
  assert.throws(() => roundRobinPairings(["A", "B", "C", "D"], 0), RangeError);
  assert.throws(() => roundRobinPairings(["A", "B", "C", "D"], 4), RangeError); // 4 players => 3 rounds
  assert.throws(() => roundRobinPairings(["A", "B", "C"], 4), RangeError);      // 3 players => 3 rounds
});

test("a format that pairs nobody returns no fixtures, and keeps its configured round count", () => {
  assert.deepEqual(pairingsFor("free_for_all", ["A", "B", "C"], 1), []);
  assert.equal(roundCountFor("free_for_all", 1, 7), 1);
  assert.equal(roundCountFor("free_for_all", 4, 7), 4);
  // A league's length is the field, not the preset.
  assert.equal(roundCountFor("round_robin", 1, 8), 7);
  assert.equal(roundCountFor("round_robin", 1, 5), 5);
});

// ---------------------------------------------------------------------------
// cardWinner (§6.2)
// ---------------------------------------------------------------------------

test("cardWinner: more points wins, and less time breaks a points tie", () => {
  assert.equal(cardWinner(res(15, 90_000), res(10, 10_000), POINTS_TIME), "a");
  assert.equal(cardWinner(res(10, 90_000), res(15, 10_000), POINTS_TIME), "b");
  assert.equal(cardWinner(res(12, 30_000), res(12, 40_000), POINTS_TIME), "a");
  assert.equal(cardWinner(res(12, 40_000), res(12, 30_000), POINTS_TIME), "b");
});

test("cardWinner: identical on every comparator in the chain is a draw", () => {
  assert.equal(cardWinner(res(12, 40_000), res(12, 40_000), POINTS_TIME), "draw");
  // With time out of the chain a points tie is a draw even at different speeds,
  // which is what leaves something for sudden death to resolve (D-50).
  assert.equal(cardWinner(res(12, 10_000), res(12, 99_000), POINTS_ONLY), "draw");
});

test("turning up beats not turning up, even though a forfeit's 0 ms is the best possible time", () => {
  const forfeit = res(0, 0, false);
  // The trap: a forfeit is stored as 0 points in 0 ms (FR-5.7). Someone who
  // played and scored 0 in a minute ties on points and LOSES on time — handing
  // the win to a player who never opened the card.
  assert.equal(cardWinner(res(0, 60_000), forfeit, POINTS_TIME), "a");
  assert.equal(cardWinner(forfeit, res(0, 60_000), POINTS_TIME), "b");
  // Even scoring zero beats a forfeit; two no-shows are a draw.
  assert.equal(cardWinner(forfeit, forfeit, POINTS_TIME), "draw");
});

// ---------------------------------------------------------------------------
// competitionRanks (§6.2)
// ---------------------------------------------------------------------------

test("competitionRanks: ties share a rank and the next distinct row skips (1, 2, 2, 4)", () => {
  const rows = [{ k: [9, 40] }, { k: [4, 30] }, { k: [4, 30] }, { k: [1, 99] }];
  assert.deepEqual(competitionRanks(rows, (r) => r.k), [1, 2, 2, 4]);
});

test("competitionRanks: a later key only decides when the earlier ones are level", () => {
  // Same first key, second key separates. Third never consulted.
  const rows = [{ k: [3, 10, 0] }, { k: [3, 20, 0] }, { k: [5, 1, 0] }];
  assert.deepEqual(competitionRanks(rows, (r) => r.k), [3, 2, 1]);
});

// ---------------------------------------------------------------------------
// Fixture: a four-player league, written out so it can be redone by hand
//
//   Seeds A B C D. Three rounds; every pair meets once.
//
//     round 1   A–D   B–C          round 2   A–C   D–B        round 3   A–B   C–D
//
//   Card points (and elapsed ms) per round:
//
//              round 1            round 2            round 3
//     A        15 / 100 000       14 / 100 000       13 / 100 000
//     B        12 /  50 000        8 /  60 000        7 /  40 000
//     C        12 /  50 000        9 /  80 000       16 /  30 000
//     D        10 /  90 000       11 /  70 000        6 /  20 000
//
//   Fixtures resolve on points, except B–C in round 1: 12 points each in
//   50 000 ms each, so the chain runs out and it is a draw.
//
//     round 1   A beats D    B draws C
//     round 2   A beats C    D beats B
//     round 3   A beats B    C beats D
//
//   Match points at 3 / 1 / 0:
//     A  W W W  = 9    card 15+14+13 = 42
//     C  D L W  = 4    card 12+ 9+16 = 37
//     D  L W L  = 3    card 10+11+ 6 = 27
//     B  D L L  = 1    card 12+ 8+ 7 = 27
//
//   Table: A 1st, C 2nd, D 3rd, B 4th.
//
//   The point of the numbers: B and D have identical card points (27) and are
//   split by match points alone, while C finishes above D on match points
//   despite... and A tops both columns. Card points do not decide the table.
// ---------------------------------------------------------------------------

const SEEDS = ["A", "B", "C", "D"];

const CARDS: Record<string, RoundResultRow>[] = [
  { A: res(15, 100_000), B: res(12, 50_000), C: res(12, 50_000), D: res(10, 90_000) },
  { A: res(14, 100_000), B: res(8, 60_000), C: res(9, 80_000), D: res(11, 70_000) },
  { A: res(13, 100_000), B: res(7, 40_000), C: res(16, 30_000), D: res(6, 20_000) },
];

const RESOLVED = CARDS.map((results, i) =>
  resolvePairings(roundRobinPairings(SEEDS, i + 1), results, POINTS_TIME, "win"));

test("the four-player fixture resolves to the outcomes written in the comment", () => {
  const text = RESOLVED.map((r) =>
    r.map((p) => `${p.a}${p.outcome === "draw" ? "=" : p.outcome === "a" ? ">" : "<"}${p.b}`).join(" "));
  assert.deepEqual(text, ["A>D B=C", "A>C D>B", "A>B C>D"]);
});

test("the four-player league table is A 9, C 4, D 3, B 1 on match points", () => {
  const recs = matchRecords(SEEDS, RESOLVED, DEFAULT_MATCH_POINTS);
  assert.deepEqual(recs.get("A"), { matchPoints: 9, won: 3, drawn: 0, lost: 0, byes: 0 });
  assert.deepEqual(recs.get("C"), { matchPoints: 4, won: 1, drawn: 1, lost: 1, byes: 0 });
  assert.deepEqual(recs.get("D"), { matchPoints: 3, won: 1, drawn: 0, lost: 2, byes: 0 });
  assert.deepEqual(recs.get("B"), { matchPoints: 1, won: 0, drawn: 1, lost: 2, byes: 0 });

  // Every fixture awarded points to exactly two players, so the totals must add
  // up to 3 per decisive fixture and 2 per draw: 5 decisive + 1 draw = 17.
  const total = SEEDS.reduce((n, u) => n + recs.get(u)!.matchPoints, 0);
  assert.equal(total, 5 * 3 + 1 * 2);
});

test("card points do not decide the table: B and D tie on 27 and are split by fixtures", () => {
  const cardTotal = (u: string) => CARDS.reduce((n, r) => n + r[u]!.points, 0);
  assert.equal(cardTotal("B"), 27);
  assert.equal(cardTotal("D"), 27);
  const recs = matchRecords(SEEDS, RESOLVED, DEFAULT_MATCH_POINTS);
  assert.ok(recs.get("D")!.matchPoints > recs.get("B")!.matchPoints);
});

test("an open round decides nothing: unresolved pairings contribute no match points", () => {
  const open = roundRobinPairings(SEEDS, 1); // outcome: null throughout
  const recs = matchRecords(SEEDS, [open], DEFAULT_MATCH_POINTS);
  for (const u of SEEDS) assert.deepEqual(recs.get(u), { matchPoints: 0, won: 0, drawn: 0, lost: 0, byes: 0 });
});

test("match points are configurable: 2/1/0 changes the table, not the outcomes", () => {
  const recs = matchRecords(SEEDS, RESOLVED, { win: 2, draw: 1, loss: 0 });
  assert.equal(recs.get("A")!.matchPoints, 6);
  assert.equal(recs.get("C")!.matchPoints, 3);
});

// ---------------------------------------------------------------------------
// Byes (§7)
// ---------------------------------------------------------------------------

test("a bye is credited as a win and counted separately, so a record never hides one", () => {
  const pairings = roundRobinPairings(["A", "B", "C"], 1);
  const resolved = resolvePairings(pairings, { A: res(6, 1000), B: res(5, 1000), C: res(4, 1000) }, POINTS_TIME, "win");
  const bye = resolved.find((p) => p.b === null)!;
  assert.equal(bye.outcome, "a");

  const recs = matchRecords(["A", "B", "C"], [resolved], DEFAULT_MATCH_POINTS);
  assert.equal(recs.get(bye.a)!.byes, 1);
  assert.equal(recs.get(bye.a)!.won, 1);
  assert.equal(recs.get(bye.a)!.matchPoints, 3);
});

test("byeCredit 'draw' hands the odd player a point instead of three", () => {
  const pairings = roundRobinPairings(["A", "B", "C"], 1);
  const resolved = resolvePairings(pairings, {}, POINTS_TIME, "draw");
  const bye = resolved.find((p) => p.b === null)!;
  assert.equal(bye.outcome, "draw");
  const recs = matchRecords(["A", "B", "C"], [resolved], DEFAULT_MATCH_POINTS);
  assert.equal(recs.get(bye.a)!.matchPoints, 1);
  assert.equal(recs.get(bye.a)!.drawn, 1);
  assert.equal(recs.get(bye.a)!.byes, 1);
});

test("a missing result is a forfeit, not a crash: both absent is a draw, one present wins", () => {
  const pairings: Pairing[] = [{ a: "A", b: "B", outcome: null }];
  assert.equal(resolvePairings(pairings, {}, POINTS_TIME, "win")[0]!.outcome, "draw");
  assert.equal(resolvePairings(pairings, { A: res(1, 5000) }, POINTS_TIME, "win")[0]!.outcome, "a");
  assert.equal(resolvePairings(pairings, { B: res(1, 5000) }, POINTS_TIME, "win")[0]!.outcome, "b");
});

test("a uid outside the field is ignored rather than inventing a table row", () => {
  const stray: Pairing[] = [{ a: "A", b: "ghost-uid", outcome: "a" }];
  const recs = matchRecords(["A"], [stray], DEFAULT_MATCH_POINTS);
  assert.equal(recs.size, 1);
  assert.equal(recs.get("A")!.won, 1);
});

// ---------------------------------------------------------------------------
// Size guard (§6.2)
// ---------------------------------------------------------------------------

test("a pairing format refuses a field it cannot schedule; free-for-all takes any", () => {
  assert.doesNotThrow(() => assertPairableSize("round_robin", MAX_PAIRED_PARTICIPANTS));
  assert.doesNotThrow(() => assertPairableSize("free_for_all", 200));
  assert.throws(
    () => assertPairableSize("round_robin", MAX_PAIRED_PARTICIPANTS + 1),
    (e: unknown) => e instanceof HttpsError && (e.details as { code: string }).code === "invalid-argument",
  );
  // 200 players would schedule 199 rounds — most of a year at one round a day.
  assert.equal(roundRobinRounds(200), 199);
});
