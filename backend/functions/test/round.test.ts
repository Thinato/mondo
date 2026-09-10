/**
 * The daily round (FR-2, FR-3).
 *
 * D-52: a day is a card of one challenge per kind, so the transitions here are
 * `lib/card.ts`'s and `test/card.test.ts` covers them once. What this file
 * pins is what is specific to a *day*: the three summary fields the boards read
 * off the top of the attempt, the streak, the share grid, the view's SEC-1 line,
 * and the fact that a day seeded before D-52 still plays.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  applyGuess, intervalsMs, maxPointsFor, newAttempt, newProfile, previousDay, puzzleItems, randomHandle,
  recordCompletion, resetAttempt, roundView, statusOf, upgradeAttempt,
  type Attempt, type Puzzle,
} from "../src/lib/round";
import type { CardItem } from "../src/lib/card";
import { COUNTRIES } from "../src/lib/countries";
import { distanceKm } from "../src/lib/geo";

const T0 = Timestamp.fromMillis(Date.parse("2026-09-15T15:30:00Z"));
const at = (plusMs: number) => Timestamp.fromMillis(T0.toMillis() + plusMs);

/** A day: silhouette (6 guesses), flag (3), capital (3). 18 points on offer. */
const CARD: CardItem[] = [
  { kind: "shape", subject: "PY" },
  { kind: "flag", subject: "BR" },
  { kind: "capital", subject: "IT" },
];
const puzzle: Puzzle = { puzzleId: "2026-09-15", items: CARD, opensAt: Timestamp.fromMillis(Date.parse("2026-09-15T15:00:00Z")) };
const start = () => newAttempt("u1", "2026-09-15", CARD, T0);

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

/** Play `codes` one second apart against the day's card. */
function play(codes: string[], a: Attempt = start()): Attempt {
  return codes.reduce((acc, code, i) => applyGuess(acc, CARD, code, at((i + 1) * 1000)), a);
}

/** Solve the whole day on first guesses: 6 + 6 + 6. */
const perfect = () => play(["PY", "BR", "IT"]);

// --- the day's shape -------------------------------------------------------

test("D-52: a fresh day holds one challenge per kind, only the first clock running", () => {
  const a = start();
  assert.deepEqual(a.items.map((i) => i.kind), ["shape", "flag", "capital"]);
  assert.equal(a.cursor, 0);
  assert.equal(a.guessCount, 0);
  assert.equal(a.points, 0);
  assert.equal(a.mode, "daily");
  assert.equal(a.puzzleId, "2026-09-15");
  assert.equal(a.items[0]!.startedAt?.toMillis(), T0.toMillis());
  assert.equal(a.items[1]!.startedAt, null);
});

test("a wrong guess records distance, bearing and proximity and leaves the challenge open", () => {
  const a = play(["AR"]);
  assert.equal(a.guessCount, 1);
  assert.equal(a.cursor, 0, "a wrong guess does not move on");
  assert.equal(a.finishedAt, null);
  assert.equal(statusOf(a), "in_progress");
  const g = a.items[0]!.guesses[0]!;
  assert.equal(g.code, "AR");
  assert.equal(g.distanceKm, distanceKm(COUNTRIES.get("AR")!.centroid, COUNTRIES.get("PY")!.centroid));
  assert.ok(g.distanceKm > 800 && g.distanceKm < 1600, `AR→PY ${g.distanceKm} km`);
  assert.ok(g.bearingDeg > 0 && g.bearingDeg < 90, `AR→PY bearing ${g.bearingDeg} should be north-east`);
  assert.ok(g.proximity > 0.9);
});

test("FR-3.1: solving the silhouette on the third guess is worth 4, and moves to the next challenge", () => {
  const a = play(["AR", "BO", "PY"]);
  assert.equal(a.cursor, 1);
  assert.equal(a.items[0]!.points, 4);
  assert.equal(a.items[0]!.solved, true);
  assert.equal(a.items[0]!.elapsedMs, 3000);
  assert.equal(a.finishedAt, null, "the day is not over until every challenge is");
  assert.equal(a.items[1]!.startedAt?.toMillis(), at(3000).toMillis(), "the next clock starts on the handover");
});

test("D-52: the day's points are the sum, and 18 is a perfect day", () => {
  const a = perfect();
  assert.equal(statusOf(a), "solved");
  assert.equal(a.points, 18);
  assert.equal(maxPointsFor(CARD), 18);
  assert.equal(a.guessCount, 3);
  assert.equal(a.solved, true);
  assert.equal(a.elapsedMs, 3000);
});

