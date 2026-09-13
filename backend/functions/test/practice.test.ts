/**
 * Practice: the session state machine (FR-9). Pure, so no emulator.
 *
 * Two tests here are load-bearing rather than descriptive. **D-60** — a subject
 * the daily schedule is about to use must never be served, because the `gdp`
 * and `capital` prompts name half of their own answer and a player could
 * otherwise grind practice until today's came up. And **the totals** — a
 * challenge is counted exactly once, whether the player moved on from it or
 * left on it, because both paths roll the same item into the same sum.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { gdpFor } from "../src/lib/countries";
import { MAX_ITEM_POINTS, KINDS, type KindId } from "../src/lib/kinds";
import {
  applyPracticeGuess, endSession, newSession, practiceView, serveNext,
  type PracticeSession,
} from "../src/lib/practice";

const T0 = Timestamp.fromMillis(Date.parse("2026-09-15T15:30:00Z"));
const at = (plusMs: number) => Timestamp.fromMillis(T0.toMillis() + plusMs);
const UID = "u-practice";

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

// Three of the four kinds take a country code and `gdp` takes a number (D-53),
// so the tests ask the kind what a right and a wrong answer look like rather
// than assuming the guess is always a country.
const right = (s: PracticeSession) => (s.kind === "gdp" ? gdpFor(s.subject)! : s.subject);
const wrong = (s: PracticeSession) =>
  s.kind === "gdp" ? gdpFor(s.subject)! * 10 : KINDS[s.kind].pool().find((c) => c.code !== s.subject)!.code;

/** Guess the answer, then look at what came back. */
const solve = (s: PracticeSession, ms: number) => applyPracticeGuess(s, right(s), at(ms));

/** Guess anything but the answer. */
const missOnce = (s: PracticeSession, ms: number) => applyPracticeGuess(s, wrong(s), at(ms));

