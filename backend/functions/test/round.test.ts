import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  applyGuess, intervalsMs, newAttempt, newProfile, previousDay, randomHandle, recordCompletion, resetAttempt, roundView, statusOf,
  type Attempt, type Puzzle,
} from "../src/lib/round";
import { COUNTRIES } from "../src/lib/countries";
import { distanceKm } from "../src/lib/geo";

const T0 = Timestamp.fromMillis(Date.parse("2026-09-15T15:30:00Z"));
const at = (plusMs: number) => Timestamp.fromMillis(T0.toMillis() + plusMs);
const puzzle: Puzzle = { puzzleId: "2026-09-15", countryCode: "PY", tier: 1, opensAt: Timestamp.fromMillis(Date.parse("2026-09-15T15:00:00Z")) };
const start = () => newAttempt("u1", "2026-09-15", T0);

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

/** Play `codes` one second apart; returns the attempt after the last. */
function play(codes: string[], a: Attempt = start()): Attempt {
  return codes.reduce((acc, code, i) => applyGuess(acc, puzzle, code, at((i + 1) * 1000)), a);
}

test("a wrong guess records distance, bearing and proximity and leaves the round open", () => {
  const a = play(["AR"]);
  assert.equal(a.guessCount, 1);
  assert.equal(a.finishedAt, null);
  assert.equal(statusOf(a), "in_progress");
  const g = a.guesses[0]!;
  assert.equal(g.code, "AR");
  assert.equal(g.distanceKm, distanceKm(COUNTRIES.get("AR")!.centroid, COUNTRIES.get("PY")!.centroid));
  assert.ok(g.distanceKm > 800 && g.distanceKm < 1600, `AR→PY ${g.distanceKm} km`);
  assert.ok(g.bearingDeg > 0 && g.bearingDeg < 90, `AR→PY bearing ${g.bearingDeg} should be north-east`);
  assert.ok(g.proximity > 0.9);
});

test("FR-3.1: solving on the third guess ends the round with 4 points", () => {
  const a = play(["AR", "BO", "PY"]);
  assert.equal(statusOf(a), "solved");
  assert.equal(a.points, 4);
  assert.equal(a.elapsedMs, 3000);
  assert.equal(a.guesses[2]!.distanceKm, 0);
  assert.equal(a.guesses[2]!.proximity, 1);
  assert.equal(a.suspicious, false);
});

test("FR-2.8: six wrong guesses end the round as failed with 0 points", () => {
  const a = play(["AR", "BO", "BR", "CL", "UY", "PE"]);
  assert.equal(statusOf(a), "failed");
  assert.equal(a.points, 0);
  assert.equal(a.solved, false);
  assert.equal(a.finishedAt?.toMillis(), at(6000).toMillis());
});

test("FR-2.10 / SEC-4: no guess after the round is over, solved or failed", () => {
  rejects(() => applyGuess(play(["PY"]), puzzle, "AR", at(9000)), "already-completed");
  rejects(() => applyGuess(play(["AR", "BO", "BR", "CL", "UY", "PE"]), puzzle, "PY", at(9000)), "already-completed");
});

test("SEC-4: a corrupted unfinished attempt with six guesses still cannot take a seventh", () => {
  const six = { ...play(["AR", "BO", "BR", "CL", "UY", "PE"]), finishedAt: null };
  rejects(() => applyGuess(six, puzzle, "PY", at(9000)), "no-guesses-remaining");
});

test("SEC-5: guesses under 400 ms apart are rate-limited; 400 ms is fine", () => {
  const a = play(["AR"]);
  rejects(() => applyGuess(a, puzzle, "BO", at(1000 + 399)), "rate-limited");
  assert.equal(applyGuess(a, puzzle, "BO", at(1000 + 400)).guessCount, 2);
});

test("suspicious: a first-guess solve under 2 s is flagged, a slower one is not", () => {
  assert.equal(applyGuess(start(), puzzle, "PY", at(1999)).suspicious, true);
  assert.equal(applyGuess(start(), puzzle, "PY", at(2000)).suspicious, false);
});

test("applyGuess never mutates its input", () => {
  const a = start();
  const frozen = JSON.stringify(a);
  play(["AR", "PY"], a);
  assert.equal(JSON.stringify(a), frozen);
});

test("unknown codes are rejected as invalid-argument", () => {
  rejects(() => applyGuess(start(), puzzle, "ZZ", at(1000)), "invalid-argument");
});

