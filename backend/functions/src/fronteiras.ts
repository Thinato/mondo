/**
 * Fronteiras (FR-15, D-107–D-113): the I/O around lib/fronteiras.ts, reached
 * through the one Multijogador callable (D-92). No rule lives here.
 *
 * A Fronteiras room is two seats and no host. The waiting player's own room is
 * the queue slot (D-111): `queue` either seats the caller in somebody else's
 * slot and starts the game, or opens/refreshes the caller's own. `challenge`
 * is the same room with no queue, reached by its link; `bot` seats `~bot`.
 *
 * One live game per account (D-112) rests on `users/{uid}.fronteirasRoom` and
 * one transaction rule: every transaction that can seat the caller reads the
 * caller's user document FIRST, with a plain `tx.get`, and takes the pointer
 * from that snapshot — so a `queue` in one tab and a `join` in another conflict
 * on it and one of them retries into `already-playing`. Every read comes before
 * every write; a missing profile is created in the write phase, never by
 * `ensureProfile` (which writes as it reads).
 *
 * A rating moves exactly once: `endGame` runs only in the transaction that
 * flips the room from playing to finished, and every later call reads
 * `finished` and does nothing.
 */

import { Timestamp, type Transaction } from "firebase-admin/firestore";
import type { CallableRequest } from "firebase-functions/v2/https";
import { db, roomRef, roomSubRef, userRef } from "./db";
import gdpJson from "./data/gdp.json";
import { EMULATED, signInProvider } from "./lib/callable";
import { mondoError } from "./lib/errors";
import {
  abort, applyAction, applyTimeout, boardOf, newFronteiras, resign, valuesOf, BOT_UID, CONTINENTS,
  type Action, type FronteirasState,
} from "./lib/fronteiras";
import { botAction } from "./lib/bot";
import { PROVISIONAL_RD, START } from "./lib/glicko";
import { inviteToken } from "./lib/invite";
import { pairCapped, pickOpponent, rateGame, QUEUE_STALE_MS } from "./lib/ladder";
import { finishRoom, joinRoom, newRoom, requirePlayer, requirePlaying, LOBBY_TTL_MS, type Room } from "./lib/room";
import { newProfile, type Profile } from "./lib/round";
import { requireFronteirasAction, requireInviteToken, requireRatingsScope } from "./lib/validate";
import { mapPiece } from "./lib/world";

const totals = (gdpJson as unknown as { totals: { values: Record<string, number> } }).totals;
const BOT_NAME = "Robô";
/** The leaderboard's length (FR-15.12). */
const RATINGS_MAX = 100;
/** Queue slots read per poll. Freshest only: a stale slot never fills it (D-111). */
const QUEUE_SCAN = 50;

/** FR-15.7: rated only between Google accounts. The emulator's e2e accounts are email/password. */
export const isGoogle = (request: CallableRequest<unknown>): boolean => {
  const p = signInProvider(request);
  return p === "google.com" || (EMULATED && p === "password");
};

const alreadyPlaying = (id: string) => mondoError("already-playing", "You are already in a Fronteiras game.", { room: id });

/** The caller's user doc, read FIRST in the transaction; a missing one is made, and written, later. */
async function readMe(tx: Transaction, uid: string, now: Timestamp): Promise<{ profile: Profile; fresh: boolean }> {
  const snap = await tx.get(userRef(uid));
  return snap.exists ? { profile: snap.data() as Profile, fresh: false } : { profile: newProfile(now), fresh: true };
}

async function readRoomIn(tx: Transaction, id: string | undefined): Promise<Room | undefined> {
  return id ? ((await tx.get(roomRef(id))).data() as Room | undefined) : undefined;
}

/** The write phase's half of `readMe`: the pointer to the caller's room, on a profile made if need be. */
function pointMe(tx: Transaction, uid: string, me: { profile: Profile; fresh: boolean }, id: string): void {
  if (me.fresh) tx.create(userRef(uid), { ...me.profile, fronteirasRoom: id });
  else if (me.profile.fronteirasRoom !== id) tx.set(userRef(uid), { fronteirasRoom: id }, { merge: true });
}

