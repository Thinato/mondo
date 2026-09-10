import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  backfillStats, leaderboardView, memberStats, newMember, nextOwner, resultOf, todayState, uniqueNames,
  type Group, type Member,
} from "../src/lib/groups";
import { applyGuess, newAttempt, type Attempt } from "../src/lib/round";
import type { CardItem } from "../src/lib/card";
import { EMPTY_STATS, windowDays } from "../src/lib/standings";

const T0 = Timestamp.fromMillis(Date.parse("2026-10-31T15:30:00Z"));
const at = (ms: number) => Timestamp.fromMillis(T0.toMillis() + ms);
const TODAY = "2026-10-31";
const CLOSED = "2026-10-30";

// --- names -------------------------------------------------------------------

test("D-26: earliest member keeps the bare name, later duplicates get 2, 3…", () => {
  const names = uniqueNames([
    { uid: "c", displayName: "Paulo", joinedAt: at(3000) },
    { uid: "a", displayName: "Paulo", joinedAt: at(1000) },
    { uid: "b", displayName: "Paulo", joinedAt: at(2000) },
    { uid: "d", displayName: "Ana", joinedAt: at(0) },
  ]);
  assert.equal(names.get("a"), "Paulo");
  assert.equal(names.get("b"), "Paulo 2");
  assert.equal(names.get("c"), "Paulo 3");
  assert.equal(names.get("d"), "Ana");
});

test("D-26: suffixed names never exceed 24 characters", () => {
  const long = "x".repeat(24);
  const names = uniqueNames([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => ({ uid: `u${String(i).padStart(2, "0")}`, displayName: long, joinedAt: at(i) })));
  for (const n of names.values()) assert.ok(n.length <= 24, n);
  assert.equal(new Set(names.values()).size, 11);
  assert.equal(names.get("u11"), "x".repeat(21) + " 11");
});

test("uniqueNames: a suffixed name does not collide with someone actually called that", () => {
  const names = uniqueNames([
    { uid: "a", displayName: "Rui", joinedAt: at(0) },
    { uid: "b", displayName: "Rui 2", joinedAt: at(1) },
    { uid: "c", displayName: "Rui", joinedAt: at(2) },
  ]);
  assert.deepEqual([...names.values()], ["Rui", "Rui 2", "Rui 3"]);
});

// --- owner succession ----------------------------------------------------------

test("D-23: the longest-standing member takes over, whatever their role; nobody → null", () => {
  assert.equal(nextOwner([
    { uid: "p1", joinedAt: at(5000) },
    { uid: "p2", joinedAt: at(1000) },
    { uid: "p3", joinedAt: at(9000) },
  ]), "p2");
  assert.equal(nextOwner([
    { uid: "b", joinedAt: at(100) },
    { uid: "a", joinedAt: at(100) },
  ]), "a", "same instant → uid decides, so the pick is deterministic");
  assert.equal(nextOwner([]), null);
});

/** A day, since D-52: one challenge of each kind. */
const CARD: CardItem[] = [
  { kind: "shape", subject: "PY" },
  { kind: "flag", subject: "BR" },
  { kind: "capital", subject: "IT" },
];

// --- stats plumbing -----------------------------------------------------------

test("resultOf: unfinished → null, finished → the four numbers", () => {
  const a = newAttempt("u", CLOSED, CARD, T0);
  assert.equal(resultOf(a), null);
  assert.deepEqual(resultOf({ ...a, finishedAt: T0, points: 4, guessCount: 3, elapsedMs: 9000 }), { puzzleId: CLOSED, points: 4, guessCount: 3, elapsedMs: 9000 });
});

test("backfillStats: only the last 30 closed days count, and all-time starts there", () => {
  const days = windowDays(CLOSED, 30);
  const results = [
    { puzzleId: "2026-09-01", points: 6, guessCount: 1, elapsedMs: 1 }, // too old
    { puzzleId: days[0]!, points: 5, guessCount: 2, elapsedMs: 100 },
    { puzzleId: CLOSED, points: 3, guessCount: 4, elapsedMs: 200 },
    { puzzleId: TODAY, points: 6, guessCount: 1, elapsedMs: 1 }, // not closed yet
  ];
  const s = backfillStats(results, CLOSED);
  assert.equal(s.allTime.points, 8);
  assert.equal(s.allTime.played, 2);
  assert.equal(s.allTimeThrough, CLOSED);
  assert.equal(s.last30.points, 8); // 28 zeros dropped twice
  assert.equal(s.last7.points, 3);
});

test("memberStats keeps the running all-time and recomputes both windows", () => {
  const prev = { allTime: { points: 100, played: 40, totalGuesses: 80, avgGuesses: 2, totalElapsedMs: 5000 }, allTimeThrough: "2026-10-29" };
  const s = memberStats(prev, [{ puzzleId: CLOSED, points: 2, guessCount: 5, elapsedMs: 50 }], CLOSED);
  assert.equal(s.allTime.points, 102);
  assert.equal(s.allTime.played, 41);
  assert.equal(s.allTimeThrough, CLOSED);
  assert.equal(s.last30.points, 2);
  assert.equal(s.last7.points, 2);
});

// --- today state ---------------------------------------------------------------

