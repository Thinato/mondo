/**
 * Standings arithmetic (FR-3.4, FR-3.5, FR-3.6, D-24, D-25). This is the file
 * people will argue about, so the main fixture is one a human can redo in a
 * spreadsheet in ten minutes. Do that once before trusting the board
 * (docs/04-roadmap.md Phase 2 acceptance).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceAllTime, effectiveStreak, nextDay, rankBy, statsFor, windowDays, EMPTY_STATS, type FinishedResult,
} from "../src/lib/standings";

// ---------------------------------------------------------------------------
// Fixture: the 30 puzzle days 2026-10-01 … 2026-10-30, closed day = 2026-10-30.
//
//   day  →  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30
//   A       6  5  4  3  2  1  6  5  4  3  2  1  6  5  4  3  2  1  6  5  4  3  2  1  6  5  4  3  2  0(x)
//   B       -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6  -  6
//   C       -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  6
//
//   "-" = never started (counts 0), "0(x)" = played and failed (0 points, 6 guesses).
//   Guess count for a p-point day is 7 − p (FR-3.1); failed = 6.
//   Elapsed per played day: A 60 000 ms, B 30 000 ms, C 10 000 ms.
//
//   A  last30: sum = 4×21 + (6+5+4+3+2+0) = 104; two lowest of 30 are 0 and 1 → 103
//      played 30, guesses 4×21 + (1+2+3+4+5+6) = 105 → avg 3.5, elapsed 1 800 000
//      last7 (days 24–30): 1 6 5 4 3 2 0 → 21; guesses 6+1+2+3+4+5+6 = 27 → avg 3.9 (27/7 = 3.857); elapsed 420 000
//   B  last30: 15 × 6 = 90; two lowest are unplayed zeros → 90
//      played 15, avg 1.0, elapsed 450 000
//      last7: days 24 26 28 30 → 24; played 4; avg 1.0; elapsed 120 000
//   C  last30: 6 (28 zeros, two dropped) ; played 1; avg 1.0; elapsed 10 000
//      last7: 6; played 1
//   Ranks (last30): A 1, B 2, C 3.
// ---------------------------------------------------------------------------

const CLOSED = "2026-10-30";
const DAYS = windowDays(CLOSED, 30);
const day = (n: number) => DAYS[n - 1]!;

function result(n: number, points: number, elapsedMs: number): FinishedResult {
  return { puzzleId: day(n), points, guessCount: points > 0 ? 7 - points : 6, elapsedMs };
}

const A_SCORES = [6, 5, 4, 3, 2, 1, 6, 5, 4, 3, 2, 1, 6, 5, 4, 3, 2, 1, 6, 5, 4, 3, 2, 1, 6, 5, 4, 3, 2, 0];
const A = A_SCORES.map((p, i) => result(i + 1, p, 60_000));
const B = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30].map((n) => result(n, 6, 30_000));
const C = [result(30, 6, 10_000)];

test("windowDays: 30 consecutive days ending at the closed day, ascending", () => {
  assert.equal(DAYS.length, 30);
  assert.equal(DAYS[0], "2026-10-01");
  assert.equal(DAYS[29], "2026-10-30");
  assert.deepEqual(windowDays("2026-03-01", 2), ["2026-02-28", "2026-03-01"]);
});

test("nextDay crosses month and year boundaries", () => {
  assert.equal(nextDay("2026-02-28"), "2026-03-01");
  assert.equal(nextDay("2028-02-28"), "2028-02-29");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
  assert.equal(nextDay(CLOSED), "2026-10-31");
});

test("fixture A: 30 played days, drop the 0 and one 1", () => {
  const s = statsFor(A, DAYS, 2);
  assert.deepEqual(s, { points: 103, played: 30, totalGuesses: 105, avgGuesses: 3.5, totalElapsedMs: 1_800_000 });
  const s7 = statsFor(A, DAYS.slice(-7), 0);
  assert.deepEqual(s7, { points: 21, played: 7, totalGuesses: 27, avgGuesses: 3.9, totalElapsedMs: 420_000 });
});

test("fixture B: unplayed days are zeros, so the drop costs nothing", () => {
  assert.deepEqual(statsFor(B, DAYS, 2), { points: 90, played: 15, totalGuesses: 15, avgGuesses: 1, totalElapsedMs: 450_000 });
  assert.deepEqual(statsFor(B, DAYS.slice(-7), 0), { points: 24, played: 4, totalGuesses: 4, avgGuesses: 1, totalElapsedMs: 120_000 });
});

test("fixture C: one played day keeps its full score", () => {
  assert.deepEqual(statsFor(C, DAYS, 2), { points: 6, played: 1, totalGuesses: 1, avgGuesses: 1, totalElapsedMs: 10_000 });
  assert.deepEqual(statsFor(C, DAYS.slice(-7), 0), { points: 6, played: 1, totalGuesses: 1, avgGuesses: 1, totalElapsedMs: 10_000 });
});

test("fixture ranks: A 1, B 2, C 3 in the 30-day window", () => {
  const rows = [C, A, B].map((r) => statsFor(r, DAYS, 2));
  assert.deepEqual(rankBy(rows, (s) => s), [3, 1, 2]);
});

test("nothing played → 0 points, avgGuesses null", () => {
  assert.deepEqual(statsFor([], DAYS, 2), { ...EMPTY_STATS });
});

test("D-24: a played-and-failed 0 and an unplayed day are equal for points, different for played", () => {
  const failed = statsFor([result(30, 0, 5_000)], DAYS, 2);
  const absent = statsFor([], DAYS, 2);
  assert.equal(failed.points, absent.points);
  assert.equal(failed.played, 1);
  assert.equal(absent.played, 0);
});

test("results outside the window are ignored", () => {
  const stale = [{ puzzleId: "2026-09-30", points: 6, guessCount: 1, elapsedMs: 1 }, { puzzleId: "2026-10-31", points: 6, guessCount: 1, elapsedMs: 1 }];
  assert.deepEqual(statsFor(stale, DAYS, 2), { ...EMPTY_STATS });
});

test("drop larger than the window does not go negative", () => {
  assert.equal(statsFor(C, DAYS.slice(-1), 5).points, 0);
});

test("advanceAllTime folds only new days and is idempotent for the same closed day", () => {
  const first = advanceAllTime({ allTime: EMPTY_STATS, allTimeThrough: null }, A, CLOSED);
  assert.equal(first.allTime.points, 104); // no drop in all-time
  assert.equal(first.allTime.played, 30);
  assert.equal(first.allTime.avgGuesses, 3.5);
  assert.equal(first.allTimeThrough, CLOSED);

  const again = advanceAllTime(first, A, CLOSED);
  assert.deepEqual(again, first);

  const nextDay = "2026-10-31";
  const withNext = advanceAllTime(first, [...A, { puzzleId: nextDay, points: 4, guessCount: 3, elapsedMs: 1_000 }], nextDay);
  assert.equal(withNext.allTime.points, 108);
  assert.equal(withNext.allTime.played, 31);
  assert.equal(withNext.allTimeThrough, nextDay);
});

test("advanceAllTime never folds days after the closed day", () => {
  const r = advanceAllTime({ allTime: EMPTY_STATS, allTimeThrough: null }, [{ puzzleId: "2026-11-01", points: 6, guessCount: 1, elapsedMs: 1 }], CLOSED);
  assert.equal(r.allTime.points, 0);
});

test("rankBy: competition ranking, elapsed breaks ties, equal on both shares a rank", () => {
  const rows = [
    { points: 10, totalElapsedMs: 500 }, // 1
    { points: 8, totalElapsedMs: 900 },  // 3 (slower)
    { points: 8, totalElapsedMs: 100 },  // 2
    { points: 5, totalElapsedMs: 100 },  // 4
    { points: 5, totalElapsedMs: 100 },  // 4
    { points: 0, totalElapsedMs: 0 },    // 6
  ];
  assert.deepEqual(rankBy(rows, (r) => r), [1, 3, 2, 4, 4, 6]);
  assert.deepEqual(rankBy([], (r: { points: number; totalElapsedMs: number }) => r), []);
});

test("effectiveStreak: stands only when the last play was the closed day or today", () => {
  const p = (lastPlayedOn: string | null) => ({ lastPlayedOn, currentStreak: 7 });
  assert.equal(effectiveStreak(p("2026-10-30"), "2026-10-30", "2026-10-31"), 7);
  assert.equal(effectiveStreak(p("2026-10-31"), "2026-10-30", "2026-10-31"), 7);
  assert.equal(effectiveStreak(p("2026-10-29"), "2026-10-30", "2026-10-31"), 0);
  assert.equal(effectiveStreak(p(null), "2026-10-30", "2026-10-31"), 0);
});
