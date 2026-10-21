/**
 * The Fronteiras ladder (FR-15.7–15.9, D-110, D-111): rating one game, the pair
 * cap, the widening queue window and picking an opponent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVISIONAL_RD } from "../src/lib/glicko";
import {
  HISTORY_MAX,
  newRecord,
  pairCapped,
  pickOpponent,
  queueWindow,
  rateGame,
  type LadderRecord,
} from "../src/lib/ladder";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const names = { a: "Ana", b: "Bia" };
const uids = { a: "uA", b: "uB" };

test("the pair cap allows a 3rd game in 24 h and refuses a 4th", () => {
  let a: LadderRecord | undefined;
  let b: LadderRecord | undefined;
  for (let i = 0; i < 3; i++) {
    assert.equal(pairCapped(a, "uB", NOW + i * H), false, `game ${i + 1}`);
    ({ a, b } = rateGame(a, b, 1, NOW + i * H, names, uids));
  }
  assert.equal(pairCapped(a, "uB", NOW + 3 * H), true);
  assert.equal(pairCapped(b, "uA", NOW + 3 * H), true);
  assert.equal(pairCapped(a, "uC", NOW + 3 * H), false);
  // 24 h after the first game it rolls off.
  assert.equal(pairCapped(a, "uB", NOW + 24 * H), false);
  // And rating again drops it from `recent`.
  ({ a } = rateGame(a, b, 1, NOW + 25 * H, names, uids));
  assert.deepEqual(
    a.recent.map((r) => r.at),
    [NOW + 2 * H, NOW + 25 * H],
  );
});

test("the queue window is 150, plus 50 every whole 10 s", () => {
  assert.equal(queueWindow(0), 150);
  assert.equal(queueWindow(9_900), 150);
  assert.equal(queueWindow(10_000), 200);
  assert.equal(queueWindow(20_000), 250);
  assert.equal(queueWindow(30_000), 300);
});

const slot = (id: string, rating: number, extra: Partial<{ uid: string; since: number; seenAt: number }> = {}) => ({
  id,
  uid: `u-${id}`,
  rating,
  since: NOW,
  seenAt: NOW,
  ...extra,
});
const me = { uid: "me", rating: 1500, since: NOW };

test("pickOpponent takes the nearest rating inside the window", () => {
  const got = pickOpponent(me, [slot("far", 1640), slot("near", 1450), slot("out", 1700)], NOW);
  assert.equal(got?.id, "near");
  assert.equal(pickOpponent(me, [slot("out", 1700)], NOW), null);
});

test("the wider of the two windows decides", () => {
  // 200 apart: neither has waited at first, then the candidate has waited 10 s.
  assert.equal(pickOpponent(me, [slot("x", 1700)], NOW), null);
  assert.equal(pickOpponent(me, [slot("x", 1700, { since: NOW - 10_000 })], NOW)?.id, "x");
  assert.equal(pickOpponent({ ...me, since: NOW - 10_000 }, [slot("x", 1700)], NOW)?.id, "x");
});

test("a stale slot and my own slot are skipped", () => {
  assert.equal(pickOpponent(me, [slot("stale", 1500, { seenAt: NOW - 25_001 })], NOW), null);
  assert.equal(pickOpponent(me, [slot("fresh", 1500, { seenAt: NOW - 25_000 })], NOW)?.id, "fresh");
  assert.equal(pickOpponent(me, [slot("mine", 1500, { uid: "me" })], NOW), null);
});

test("rateGame rates one game once: games +1, history newest first, winner up", () => {
  const { a, b, before, after } = rateGame(undefined, undefined, 1, NOW, names, uids);
  assert.equal(a.games, 1);
  assert.equal(b.games, 1);
  assert.deepEqual(before, { a: 1500, b: 1500 });
  assert.ok(after.a > 1500 && after.b < 1500);
  assert.equal(after.a - 1500, 1500 - after.b);
  assert.deepEqual(a.history, [{ at: NOW, rating: after.a, opp: "Bia", result: "w" }]);
  assert.deepEqual(b.history, [{ at: NOW, rating: after.b, opp: "Ana", result: "l" }]);
  assert.deepEqual(a.recent, [{ opp: "uB", at: NOW }]);
  assert.equal(a.lastPlayedAt, NOW);
  assert.equal(a.settled, false);
});

test("a draw between equals moves nobody's rating and is a 'd' both sides", () => {
  const { a, b } = rateGame(newRecord(), newRecord(), 0.5, NOW, names, uids);
  assert.ok(Math.abs(a.rating - 1500) < 1e-9);
  assert.ok(Math.abs(b.rating - 1500) < 1e-9);
  assert.equal(a.history[0]?.result, "d");
  assert.equal(b.history[0]?.result, "d");
  assert.ok(a.rd < 350);
});

test("history keeps the newest 30 and a player settles as RD falls", () => {
  let a: LadderRecord | undefined;
  let b: LadderRecord | undefined;
  for (let i = 0; i < 40; i++) ({ a, b } = rateGame(a, b, i % 2, NOW + i * H, names, uids));
  assert.equal(a!.games, 40);
  assert.equal(a!.history.length, HISTORY_MAX);
  assert.equal(a!.history[0]?.at, NOW + 39 * H);
  assert.equal(a!.settled, a!.rd <= PROVISIONAL_RD);
  assert.equal(a!.settled, true);
});

test("idle days grow RD before the game, once", () => {
  const rec: LadderRecord = { ...newRecord(), rd: 80, lastPlayedAt: NOW - 10 * 24 * H };
  const fresh: LadderRecord = { ...rec, lastPlayedAt: NOW };
  const idle = rateGame(rec, rec, 0.5, NOW, names, uids).a;
  const now = rateGame(fresh, fresh, 0.5, NOW, names, uids).a;
  assert.ok(idle.rd > now.rd);
});