const fresh = (uid: string) => newAttempt(uid, TODAY, CARD, T0);
const solvedIn = (uid: string, codes: string[]) => codes.reduce((a, c, i) => applyGuess(a, CARD, c, at((i + 1) * 1000)), fresh(uid));
/** D-52: a day is over only when all three challenges are. */
const perfectDay = (uid: string) => solvedIn(uid, ["PY", "BR", "IT"]);
const missedEverything = (uid: string) => solvedIn(uid, ["AR", "BO", "BR", "CL", "UY", "PE", "AR", "CL", "UY", "BR", "CL", "UY"]);

test("todayState: missing, unfinished, finished", () => {
  assert.equal(todayState(null), "not_started");
  assert.equal(todayState(undefined), "not_started");
  assert.equal(todayState(fresh("u")), "in_progress");
  assert.equal(todayState(solvedIn("u", ["PY"])), "in_progress", "one challenge down is not a finished day (D-52)");
  assert.equal(todayState(perfectDay("u")), "finished");
  assert.equal(todayState(missedEverything("u")), "finished");
});

// --- the board -----------------------------------------------------------------

function member(uid: string, name: string, joinedMs: number, last30Points: number, elapsed: number, role: Member["role"] = "member"): Member {
  const m = newMember(uid, name, role, at(joinedMs), { allTime: EMPTY_STATS, allTimeThrough: CLOSED, last7: EMPTY_STATS, last30: EMPTY_STATS }, 3);
  return { ...m, last30: { ...EMPTY_STATS, points: last30Points, totalElapsedMs: elapsed }, allTime: { ...EMPTY_STATS, points: last30Points * 2, totalElapsedMs: elapsed } };
}

const group: Group = { name: "Almoço", ownerUid: "owner", memberCount: 3, maxMembers: 200, createdAt: T0 };
const members = [
  member("owner", "Paulo", 0, 50, 1000, "owner"),
  member("m1", "Ana", 1000, 70, 5000),
  member("m2", "Ana", 2000, 50, 900),
];

test("FR-4.11: before the viewer finishes, states show but no scores", () => {
  const view = leaderboardView({
    groupId: "g".repeat(20), group, members, viewerUid: "owner", today: TODAY, closedDay: CLOSED,
    todayAttempts: new Map<string, Attempt | null>([["owner", fresh("owner")], ["m1", perfectDay("m1")], ["m2", null]]),
  });
  assert.equal(view.today.viewerFinished, false);
  assert.deepEqual(view.today.players.map((p) => [p.displayName, p.state, p.points, p.guessCount]), [
    ["Paulo", "in_progress", null, null],
    ["Ana", "finished", null, null],
    ["Ana 2", "not_started", null, null],
  ]);
  assert.equal(view.group.isOwner, true);
  assert.equal(view.group.ownerDisplayName, "Paulo");
  assert.equal(view.closedThrough, CLOSED);
});

test("FR-4.11: once the viewer has finished, finished players' points and guess counts appear", () => {
  const view = leaderboardView({
    groupId: "g".repeat(20), group, members, viewerUid: "m2", today: TODAY, closedDay: CLOSED,
    todayAttempts: new Map<string, Attempt | null>([
      ["owner", fresh("owner")],
      // A whole day: silhouette on the second guess, then both others first time.
      ["m1", solvedIn("m1", ["AR", "PY", "BR", "IT"])],
      ["m2", missedEverything("m2")],
    ]),
  });
  assert.equal(view.today.viewerFinished, true);
  assert.deepEqual(view.today.players.map((p) => [p.state, p.points, p.guessCount]), [
    ["in_progress", null, null],
    ["finished", 17, 4],
    ["finished", 0, 12],
  ]);
  assert.equal(view.group.isOwner, false);
  assert.equal(view.rows.find((r) => r.uid === "m2")?.isMe, true);
});

test("ranks per window: last30 breaks the 50-point tie on elapsed; all-time doubles keep the order", () => {
  const view = leaderboardView({
    groupId: "g".repeat(20), group, members, viewerUid: "m1", today: TODAY, closedDay: CLOSED, todayAttempts: new Map(),
  });
  const byUid = Object.fromEntries(view.rows.map((r) => [r.uid, r]));
  assert.equal(byUid["m1"]!.last30.rank, 1);
  assert.equal(byUid["m2"]!.last30.rank, 2); // 900 ms beats 1000 ms
  assert.equal(byUid["owner"]!.last30.rank, 3);
  assert.equal(byUid["m1"]!.allTime.rank, 1);
  assert.equal(byUid["owner"]!.last7.rank, 1); // all zero → everyone rank 1
  assert.equal(byUid["m2"]!.last7.rank, 1);
});

test("SEC-1: the board never carries a country code or name", () => {
  const view = leaderboardView({
    groupId: "g".repeat(20), group, members, viewerUid: "m1", today: TODAY, closedDay: CLOSED,
    todayAttempts: new Map<string, Attempt | null>([["m1", solvedIn("m1", ["AR", "PY"])], ["owner", solvedIn("owner", ["PY"])]]),
  });
  const json = JSON.stringify(view);
  for (const needle of ['"code"', "Paraguai", "Argentina", "countryCode", "guesses"]) assert.ok(!json.includes(needle), needle);
});