test("D-52: `solved` means every challenge fell, not merely that one did", () => {
  // Silhouette solved, flag missed three times, capital solved.
  const a = play(["PY", "AR", "CL", "UY", "IT"]);
  assert.equal(a.finishedAt !== null, true);
  assert.equal(a.solved, false, "one missed challenge is not a solved day");
  assert.equal(a.items[0]!.solved, true);
  assert.equal(a.items[1]!.solved, false);
  assert.equal(a.points, 6 + 0 + 6);
  assert.equal(statusOf(a), "failed");
});

test("guessCount is the whole day, which is what the boards and the dashboard read", () => {
  const a = play(["AR", "BO", "PY", "AR", "BR"]);
  assert.equal(a.guessCount, 5);
  assert.equal(a.items[0]!.guesses.length, 3);
  assert.equal(a.items[1]!.guesses.length, 2);
});

test("FR-2.8: exhausting a challenge's guesses scores it 0 and moves on, it does not end the day", () => {
  const a = play(["AR", "BO", "BR", "CL", "UY", "PE"]);
  assert.equal(a.items[0]!.solved, false);
  assert.equal(a.items[0]!.points, 0);
  assert.equal(a.cursor, 1);
  assert.equal(a.finishedAt, null);
  assert.equal(statusOf(a), "in_progress");
});

test("FR-2.10 / SEC-4: no guess after the day is over", () => {
  rejects(() => applyGuess(perfect(), CARD, "AR", at(9000)), "already-completed");
});

test("SEC-4: a challenge that already used its guesses cannot take another", () => {
  const stuck = { ...play(["AR", "BO", "BR", "CL", "UY", "PE"]), cursor: 0 };
  rejects(() => applyGuess(stuck, CARD, "PY", at(9000)), "no-guesses-remaining");
});

test("SEC-5: guesses under 400 ms apart are rate-limited, across the challenge boundary too", () => {
  const a = play(["AR"]);
  rejects(() => applyGuess(a, CARD, "BO", at(1399)), "rate-limited");
  assert.equal(applyGuess(a, CARD, "BO", at(1400)).guessCount, 2);

  // The first guess of challenge 2 is throttled against challenge 1's finish,
  // or every handover would hand out one free un-throttled guess.
  const solved = play(["PY"]);
  rejects(() => applyGuess(solved, CARD, "BR", at(1399)), "rate-limited");
});

test("suspicious: a first-guess solve under 2 s is flagged, on whichever challenge it happens", () => {
  assert.equal(play(["PY", "BR", "IT"]).suspicious, true);
  const slow = ["PY", "BR", "IT"].reduce((acc, code, i) => applyGuess(acc, CARD, code, at((i + 1) * 5000)), start());
  assert.equal(slow.suspicious, false);
});

test("applyGuess never mutates its input", () => {
  const a = start();
  const frozen = JSON.stringify(a);
  play(["AR", "PY"], a);
  assert.equal(JSON.stringify(a), frozen);
});

test("unknown codes are rejected as invalid-argument", () => {
  rejects(() => applyGuess(start(), CARD, "ZZ", at(1000)), "invalid-argument");
});

// --- what the client is allowed to see --------------------------------------

test("SEC-1: while a challenge is open the view names nothing, for every country", () => {
  for (const answer of COUNTRIES.values()) {
    const card: CardItem[] = [{ kind: "shape", subject: answer.code }, ...CARD.slice(1)];
    const p: Puzzle = { ...puzzle, items: card };
    const guess = answer.code === "AR" ? "BO" : "AR";
    const view = roundView(applyGuess(newAttempt("u1", p.puzzleId, card, T0), card, guess, at(1000)), p, at(1000));
    assert.equal(view.points, null);
    assert.equal(view.shareGrid, null);
    assert.equal(view.items.every((it) => it.answer === null), true, `${answer.code}: an unfinished challenge revealed an answer`);
    const json = JSON.stringify(view);
    assert.ok(!json.includes(`"code":"${answer.code}"`), `${answer.code}: code in payload`);
    for (const name of [answer.names.en, answer.names["pt-BR"]]) {
      assert.ok(!json.includes(name), `${answer.code}: "${name}" in payload`);
    }
    assert.equal(view.prompt?.kind, "shape");
  }
});

