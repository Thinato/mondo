/**
 * D-77 — the self-reported visibility record.
 *
 * Two things are under test and the second is the important one. The parser,
 * because anything arriving from a client is refused rather than coerced. And
 * the boundary: a claim may be stored, read and shown to a human, and may never
 * touch a score. The test that would catch a violation of that is the one that
 * scores the same guess twice, with and without a report, and demands the same
 * number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { countImpossible, EMPTY_REPORT, parseSelfReport, reportExceedsInterval, type SelfReport } from "../src/lib/report";
import { applyCardGuess, cardIntervalsMs, cardSelfReports, newCardPlay, type CardItem, type CardPlay } from "../src/lib/card";

const T0 = Timestamp.fromMillis(Date.parse("2026-09-22T15:00:00Z"));
const at = (ms: number) => Timestamp.fromMillis(T0.toMillis() + ms);
const CARD: CardItem[] = [{ kind: "capital", subject: "IT" }, { kind: "shape", subject: "PY" }];
const report = (o: Partial<SelfReport> = {}): SelfReport => ({ ...EMPTY_REPORT, ...o });

const rejects = (fn: () => unknown) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code: "invalid-argument" });
    return true;
  });

// --- the parser -------------------------------------------------------------

test("a client that sends nothing is an older page, not an error", () => {
  // The field is optional forever: a browser holding last month's game.js must
  // keep playing. `null` and absent mean the same thing — no claim was made.
  assert.equal(parseSelfReport(undefined), null);
  assert.equal(parseSelfReport(null), null);
});

test("a well-formed report survives intact", () => {
  const r = parseSelfReport({ hides: 3, blurs: 1, hiddenMs: 42_000, platform: "mobile" });
  assert.deepEqual(r, { hides: 3, blurs: 1, hiddenMs: 42_000, platform: "mobile" });
});

test("a report of nothing is still a report", () => {
  // The whole design rests on this being sent and stored rather than skipped:
  // zeros are what make a MISSING report conspicuous.
  assert.deepEqual(parseSelfReport(EMPTY_REPORT), { hides: 0, blurs: 0, hiddenMs: 0, platform: "desktop" });
});

test("the shape is closed: an unknown key is refused, not ignored", () => {
  rejects(() => parseSelfReport({ ...EMPTY_REPORT, mouseMoves: 900 }));
});

test("every field is checked, and nothing is coerced", () => {
  for (const bad of [
    { ...EMPTY_REPORT, hides: -1 },
    { ...EMPTY_REPORT, hides: 1.5 },
    { ...EMPTY_REPORT, hides: "3" },
    { ...EMPTY_REPORT, hides: NaN },
    { ...EMPTY_REPORT, hides: Infinity },
    { ...EMPTY_REPORT, hides: 10_001 },
    { ...EMPTY_REPORT, hiddenMs: 25 * 60 * 60 * 1000 },
    { ...EMPTY_REPORT, platform: "watch" },
    { ...EMPTY_REPORT, platform: null },
  ]) {
    rejects(() => parseSelfReport(bad));
  }
  for (const bad of ["{}", 3, true, [], [EMPTY_REPORT]]) rejects(() => parseSelfReport(bad));
});

// --- the claim against the clock --------------------------------------------

test("a claim larger than the window it describes is impossible", () => {
  // The client's window sits inside the server's, so the only honest overhang
  // is latency. Ten seconds hidden inside a four-second interval is not.
  assert.equal(reportExceedsInterval(report({ hiddenMs: 10_000 }), 4_000), true);
  assert.equal(reportExceedsInterval(report({ hiddenMs: 3_500 }), 4_000), false);
  // The jitter allowance is a second, and it is not a free pass.
  assert.equal(reportExceedsInterval(report({ hiddenMs: 4_900 }), 4_000), false);
  assert.equal(reportExceedsInterval(report({ hiddenMs: 5_200 }), 4_000), true);
  // No claim is not a false claim. Silence is read elsewhere, not here.
  assert.equal(reportExceedsInterval(null, 0), false);
});

test("countImpossible walks the two arrays in step and tolerates a short one", () => {
  const reports = [report({ hiddenMs: 50_000 }), null, report({ hiddenMs: 10 })];
  assert.equal(countImpossible(reports, [1_000, 1_000, 1_000]), 1);
  assert.equal(countImpossible(reports, []), 0, "an old document is not a crash");
  assert.equal(countImpossible([], [1_000]), 0);
});

// --- what it may and may not touch ------------------------------------------

const play = (selfReport: SelfReport | null) => {
  const open = newCardPlay("u1", "t1", "r1", CARD, T0);
  return { ...open, ...applyCardGuess(open, CARD, "IT", at(5_000), selfReport) } as CardPlay;
};

test("SEC-1/invariant 3: a self-report cannot move a score", () => {
  // If this ever fails, the field has become worth forging and the whole
  // argument for collecting it collapses.
  const without = play(null);
  const claimed = play(report({ hides: 99, blurs: 99, hiddenMs: 300_000 }));
  assert.equal(without.items[0]!.points, claimed.items[0]!.points);
  assert.equal(without.items[0]!.solved, claimed.items[0]!.solved);
  assert.deepEqual(cardIntervalsMs(without), cardIntervalsMs(claimed), "the server's clock is the server's");
});

test("the report rides on the guess, in the window it describes", () => {
  const p = play(report({ hides: 2, hiddenMs: 3_000 }));
  const guess = p.items[0]!.guesses[0]!;
  assert.equal(guess.selfReport?.hides, 2);
  assert.deepEqual(cardSelfReports(p)[0]![0], guess.selfReport);
  // Same shape as the intervals, so the two read side by side.
  assert.deepEqual(cardSelfReports(p).map((r) => r.length), cardIntervalsMs(p).map((r) => r.length));
});

test("no report means NO FIELD — Firestore will not store an undefined", () => {
  // `{ ...guess, selfReport: undefined }` would throw on write, and a client
  // that sends nothing is the normal case for every page older than D-77.
  const guess = play(null).items[0]!.guesses[0]!;
  assert.equal("selfReport" in guess, false);
  assert.deepEqual(cardSelfReports(play(null))[0], [null], "and it reads back as an explicit null");
});
