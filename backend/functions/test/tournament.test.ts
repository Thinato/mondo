/**
 * Tournament presets, round windows and standings (docs/06-tournaments.md §4,
 * §6). Pure.
 *
 * The standings fixture is deliberately small enough to check by hand, the way
 * test/standings.test.ts is for the daily board — this is the other arithmetic
 * the group will argue about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  MAX_PARTICIPANTS, MIN_ROUND_MS, newTournament, playId, presetById, PRESETS, roundClosesAt, roundId,
  seedOrder, standings, type Tournament, type TournamentRound,
} from "../src/lib/tournament";
import type { Pairing } from "../src/lib/tournament-core";
import { KIND_IDS } from "../src/lib/kinds";
import { MAX_CARD_ITEMS } from "../src/lib/card";
import { puzzleIdAt } from "../src/lib/puzzle-day";

const ts = (iso: string) => Timestamp.fromMillis(Date.parse(iso));
const T0 = ts("2026-09-15T15:30:00Z"); // 12:30 in São Paulo

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

// ---------------------------------------------------------------------------
// Presets (D-48)
// ---------------------------------------------------------------------------

test("every shipped preset is coherent: a real format, a real regime, real kinds", () => {
  assert.ok(PRESETS.length >= 3);
  for (const p of PRESETS) {
    assert.match(p.id, /^[a-z][a-z0-9-]{1,23}$/, `${p.id}: must pass requirePresetId`);
    assert.ok(p.label.length > 0 && p.description.length > 0, `${p.id}: needs pt-BR copy for the create form`);
    // §6.1 — `aggregate` is offered only for free-for-all, because under D-38 a
    // pairing format whose pairings decide nothing is doing no work at all.
    if (p.regime === "aggregate") assert.equal(p.format, "free_for_all", `${p.id}`);
    const items = p.config.cardSpec.items;
    const total = items.reduce((n, i) => n + i.count, 0);
    assert.ok(total >= 1 && total <= MAX_CARD_ITEMS, `${p.id}: ${total} challenges`);
    for (const { kind } of items) assert.ok((KIND_IDS as readonly string[]).includes(kind), `${p.id}: kind ${kind} is not shipped`);
    assert.ok(p.config.rounds >= 1);
    assert.ok(p.config.roundDays >= 1);
    assert.ok(p.config.tiebreak.chain.includes("points"), `${p.id}: points must be the first comparator`);
    assert.ok(p.config.maxParticipants <= MAX_PARTICIPANTS);
  }
});

test("preset ids are unique and unknown ones are refused", () => {
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  assert.equal(presetById("quintal").format, "free_for_all");
  assert.equal(presetById("liga").format, "round_robin");
  assert.equal(presetById("mata-mata").format, "single_elim");
  assert.equal(presetById("suico").format, "swiss");
  assert.equal(presetById("chave-dupla").format, "double_elim");
  rejects(() => presetById("nope"), "invalid-argument");
});

test("every pairing preset caps its field, and only free-for-all takes a whole group", () => {
  for (const p of PRESETS) {
    if (p.format === "free_for_all") assert.equal(p.config.maxParticipants, MAX_PARTICIPANTS, p.id);
    else assert.ok(p.config.maxParticipants <= 12, `${p.id}: a pairing format must stay lunch-sized`);
  }
});

test("D-50: only a format that can hold a draw is allowed to record one", () => {
  for (const p of PRESETS) {
    if (p.config.tiebreak.unresolved !== "draw") continue;
    assert.ok(["round_robin", "swiss"].includes(p.format), `${p.id}: a knockout cannot end drawn`);
  }
  // And a preset that wants sudden death must leave time out of the chain, or
  // millisecond ties never happen and the policy is unreachable (D-44).
  for (const p of PRESETS) {
    if (p.config.tiebreak.unresolved !== "sudden_death") continue;
    assert.ok(!p.config.tiebreak.chain.includes("time"), `${p.id}: sudden death would never fire`);
    assert.ok(p.config.tiebreak.suddenDeathMaxItems >= 1, `${p.id}: needs a safety valve`);
  }
});

test("the shipped presets cover every kind and both orderings", () => {
  const quintal = presetById("quintal");
  assert.deepEqual(quintal.config.cardSpec, { items: [{ kind: "shape", count: 5 }], order: "as_listed" });
  assert.deepEqual(presetById("capitais").config.cardSpec.items, [{ kind: "capital", count: 5 }]);
  assert.deepEqual(presetById("bandeiras").config.cardSpec.items, [{ kind: "flag", count: 5 }]);
  assert.deepEqual(presetById("economia").config.cardSpec.items, [{ kind: "gdp", count: 5 }]);
  const mistura = presetById("mistura");
  assert.equal(mistura.config.cardSpec.order, "shuffled");
  assert.deepEqual(mistura.config.cardSpec.items.map((i) => i.kind), ["shape", "capital"]);
  // Every shipped kind is reachable from some preset: a kind nobody can pick
  // is a kind nobody tests (D-48 leaves the client no other way in).
  const asked = new Set(PRESETS.flatMap((p) => p.config.cardSpec.items.map((i) => i.kind)));
  assert.deepEqual([...asked].sort(), ["capital", "flag", "gdp", "shape"]);
});

test("D-48: a new tournament copies the preset's settings rather than referring to it", () => {
  const t = newTournament({ groupId: "g1", name: "Quintal de sexta", preset: presetById("quintal"), createdBy: "u1", displayName: "ana-um", now: T0 });
  assert.equal(t.status, "draft");
  assert.equal(t.preset, "quintal");
  assert.deepEqual(t.config, presetById("quintal").config);
  assert.deepEqual(t.participantUids, ["u1"], "the creator is in by default");
  assert.equal(t.participants.u1!.displayName, "ana-um");
  assert.equal(t.currentRound, null);
  // Editing the preset later must not reach a tournament already created.
  assert.notEqual(t.config, presetById("quintal").config);
});

// ---------------------------------------------------------------------------
// Ids (§4.4)
// ---------------------------------------------------------------------------

test("D-40: a play id starts with the uid, so the attempts rule's split('_') still holds", () => {
  const id = playId("aliceUid1", "t1tournament0000001", 3);
  assert.equal(id, "aliceUid1_t1tournament0000001_r3");
  assert.equal(id.split("_")[0], "aliceUid1");
  assert.equal(roundId("t1tournament0000001", 3), "t1tournament0000001_r3");
});

// ---------------------------------------------------------------------------
// Round windows (D-43)
// ---------------------------------------------------------------------------

test("a round closes at the next noon in São Paulo, one puzzle day out", () => {
  // Opens 12:30 local on the 15th → closes noon local on the 16th.
  const closes = roundClosesAt(T0, 1);
  assert.equal(closes.toISOString(), "2026-09-16T15:00:00.000Z");
  assert.equal(puzzleIdAt(closes), "2026-09-16");
});

test("roundDays stretches the window by whole puzzle days", () => {
  assert.equal(roundClosesAt(T0, 2).toISOString(), "2026-09-17T15:00:00.000Z");
  assert.equal(roundClosesAt(T0, 5).toISOString(), "2026-09-20T15:00:00.000Z");
});

test("a round opened just before noon still gets a full window, not one minute", () => {
  // 14:59Z is 11:59 in São Paulo, so `puzzleIdAt` still answers with yesterday
  // and "yesterday + 1 day" is TODAY's noon — sixty seconds away. This test was
  // originally written asserting that sixty seconds while claiming the opposite
  // in its own name; the code review caught it. MIN_ROUND_MS is the floor.
  const justBefore = ts("2026-09-16T14:59:00Z");
  const closes = roundClosesAt(justBefore, 1);
  assert.equal(closes.toISOString(), "2026-09-17T15:00:00.000Z");
  assert.ok(closes.getTime() - justBefore.toMillis() >= MIN_ROUND_MS);
});

test("every opening minute of the day gets at least MIN_ROUND_MS, and always lands on noon", () => {
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 1, 59]) {
      const opened = ts(`2026-09-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
      const closes = roundClosesAt(opened, 1);
      const window = closes.getTime() - opened.toMillis();
      assert.ok(window >= MIN_ROUND_MS, `opened ${opened.toDate().toISOString()} → ${window / 3_600_000}h`);
      assert.ok(window < MIN_ROUND_MS + 86_400_000, `opened ${opened.toDate().toISOString()} → ${window / 3_600_000}h`);
      assert.equal(puzzleIdAt(closes), puzzleIdAt(new Date(closes.getTime() + 1000)), "closes exactly on a boundary");
    }
  }
});

test("the lunch case the review found: a quintal started at 11:50 does not die at noon", () => {
  const elevenFifty = ts("2026-09-16T14:50:00Z");
  const closes = roundClosesAt(elevenFifty, 1);
  assert.equal(closes.toISOString(), "2026-09-17T15:00:00.000Z");
});

test("roundDays must be a positive whole number", () => {
  assert.throws(() => roundClosesAt(T0, 0), RangeError);
  assert.throws(() => roundClosesAt(T0, 1.5), RangeError);
});

// ---------------------------------------------------------------------------
// Standings — the fixture (D-41)
// ---------------------------------------------------------------------------
//
// A three-round `quintal`-shaped free-for-all, aggregate regime. Rounds 1 and 2
// are closed; round 3 is still open, so nothing from it counts (FR-5.6).
//
//   round      1              2              3 (open)
//   ana        12  / 40 000   18  / 30 000   30 / 10 000
//   bruno      18  / 60 000   12  / 25 000   —
//   carla      12  / 20 000   —  (forfeit)   —
//
//   totals over the CLOSED rounds:
//     ana    30 points, 70 000 ms, 2 played
//     bruno  30 points, 85 000 ms, 2 played
//     carla  12 points, 20 000 ms, 1 played
//
//   Ranked by points then total time (the `aggregate` chain): ana 1 (faster on
//   equal points), bruno 2, carla 3. Round 3's 30 points must not move ana.
// ---------------------------------------------------------------------------

const P = (seed: number, displayName: string) => ({ seed, displayName, joinedAt: T0 });

const T: Pick<Tournament, "participants" | "participantUids" | "regime" | "config" | "format"> = {
  participantUids: ["ana", "bruno", "carla"],
  participants: { ana: P(1, "ana-um"), bruno: P(2, "bruno-dois"), carla: P(3, "carla-tres") },
  regime: "aggregate",
  format: "free_for_all",
  config: presetById("quintal").config,
};

const row = (points: number, elapsedMs: number, guessCount = 5, played = true) => ({ points, elapsedMs, guessCount, played });

const round = (n: number, results: TournamentRound["results"], closed: boolean): TournamentRound => ({
  n,
  opensAt: T0,
  closesAt: Timestamp.fromDate(roundClosesAt(T0, 1)),
  closedAt: closed ? Timestamp.fromDate(roundClosesAt(T0, 1)) : null,
  cardId: roundId("t1", n),
  results,
});

const ROUNDS = [
  round(1, { ana: row(12, 40_000), bruno: row(18, 60_000), carla: row(12, 20_000) }, true),
  round(2, { ana: row(18, 30_000), bruno: row(12, 25_000), carla: row(0, 0, 0, false) }, true),
  round(3, { ana: row(30, 10_000) }, false),
];

test("the fixture ranks by points then total time, over closed rounds only", () => {
  const rows = standings(T, ROUNDS, "ana");
  assert.deepEqual(
    rows.map((r) => [r.displayName, r.rank, r.points, r.totalElapsedMs, r.played]),
    [
      ["ana-um", 1, 30, 70_000, 2],
      ["bruno-dois", 2, 30, 85_000, 2],
      ["carla-tres", 3, 12, 20_000, 1],
    ],
  );
});

test("FR-5.6: the open round contributes nothing — not even to the viewer's own row", () => {
  const rows = standings(T, ROUNDS, "ana");
  assert.equal(rows[0]!.points, 30, "ana's 30 in round 3 must not be counted yet");
  const closedOnly = standings(T, ROUNDS.slice(0, 2), "ana");
  assert.deepEqual(rows, closedOnly, "an open round is indistinguishable from not existing");
});

test("closing round 3 adds it, and ana pulls clear", () => {
  const all = [...ROUNDS.slice(0, 2), round(3, ROUNDS[2]!.results, true)];
  const rows = standings(T, all, "ana");
  assert.deepEqual(rows.map((r) => [r.displayName, r.rank, r.points]), [["ana-um", 1, 60], ["bruno-dois", 2, 30], ["carla-tres", 3, 12]]);
});

test("a forfeit scores zero and is not counted as played (FR-5.7)", () => {
  const carla = standings(T, ROUNDS, "ana").find((r) => r.uid === "carla")!;
  assert.equal(carla.played, 1);
  assert.equal(carla.points, 12);
});

test("isMe marks exactly one row, and only for a participant", () => {
  assert.deepEqual(standings(T, ROUNDS, "bruno").map((r) => r.isMe), [false, true, false]);
  assert.deepEqual(standings(T, ROUNDS, "someone-else").map((r) => r.isMe), [false, false, false]);
});

test("a participant with no results at all still appears, on zero", () => {
  const withDavi = {
    ...T,
    participantUids: [...T.participantUids, "davi"],
    participants: { ...T.participants, davi: P(4, "davi-quatro") },
  };
  const davi = standings(withDavi, ROUNDS, "ana").find((r) => r.uid === "davi")!;
  assert.deepEqual([davi.rank, davi.points, davi.played, davi.totalElapsedMs], [4, 0, 0, 0]);
});

test("D-46: a scrubbed participant keeps their slot under a neutral label", () => {
  const scrubbed = { ...T, participants: { ...T.participants, bruno: P(2, "[removido]") } };
  const rows = standings(scrubbed, ROUNDS, "ana");
  assert.equal(rows[1]!.displayName, "[removido]");
  assert.equal(rows[1]!.points, 30, "their results stay in the fold; the bracket keeps its shape");
});

test("D-24's competition ranks: equal points AND equal time tie, and the next rank skips", () => {
  const tied = [round(1, { ana: row(12, 40_000), bruno: row(12, 40_000), carla: row(6, 10_000) }, true)];
  assert.deepEqual(standings(T, tied, "ana").map((r) => r.rank), [1, 1, 3]);
});

test("D-50: with time out of the chain, equal points tie — which is what lets sudden death fire", () => {
  const pointsOnly = {
    ...T,
    config: { ...T.config, tiebreak: { chain: ["points"] as ("points" | "time")[], unresolved: "sudden_death" as const, suddenDeathMaxItems: 5 } },
  };
  const rows = standings(pointsOnly, ROUNDS, "ana");
  // ana and bruno both have 30; with the stopwatch out of it they are level.
  assert.deepEqual(rows.map((r) => [r.displayName, r.rank]), [["ana-um", 1], ["bruno-dois", 1], ["carla-tres", 3]]);
});

// ---------------------------------------------------------------------------
// The `match` regime (D-49) — the same three players, run as a league.
//
//   Three players means the circle method adds a ghost, so this is also the
//   odd-count path through `standings`. Three rounds:
//
//     round 1   ana bye     bruno–carla        bruno 18 v carla 12  -> bruno
//     round 2   ana–carla   bruno bye          ana   18 v carla  9  -> ana
//     round 3   ana–bruno   carla bye          ana   12 v bruno 24  -> bruno
//
//   Match points 3/1/0, byes credited as wins:
//     bruno  bye + 2 wins = 9   card  18 + 0 + 24 = 42
//     ana    bye + 1 win + 1 loss = 6   card  0 + 18 + 12 = 30
//     carla  bye + 2 losses = 3   card  12 + 9 + 0 = 21
//
//   Table: bruno 1, ana 2, carla 3 — and note that carla is last on match
//   points while ana, who scored more, is second. Card points do not carry.
// ---------------------------------------------------------------------------

const LIGA: Pick<Tournament, "participants" | "participantUids" | "regime" | "config" | "format"> = {
  ...T,
  regime: "match",
  format: "round_robin",
  config: presetById("liga").config,
};

const withPairings = (n: number, results: TournamentRound["results"], pairings: Pairing[]): TournamentRound =>
  ({ ...round(n, results, true), pairings });

const LEAGUE_ROUNDS = [
  withPairings(1, { bruno: row(18, 30_000), carla: row(12, 40_000), ana: row(0, 0, 0, false) }, [
    { a: "ana", b: null, outcome: "a" },
    { a: "bruno", b: "carla", outcome: "a" },
  ]),
  withPairings(2, { ana: row(18, 20_000), carla: row(9, 50_000), bruno: row(0, 0, 0, false) }, [
    { a: "ana", b: "carla", outcome: "a" },
    { a: "bruno", b: null, outcome: "a" },
  ]),
  withPairings(3, { ana: row(12, 60_000), bruno: row(24, 10_000), carla: row(0, 0, 0, false) }, [
    { a: "ana", b: "bruno", outcome: "b" },
    { a: "carla", b: null, outcome: "a" },
  ]),
];

test("the match regime ranks on match points, not on the card total", () => {
  const rows = standings(LIGA, LEAGUE_ROUNDS, "ana");
  assert.deepEqual(
    rows.map((r) => [r.displayName, r.rank, r.record!.matchPoints, r.points]),
    [
      ["bruno-dois", 1, 9, 42],
      ["ana-um", 2, 6, 30],
      ["carla-tres", 3, 3, 21],
    ],
  );
});

test("the match record carries wins, draws, losses and byes separately", () => {
  const by = new Map(standings(LIGA, LEAGUE_ROUNDS, "ana").map((r) => [r.uid, r.record!]));
  assert.deepEqual(by.get("bruno"), { matchPoints: 9, won: 3, drawn: 0, lost: 0, byes: 1 });
  assert.deepEqual(by.get("ana"), { matchPoints: 6, won: 2, drawn: 0, lost: 1, byes: 1 });
  assert.deepEqual(by.get("carla"), { matchPoints: 3, won: 1, drawn: 0, lost: 2, byes: 1 });
});

test("an open round contributes no match points, the same way it contributes no card points", () => {
  const openLast = [...LEAGUE_ROUNDS.slice(0, 2), { ...LEAGUE_ROUNDS[2]!, closedAt: null }];
  const rows = standings(LIGA, openLast, "ana");
  const by = new Map(rows.map((r) => [r.uid, r]));
  // Without round 3: ana bye+win = 6, bruno bye+win = 6, carla two losses = 0.
  assert.equal(by.get("ana")!.record!.matchPoints, 6);
  assert.equal(by.get("bruno")!.record!.matchPoints, 6);
  assert.equal(by.get("carla")!.record!.matchPoints, 0);
});

test("level on match points, the card total breaks it BEFORE the stopwatch is consulted", () => {
  // ana and bruno both win a fixture and a bye, so both are on 6. ana has the
  // bigger card total (30 v 18) but is nine times slower (90 s v 10 s). Card
  // points come first in the chain, so ana takes it — if the two keys were
  // swapped, or collapsed into one, bruno would win this and the test would say so.
  const rounds = [
    withPairings(1, { ana: row(20, 50_000), bruno: row(9, 5_000), carla: row(8, 40_000) }, [
      { a: "ana", b: null, outcome: "a" },
      { a: "bruno", b: "carla", outcome: "a" },
    ]),
    withPairings(2, { ana: row(10, 40_000), carla: row(5, 50_000), bruno: row(9, 5_000) }, [
      { a: "ana", b: "carla", outcome: "a" },
      { a: "bruno", b: null, outcome: "a" },
    ]),
  ];
  const rows = standings(LIGA, rounds, "ana");
  assert.deepEqual(rows.map((r) => [r.displayName, r.rank, r.record!.matchPoints, r.points, r.totalElapsedMs]), [
    ["ana-um", 1, 6, 30, 90_000],
    ["bruno-dois", 2, 6, 18, 10_000],
    ["carla-tres", 3, 0, 13, 90_000],
  ]);
});

test("level on match points AND on card points, the stopwatch decides", () => {
  // Rounds 1-2 of the league fixture leave ana and bruno on 6 match points and
  // 18 card points each — each won one fixture and sat out one bye. The only
  // thing left is time: ana's 20 s against bruno's 30 s.
  const openLast = [...LEAGUE_ROUNDS.slice(0, 2), { ...LEAGUE_ROUNDS[2]!, closedAt: null }];
  const rows = standings(LIGA, openLast, "ana");
  assert.deepEqual(rows.map((r) => [r.displayName, r.rank, r.record!.matchPoints, r.points, r.totalElapsedMs]), [
    ["ana-um", 1, 6, 18, 20_000],
    ["bruno-dois", 2, 6, 18, 30_000],
    ["carla-tres", 3, 0, 21, 90_000],
  ]);
  // And note carla: the most card points of anyone (21) and dead last, because
  // she lost both fixtures. That is "points off" (D-49) doing its job.
});

test("a free-for-all round carries no pairings, and the match fold simply finds nothing", () => {
  // Defensive: rounds written before slice 3 have no `pairings` field at all.
  const legacy = LEAGUE_ROUNDS.map(({ pairings: _drop, ...r }) => r);
  const rows = standings(LIGA, legacy, "ana");
  for (const r of rows) assert.equal(r.record!.matchPoints, 0);
  // Card points still fold, so the table degrades to a card ranking rather than
  // throwing or reporting nothing at all.
  assert.deepEqual(rows.map((r) => r.points).sort((a, b) => b - a), [42, 30, 21]);
});

// ---------------------------------------------------------------------------

test("seeds follow join order, with uid as the stable tiebreak", () => {
  const later = Timestamp.fromMillis(T0.toMillis() + 1000);
  const order = seedOrder({
    zoe: { seed: 0, displayName: "z", joinedAt: later },
    ana: { seed: 0, displayName: "a", joinedAt: T0 },
    bruno: { seed: 0, displayName: "b", joinedAt: T0 },
  });
  assert.deepEqual(order, ["ana", "bruno", "zoe"]);
});

// ---------------------------------------------------------------------------
// Single elimination (§6.3, D-47) — the same three players, run as a knockout.
//
//   Bracket of 4, so ana (seed 1) gets the bye. Two rounds:
//
//     round 1   ana bye        bruno–carla     bruno 20 v carla 15  -> bruno
//     round 2   ana–bruno                      ana   10 v bruno 24  -> bruno
//
//   Survived: bruno 2 (champion), ana 1, carla 0.
//
//   carla is knocked out in round 1 and KEEPS PLAYING (consolation, D-47), so
//   she out-scores ana on cards across the two rounds — 15 + 30 against
//   ana's 0 + 10. She still finishes last, because a knockout is ranked by how
//   far you got and nothing else can move you past someone still in.
// ---------------------------------------------------------------------------

const MATA: Pick<Tournament, "participants" | "participantUids" | "regime" | "config" | "format"> = {
  ...T,
  regime: "match",
  format: "single_elim",
  config: presetById("mata-mata").config,
};

const KNOCKOUT = [
  withPairings(1, { ana: row(0, 0, 0, false), bruno: row(20, 30_000), carla: row(15, 40_000) }, [
    { a: "ana", b: null, outcome: "a" },
    { a: "bruno", b: "carla", outcome: "a" },
  ]),
  withPairings(2, { ana: row(10, 50_000), bruno: row(24, 20_000), carla: row(30, 10_000) }, [
    { a: "ana", b: "bruno", outcome: "b" },
  ]),
];

test("a knockout is ranked by how far you got, not by what you scored", () => {
  const rows = standings(MATA, KNOCKOUT, "ana");
  assert.deepEqual(
    rows.map((r) => [r.displayName, r.rank, r.survived, r.eliminated, r.points]),
    [
      ["bruno-dois", 1, 2, false, 44],
      ["ana-um", 2, 1, true, 10],
      ["carla-tres", 3, 0, true, 45],
    ],
  );
});

test("D-47: the consolation player out-scores a semifinalist and still finishes below her", () => {
  const rows = standings(MATA, KNOCKOUT, "ana");
  const carla = rows.find((r) => r.uid === "carla")!;
  const ana = rows.find((r) => r.uid === "ana")!;
  assert.ok(carla.points > ana.points, "carla scored more across the two cards");
  assert.ok(carla.rank > ana.rank, "and is still ranked below her, because she went out first");
});

test("the champion is the only player left alive", () => {
  const rows = standings(MATA, KNOCKOUT, "ana");
  assert.deepEqual(rows.filter((r) => !r.eliminated).map((r) => r.uid), ["bruno"]);
});

test("with only round 1 closed, nobody is champion yet and the bye player is still in", () => {
  const rows = standings(MATA, KNOCKOUT.slice(0, 1), "ana");
  const stillIn = rows.filter((r) => !r.eliminated).map((r) => r.uid).sort();
  assert.deepEqual(stillIn, ["ana", "bruno"], "a bye eliminates nobody");
  assert.equal(rows.find((r) => r.uid === "carla")!.survived, 0);
});