test("SEC-1: a solved challenge reveals its own answer and still says nothing about the next", () => {
  const view = roundView(play(["PY"]), puzzle, at(1000));
  assert.deepEqual(view.items[0]!.answer, { code: "PY", name: "Paraguai" });
  assert.equal(view.items[1]!.answer, null);
  assert.equal(view.items[2]!.answer, null);
  assert.equal(view.items[0]!.points, 6);
  assert.equal(view.points, null, "the day's total waits for the day");
  assert.equal(view.cursor, 1);
  assert.equal(view.prompt?.kind, "flag", "the prompt follows the cursor");
  assert.equal(view.guessesMax, 3, "and so does the guess allowance");
  assert.equal(view.guesses.length, 0, "guesses are the current challenge's only");
  assert.ok(!JSON.stringify(view).includes("Brasil"), "the flag's answer is not out yet");
});

test("the view after the day reveals every answer, the total and the share grid", () => {
  const view = roundView(play(["AR", "PY", "BR", "IT"]), puzzle, at(4000));
  assert.equal(view.status, "solved");
  assert.equal(view.points, 17, "5 + 6 + 6");
  assert.equal(view.maxPoints, 18);
  assert.equal(view.elapsedMs, 4000);
  assert.deepEqual(view.items.map((it) => it.answer?.name), ["Paraguai", "Brasil", "Itália"]);
  assert.deepEqual(view.items.map((it) => it.status), ["solved", "solved", "solved"]);
  assert.equal(view.serverTime, "2026-09-15T15:30:04.000Z");
  assert.equal(view.me, null, "no profile passed → no me");
  assert.deepEqual(
    roundView(play(["AR"]), puzzle, at(1000), newProfile(T0, "tatu-alegre-0001")).me,
    { displayName: "tatu-alegre-0001", role: "player", groupCount: 0 },
  );
});

test("FR-2.11: the share grid is one row per challenge, with the score out of 18", () => {
  const grid = roundView(play(["AR", "PY", "BR", "IT"]), puzzle, at(4000)).shareGrid!;
  const [header, ...rows] = grid.split("\n");
  assert.equal(header, "Mondo 2026-09-15 17/18");
  assert.equal(rows.length, 3, "one row per challenge, however many guesses it took");
  assert.ok(rows[0]!.startsWith("🗺️ "), rows[0]);
  assert.ok(rows[1]!.startsWith("🏳️ "), rows[1]);
  assert.ok(rows[2]!.startsWith("🏙️ "), rows[2]);
  assert.equal(rows[0]!.includes("🎉"), true, "the solving guess is a party");
  // SEC-1 holds for the text people paste into a group chat.
  for (const needle of ["PY", "BR", "IT", "Paraguai", "Brasil", "Itália"]) {
    assert.ok(!grid.includes(needle), `share grid leaks ${needle}`);
  }
});

test("SEC-1: the view gives the 8-point arrow, never the exact bearing", () => {
  // Exact distance AND exact bearing from a public centroid solve for the
  // answer's centroid in closed form, so one guess would have named it.
  const view = roundView(play(["AR"]), puzzle, at(1000));
  const g = view.guesses[0]!;
  assert.equal(g.compass, "NE");
  assert.equal("bearingDeg" in g, false);
  assert.equal(JSON.stringify(view).includes("bearing"), false);
});

// --- days seeded before D-52 ------------------------------------------------

test("D-52: a day seeded as one silhouette still plays, as a one-challenge day", () => {
  const legacy: Puzzle = { puzzleId: "2026-09-14", countryCode: "PY", tier: 1, opensAt: T0 };
  const card = puzzleItems(legacy);
  assert.deepEqual(card, [{ kind: "shape", subject: "PY" }]);
  assert.equal(maxPointsFor(card), 6);

  const a = applyGuess(newAttempt("u1", "2026-09-14", card, T0), card, "PY", at(1000));
  assert.equal(a.points, 6);
  assert.equal(a.solved, true);
  const view = roundView(a, legacy, at(1000));
  assert.equal(view.itemCount, 1);
  assert.equal(view.maxPoints, 6);
  assert.ok(view.shareGrid?.startsWith("Mondo 2026-09-14 6/6\n"));
});

/**
 * The production bug of 2026-09-10. D-52 made `puzzles` backward compatible and
 * forgot `attempts`: the one player who had already played that day had a
 * document with no `items`, and `getRound` answered INTERNAL for the rest of
 * the day. These fixtures are that document's exact shape.
 */