/** A one-seat Fronteiras lobby of `uid`'s that can still be joined: their queue slot or challenge link. */
const waiting = (room: Room | undefined, uid: string, ms: number): room is Room =>
  room?.mode === "fronteiras" && room.state === "lobby" && room.playerUids.length === 1 && room.playerUids[0] === uid && ms < room.expiresAt;

/** The caller's OWN seat, from their own token and user doc (never inferred for anyone else). */
function stamp(room: Room, uid: string, profile: Profile, google: boolean): Room {
  const rec = profile.fronteiras;
  const seat = { ...room.players[uid]!, google, rating: rec?.rating ?? START.rating, provisional: (rec?.rd ?? START.rd) > PROVISIONAL_RD };
  return { ...room, players: { ...room.players, [uid]: seat } };
}

const newFronteirasRoom = (uid: string, name: string, ms: number): Room =>
  ({ ...newRoom(uid, name, "fronteiras", "fronteiras", ms), hostUid: null, queue: null, fronteiras: null });

/** A waiting room the caller has left for another game. */
const closed = (room: Room, ms: number): Room => ({ ...room, queue: null, state: "finished", finishedAt: ms, expiresAt: ms });

/** The bot moves inside the transaction that hands it the turn, until the turn is a person's (D-113). */
function runBot(s: FronteirasState, ms: number): FronteirasState {
  const { adj } = boardOf(s.continent);
  while (!s.result && s.turnUid === BOT_UID) s = applyAction(s, adj, BOT_UID, botAction(s, adj, Math.random), ms);
  return s;
}

/**
 * Both seats are in: deal the board and start (FR-15.2). `users` holds the two
 * user docs already read, for the pair cap; the bot has none.
 */
function start(tx: Transaction, id: string, room: Room, users: Record<string, Profile | undefined>, ms: number): void {
  const [a, b] = room.playerUids as [string, string];
  const order: [string, string] = Math.random() < 0.5 ? [a, b] : [b, a];
  const continent = CONTINENTS[Math.floor(Math.random() * CONTINENTS.length)]!;
  const rated = Boolean(room.players[a]?.google && room.players[b]?.google) &&
    !pairCapped(users[a]?.fronteiras, b, ms) && !pairCapped(users[b]?.fronteiras, a, ms);
  const s = runBot(newFronteiras({ order, continent, values: valuesOf(continent, totals), rated, now: ms }), ms);
  tx.set(roomRef(id), { ...room, queue: null, state: "playing", startedAt: ms, fronteiras: s });
  const board = boardOf(continent);
  tx.set(roomSubRef(id, "map", "_board"), {
    viewBox: board.viewBox,
    paths: Object.fromEntries(board.codes.map((c) => [c, mapPiece(c)])),
    adj: board.adj,
    labels: board.labels,
  });
}

/** The two players' user docs, read only when a rated game has just ended. */
async function readPlayers(tx: Transaction, s: FronteirasState): Promise<Record<string, Profile> | null> {
  if (!s.rated || s.result?.reason === "abort") return null;
  const snaps = await tx.getAll(userRef(s.order[0]), userRef(s.order[1]));
  if (!snaps.every((x) => x.exists)) return null; // an account deleted mid-game: nobody is rated
  return Object.fromEntries(snaps.map((x) => [x.id, x.data() as Profile]));
}

/**
 * The game in `s` has just ended: rate it when rated, and finish the room.
 * Exactly once — the caller is the transaction flipping playing → finished.
 */