/** Miss until the challenge runs out of guesses. */
function exhaust(s: PracticeSession): PracticeSession {
  let ms = 1000;
  while (s.item.finishedAt === null) {
    s = missOnce(s, ms);
    ms += 1000;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Serving challenges
// ---------------------------------------------------------------------------

test("a new session opens on a challenge of the chosen kind, unplayed", () => {
  const s = newSession(UID, "flag", [], T0);
  assert.equal(s.kind, "flag");
  assert.equal(s.item.kind, "flag");
  assert.deepEqual(s.item.guesses, []);
  assert.equal(s.item.finishedAt, null);
  assert.equal(s.item.startedAt?.toMillis(), T0.toMillis());
  assert.deepEqual(s.totals, { played: 0, solved: 0, points: 0 });
  assert.deepEqual(s.asked, [s.subject]);
});

test("D-60: a blocked subject is never served, however long the session runs", () => {
  // Block all but three, so a picker that ignored `blocked` would be caught on
  // the first challenge rather than after a lucky streak.
  const pool = KINDS.capital.pool().map((c) => c.code);
  const allowed = pool.slice(0, 3);
  const blocked = pool.slice(3);

  let s = newSession(UID, "capital", blocked, T0);
  const seen = new Set([s.subject]);
  for (let i = 0; i < 30; i++) {
    s = serveNext(exhaust(s), at(100_000 + i * 10_000));
    seen.add(s.subject);
  }
  assert.deepEqual([...seen].sort(), [...allowed].sort());
});

test("a session does not repeat itself until the pool runs out, then starts over", () => {
  const pool = KINDS.shape.pool().map((c) => c.code);
  const blocked = pool.slice(2); // exactly two countries left to ask about

  let s = newSession(UID, "shape", blocked, T0);
  const first = s.subject;
  s = serveNext(exhaust(s), at(10_000));
  assert.notEqual(s.subject, first, "the second challenge repeated the first");
  assert.equal(s.asked.length, 2);

  // Both are used up; the third has to recycle, and the memory resets to it.
  s = serveNext(exhaust(s), at(20_000));
  assert.deepEqual(s.asked, [s.subject]);
  assert.ok(pool.slice(0, 2).includes(s.subject));
});

// ---------------------------------------------------------------------------
// Playing one challenge
// ---------------------------------------------------------------------------

test("a first-guess solve is worth six, and the challenge is over", () => {
  const solved = solve(newSession(UID, "shape", [], T0), 1000);
  assert.equal(solved.item.solved, true);
  assert.equal(solved.item.points, MAX_ITEM_POINTS);
  assert.ok(solved.item.finishedAt !== null);
  // Not counted yet: `next` or `end` is what counts it.
  assert.deepEqual(solved.totals, { played: 0, solved: 0, points: 0 });
});

test("the guess budget is the kind's, and running out ends the challenge at zero", () => {
  const failed = exhaust(newSession(UID, "flag", [], T0));
  assert.equal(failed.item.guesses.length, KINDS.flag.maxGuesses);
  assert.equal(failed.item.solved, false);
  assert.equal(failed.item.points, 0);
});

test("a finished challenge takes no further guess", () => {
  const solved = solve(newSession(UID, "capital", [], T0), 1000);
  // The card transitions guard the CARD's finish, which a one-item practice
  // session never stores — without practice's own guard this would grade twice.
  rejects(() => applyPracticeGuess(solved, right(solved), at(2000)), "already-completed");
});

test("SEC-5: the 400 ms floor is the card's, and practice inherits it", () => {
  const s = missOnce(newSession(UID, "shape", [], T0), 1000);
  rejects(() => missOnce(s, 1100), "rate-limited");
});

test("an ended session takes neither a guess nor a next", () => {
  const over = endSession(newSession(UID, "shape", [], T0), at(5000));
  rejects(() => applyPracticeGuess(over, right(over), at(6000)), "already-completed");
  rejects(() => serveNext(over, at(6000)), "already-completed");
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

test("moving on counts the challenge exactly once", () => {
  let s = solve(newSession(UID, "shape", [], T0), 1000);
  s = serveNext(s, at(2000));
  assert.deepEqual(s.totals, { played: 1, solved: 1, points: MAX_ITEM_POINTS });

  s = serveNext(exhaust(s), at(60_000));
  assert.deepEqual(s.totals, { played: 2, solved: 1, points: MAX_ITEM_POINTS });
});

test("leaving on a finished challenge counts it; leaving mid-challenge does not", () => {
  const solved = solve(newSession(UID, "shape", [], T0), 1000);
  assert.deepEqual(endSession(solved, at(2000)).totals, { played: 1, solved: 1, points: MAX_ITEM_POINTS });

  const midway = missOnce(newSession(UID, "shape", [], T0), 1000);
  assert.deepEqual(endSession(midway, at(2000)).totals, { played: 0, solved: 0, points: 0 });
});

test("leaving twice does not count the last challenge twice", () => {
  const once = endSession(solve(newSession(UID, "shape", [], T0), 1000), at(2000));
  assert.deepEqual(endSession(once, at(3000)), once);
});

// ---------------------------------------------------------------------------
// What the client sees (SEC-1)
// ---------------------------------------------------------------------------

test("an open challenge sends a prompt and no answer", () => {
  const v = practiceView(newSession(UID, "capital", [], T0), T0);
  assert.equal(v.status, "in_progress");
  assert.equal(v.item?.status, "current");
  assert.equal(v.item?.prompt?.kind, "capital");
  assert.equal(v.item?.answer, null);
  assert.equal(v.item?.points, null);
  assert.equal(v.item?.guessesMax, KINDS.capital.maxGuesses);
});

test("a finished challenge sends the answer and no prompt", () => {
  const s = solve(newSession(UID, "shape", [], T0), 1000);
  const v = practiceView(s, at(1000));
  assert.equal(v.item?.status, "solved");
  assert.equal(v.item?.prompt, null, "the prompt outlived the challenge");
  assert.equal(v.item?.answer?.code, s.subject);
  assert.equal(v.item?.points, MAX_ITEM_POINTS);
  assert.equal(v.item?.guesses.length, 1);
});

test("an abandoned challenge takes its answer with it", () => {
  const midway = missOnce(newSession(UID, "shape", [], T0), 1000);
  const v = practiceView(endSession(midway, at(2000)), at(2000));
  assert.equal(v.status, "ended");
  assert.equal(v.item, null);
  assert.deepEqual(v.totals, { played: 0, solved: 0, points: 0, maxPoints: 0 });
});

test("maxPoints is six a challenge, counted from what was played", () => {
  let s = newSession(UID, "shape", [], T0);
  for (let i = 0; i < 3; i++) s = serveNext(exhaust(s), at(100_000 * (i + 1)));
  const v = practiceView(endSession(s, at(500_000)), at(500_000));
  assert.equal(v.totals.played, 3);
  assert.equal(v.totals.maxPoints, 3 * MAX_ITEM_POINTS);
});

test("every shipped kind can be practised", () => {
  for (const id of Object.keys(KINDS) as KindId[]) {
    const s = newSession(UID, id, [], T0);
    assert.equal(practiceView(s, T0).item?.prompt?.kind, id, `${id} served no prompt`);
    assert.equal(solve(s, 1000).item.points, MAX_ITEM_POINTS, `${id} did not score a first-guess solve`);
  }
});