test("SEC-1: while in progress the view has answer null and leaks no answer name or code, for every country", () => {
  for (const answer of COUNTRIES.values()) {
    const p: Puzzle = { ...puzzle, countryCode: answer.code };
    const guess = answer.code === "AR" ? "BO" : "AR";
    const view = roundView(applyGuess(newAttempt("u1", p.puzzleId, T0), p, guess, at(1000)), p, at(1000));
    assert.equal(view.answer, null);
    assert.equal(view.points, null);
    assert.equal(view.shareGrid, null);
    const json = JSON.stringify(view);
    assert.ok(!json.includes(`"code":"${answer.code}"`), `${answer.code}: code in payload`);
    for (const name of [answer.names.en, answer.names["pt-BR"]]) {
      assert.ok(!json.includes(name), `${answer.code}: "${name}" in payload`);
    }
    assert.deepEqual(Object.keys(view.shape).sort(), ["d", "fillRule", "viewBox"]);
  }
});

test("the view after the round reveals the answer, points and share grid", () => {
  const view = roundView(play(["AR", "PY"]), puzzle, at(2000));
  assert.equal(view.status, "solved");
  assert.deepEqual(view.answer, { code: "PY", name: "Paraguai" });
  assert.equal(view.points, 5);
  assert.equal(view.elapsedMs, 2000);
  assert.ok(view.shareGrid?.startsWith("Mondo 2026-09-15 2/6\n"));
  assert.equal(view.guessesUsed, 2);
  assert.equal(view.guessesMax, 6);
  assert.equal(view.guesses[0]!.name, "Argentina");
  assert.equal(view.guesses[0]!.compass, "NE");
  assert.equal(view.serverTime, "2026-09-15T15:30:02.000Z");
  assert.equal(view.me, null, "no profile passed → no me");
  assert.deepEqual(roundView(play(["AR"]), puzzle, at(1000), newProfile(T0, "tatu-alegre-0001")).me, { displayName: "tatu-alegre-0001" });
});

test("FR-3.6: streaks continue on consecutive puzzle days and reset after a gap", () => {
  const p0 = newProfile(T0, "x");
  const day = (id: string, solved: boolean) => ({ ...play(solved ? ["PY"] : ["AR", "BO", "BR", "CL", "UY", "PE"]), puzzleId: id });
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

test("D-30: resetAttempt starts over now and keeps the old try in history", () => {
  const old = play(["AR", "BO", "PY"]);
  const reset = resetAttempt(old, at(60_000), "admin1");
  assert.equal(reset.guessCount, 0);
  assert.equal(reset.finishedAt, null);
  assert.equal(reset.startedAt.toMillis(), at(60_000).toMillis());
  assert.equal(reset.retries, 1);
  assert.equal(reset.history?.length, 1);
  assert.equal(reset.history?.[0]?.points, 4);
  assert.equal(reset.history?.[0]?.retryGrantedBy, "admin1");
  assert.ok(!("history" in (reset.history?.[0] ?? {})), "snapshots do not nest");

  const twice = resetAttempt(play(["PY"], reset), at(120_000), "admin1");
  assert.equal(twice.retries, 2);
  assert.equal(twice.history?.length, 2);
  assert.equal(twice.history?.[1]?.points, 6);
  assert.equal(statusOf(twice), "in_progress");
});

test("D-30: completing a retried day adjusts totalSolved only, never the streak or totalPlayed", () => {
  const p0 = { ...newProfile(T0), lastPlayedOn: "2026-09-14", currentStreak: 3, longestStreak: 3, totalPlayed: 10, totalSolved: 7 };
  const failed = play(["AR", "BO", "BR", "CL", "UY", "PE"]);
  const p1 = recordCompletion(p0, failed);
  assert.deepEqual([p1.lastPlayedOn, p1.currentStreak, p1.totalPlayed, p1.totalSolved], ["2026-09-15", 4, 11, 7]);

  const retried = play(["PY"], resetAttempt(failed, at(10_000), "admin1"));
  const p2 = recordCompletion(p1, retried);
  assert.deepEqual([p2.lastPlayedOn, p2.currentStreak, p2.totalPlayed, p2.totalSolved], ["2026-09-15", 4, 11, 8]);

  // Solved → retried → failed again: back down, not below.
  const solvedFirst = play(["PY"]);
  const q1 = recordCompletion(p0, solvedFirst);
  const q2 = recordCompletion(q1, play(["AR", "BO", "BR", "CL", "UY", "PE"], resetAttempt(solvedFirst, at(10_000), "admin1")));
  assert.equal(q1.totalSolved, 8);
  assert.equal(q2.totalSolved, 7);
  assert.equal(q2.totalPlayed, 11);
});

test("intervalsMs: start→first guess, then guess→guess", () => {
  assert.deepEqual(intervalsMs(start()), []);
  assert.deepEqual(intervalsMs(play(["AR"])), [1000]);
  assert.deepEqual(intervalsMs(play(["AR", "BO", "BR", "CL", "UY", "PE"])), [1000, 1000, 1000, 1000, 1000, 1000]);
  const a = applyGuess(applyGuess(start(), puzzle, "AR", at(500)), puzzle, "BO", at(2500));
  assert.deepEqual(intervalsMs(a), [500, 2000]);
});