function endGame(tx: Transaction, id: string, room: Room, s: FronteirasState, users: Record<string, Profile> | null, ms: number): void {
  let result = s.result!;
  if (users) {
    const [a, b] = s.order;
    const score = result.winner === a ? 1 : result.winner === b ? 0 : 0.5;
    const r = rateGame(users[a]!.fronteiras, users[b]!.fronteiras, score, ms,
      { a: users[a]!.displayName, b: users[b]!.displayName }, { a, b });
    tx.set(userRef(a), { fronteiras: r.a }, { merge: true });
    tx.set(userRef(b), { fronteiras: r.b }, { merge: true });
    result = { ...result, ratings: { [a]: { before: r.before.a, after: r.after.a }, [b]: { before: r.before.b, after: r.after.b } } };
  }
  tx.set(roomRef(id), finishRoom({ ...room, fronteiras: { ...s, result } }, ms));
}

/** Write `s` back: the end of the game when it has one, else the room as it now stands. */
async function commit(tx: Transaction, id: string, room: Room, s: FronteirasState, ms: number): Promise<void> {
  if (s.result) endGame(tx, id, room, s, await readPlayers(tx, s), ms);
  else tx.set(roomRef(id), { ...room, fronteiras: s });
}

const clock = () => { const now = Timestamp.now(); return { now, ms: now.toMillis() }; };

/**
 * Before `queue`/`challenge`/`bot`: a game of the caller's whose deadline has
 * passed is settled in a transaction of its own (D-112), so an abandoned game
 * ends when either player next asks for another. Returns its id if it did.
 */
async function settle(uid: string): Promise<string | null> {
  return db().runTransaction(async (tx) => {
    const { ms } = clock();
    const me = await tx.get(userRef(uid));
    const id = (me.data() as Profile | undefined)?.fronteirasRoom;
    const room = await readRoomIn(tx, id);
    const s = room?.fronteiras;
    if (room?.state !== "playing" || !s || s.result || ms < s.deadline) return null;
    await commit(tx, id!, room, applyTimeout(s, ms), ms);
    return id!;
  });
}

/** The caller's next room for a challenge or a bot: their waiting room again, or a new one. */
function nextRoom(me: Profile, mine: Room | undefined, uid: string, ms: number): { id: string; room: Room } {
  const id = me.fronteirasRoom;
  if (mine?.state === "playing") throw alreadyPlaying(id!);
  if (waiting(mine, uid, ms)) return { id: id!, room: { ...mine, queue: null, expiresAt: ms + LOBBY_TTL_MS } };
  return { id: inviteToken(), room: newFronteirasRoom(uid, me.displayName, ms) };
}

async function queue(uid: string, google: boolean): Promise<Record<string, unknown>> {
  // Peek outside the transaction (multiplayer.ts `start` does the same), then
  // re-check everything inside it. Only slots polled in the last 25 s.
  const peekNow = Date.now();
  const [meSnap, open] = await Promise.all([
    userRef(uid).get(),
    db().collection("rooms").where("queue.seenAt", ">=", peekNow - QUEUE_STALE_MS)
      .select("queue", "playerUids").limit(QUEUE_SCAN).get(),
  ]);
  const slots = open.docs.flatMap((d) => {
    const r = d.data() as Pick<Room, "queue" | "playerUids">;
    return r.queue && r.playerUids?.length === 1 ? [{ id: d.id, uid: r.playerUids[0]!, ...r.queue }] : [];
  });
  const myRating = (meSnap.data() as Profile | undefined)?.fronteiras?.rating ?? START.rating;
  const pick = pickOpponent({ uid, rating: myRating, since: slots.find((c) => c.uid === uid)?.since ?? peekNow }, slots, peekNow);

  return db().runTransaction(async (tx) => {
    const { now, ms } = clock();
    const me = await readMe(tx, uid, now);
    const mineId = me.profile.fronteirasRoom;
    const mine = await readRoomIn(tx, mineId);
    if (mine?.state === "playing") throw alreadyPlaying(mineId!);
    const rating = me.profile.fronteiras?.rating ?? START.rating;
    const since = waiting(mine, uid, ms) && mine.queue ? mine.queue.since : ms;

    const theirs = pick ? await readRoomIn(tx, pick.id) : undefined;
    const them = theirs ? (await tx.get(userRef(pick!.uid))).data() as Profile | undefined : undefined;
    const fit = pick && waiting(theirs, pick.uid, ms) && theirs.queue?.open && them?.fronteirasRoom === pick.id &&
      pickOpponent({ uid, rating, since }, [{ id: pick.id, uid: pick.uid, ...theirs.queue }], ms);

    if (fit) {
      const seated = stamp(joinRoom(theirs!, uid, me.profile.displayName, ms), uid, me.profile, google);
      start(tx, pick!.id, seated, { [uid]: me.profile, [pick!.uid]: them }, ms);
      if (mine && mineId !== pick!.id && mine.state === "lobby") tx.set(roomRef(mineId!), closed(mine, ms));
      pointMe(tx, uid, me, pick!.id);
      return { room: pick!.id, matched: true };
    }

    const slot = { open: true as const, rating, since, seenAt: ms };
    if (waiting(mine, uid, ms)) {
      tx.set(roomRef(mineId!), stamp({ ...mine, queue: slot, expiresAt: ms + LOBBY_TTL_MS }, uid, me.profile, google));
      return { room: mineId!, matched: false };
    }
    const id = inviteToken();
    tx.create(roomRef(id), stamp({ ...newFronteirasRoom(uid, me.profile.displayName, ms), queue: slot }, uid, me.profile, google));
    pointMe(tx, uid, me, id);
    return { room: id, matched: false };
  });
}