const legacyAttempt = (over: boolean): Attempt => ({
  uid: "u1",
  puzzleId: "2026-09-10",
  startedAt: T0,
  finishedAt: over ? at(6000) : null,
  guesses: ["AR", "BO", "BR", "CL", "UY", "PE"].slice(0, over ? 6 : 2).map((code, i) => ({
    code, distanceKm: 1000, bearingDeg: 90, proximity: 0.5, at: at((i + 1) * 1000),
  })),
  guessCount: over ? 6 : 2,
  solved: false,
  points: 0,
  elapsedMs: over ? 6000 : null,
  mode: "daily",
  suspicious: false,
} as unknown as Attempt);

const legacyPuzzle: Puzzle = { puzzleId: "2026-09-10", countryCode: "GA", tier: 1, opensAt: T0 };

test("D-52: a FINISHED day played before the switch still renders, it does not 500", () => {
  const view = roundView(legacyAttempt(true), legacyPuzzle, at(9000));
  assert.equal(view.status, "failed");
  assert.equal(view.itemCount, 1);
  assert.equal(view.cursor, 1, "a finished one-challenge day sits past its only item");
  assert.equal(view.points, 0);
  assert.equal(view.maxPoints, 6);
  assert.deepEqual(view.items[0]!.answer, { code: "GA", name: "Gabão" });
  assert.equal(view.items[0]!.guessCount, 6);
  assert.ok(view.shareGrid?.startsWith("Mondo 2026-09-10 0/6\n"));
  assert.equal(view.prompt, null);
});

test("D-52: an UNFINISHED day played before the switch can be finished", () => {
  const view = roundView(legacyAttempt(false), legacyPuzzle, at(3000));
  assert.equal(view.status, "in_progress");
  assert.equal(view.cursor, 0);
  assert.equal(view.guessesUsed, 2, "the guesses already spent still count");
  assert.equal(view.guessesMax, 6);
  assert.equal(view.prompt?.kind, "shape");

  const after = applyGuess(legacyAttempt(false), puzzleItems(legacyPuzzle), "GA", at(3000));
  assert.equal(after.solved, true);
  assert.equal(after.points, 4, "solved on the third guess");
  assert.equal(after.guessCount, 3);
  assert.equal(after.items.length, 1);
  assert.equal("guesses" in after, false, "the first guess after the upgrade rewrites the document");
});

test("upgradeAttempt leaves a D-52 attempt exactly as it found it", () => {
  const a = play(["AR", "PY"]);
  assert.equal(upgradeAttempt(a), a, "same object: no copy, no churn");
});

test("a day whose puzzle was re-seeded mid-play is a typed error, not a crash", () => {
  rejects(() => roundView(legacyAttempt(false), puzzle, at(3000)), "not-found");
});

test("a puzzle with neither items nor a country is a typed error, not a crash", () => {
  rejects(() => puzzleItems({ puzzleId: "2026-09-14", opensAt: T0 }), "not-found");
  rejects(() => puzzleItems({ puzzleId: "2026-09-14", items: [], opensAt: T0 }), "not-found");
});

// --- profile counters -------------------------------------------------------

test("FR-3.6: streaks continue on consecutive puzzle days and reset after a gap", () => {
  const p0 = newProfile(T0, "x");
  const day = (id: string, solved: boolean) => ({ ...(solved ? perfect() : play(["AR", "BO", "BR", "CL", "UY", "PE", "AR", "CL", "UY", "BR", "CL", "UY"])), puzzleId: id });
  const p1 = recordCompletion(p0, day("2026-09-15", true));
  assert.deepEqual([p1.currentStreak, p1.longestStreak, p1.totalPlayed, p1.totalSolved, p1.lastPlayedOn], [1, 1, 1, 1, "2026-09-15"]);
  const p2 = recordCompletion(p1, day("2026-09-16", false));
  assert.deepEqual([p2.currentStreak, p2.longestStreak, p2.totalPlayed, p2.totalSolved], [2, 2, 2, 1], "a failed day still keeps the streak");
  const p3 = recordCompletion(p2, day("2026-09-18", true));
  assert.deepEqual([p3.currentStreak, p3.longestStreak], [1, 2], "a missed day resets the streak");
  assert.throws(() => recordCompletion(p3, start()), /unfinished/);
});

test("previousDay crosses month and year boundaries", () => {
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  assert.equal(previousDay("2028-03-01"), "2028-02-29");
  assert.equal(previousDay("2027-01-01"), "2026-12-31");
});

