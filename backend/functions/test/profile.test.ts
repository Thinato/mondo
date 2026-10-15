/**
 * The profile (FR-13, D-97). What this file exists to pin is the visibility
 * line — an open day's answers never reach anyone but the player who finished
 * it — and that the numbers are the ones `regras`-minded people will check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  PROFILE_DAYS, profileView, recapAllowed, recapView, trendOf, visibilityOf,
  type ProfileInput,
} from "../src/lib/profile";
import { applyGuess, newAttempt, newProfile, roundView, type Attempt, type Profile, type Puzzle, type StoredGuess } from "../src/lib/round";
import type { CardItem } from "../src/lib/card";
import type { KindId } from "../src/lib/kinds";
import { windowDays } from "../src/lib/standings";

const TODAY = "2026-10-15";
const YESTERDAY = "2026-10-14";
const T0 = Timestamp.fromMillis(Date.parse("2026-10-15T16:00:00Z"));
const at = (ms = 0) => Timestamp.fromMillis(T0.toMillis() + ms);

const COUNTRY_KINDS = new Set<KindId>(["shape", "capital", "flag", "person"]);
function guess(kind: KindId): StoredGuess {
  if (COUNTRY_KINDS.has(kind)) return { code: "BR", distanceKm: 1234, bearingDeg: 77, proximity: 0.5, at: at() };
  if (kind === "gdp") return { value: 1000, higher: true, proximity: 0.5, at: at() };
  return { pick: 3, proximity: 0, at: at() };
}

/** [kind, points, solved, guess count] */
type Spec = [KindId, number, boolean, number];
function day(puzzleId: string, specs: Spec[], extra: Partial<Attempt> = {}): Attempt {
  const items = specs.map(([kind, points, solved, n]) => ({
    kind, points, solved, guesses: Array.from({ length: n }, () => guess(kind)),
    startedAt: at(), finishedAt: at(1000), elapsedMs: 1000,
  }));
  const points = items.reduce((s, it) => s + it.points, 0);
  return {
    uid: "A", startedAt: at(), finishedAt: at(5000), cursor: items.length, items, points, elapsedMs: 5000,
    suspicious: false, puzzleId, mode: "daily", guessCount: 0, solved: items.every((i) => i.solved), ...extra,
  };
}
const SEVEN: Spec[] = [["shape", 6, true, 1], ["capital", 4, true, 2], ["flag", 0, false, 3], ["gdp", 6, true, 1], ["flagPick", 6, true, 1], ["shapePick", 2, true, 2], ["person", 5, true, 2]];

const PROFILE: Profile = {
  ...newProfile(at(), "ana"), lastPlayedOn: TODAY, currentStreak: 4, longestStreak: 9,
  role: "admin", groups: ["g1"], subscription: { status: "active", currentPeriodEnd: at(1e9) },
};
const base = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  uid: "A", profile: PROFILE, attempts: [], isOwner: false, today: TODAY, closedDay: YESTERDAY, viewerFinishedToday: false, ...over,
});

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

// ---------------------------------------------------------------------------

test("visibilityOf: the whole matrix", () => {
  const done = { puzzleId: TODAY, finishedAt: at() };
  const open = { puzzleId: TODAY, finishedAt: null };
  const v = (isOwner: boolean, viewerFinishedToday: boolean) => ({ isOwner, viewerFinishedToday, today: TODAY });
  assert.equal(visibilityOf({ puzzleId: YESTERDAY, finishedAt: at() }, v(false, false)), "full");
  assert.equal(visibilityOf({ puzzleId: YESTERDAY, finishedAt: null }, v(true, true)), "hidden");
  assert.equal(visibilityOf(done, v(true, false)), "full");
  assert.equal(visibilityOf(open, v(true, true)), "hidden");
  assert.equal(visibilityOf(done, v(false, false)), "hidden");
  assert.equal(visibilityOf(done, v(false, true)), "score", "a non-owner never gets today's recap");
  assert.equal(visibilityOf(open, v(false, true)), "hidden");
  assert.equal(visibilityOf({ puzzleId: "2026-10-16", finishedAt: at() }, v(true, true)), "hidden");
});

test("today's row follows FR-4.11 for another viewer and never offers a recap", () => {
  const attempts = [day(TODAY, SEVEN), day(YESTERDAY, SEVEN)];
  const notYet = profileView(base({ attempts }));
  assert.deepEqual(notYet.days.map((d) => d.puzzleId), [YESTERDAY]);
  assert.equal(notYet.chart.at(-1), null, "today is not plotted for a viewer who has not finished");

  const after = profileView(base({ attempts, viewerFinishedToday: true }));
  assert.deepEqual(after.days.map((d) => [d.puzzleId, d.recap]), [[TODAY, false], [YESTERDAY, true]]);

  const owner = profileView(base({ attempts, isOwner: true }));
  assert.deepEqual(owner.days.map((d) => [d.puzzleId, d.recap]), [[TODAY, true], [YESTERDAY, true]]);
});