async function challenge(uid: string, google: boolean): Promise<Record<string, unknown>> {
  return db().runTransaction(async (tx) => {
    const { now, ms } = clock();
    const me = await readMe(tx, uid, now);
    const next = nextRoom(me.profile, await readRoomIn(tx, me.profile.fronteirasRoom), uid, ms);
    tx.set(roomRef(next.id), stamp(next.room, uid, me.profile, google));
    pointMe(tx, uid, me, next.id);
    return { room: next.id };
  });
}

async function bot(uid: string, google: boolean): Promise<Record<string, unknown>> {
  return db().runTransaction(async (tx) => {
    const { now, ms } = clock();
    const me = await readMe(tx, uid, now);
    const next = nextRoom(me.profile, await readRoomIn(tx, me.profile.fronteirasRoom), uid, ms);
    const seated = joinRoom(stamp(next.room, uid, me.profile, google), BOT_UID, BOT_NAME, ms);
    start(tx, next.id, seated, {}, ms); // never rated: the bot is not google (D-113)
    pointMe(tx, uid, me, next.id);
    return { room: next.id };
  });
}

/**
 * `join` of a Fronteiras room: the creator reopening their own link is a no-op;
 * anyone else takes the second seat and the game starts.
 */
export async function joinFronteiras(uid: string, id: string, google: boolean): Promise<Record<string, unknown>> {
  return db().runTransaction(async (tx) => {
    const { now, ms } = clock();
    const me = await readMe(tx, uid, now);
    const room = await readRoomIn(tx, id);
    if (!room) throw mondoError("not-found", "No such room.");
    const done = { room: id, mine: null, presets: me.profile.presets ?? [] };
    if (room.playerUids.includes(uid)) return done;
    const prevId = me.profile.fronteirasRoom;
    const prev = prevId && prevId !== id ? await readRoomIn(tx, prevId) : undefined;
    const creator = room.playerUids[0];
    const theirs = creator ? (await tx.get(userRef(creator))).data() as Profile | undefined : undefined;

    if (prev?.state === "playing") throw alreadyPlaying(prevId!);
    if (room.state !== "lobby") throw mondoError("room-started", "This game has already started.");
    if (!creator || !waiting(room, creator, ms) || theirs?.fronteirasRoom !== id) throw mondoError("not-found", "This challenge is no longer open.");

    start(tx, id, stamp(joinRoom(room, uid, me.profile.displayName, ms), uid, me.profile, google), { [uid]: me.profile, [creator]: theirs }, ms);
    if (prev?.state === "lobby") tx.set(roomRef(prevId!), closed(prev, ms));
    pointMe(tx, uid, me, id);
    return done;
  });
}

