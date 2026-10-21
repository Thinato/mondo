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
import { newFronteiras } from "../src/lib/fronteiras";

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

// --- D-105: trophies ---------------------------------------------------------

test("D-105: the one player with the most points takes a trophy, and keeps it into the next game", () => {
  const trio = joinRoom(pair(), "c", "Caio", T0);
  const clássico = (scores: Record<string, number>, from: Room = trio): Room => ({
    ...from, state: "playing", potato: null,
    players: Object.fromEntries(Object.entries(from.players).map(([uid, p]) => [uid, { ...p, score: scores[uid] ?? 0 }])),
  });
  const won = finishRoom(clássico({ host: 30, b: 12, c: 7 }), T0);
  assert.deepEqual(Object.values(won.players).map((p) => p.wins ?? 0), [1, 0, 0]);
  // A new game zeroes the score, not the trophies.
  const again = finishRoom(clássico({ b: 20 }, resetForGame(won)), T0 + 1);
  assert.deepEqual(Object.values(again.players).map((p) => p.wins ?? 0), [1, 1, 0]);
});

test("D-105: a tie at the top is a draw — nobody takes a trophy, whatever the clock says", () => {
  const r: Room = {
    ...joinRoom(pair(), "c", "Caio", T0), state: "playing",
    potato: { ...newPotato(["host", "b", "c"], T0), scores: {
      host: { points: 40, timeMs: 9_000, named: 5 }, b: { points: 40, timeMs: 3_000, named: 5 }, c: { points: 2, timeMs: 1_000, named: 1 },
    } },
  };
  assert.ok(Object.values(finishRoom(r, T0).players).every((p) => !p.wins));
  // Batata Quente's points are read from the game, not from the seat.
  const solo = { ...r, potato: { ...r.potato!, scores: { ...r.potato!.scores, b: { points: 39, timeMs: 0, named: 5 } } } };
  assert.equal(finishRoom(solo, T0).players.host!.wins, 1);
});

test("D-105: training has nobody to beat", () => {
  const training: Room = { ...newRoom("g", "G", "potato", "treino", T0), state: "playing", potato: { ...newPotato(["g"], T0, false), scores: { g: { points: 9, timeMs: 0, named: 9 } } } };
  assert.equal(finishRoom(training, T0).players.g!.wins, undefined);
});

test("D-106: a custom game sets the room to Clássico and carries a copy; a built-in preset clears it", () => {
  const custom = { name: "Europa", kinds: ["flag" as const, "capital" as const], shuffled: false, regions: ["Europe" as const] };
  const r = configureRoom(pair(), "host", custom, T0);
  assert.equal(r.presetId, "custom");
  assert.equal(r.mode, "classic");
  assert.deepEqual(r.custom, custom);
  const back = configureRoom(r, "host", BANDEIRAS, T0);
  assert.equal(back.presetId, "bandeiras");
  assert.equal(back.custom, null);
  rejects(() => configureRoom(pair(), "b", custom, T0), "permission-denied");
  rejects(() => configureRoom({ ...pair(), state: "playing" }, "host", custom, T0), "room-started");
});

// --- D-107: Fronteiras --------------------------------------------------------

const fronteirasRoom = (): Room => ({ ...newRoom("a", "Ana", "fronteiras", "fronteiras", T0), hostUid: null });

test("D-107: a Fronteiras room seats two and nobody hosts it", () => {
  const r = joinRoom(fronteirasRoom(), "b", "Bia", T0);
  rejects(() => joinRoom(r, "c", "Caio", T0), "room-full");
  rejects(() => requireStartable(r, "a", T0), "permission-denied");
  rejects(() => configureRoom(r, "a", BANDEIRAS, T0), "permission-denied");
  rejects(() => removePlayer(r, "a", "b"), "permission-denied");
  assert.equal(reusableHostRoom(r, "a", T0), false);
  assert.equal(leaveRoom(r, "a", T0).hostUid, null, "leaving hands nothing on");
});

test("D-111: leaving a queue slot closes the slot", () => {
  const waiting: Room = { ...fronteirasRoom(), queue: { open: true, rating: 1500, since: T0, seenAt: T0 } };
  assert.equal(leaveRoom(waiting, "a", T0).queue, null);
  assert.equal("queue" in leaveRoom(pair(), "b", T0), false, "other rooms are not touched");
});

test("D-105, D-107: Fronteiras's winner takes the trophy, a draw gives nobody one, and the room closes", () => {
  const base: Room = { ...joinRoom(fronteirasRoom(), "b", "Bia", T0), state: "playing" };
  const ended = (winner: string | null): Room => ({
    ...base, fronteiras: { ...newFronteiras({ order: ["a", "b"], continent: "Europe", values: {}, rated: false, now: T0 }), result: { winner, reason: "turns" } },
  });
  const won = finishRoom(ended("b"), T0 + 9);
  assert.deepEqual(Object.values(won.players).map((p) => p.wins ?? 0), [0, 1]);
  assert.equal(won.expiresAt, T0 + 9, "one game per room");
  rejects(() => joinRoom(won, "c", "Caio", T0 + 9), "not-found");
  assert.ok(Object.values(finishRoom(ended(null), T0).players).every((p) => !p.wins));
});
