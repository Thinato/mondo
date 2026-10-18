/**
 * Multijogador rooms (FR-12.1): who hosts, who joins, who starts. Pure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsError } from "firebase-functions/v2/https";
import { canCreateGroup, type Rank } from "../src/lib/authz";
import {
  configureRoom, finishRoom, joinRoom, leaveRoom, newRoom, removePlayer, requirePlayer, requireStartable, resetForGame, reusableHostRoom,
  LOBBY_TTL_MS, PLAYER_COLORS, ROOM_MAX_PLAYERS, type Room,
} from "../src/lib/room";
import { newPotato } from "../src/lib/potato";

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

// --- D-104: a room outlives its game ----------------------------------------

const pair = () => joinRoom(newRoom("host", "Ana", "potato", "mundo", T0), "b", "Bia", T0);
const BANDEIRAS = { id: "bandeiras", mode: "classic" as const };

test("D-104: a finished game is a lobby with a result on it, open two more hours", () => {
  const playing: Room = { ...pair(), state: "playing", startedAt: T0 };
  const done = finishRoom(playing, T0 + 5);
  assert.equal(done.state, "finished");
  assert.equal(done.finishedAt, T0 + 5);
  assert.equal(done.expiresAt, T0 + 5 + LOBBY_TTL_MS);
  // Joining, leaving and starting all work on it as on a lobby.
  const more = joinRoom(done, "c", "Caio", T0 + 6);
  assert.deepEqual(more.playerUids, ["host", "b", "c"]);
  assert.equal(leaveRoom(more, "host", T0 + 7).hostUid, "b");
  requireStartable(more, "host", T0 + 7);
  // ...until it expires like a lobby does.
  rejects(() => joinRoom(done, "c", "Caio", done.expiresAt), "not-found");
  rejects(() => requireStartable(more, "host", done.expiresAt), "not-found");
});

test("D-104: a new game starts everyone at zero, with nothing of the last one left", () => {
  const scored: Room = {
    ...finishRoom({ ...pair(), state: "playing", startedAt: T0 }, T0 + 9),
    players: { host: { ...pair().players.host!, score: 40, timeMs: 9000 }, b: { ...pair().players.b!, score: 12, timeMs: 3000 } },
    potato: newPotato(["host", "b"], T0),
  };
  const r = resetForGame(scored);
  assert.deepEqual(Object.values(r.players).map((p) => [p.score, p.timeMs]), [[0, 0], [0, 0]]);
  assert.equal(r.potato, null);
  assert.equal(r.classic, null);
  assert.equal(r.finishedAt, null);
  assert.deepEqual(r.playerUids, scored.playerUids, "everyone keeps their seat");
});

test("FR-12.7: the host picks the next game between games, and only the host", () => {
  const r = configureRoom(pair(), "host", BANDEIRAS, T0 + 10);
  assert.equal(r.mode, "classic");
  assert.equal(r.presetId, "bandeiras");
  assert.equal(r.expiresAt, T0 + 10 + LOBBY_TTL_MS, "touching the room keeps it open");
  const done = finishRoom({ ...pair(), state: "playing" }, T0);
  assert.equal(configureRoom(done, "host", BANDEIRAS, T0).presetId, "bandeiras");
  rejects(() => configureRoom(pair(), "b", BANDEIRAS, T0), "permission-denied");
  rejects(() => configureRoom({ ...pair(), state: "playing" }, "host", BANDEIRAS, T0), "room-started");
  rejects(() => configureRoom(pair(), "host", { id: "treino", mode: "potato", solo: true }, T0), "invalid-argument");
  rejects(() => configureRoom(pair(), "host", BANDEIRAS, T0 + LOBBY_TTL_MS), "not-found");
});

test("FR-12.8: the host removes a seat between games; never their own, never mid-game", () => {
  const r = removePlayer(pair(), "host", "b");
  assert.deepEqual(r.playerUids, ["host"]);
  assert.equal(r.players.b, undefined);
  assert.equal(removePlayer(r, "host", "b"), r, "removing someone who is gone changes nothing");
  assert.deepEqual(removePlayer(finishRoom({ ...pair(), state: "playing" }, T0), "host", "b").playerUids, ["host"]);
  rejects(() => removePlayer(pair(), "b", "host"), "permission-denied");
  rejects(() => removePlayer(pair(), "host", "host"), "invalid-argument");
  rejects(() => removePlayer({ ...pair(), state: "playing" }, "host", "b"), "room-started");
  // Not a ban: the link still works.
  assert.deepEqual(joinRoom(r, "b", "Bia", T0).playerUids, ["host", "b"]);
});

test("D-93: a training room is never a lobby, finished or not", () => {
  const training: Room = { ...newRoom("g", "G", "potato", "treino", T0), state: "finished", potato: newPotato(["g"], T0, false) };
  rejects(() => joinRoom(training, "x", "X", T0), "room-started");
  rejects(() => configureRoom(training, "g", BANDEIRAS, T0), "room-started");
});

test("D-103: opening Multijogador goes back to the host's room only while it is still theirs", () => {
  const r = pair();
  assert.equal(reusableHostRoom(r, "host", T0), true);
  assert.equal(reusableHostRoom(r, "host", r.expiresAt), false, "expired");
  assert.equal(reusableHostRoom({ ...r, state: "playing" }, "host", r.expiresAt + 1), true, "a game running past the lobby's expiry");
  const left = leaveRoom(r, "host", T0);
  assert.equal(reusableHostRoom(left, "host", T0), false, "left");
  // Back by the link, but the room is Bia's now: a room of their own instead.
  assert.equal(reusableHostRoom(joinRoom(left, "host", "Ana", T0), "host", T0), false, "left, then rejoined");
  assert.equal(reusableHostRoom(r, "b", T0), false, "a seated player who is not the host");
});

test("D-104: the last one out closes the room for good, so nobody joins an empty one", () => {
  const empty = leaveRoom(newRoom("host", "Ana", "potato", "mundo", T0), "host", T0 + 1);
  assert.equal(empty.expiresAt, T0 + 1);
  rejects(() => joinRoom(empty, "x", "X", T0 + 2), "not-found");
});