async function move(uid: string, id: string, action: Action): Promise<Record<string, unknown>> {
  await db().runTransaction(async (tx) => {
    const { ms } = clock();
    const room = await readRoomIn(tx, id);
    if (!room) throw mondoError("not-found", "No such room.");
    requirePlayer(room, uid);
    requirePlaying(room, "fronteiras");
    const { adj } = boardOf(room.fronteiras!.continent);
    // At or after the deadline this throws `deadline-passed` and nothing is written: the client ticks.
    const s = runBot(applyAction(room.fronteiras!, adj, uid, action, ms), ms);
    await commit(tx, id, room, s, ms);
  });
  return {};
}

/** `tick` on a playing Fronteiras room: settle the turn if its deadline has passed. */
export async function tickFronteiras(tx: Transaction, id: string, room: Room, ms: number): Promise<boolean> {
  const s = room.fronteiras;
  if (!s || s.result || ms < s.deadline) return false;
  await commit(tx, id, room, applyTimeout(s, ms), ms);
  return true;
}

/** `giveUp`: an abort in the draft (no result), a resignation in play — unless the clock already decided it. */
export async function giveUpFronteiras(tx: Transaction, id: string, room: Room, uid: string, ms: number): Promise<void> {
  const s = room.fronteiras;
  if (!s) throw mondoError("invalid-argument", "This game has not started.");
  const next = ms >= s.deadline ? applyTimeout(s, ms) : s.phase === "draft" ? abort(s) : resign(s, uid);
  await commit(tx, id, room, next, ms);
}

/**
 * FR-15.12: the top 100 settled players, everyone's or the caller's groups'.
 * Read-only. D-110: uid + display name + rating to anyone signed in.
 */
async function ratings(uid: string, scope: "all" | "groups"): Promise<Record<string, unknown>> {
  let q = db().collection("users").where("fronteiras.settled", "==", true);
  if (scope === "groups") {
    const groups = ((await userRef(uid).get()).data() as Profile | undefined)?.groups ?? [];
    if (groups.length === 0) return { players: [] };
    q = q.where("groups", "array-contains-any", groups); // ≤ 10 (D-27)
  }
  // ponytail: ≤100 reads per view; cache a top-100 doc written at rated finish if §7 moves.
  const snap = await q.orderBy("fronteiras.rating", "desc").limit(RATINGS_MAX)
    .select("displayName", "fronteiras.rating", "fronteiras.games", "fronteiras.lastPlayedAt").get();
  return {
    players: snap.docs.map((d) => {
      const p = d.data() as Pick<Profile, "displayName"> & { fronteiras: { rating: number; games: number; lastPlayedAt: number } };
      return { uid: d.id, displayName: p.displayName, rating: p.fronteiras.rating, games: p.fronteiras.games, lastPlayedAt: p.fronteiras.lastPlayedAt };
    }),
  };
}

/** The Fronteiras-only ops of `multiplayer({ op })`. */
export async function fronteirasOp(
  op: string, uid: string, body: Record<string, unknown>, request: CallableRequest<unknown>,
): Promise<Record<string, unknown>> {
  switch (op) {
    case "queue":
    case "challenge":
    case "bot": {
      const settled = await settle(uid);
      if (settled) return { room: settled, settled: true };
      const google = isGoogle(request);
      return op === "queue" ? queue(uid, google) : op === "challenge" ? challenge(uid, google) : bot(uid, google);
    }
    case "move":
      return move(uid, requireInviteToken(body.room), requireFronteirasAction(body.action));
    case "ratings":
      return ratings(uid, requireRatingsScope(body.scope));
    default:
      throw mondoError("invalid-argument", "Unknown op.");
  }
}