test("nothing private and nothing answer-bearing is on the wire", () => {
  const json = JSON.stringify(profileView(base({ attempts: [day(TODAY, SEVEN), day(YESTERDAY, SEVEN)], viewerFinishedToday: true })));
  for (const key of ["bearingDeg", "email", "role", "rank", "ads", "subscription", "groups", "answer", "guesses", "code", "pick", "distanceKm"]) {
    assert.ok(!json.includes(`"${key}"`), `${key} must not appear`);
  }
  assert.ok(!json.includes("admin") && !json.includes("g1"));
});

test("unfinished, future and other-mode attempts are not rows", () => {
  const unfinished = day("2026-10-10", SEVEN, { finishedAt: null });
  const future = day("2026-10-16", SEVEN);
  const match = { ...day("2026-10-09", SEVEN), mode: "match" } as unknown as Attempt;
  const outside = day("2026-09-01", SEVEN);
  const v = profileView(base({ attempts: [unfinished, future, match, outside, null, undefined], isOwner: true }));
  assert.deepEqual(v.days, []);
  assert.ok(v.kinds.every((k) => k.played === 0));
});

test("a voided day is a row but counts for nothing (D-82)", () => {
  const voided = day("2026-10-12", SEVEN, { cheated: { by: "admin", at: at() } });
  const v = profileView(base({ attempts: [voided, day(YESTERDAY, SEVEN)] }));
  assert.deepEqual(v.days.map((d) => [d.puzzleId, d.cheated]), [[YESTERDAY, false], ["2026-10-12", true]]);
  assert.equal(v.kinds.find((k) => k.kind === "shape")!.played, 1);
  const w = windowDays(TODAY, PROFILE_DAYS);
  assert.equal(v.chart[w.indexOf("2026-10-12")], null);
  assert.equal(v.chart[w.indexOf(YESTERDAY)], Math.round((100 * 29) / 42));
});

test("per-kind numbers: average out of 6, solved %, first-guess %; none played is null", () => {
  const v = profileView(base({
    attempts: [
      day("2026-10-13", [["shape", 6, true, 1], ["flag", 4, true, 2]]),
      day("2026-10-12", [["shape", 3, true, 4], ["flag", 0, false, 3]]),
      day("2026-10-11", [["shape", 0, false, 6]]),
    ],
  }));
  const shape = v.kinds.find((k) => k.kind === "shape")!;
  assert.deepEqual(shape, { kind: "shape", played: 3, avgPoints: 3, solvedPct: 67, firstGuessPct: 33, trend: null });
  assert.deepEqual(v.kinds.find((k) => k.kind === "flag"), { kind: "flag", played: 2, avgPoints: 2, solvedPct: 50, firstGuessPct: 0, trend: null });
  assert.deepEqual(v.kinds.find((k) => k.kind === "gdp"), { kind: "gdp", played: 0, avgPoints: null, solvedPct: null, firstGuessPct: null, trend: null });
  assert.deepEqual(v.kinds.map((k) => k.kind), ["shape", "capital", "flag", "gdp", "flagPick", "shapePick", "person"]);
});

test("trend: latest 15 days against the 15 before, needing 3 a side, flat under half a point", () => {
  assert.equal(trendOf([6, 6], [0, 0, 0]), null);
  assert.equal(trendOf([2, 2, 2], [2.49, 2.49, 2.49]), "flat");
  assert.equal(trendOf([2, 2, 2], [2.5, 2.5, 2.5]), "up");
  assert.equal(trendOf([2, 2, 2], [1.5, 1.5, 1.5]), "down");

  const w = windowDays(TODAY, PROFILE_DAYS);
  const early = w.slice(0, 3).map((d) => day(d, [["capital", 2, true, 3]]));
  const late = w.slice(-4, -1).map((d) => day(d, [["capital", 6, true, 1]]));
  assert.equal(profileView(base({ attempts: [...early, ...late] })).kinds.find((k) => k.kind === "capital")!.trend, "up");
});

test("pct is of that day's own max, across the seams (D-75, D-79)", () => {
  const five: Spec[] = [["shape", 6, true, 1], ["capital", 6, true, 1], ["flag", 6, true, 1], ["gdp", 6, true, 1], ["flagPick", 6, true, 1]];
  const v = profileView(base({ attempts: [day("2026-09-20", five), day(YESTERDAY, SEVEN)] }));
  assert.deepEqual(v.days.map((d) => [d.maxPoints, d.pct]), [[42, 69], [30, 100]]);
});

test("the grid drawn from the attempt alone equals the daily's own share grid", () => {
  const card: CardItem[] = [{ kind: "shape", subject: "PY" }, { kind: "flag", subject: "BR" }, { kind: "capital", subject: "IT" }];
  const puzzle: Puzzle = { puzzleId: YESTERDAY, items: card, opensAt: at() };
  let a = newAttempt("A", YESTERDAY, card, at());
  ["AR", "BO", "PY", "AR", "BR", "FR", "ES", "PT"].forEach((g, i) => { a = applyGuess(a, card, g, at((i + 1) * 1000)); });
  assert.notEqual(a.finishedAt, null);
  const expected = roundView(a, puzzle, at(20_000)).shareGrid!.split("\n").slice(1);
  assert.deepEqual(profileView(base({ attempts: [a] })).days[0]!.grid, expected);
});

