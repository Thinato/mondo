/**
 * Multijogador rooms (FR-12.1): who hosts, who joins, who starts. Pure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsError } from "firebase-functions/v2/https";
import { canCreateGroup, type Rank } from "../src/lib/authz";
import {
  joinRoom, leaveRoom, newRoom, requirePlayer, requireStartable, LOBBY_TTL_MS, PLAYER_COLORS, ROOM_MAX_PLAYERS, type Room,
} from "../src/lib/room";

const T0 = 1_800_000_000_000;

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

test("hosting a room takes the rank a group takes; joining takes nothing", () => {
  // `multiplayer.ts` gates `create` on exactly this function (FR-10.3, D-84).
  const hosts: Record<Rank, boolean> = { admin: true, invited: true, subscriber: true, user: false, guest: false };
  for (const [rank, can] of Object.entries(hosts)) assert.equal(canCreateGroup(rank as Rank), can, rank);
});

test("a new room is a lobby with its host in the first seat", () => {
  const r = newRoom("host", "Ana", "potato", "mundo", T0);
  assert.equal(r.state, "lobby");
  assert.deepEqual(r.playerUids, ["host"]);
  assert.equal(r.players.host!.color, PLAYER_COLORS[0]);
  assert.equal(r.expiresAt, T0 + LOBBY_TTL_MS);
});

test("joining is idempotent and gives each seat its own colour", () => {
  let r = newRoom("host", "Ana", "potato", "mundo", T0);
  r = joinRoom(r, "b", "Bia", T0 + 1);
  assert.equal(joinRoom(r, "b", "Bia", T0 + 2), r);
  r = joinRoom(r, "c", "Caio", T0 + 3);
  const colours = Object.values(r.players).map((p) => p.color);
  assert.equal(new Set(colours).size, 3);
});

test("a room holds eight, only while it is a lobby, and only until it expires", () => {
  let r = newRoom("p0", "P0", "potato", "mundo", T0);
  for (let i = 1; i < ROOM_MAX_PLAYERS; i++) r = joinRoom(r, `p${i}`, `P${i}`, T0);
  rejects(() => joinRoom(r, "late", "Late", T0), "room-full");
  rejects(() => joinRoom(newRoom("h", "H", "potato", "mundo", T0), "x", "X", T0 + LOBBY_TTL_MS), "not-found");
  const started: Room = { ...newRoom("h", "H", "potato", "mundo", T0), state: "playing" };
  rejects(() => joinRoom(started, "x", "X", T0), "room-started");
  // ...but a player already in it may always come back.
  assert.equal(joinRoom(started, "h", "H", T0), started);
});

test("the host leaving hands the room on; the last one out closes it", () => {
  let r = joinRoom(newRoom("host", "Ana", "potato", "mundo", T0), "b", "Bia", T0);
  r = leaveRoom(r, "host", T0 + 1);
  assert.equal(r.hostUid, "b");
  assert.deepEqual(r.playerUids, ["b"]);
  r = leaveRoom(r, "b", T0 + 2);
  assert.equal(r.state, "finished");
  const playing: Room = { ...joinRoom(newRoom("h", "H", "potato", "mundo", T0), "b", "B", T0), state: "playing" };
  rejects(() => leaveRoom(playing, "b", T0), "room-started");
});

test("only the host starts, and only with two or more", () => {
  const solo = newRoom("host", "Ana", "potato", "mundo", T0);
  rejects(() => requireStartable(solo, "host", T0), "invalid-argument");
  const r = joinRoom(solo, "b", "Bia", T0);
  rejects(() => requireStartable(r, "b", T0), "permission-denied");
  requireStartable(r, "host", T0);
  rejects(() => requirePlayer(r, "stranger"), "permission-denied");
});
