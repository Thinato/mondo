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
  alive, allowsDraws, applyTieResults, assertPairableSize, bracketOrder, bracketSize, cardWinner,
  competitionRanks, DEFAULT_MATCH_POINTS, drawnPairs, matchRecords, MAX_PAIRED_PARTICIPANTS,
  pairingsFor, resolvePairings, roundCountFor, roundRobinPairings, roundRobinRounds,
  doubleElimPairings, doubleElimRounds, doubleElimSlot, dropdownSource, lossesOf,
  singleElimPairings, singleElimRounds, survivedRounds, swissPairings, swissRounds, type Pairing,
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

// ---------------------------------------------------------------------------
// Single elimination (§6.3) — slice 4
// ---------------------------------------------------------------------------

test("the bracket is the next power of two, and its depth is log2 of that", () => {
  assert.deepEqual([2, 3, 4, 5, 8, 9, 12].map(bracketSize), [2, 4, 4, 8, 8, 16, 16]);
  assert.deepEqual([2, 3, 4, 5, 8, 9, 12].map(singleElimRounds), [1, 2, 2, 3, 3, 4, 4]);
});

test("bracketOrder is the standard recursive seeding", () => {
  assert.deepEqual(bracketOrder(2), [1, 2]);
  assert.deepEqual(bracketOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(bracketOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test("seeding well is rewarded: the top 2^m seeds are always in different eighths, quarters, halves", () => {
  // The property the whole bracket order exists for. If seeds 1 and 2 could
  // land in the same half, the final would be decided in the semis.
  for (const size of [2, 4, 8, 16, 32]) {
    const order = bracketOrder(size);
    const slotOf = new Map(order.map((seed, slot) => [seed, slot]));
    for (let block = size / 2; block >= 1; block /= 2) {
      const top = size / block;                       // how many seeds must be separated
      const blocks = new Set<number>();
      for (let seed = 1; seed <= top; seed++) blocks.add(Math.floor(slotOf.get(seed)! / block));
      assert.equal(blocks.size, top, `size ${size}: seeds 1..${top} must be in ${top} distinct blocks of ${block}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Fixture: five players, the odd knockout, written out
//
//   Seeds A B C D E. The bracket is 8, so there are 3 byes and they go to the
//   top three seeds — the conventional reward, and the advantage the odd
//   players get (§7).
//
//     round 1   A bye   D–E   B bye   C bye
//     round 2   A–D     B–C                    (D beat E)
//     round 3   A–B                            (A beat D, B beat C)
//
//   Survived: A 3 (champion), B 2, C 1, D 1, E 0.
// ---------------------------------------------------------------------------

const BRACKET = ["A", "B", "C", "D", "E"];

test("the five-player bracket is exactly the draw written in the comment", () => {
  const show = (ps: Pairing[]) => ps.map((p) => (p.b === null ? `${p.a} bye` : `${p.a}-${p.b}`)).join(" ");
  const r1 = singleElimPairings(BRACKET, 1, []);
  assert.equal(show(r1), "A bye D-E B bye C bye");
  assert.equal(r1.filter((p) => p.b === null).length, bracketSize(5) - 5, "S - n byes");

  const decided1 = r1.map((p) => ({ ...p, outcome: "a" as const })); // byes and D over E
  const r2 = singleElimPairings(BRACKET, 2, [decided1]);
  assert.equal(show(r2), "A-D B-C");

  const decided2 = r2.map((p) => ({ ...p, outcome: "a" as const })); // A over D, B over C
  const r3 = singleElimPairings(BRACKET, 3, [decided1, decided2]);
  assert.equal(show(r3), "A-B");
});

test("byes land on the top seeds, for every field size from 2 to 12", () => {
  for (let n = 2; n <= 12; n++) {
    const seeds = Array.from({ length: n }, (_, i) => `s${i + 1}`);
    const r1 = singleElimPairings(seeds, 1, []);
    const byes = r1.filter((p) => p.b === null).map((p) => p.a);
    assert.equal(byes.length, bracketSize(n) - n, `${n} players: bye count`);
    // Whoever got a bye must be among the top `byes.length` seeds.
    const topSeeds = seeds.slice(0, byes.length);
    assert.deepEqual([...byes].sort(), [...topSeeds].sort(), `${n} players: byes must go to the top seeds`);
    // Nobody is scheduled twice, and everybody appears exactly once.
    const seen = r1.flatMap((p) => (p.b === null ? [p.a] : [p.a, p.b]));
    assert.deepEqual([...seen].sort(), [...seeds].sort(), `${n} players: round one must include everybody once`);
  }
});

test("a knockout cannot be paired past an undecided fixture", () => {
  const r1 = singleElimPairings(["A", "B", "C", "D"], 1, []);
  assert.throws(() => singleElimPairings(["A", "B", "C", "D"], 2, [r1]), /undecided/);
  assert.throws(() => singleElimPairings(["A", "B", "C", "D"], 2, []), RangeError);
});

test("alive and survivedRounds fold the bracket rather than storing a flag", () => {
  const r1 = singleElimPairings(BRACKET, 1, []).map((p) => ({ ...p, outcome: "a" as const }));
  const r2 = singleElimPairings(BRACKET, 2, [r1]).map((p) => ({ ...p, outcome: "a" as const }));
  const r3 = singleElimPairings(BRACKET, 3, [r1, r2]).map((p) => ({ ...p, outcome: "a" as const }));
  const rounds = [r1, r2, r3];

  assert.deepEqual([...alive(BRACKET, rounds)], ["A"], "one player standing");
  const s = survivedRounds(BRACKET, rounds);
  assert.deepEqual(BRACKET.map((u) => [u, s.get(u)]), [["A", 3], ["B", 2], ["C", 1], ["D", 1], ["E", 0]]);
});

test("a bye never knocks anybody out, and consolation play cannot eliminate you twice", () => {
  const bye: Pairing[] = [{ a: "A", b: null, outcome: "a" }];
  assert.deepEqual([...alive(["A", "B"], [bye])], ["A", "B"], "an unpaired player loses nothing");
  // Losing in round 1 and again in round 3 (consolation) still reads as round 1.
  const r1: Pairing[] = [{ a: "A", b: "B", outcome: "a" }];
  const r3: Pairing[] = [{ a: "A", b: "B", outcome: "a" }];
  assert.equal(survivedRounds(["A", "B"], [r1, [], r3]).get("B"), 0);
});

// ---------------------------------------------------------------------------
// Ties the clock cannot settle (§6.4, D-50)
// ---------------------------------------------------------------------------

test("only a table can hold a draw; a knockout must settle it", () => {
  assert.equal(allowsDraws("round_robin"), true);
  assert.equal(allowsDraws("swiss"), true);
  assert.equal(allowsDraws("single_elim"), false);
  assert.equal(allowsDraws("double_elim"), false);
});

test("drawnPairs finds the level fixtures and ignores byes", () => {
  const ps: Pairing[] = [
    { a: "A", b: "B", outcome: "draw" },
    { a: "C", b: "D", outcome: "a" },
    { a: "E", b: null, outcome: "a" },
    { a: "F", b: "G", outcome: "draw" },
  ];
  assert.deepEqual(drawnPairs(ps), [["A", "B"], ["F", "G"]]);
});

test("sudden death decides the level fixture and leaves every other one alone", () => {
  const ps: Pairing[] = [{ a: "A", b: "B", outcome: "draw" }, { a: "C", b: "D", outcome: "a" }];
  const after = applyTieResults(ps, { A: res(6, 1000), B: res(4, 900) }, POINTS_ONLY,
    { exhausted: false, seedOf: () => 1 });
  assert.equal(after[0]!.outcome, "a", "A scored more on the sudden-death card");
  assert.equal(after[1]!.outcome, "a", "an already-decided fixture is untouched");
});

test("still level after the card, and another challenge follows", () => {
  const ps: Pairing[] = [{ a: "A", b: "B", outcome: "draw" }];
  const after = applyTieResults(ps, { A: res(6, 1000), B: res(6, 9999) }, POINTS_ONLY,
    { exhausted: false, seedOf: () => 1 });
  assert.equal(after[0]!.outcome, "draw", "time is not in the chain, so this is still level");
  assert.deepEqual(drawnPairs(after), [["A", "B"]]);
});

test("the safety valve: once sudden death runs out, the better seed takes it", () => {
  const ps: Pairing[] = [{ a: "A", b: "B", outcome: "draw" }];
  const seeds: Record<string, number> = { A: 3, B: 2 };
  const after = applyTieResults(ps, { A: res(6, 1), B: res(6, 1) }, POINTS_ONLY,
    { exhausted: true, seedOf: (u) => seeds[u]! });
  assert.equal(after[0]!.outcome, "b", "B is seed 2, A is seed 3");
  assert.deepEqual(drawnPairs(after), [], "and nothing is left level, so the round can advance");
});

test("a player who skipped the sudden-death card loses it, however level they were", () => {
  const ps: Pairing[] = [{ a: "A", b: "B", outcome: "draw" }];
  const after = applyTieResults(ps, { A: res(0, 60_000) }, POINTS_ONLY, { exhausted: false, seedOf: () => 1 });
  assert.equal(after[0]!.outcome, "a", "B never opened it; turning up wins");
});

// ---------------------------------------------------------------------------
// Swiss (§6.3) — slice 5
//
// The claims that matter, and none of them are checkable by eye:
//   - nobody meets the same opponent twice
//   - nobody sits out twice while somebody else has not sat out at all
//   - winners are paired with winners
// So they are simulated over full tournaments and asserted as properties.
// ---------------------------------------------------------------------------

/** Run a whole Swiss, deciding every fixture with `decide`. */
function runSwiss(
  uids: string[],
  rounds: number,
  decide: (a: string, b: string, round: number) => "a" | "b" | "draw",
): Pairing[][] {
  const history: Pairing[][] = [];
  for (let n = 1; n <= rounds; n++) {
    const recs = matchRecords(uids, history, DEFAULT_MATCH_POINTS);
    const standing = [...uids]
      .sort((x, y) => recs.get(y)!.matchPoints - recs.get(x)!.matchPoints || uids.indexOf(x) - uids.indexOf(y))
      .map((uid) => ({ uid, matchPoints: recs.get(uid)!.matchPoints }));
    const ps = swissPairings(standing, history);
    history.push(ps.map((p) => ({ ...p, outcome: p.b === null ? "a" : decide(p.a, p.b, n) })));
  }
  return history;
}

const meetings = (history: Pairing[][]) =>
  history.flat().filter((p) => p.b !== null).map((p) => [p.a, p.b].sort().join("|"));
const byesIn = (history: Pairing[][]) => history.flat().filter((p) => p.b === null).map((p) => p.a);

test("a Swiss never runs longer than there are opponents to play", () => {
  assert.equal(swissRounds(4, 8), 4);
  assert.equal(swissRounds(4, 4), 3, "four players have three possible opponents");
  assert.equal(swissRounds(4, 2), 1);
  assert.equal(swissRounds(9, 6), 5);
  assert.equal(roundCountFor("swiss", 4, 4), 3);
});

test("nobody meets the same opponent twice, for every field from 2 to 12", () => {
  for (let n = 2; n <= MAX_PAIRED_PARTICIPANTS; n++) {
    const uids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    const rounds = swissRounds(4, n);
    // Decide deterministically but not uniformly: the higher seed usually wins,
    // every third fixture is an upset, so the score groups actually churn.
    const history = runSwiss(uids, rounds, (a, b, r) => ((uids.indexOf(a) + uids.indexOf(b) + r) % 3 === 0 ? "b" : "a"));
    const met = meetings(history);
    assert.equal(new Set(met).size, met.length, `${n} players: a rematch was scheduled`);
    for (const round of history) {
      const seen = round.flatMap((p) => (p.b === null ? [p.a] : [p.a, p.b]));
      assert.equal(new Set(seen).size, seen.length, `${n} players: somebody is double-booked`);
      assert.deepEqual([...seen].sort(), [...uids].sort(), `${n} players: everybody plays every round`);
    }
  }
});

test("an odd field gives exactly one bye per round, and never twice to the same player first", () => {
  for (const n of [3, 5, 7, 9, 11]) {
    const uids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    const rounds = swissRounds(4, n);
    const history = runSwiss(uids, rounds, () => "a");
    const byes = byesIn(history);
    assert.equal(byes.length, rounds, `${n} players: one bye per round`);
    // Nobody sits out a second time while somebody has not sat out at all.
    const counts = new Map<string, number>();
    for (const u of byes) counts.set(u, (counts.get(u) ?? 0) + 1);
    assert.ok(Math.max(...counts.values()) - Math.min(0, ...uids.map((u) => counts.get(u) ?? 0)) <= 1,
      `${n} players: byes are not spread evenly`);
    assert.equal(new Set(byes).size, byes.length, `${n} players: somebody sat out twice inside ${rounds} rounds`);
  }
});

test("an even field has no byes at all", () => {
  const uids = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(byesIn(runSwiss(uids, 3, () => "a")), []);
});

test("the bye goes to the bottom of the table, not to whoever happens to be last in the list", () => {
  // p1 has lost everything, so it sits at the bottom of the standing even though
  // it is first in the uid list.
  const standing = [
    { uid: "p3", matchPoints: 6 },
    { uid: "p2", matchPoints: 3 },
    { uid: "p1", matchPoints: 0 },
  ];
  const ps = swissPairings(standing, []);
  assert.deepEqual(ps.filter((p) => p.b === null).map((p) => p.a), ["p1"]);
});

test("somebody who has already sat out is passed over for the bye", () => {
  const standing = [
    { uid: "top", matchPoints: 6 },
    { uid: "mid", matchPoints: 3 },
    { uid: "bottom", matchPoints: 0 },
  ];
  // `bottom` is lowest but already had one, so it falls to `mid`.
  const prior: Pairing[][] = [[{ a: "bottom", b: null, outcome: "a" }]];
  const ps = swissPairings(standing, prior);
  assert.deepEqual(ps.filter((p) => p.b === null).map((p) => p.a), ["mid"]);
});

test("winners are paired with winners: the fold happens inside each score group", () => {
  // Four on 3 points, four on 0. The 3-point group must pair 1v3 and 2v4 within
  // itself, and the 0-point group likewise — no cross-group fixture is needed.
  const standing = [
    { uid: "w1", matchPoints: 3 }, { uid: "w2", matchPoints: 3 },
    { uid: "w3", matchPoints: 3 }, { uid: "w4", matchPoints: 3 },
    { uid: "l1", matchPoints: 0 }, { uid: "l2", matchPoints: 0 },
    { uid: "l3", matchPoints: 0 }, { uid: "l4", matchPoints: 0 },
  ];
  const ps = swissPairings(standing, []);
  const text = ps.map((p) => `${p.a}-${p.b}`).sort();
  assert.deepEqual(text, ["l1-l3", "l2-l4", "w1-w3", "w2-w4"]);
});

test("an odd score group floats its spare player down to the next one", () => {
  const standing = [
    { uid: "w1", matchPoints: 3 }, { uid: "w2", matchPoints: 3 }, { uid: "w3", matchPoints: 3 },
    { uid: "l1", matchPoints: 0 }, { uid: "l2", matchPoints: 0 }, { uid: "l3", matchPoints: 0 },
  ];
  const ps = swissPairings(standing, []);
  // w1-w2 inside the group, then w3 floats down to meet the 0-point group.
  const crossGroup = ps.filter((p) => p.b !== null && p.a.startsWith("w") !== p.b!.startsWith("w"));
  assert.equal(crossGroup.length, 1, "exactly one float");
  assert.equal(crossGroup[0]!.a, "w3", "and it is the bottom of the odd group that drops");
});

test("T-3: the engine backtracks rather than settling for a rematch it could avoid", () => {
  // A's preferred opponent is C (the fold), but taking it strands B and D, who
  // have already met. A heuristic that does not backtrack pairs A-C and then
  // repeats B-D; enumeration finds A-B / C-D instead.
  const standing = ["A", "B", "C", "D"].map((uid) => ({ uid, matchPoints: 0 }));
  const prior: Pairing[][] = [[
    { a: "B", b: "C", outcome: "a" },
    { a: "B", b: "D", outcome: "a" },
  ]];
  const ps = swissPairings(standing, prior);
  const met = ps.filter((p) => p.b !== null).map((p) => [p.a, p.b].sort().join("|"));
  assert.ok(!met.includes("B|C") && !met.includes("B|D"), `rematch scheduled: ${met.join(", ")}`);
  assert.deepEqual(met.sort(), ["A|B", "C|D"]);
});

test("when every legal pairing is a rematch it still pairs, rather than returning nothing", () => {
  // Two players who have already met and a round left to play: the round cap
  // exists to stop this, so reaching it means something upstream went wrong —
  // but a tournament that silently stops pairing is worse than a rematch.
  const standing = [{ uid: "A", matchPoints: 3 }, { uid: "B", matchPoints: 0 }];
  const prior: Pairing[][] = [[{ a: "A", b: "B", outcome: "a" }]];
  const ps = swissPairings(standing, prior);
  assert.equal(ps.length, 1);
  assert.deepEqual([ps[0]!.a, ps[0]!.b].sort(), ["A", "B"]);
});

test("round one has no table, so a Swiss folds the seed order instead", () => {
  const seeds = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const ps = pairingsFor("swiss", seeds, 1, [], []);
  assert.deepEqual(ps.map((p) => `${p.a}-${p.b}`), ["s1-s4", "s2-s5", "s3-s6"]);
});

// ---------------------------------------------------------------------------
// Double elimination (§6.3, T-2) — slice 6
//
// The schedule, from the hand-worked table this was built against:
//
//   t          1     2       3       4     5     6
//   S=8,k=3    W1    W2      W3      -     -     GF
//              -     L1      L2      L3    L4    -
// ---------------------------------------------------------------------------

test("the schedule runs both brackets in the same tournament round", () => {
  const slots = (k: number, upTo: number) =>
    Array.from({ length: upTo }, (_, i) => doubleElimSlot(k, i + 1))
      .map((s) => `${s.wb ?? "-"}/${s.lb ?? "-"}${s.grandFinal ? "/GF" : ""}`);

  assert.deepEqual(slots(3, 6), ["1/-", "2/1", "3/2", "-/3", "-/4", "-/-/GF"]);
  assert.deepEqual(slots(2, 4), ["1/-", "2/1", "-/2", "-/-/GF"]);
  assert.deepEqual(slots(1, 2), ["1/-", "-/-/GF"]);
});

test("double elimination is 2·log2(S) rounds, not 3k−1", () => {
  assert.deepEqual([2, 3, 4, 5, 8, 12].map(doubleElimRounds), [2, 4, 4, 6, 6, 8]);
  assert.equal(roundCountFor("double_elim", 1, 8), 6);
});

test("dropdowns arrive on the rounds the hand table says they do", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(dropdownSource), [1, 2, null, 3, null, 4]);
});

/** Run a whole double elimination, deciding every fixture with `decide`. */
function runDoubleElim(uids: string[], decide: (a: string, b: string) => "a" | "b"): Pairing[][] {
  const history: Pairing[][] = [];
  for (let n = 1; n <= doubleElimRounds(uids.length); n++) {
    const ps = doubleElimPairings(uids, n, history);
    history.push(ps.map((p) => ({ ...p, outcome: p.b === null ? ("a" as const) : decide(p.a, p.b) })));
  }
  return history;
}

const SEEDED = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
/** The better seed (lower number) always wins. */
const seedWins = (a: string, b: string) => (Number(a.slice(1)) < Number(b.slice(1)) ? "a" as const : "b" as const);

test("the eight-player bracket is exactly the table worked out by hand", () => {
  const history = runDoubleElim(SEEDED, seedWins);
  const show = (n: number, half: "w" | "l" | "gf") =>
    history[n - 1]!.filter((p) => p.bracket === half)
      .map((p) => (p.b === null ? `${p.a} bye` : `${p.a}-${p.b}`)).join(" ");

  assert.equal(show(1, "w"), "p1-p8 p4-p5 p2-p7 p3-p6");
  assert.equal(show(2, "w"), "p1-p4 p2-p3");
  assert.equal(show(2, "l"), "p5-p7 p6-p8");
  assert.equal(show(3, "w"), "p1-p2");
  // The T-2 case: the naive mapping would hand p5 back to p4 and p6 back to p3,
  // the very players who just knocked them down. Search finds the clean draw.
  assert.equal(show(3, "l"), "p5-p3 p6-p4");
  assert.equal(show(4, "l"), "p3-p4");
  assert.equal(show(5, "l"), "p3-p2");
  assert.equal(show(6, "gf"), "p1-p2");
});

test("nobody meets the same opponent twice before the losers final", () => {
  const history = runDoubleElim(SEEDED, seedWins);
  // Rounds 1-4: every fixture must be a first meeting.
  const seen = new Set<string>();
  for (const round of history.slice(0, 4)) {
    for (const p of round) {
      if (p.b === null) continue;
      const key = [p.a, p.b].sort().join("|");
      assert.ok(!seen.has(key), `rematch scheduled early: ${key}`);
      seen.add(key);
    }
  }
  // The losers final IS a rematch here, and that is expected: the beaten
  // winners-bracket finalist has to enter the losers bracket somewhere.
  const lbFinal = history[4]!.find((p) => p.bracket === "l")!;
  assert.deepEqual([lbFinal.a, lbFinal.b].sort(), ["p2", "p3"]);
});

test("two defeats put you out, one does not", () => {
  const history = runDoubleElim(SEEDED, seedWins);
  const losses = lossesOf(SEEDED, history);
  assert.equal(losses.get("p1"), 0, "the winners champion never lost");
  assert.equal(losses.get("p2"), 2, "beaten in the winners final and again in the grand final");
  assert.deepEqual([...alive(SEEDED, history, 2)], ["p1"], "exactly one player left");
  // With one life the same log would have knocked out everybody but p1 by round 3.
  assert.ok(alive(SEEDED, history, 1).size <= 1);
});

test("every field from 2 to 12 ends with exactly one unbeaten-enough champion", () => {
  for (let n = 2; n <= MAX_PAIRED_PARTICIPANTS; n++) {
    const uids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    // An upset every third fixture, so the brackets do not just mirror the seeds.
    let seq = 0;
    const history = runDoubleElim(uids, (a, b) => (seq++ % 3 === 2 ? "b" : seedWins(a, b)));

    const left = alive(uids, history, 2);
    assert.equal(left.size, 1, `${n} players: ${left.size} players left standing`);

    for (const round of history) {
      const seen = round.flatMap((p) => (p.b === null ? [p.a] : [p.a, p.b]));
      assert.equal(new Set(seen).size, seen.length, `${n} players: somebody is double-booked in one round`);
    }
    // Nobody keeps playing after their second defeat.
    const losses = lossesOf(uids, history);
    for (const u of uids) assert.ok((losses.get(u) ?? 0) <= 2, `${n} players: ${u} lost ${losses.get(u)} times`);
  }
});

test("survivedRounds counts the defeat that ends it, not the first one", () => {
  // One loss in round 1, the second in round 3: knocked out in round 3, so two
  // rounds survived — under single elimination the same log reads as zero.
  const history: Pairing[][] = [
    [{ a: "A", b: "B", outcome: "a", bracket: "w" }],
    [],
    [{ a: "C", b: "B", outcome: "a", bracket: "l" }],
  ];
  assert.equal(survivedRounds(["A", "B", "C"], history, 2).get("B"), 2);
  assert.equal(survivedRounds(["A", "B", "C"], history, 1).get("B"), 0);
});

test("a grand final the losers champion wins is the one that needs a reset", () => {
  const history = runDoubleElim(SEEDED, seedWins);
  const gf = history[5]!.find((p) => p.bracket === "gf")!;
  assert.equal(gf.a, "p1", "the winners champion is always side a");
  assert.equal(gf.b, "p2");
  // p1 won it here, so both brackets agree and nothing more is needed. Had it
  // gone the other way both would be on one defeat — which is what
  // grandFinalReset exists for.
  assert.equal(gf.outcome, "a");
});

test("losing the grand final ends it, even on only one defeat (reset off)", () => {
  // The losers champion wins the final, so both finalists are on one defeat.
  // Without the "last grand final is decisive" rule the table would show two
  // survivors and no champion — which is what a property check caught.
  const history = runDoubleElim(SEEDED, seedWins);
  const upset = history.map((round, i) =>
    i === 5 ? round.map((p) => (p.bracket === "gf" ? { ...p, outcome: "b" as const } : p)) : round);

  const losses = lossesOf(SEEDED, upset);
  assert.equal(losses.get("p1"), 1, "the winners champion has lost exactly once");
  assert.equal(losses.get("p2"), 1, "and so has the losers champion");
  assert.deepEqual([...alive(SEEDED, upset, 2)], ["p2"], "the final decided it anyway");
});

test("with the reset on, that same result pairs the two of them again", () => {
  const history = runDoubleElim(SEEDED, seedWins);
  const upset = history.map((round, i) =>
    i === 5 ? round.map((p) => (p.bracket === "gf" ? { ...p, outcome: "b" as const } : p)) : round);

  const reset = doubleElimPairings(SEEDED, 7, upset);
  assert.equal(reset.length, 1);
  assert.equal(reset[0]!.bracket, "gf");
  assert.deepEqual([reset[0]!.a, reset[0]!.b], ["p1", "p2"]);

  // And once the reset is played, the loser of THAT is the one who is out.
  const played = [...upset, reset.map((p) => ({ ...p, outcome: "a" as const }))];
  assert.deepEqual([...alive(SEEDED, played, 2)], ["p1"]);
});

test("the losers bye is chosen so the rest of the draw stays rematch-free", () => {
  // The five-player case that produced a rematch on the first run: the losers
  // pool is one survivor plus two dropdowns, and giving the bye to the best
  // seed strands the other two, who met in round one.
  const seeds = ["s1", "s2", "s3", "s4", "s5"];
  const history: Pairing[][] = [
    [
      { a: "s1", b: null, outcome: "a", bracket: "w" },
      { a: "s4", b: "s5", outcome: "a", bracket: "w" },
      { a: "s2", b: null, outcome: "a", bracket: "w" },
      { a: "s3", b: null, outcome: "a", bracket: "w" },
    ],
    [
      { a: "s1", b: "s4", outcome: "a", bracket: "w" },
      { a: "s2", b: "s3", outcome: "a", bracket: "w" },
      { a: "s5", b: null, outcome: "a", bracket: "l" },
    ],
  ];
  const lb = doubleElimPairings(seeds, 3, history).filter((p) => p.bracket === "l");
  const fixture = lb.find((p) => p.b !== null)!;
  const key = [fixture.a, fixture.b].sort().join("|");
  assert.notEqual(key, "s4|s5", "s4 and s5 met in round one; the bye must not force them together");
  assert.equal(lb.filter((p) => p.b === null).length, 1, "still exactly one bye");
});