test("a pre-D-52 attempt reads as a one-challenge day", () => {
  const legacy = { ...day(YESTERDAY, []), items: undefined, guesses: [guess("shape")], points: 6, solved: true } as unknown as Attempt;
  const v = profileView(base({ attempts: [legacy] }));
  assert.equal(v.days[0]!.grid.length, 1);
  assert.equal(v.days[0]!.maxPoints, 6);
});

test("no profile: not found, but the owner is still the owner", () => {
  const v = profileView(base({ profile: null, isOwner: true, attempts: [day(YESTERDAY, SEVEN)] }));
  assert.equal(v.found, false);
  assert.equal(v.isOwner, true);
  assert.deepEqual(v.days, []);
  assert.equal(v.chart.length, PROFILE_DAYS);
});

test("the streak shown is the one that still holds", () => {
  assert.equal(profileView(base()).profile!.currentStreak, 4);
  assert.equal(profileView(base({ profile: { ...PROFILE, lastPlayedOn: "2026-10-01" } })).profile!.currentStreak, 0);
});

// ---------------------------------------------------------------------------
// The recap — the only reader of a puzzle.

const RECAP_CARD: CardItem[] = [{ kind: "shape", subject: "PY" }, { kind: "flagPick", subject: "BR", options: ["AR", "BR", "CL", "UY", "PE", "BO", "EC", "CO"] } as CardItem];
const recapPuzzle = (puzzleId: string): Puzzle => ({ puzzleId, items: RECAP_CARD, opensAt: at() });
const recapDay = (puzzleId: string, extra: Partial<Attempt> = {}) =>
  day(puzzleId, [["shape", 5, true, 2], ["flagPick", 6, true, 1]], extra);

test("recapAllowed is decided before any read", () => {
  assert.equal(recapAllowed(YESTERDAY, { isOwner: false, today: TODAY }), true);
  assert.equal(recapAllowed(TODAY, { isOwner: false, today: TODAY }), false);
  assert.equal(recapAllowed(TODAY, { isOwner: true, today: TODAY }), true);
  assert.equal(recapAllowed("2026-10-16", { isOwner: true, today: TODAY }), false);
  assert.equal(recapAllowed(windowDays(TODAY, PROFILE_DAYS)[0]!, { isOwner: false, today: TODAY }), true);
  assert.equal(recapAllowed("2026-09-15", { isOwner: false, today: TODAY }), false);
});

test("recapView refuses every not-visible case with the same error", () => {
  const v = { isOwner: false, today: TODAY };
  rejects(() => recapView(TODAY, recapDay(TODAY), recapPuzzle(TODAY), v), "permission-denied");
  rejects(() => recapView(YESTERDAY, null, recapPuzzle(YESTERDAY), v), "permission-denied");
  rejects(() => recapView(YESTERDAY, recapDay(YESTERDAY, { finishedAt: null }), recapPuzzle(YESTERDAY), v), "permission-denied");
  rejects(() => recapView(YESTERDAY, { ...recapDay(YESTERDAY), mode: "match" } as unknown as Attempt, recapPuzzle(YESTERDAY), v), "permission-denied");
  rejects(() => recapView(YESTERDAY, recapDay("2026-10-13"), recapPuzzle(YESTERDAY), v), "permission-denied");
  rejects(() => recapView("2026-09-01", recapDay("2026-09-01"), recapPuzzle("2026-09-01"), v), "permission-denied");
  rejects(() => recapView(TODAY, recapDay(TODAY, { finishedAt: null }), recapPuzzle(TODAY), { isOwner: true, today: TODAY }), "permission-denied");
});

test("recapView: answers and guesses, projected — no bearing, no earlier tries", () => {
  const history = [{ ...recapDay(YESTERDAY), retryGrantedBy: "admin", retryGrantedAt: at() }];
  const r = recapView(YESTERDAY, recapDay(YESTERDAY, { history }), recapPuzzle(YESTERDAY), { isOwner: false, today: TODAY });
  assert.equal(r.items[0]!.answer!.code, "PY");
  assert.equal(r.items[1]!.answer!.pick, 1);
  assert.equal(r.items[0]!.guesses.length, 2);
  const json = JSON.stringify(r);
  for (const key of ["bearingDeg", "history", "retryGrantedBy", "uid", "selfReport"]) assert.ok(!json.includes(`"${key}"`), key);
  assert.deepEqual(Object.keys(r).sort(), ["cheated", "items", "maxPoints", "points", "puzzleId"]);

  const own = recapView(TODAY, recapDay(TODAY), recapPuzzle(TODAY), { isOwner: true, today: TODAY });
  assert.equal(own.items.length, 2);
});

test("a re-seeded day keeps its guesses and loses only the answers", () => {
  const r = recapView(YESTERDAY, recapDay(YESTERDAY), { puzzleId: YESTERDAY, items: [RECAP_CARD[0]!], opensAt: at() }, { isOwner: true, today: TODAY });
  assert.deepEqual(r.items.map((it) => it.answer), [null, null]);
  assert.equal(r.items[0]!.guesses.length, 2);
});
