/**
 * Batata Quente's rules (FR-12.3). Pure: the clock is a number passed in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsError } from "firebase-functions/v2/https";
import { COUNTRIES } from "../src/lib/countries";
import {
  applyAnswer, applyTimeout, giveUpPotato, newPotato, pointsFor, potatoRanking, turnLimitMs,
  POTATO_TOTAL, type PotatoState,
} from "../src/lib/potato";

const T0 = 1_800_000_000_000;
const CODES = [...COUNTRIES.keys()];

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

test("the turn shrinks a second a round, from 20 to a floor of 3", () => {
  assert.equal(turnLimitMs(1), 20_000);
  assert.equal(turnLimitMs(2), 19_000);
  assert.equal(turnLimitMs(17), 4_000);
  assert.equal(turnLimitMs(18), 3_000);
  assert.equal(turnLimitMs(19), 3_000);
  assert.equal(turnLimitMs(40), 3_000);
});

test("an answer is worth 10 at once, 1 at the buzzer, and never less", () => {
  assert.equal(pointsFor(0, 20_000), 10);
  assert.equal(pointsFor(10_000, 20_000), 5);
  assert.equal(pointsFor(19_999, 20_000), 1);
  assert.equal(pointsFor(20_000, 20_000), 1);
  assert.equal(pointsFor(-50, 3_000), 10);
});

test("a right answer scores and passes the turn; a round closes after everyone", () => {
  let s = newPotato(["a", "b", "c"], T0);
  assert.equal(s.turnUid, "a");
  s = applyAnswer(s, "a", "BR", T0 + 2_000).state;
  assert.equal(s.scores.a!.points, 9);
  assert.equal(s.scores.a!.timeMs, 2_000);
  assert.equal(s.turnUid, "b");
  assert.equal(s.round, 1);
  s = applyAnswer(s, "b", "AR", T0 + 3_000).state;
  s = applyAnswer(s, "c", "CL", T0 + 4_000).state;
  assert.equal(s.turnUid, "a");
  assert.equal(s.round, 2);
  assert.equal(s.limitMs, 19_000);
  assert.equal(s.deadline, T0 + 4_000 + 19_000);
});

test("a country already on the map does not pass the turn", () => {
  let s = newPotato(["a", "b"], T0);
  s = applyAnswer(s, "a", "BR", T0 + 1_000).state;
  rejects(() => applyAnswer(s, "b", "BR", T0 + 2_000), "already-named");
  assert.equal(s.turnUid, "b"); // still b's turn
});

test("only the player whose turn it is may answer, and only in time", () => {
  const s = newPotato(["a", "b"], T0);
  rejects(() => applyAnswer(s, "b", "BR", T0 + 1), "not-your-turn");
  rejects(() => applyAnswer(s, "a", "BR", T0 + 20_000), "time-up");
});

test("a timeout passes the turn for nothing", () => {
  let s = newPotato(["a", "b"], T0);
  rejects(() => applyTimeout(s, T0 + 19_999), "invalid-argument");
  s = applyTimeout(s, T0 + 20_000);
  assert.equal(s.turnUid, "b");
  assert.equal(s.scores.a!.points, 0);
  assert.equal(s.passStreak, 1);
});

test("players who gave up are skipped, and keep what they scored", () => {
  let s = newPotato(["a", "b", "c"], T0);
  s = applyAnswer(s, "a", "BR", T0 + 1_000).state;
  s = giveUpPotato(s, "c", T0 + 1_500);
  s = applyAnswer(s, "b", "AR", T0 + 2_000).state;
  assert.equal(s.turnUid, "a");
  assert.equal(s.round, 2);
  assert.equal(s.scores.a!.points, 10);
  // Giving up on your own turn hands it on.
  s = giveUpPotato(s, "a", T0 + 2_500);
  assert.equal(s.turnUid, "b");
});

test("two silent rounds end the game", () => {
  let s = newPotato(["a", "b"], T0);
  let now = T0;
  for (let i = 0; i < 3; i++) {
    now = s.deadline!;
    s = applyTimeout(s, now);
    assert.equal(s.endedAt, null);
  }
  s = applyTimeout(s, s.deadline!);
  assert.equal(s.endReason, "silence");
  assert.equal(s.turnUid, null);
  rejects(() => applyTimeout(s, s.deadline! + 1), "already-completed");
});

test("an answer resets the silence", () => {
  let s = newPotato(["a", "b"], T0);
  s = applyTimeout(s, s.deadline!);
  s = applyTimeout(s, s.deadline!);
  s = applyTimeout(s, s.deadline!);
  s = applyAnswer(s, "b", "BR", s.turnStartedAt + 100).state;
  assert.equal(s.passStreak, 0);
  assert.equal(s.endedAt, null);
});

test("everyone giving up ends the game", () => {
  let s = newPotato(["a", "b"], T0);
  s = giveUpPotato(s, "a", T0 + 1);
  assert.equal(s.endedAt, null);
  s = giveUpPotato(s, "b", T0 + 2);
  assert.equal(s.endReason, "all-gave-up");
});

test("the game ends when every country is on the map", () => {
  assert.equal(POTATO_TOTAL, COUNTRIES.size);
  let s: PotatoState = newPotato(["a", "b", "c"], T0);
  for (const code of CODES) s = applyAnswer(s, s.turnUid!, code, s.turnStartedAt + 10).state;
  assert.equal(s.endReason, "map-full");
  assert.equal(s.named.length, POTATO_TOTAL);
});

test("ranking: most points, then least time", () => {
  let s = newPotato(["a", "b", "c"], T0);
  s = applyAnswer(s, "a", "BR", s.turnStartedAt + 2_000).state; // 9 in 2s
  s = applyAnswer(s, "b", "AR", s.turnStartedAt + 2_000).state; // 9 in 2s
  s = applyAnswer(s, "c", "CL", s.turnStartedAt + 0).state; // 10
  s = applyAnswer(s, "a", "PE", s.turnStartedAt + 1_000).state; // a: +9 (1s of 19s ≈ 9.47 → 9) — 18 in 3s
  s = applyAnswer(s, "b", "UY", s.turnStartedAt + 1_400).state; // b: +9 — 18 in 3.4s
  assert.deepEqual(potatoRanking(s), ["a", "b", "c"]);
});

test("training has no clock: a country is worth 1 whenever it comes, and nothing times out (D-93)", () => {
  let s = newPotato(["a"], T0, false);
  assert.equal(s.deadline, null);
  assert.equal(s.limitMs, null);
  s = applyAnswer(s, "a", "BR", T0 + 3_600_000).state; // an hour in, still on time
  rejects(() => applyTimeout(s, T0 + 7_200_000), "invalid-argument");
  rejects(() => applyAnswer(s, "a", "BR", T0 + 3_600_001), "already-named");
  s = applyAnswer(s, "a", "AR", T0 + 3_600_002).state;
  assert.equal(s.turnUid, "a");
  assert.equal(s.deadline, null);
  assert.deepEqual(s.scores.a, { points: 2, timeMs: 3_600_000 + 2, named: 2 });
});

test("training ends when you stop, or when the map is full (D-93)", () => {
  assert.equal(giveUpPotato(newPotato(["a"], T0, false), "a", T0 + 1).endReason, "all-gave-up");
  let s = newPotato(["a"], T0, false);
  for (const code of CODES) s = applyAnswer(s, "a", code, T0 + 10).state;
  assert.equal(s.endReason, "map-full");
  assert.equal(s.scores.a!.points, POTATO_TOTAL);
});