test("FR-1.2 / FR-1.3: random handles are animal-adjective-digits, 3–24 chars, never an email", () => {
  for (let i = 0; i < 500; i++) {
    const h = randomHandle();
    assert.match(h, /^[a-záéíóúãõâêôç]+-[a-záéíóúãõâêôç]+-\d{4}$/u);
    assert.ok(h.length >= 3 && h.length <= 24, h);
  }
  assert.equal(randomHandle(() => 0), "pinguim-veloz-0000");
  assert.equal(randomHandle(() => 0.9999), "ema-esperto-9999");
});

test("FR-7.1 / D-27: a new profile is a player with no groups", () => {
  const p = newProfile(T0);
  assert.equal(p.role, "player");
  assert.deepEqual(p.groups, []);
});

// --- D-30 retries -----------------------------------------------------------

test("D-30: resetAttempt starts the whole day over and keeps the old try in history", () => {
  const old = play(["AR", "BO", "PY"]);
  const reset = resetAttempt(old, CARD, at(60_000), "admin1");
  assert.equal(reset.guessCount, 0);
  assert.equal(reset.cursor, 0, "a retry goes back to the first challenge");
  assert.equal(reset.items.every((it) => it.guesses.length === 0), true);
  assert.equal(reset.finishedAt, null);
  assert.equal(reset.startedAt.toMillis(), at(60_000).toMillis());
  assert.equal(reset.retries, 1);
  assert.equal(reset.history?.length, 1);
  assert.equal(reset.history?.[0]?.points, 0, "the old try had not finished the day");
  assert.equal(reset.history?.[0]?.items[0]?.points, 4, "but its silhouette is on the record");
  assert.equal(reset.history?.[0]?.retryGrantedBy, "admin1");
  assert.ok(!("history" in (reset.history?.[0] ?? {})), "snapshots do not nest");

  const twice = resetAttempt(perfect(), CARD, at(120_000), "admin1");
  assert.equal(twice.retries, 1);
  assert.equal(twice.history?.[0]?.points, 18);
  assert.equal(statusOf(twice), "in_progress");
});

test("D-30: completing a retried day adjusts totalSolved only, never the streak or totalPlayed", () => {
  const p0 = { ...newProfile(T0), lastPlayedOn: "2026-09-14", currentStreak: 3, longestStreak: 3, totalPlayed: 10, totalSolved: 7 };
  const missedTheFlag = play(["PY", "AR", "CL", "UY", "IT"]);
  const p1 = recordCompletion(p0, missedTheFlag);
  assert.deepEqual([p1.lastPlayedOn, p1.currentStreak, p1.totalPlayed, p1.totalSolved], ["2026-09-15", 4, 11, 7]);

  const retried = play(["PY", "BR", "IT"], resetAttempt(missedTheFlag, CARD, at(10_000), "admin1"));
  const p2 = recordCompletion(p1, retried);
  assert.deepEqual([p2.lastPlayedOn, p2.currentStreak, p2.totalPlayed, p2.totalSolved], ["2026-09-15", 4, 11, 8]);

  // Perfect → retried → missed one: back down, not below.
  const q1 = recordCompletion(p0, perfect());
  const q2 = recordCompletion(q1, play(["PY", "AR", "CL", "UY", "IT"], resetAttempt(perfect(), CARD, at(10_000), "admin1")));
  assert.equal(q1.totalSolved, 8);
  assert.equal(q2.totalSolved, 7);
  assert.equal(q2.totalPlayed, 11);
});

// --- telemetry --------------------------------------------------------------

test("intervalsMs: served→first guess then guess→guess, concatenated across the day", () => {
  assert.deepEqual(intervalsMs(start()), []);
  assert.deepEqual(intervalsMs(play(["AR"])), [1000]);
  assert.deepEqual(intervalsMs(play(["AR", "PY", "BR"])), [1000, 1000, 1000]);
  const a = applyGuess(applyGuess(start(), CARD, "AR", at(500)), CARD, "BO", at(2500));
  assert.deepEqual(intervalsMs(a), [500, 2000]);
});

test("intervalsMs still reads an attempt written before D-52", () => {
  const legacy = {
    startedAt: T0,
    guesses: [{ code: "AR", distanceKm: 1, bearingDeg: 1, proximity: 1, at: at(1500) }, { code: "PY", distanceKm: 0, bearingDeg: 0, proximity: 1, at: at(4000) }],
  } as unknown as Attempt;
  assert.deepEqual(intervalsMs(legacy), [1500, 2500]);
});
