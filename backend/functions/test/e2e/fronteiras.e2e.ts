/**
 * Fronteiras end-to-end against the emulators (FR-15, D-107–D-113).
 *
 * The unit tests own the game, the ladder and the bot. What only this file can
 * prove is the wire and the transactions: that queue and challenge seat two
 * players in one room and start it, that a refused action writes nothing, that
 * a rating moves exactly once and only between two "Google" accounts (the
 * emulator counts email/password, `lib/callable.ts`), and that one account has
 * one live game.
 *
 * Long games are not played out: their state is seeded or backdated through
 * the Admin SDK, so no test-only clock knob ships in production code.
 * Every test uses its own accounts, and every queue slot it opens is consumed
 * or closed before the next test, so no test can be matched into another's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { boardOf, legalActions, BOT_UID, type FronteirasState } from "../../src/lib/fronteiras";
import { newRecord } from "../../src/lib/ladder";
import { newProfile } from "../../src/lib/round";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST is not set; run under emulators:exec.");
if (getApps().length === 0) initializeApp({ projectId: "demo-mondo" });
const db = getFirestore();

const FUNCTIONS = `${process.env.MONDO_FUNCTIONS_ORIGIN ?? "http://127.0.0.1:5001"}/demo-mondo/southamerica-east1`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099"}/identitytoolkit.googleapis.com/v1`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
interface Res { status: number; result?: Any; error?: Any }
interface Account { uid: string; call: (data: unknown) => Promise<Res> }

async function post(data: unknown, token: string): Promise<Res> {
  const r = await fetch(`${FUNCTIONS}/multiplayer`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const text = await r.text();
  let body: Any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: r.status, result: body.result, error: body.error };
}

/** An email account (rated, in the emulator), or — with no label — a guest. */
async function newAccount(label?: string): Promise<Account> {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(label
      ? { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "secret123", returnSecureToken: true }
      : { returnSecureToken: true }),
  }).then((x) => x.json() as Promise<Any>);
  return { uid: r.localId, call: (data) => post(data, r.idToken) };
}

const code = (r: Res) => r.error?.details?.code ?? r.error?.status ?? null;
const ok = (r: Res, what: string) => { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.error)}`); return r.result; };
const room = async (id: string) => (await db.doc(`rooms/${id}`).get()).data() as Any;
const user = async (uid: string) => (await db.doc(`users/${uid}`).get()).data() as Any;

/** A challenge link from `a`, taken by `b`: a started game. */
async function game(a: Account, b: Account): Promise<string> {
  const { room: id } = ok(await a.call({ op: "challenge" }), "challenge");
  ok(await b.call({ op: "join", room: id }), "join");
  return id;
}

/**
 * Put the game into play with `mover` to move and one attack away from the
 * other's capital: two neighbouring territories on its board, one each.
 */
async function seedPlay(id: string, mover: string, over: Partial<FronteirasState> = {}) {
  const s = (await room(id)).fronteiras as FronteirasState;
  const { adj } = boardOf(s.continent);
  const mine = Object.keys(adj).find((c) => adj[c]!.length > 0)!;
  const theirs = adj[mine]![0]!;
  const seat = s.order[0] === mover ? 0 : 1;
  const now = Date.now();
  const next: FronteirasState = {
    ...s, phase: "play", draftIdx: 6, ply: 10, turnUid: mover, turnStartedAt: now, deadline: now + 300_000,
    owner: { [mine]: seat, [theirs]: (1 - seat) as 0 | 1 },
    capital: seat === 0 ? [mine, theirs] : [theirs, mine],
    fort: {}, gold: seat === 0 ? [50, 0] : [0, 50],
    clock: Object.fromEntries(s.order.map((u) => [u, 300_000])),
    ...over,
  };
  await db.doc(`rooms/${id}`).update({ fronteiras: next });
  return { s: next, mine, theirs, adj };
}

test("FR-15.9: two players queue and are matched into one started, rated room", async () => {
  const [a, b] = await Promise.all([newAccount("fr-q-a"), newAccount("fr-q-b")]);
  const first = ok(await a.call({ op: "queue" }), "a queues");
  assert.equal(first.matched, false);
  let r = await room(first.room);
  assert.equal(r.mode, "fronteiras");
  assert.equal(r.hostUid, null);
  assert.equal(r.queue.open, true);
  assert.equal(r.players[a.uid].google, true);
  assert.equal(r.players[a.uid].rating, 1500);
  assert.equal(r.players[a.uid].provisional, true);
  // Polling again refreshes the same slot.
  assert.equal(ok(await a.call({ op: "queue" }), "a polls").room, first.room);

  const second = ok(await b.call({ op: "queue" }), "b queues");
  assert.deepEqual([second.room, second.matched], [first.room, true]);
  r = await room(first.room);
  assert.equal(r.state, "playing");
  assert.equal(r.queue, null);
  assert.deepEqual([...r.playerUids].sort(), [a.uid, b.uid].sort());
  assert.equal(r.fronteiras.rated, true);
  assert.equal(r.fronteiras.phase, "draft");
  assert.equal((await user(a.uid)).fronteirasRoom, first.room);
  assert.equal((await user(b.uid)).fronteirasRoom, first.room);

  const board = (await db.doc(`rooms/${first.room}/map/_board`).get()).data() as Any;
  const codes = Object.keys(r.fronteiras.values).sort();
  assert.deepEqual(Object.keys(board.paths).sort(), codes);
  assert.deepEqual(Object.keys(board.adj).sort(), codes);
  assert.ok(board.viewBox && board.labels);
  for (const c of codes) assert.ok(board.paths[c].d || board.paths[c].dot, c);

  // One live game per account (D-112).
  const again = await a.call({ op: "queue" });
  assert.equal(code(again), "already-playing");
  assert.equal(again.error.details.room, first.room);
  assert.equal(code(await a.call({ op: "bot" })), "already-playing");
  assert.equal(code(await b.call({ op: "challenge" })), "already-playing");
});

test("FR-15.5, FR-15.7: a capital capture rates both players once; a second tick changes nothing", async () => {
  const [a, b] = await Promise.all([newAccount("fr-cap-a"), newAccount("fr-cap-b")]);
  const id = await game(a, b);
  const { theirs } = await seedPlay(id, a.uid);
  ok(await a.call({ op: "move", room: id, action: { t: "attack", code: theirs } }), "capture");

  const r = await room(id);
  assert.equal(r.state, "finished");
  assert.equal(r.expiresAt, r.finishedAt, "one game per room (D-107)");
  assert.deepEqual([r.fronteiras.result.winner, r.fronteiras.result.reason], [a.uid, "capital"]);
  const ra = r.fronteiras.result.ratings;
  assert.ok(ra[a.uid].after > ra[a.uid].before && ra[b.uid].after < ra[b.uid].before);
  assert.equal(r.players[a.uid].wins, 1);

  const [ua, ub] = await Promise.all([user(a.uid), user(b.uid)]);
  assert.equal(ua.fronteiras.games, 1);
  assert.equal(ub.fronteiras.games, 1);
  assert.equal(ua.fronteiras.rating, ra[a.uid].after);
  assert.equal(ua.fronteiras.history[0].result, "w");
  assert.equal(ub.fronteiras.history[0].result, "l");
  assert.deepEqual(ua.fronteiras.recent.map((x: Any) => x.opp), [b.uid]);

  assert.equal(ok(await b.call({ op: "tick", room: id }), "tick").moved, false);
  assert.equal(code(await b.call({ op: "move", room: id, action: { t: "pass" } })), "already-completed");
  assert.equal(code(await b.call({ op: "giveUp", room: id })), "already-completed");
  assert.deepEqual(await user(a.uid), ua);
  assert.deepEqual(await user(b.uid), ub);
  // The finished room is closed: nobody else sits down in it.
  const c = await newAccount("fr-cap-c");
  assert.notEqual(code(await c.call({ op: "join", room: id })), null);
});

test("FR-15.9: a challenge link — the creator reopening it changes nothing, the second player starts it", async () => {
  const [a, b, c] = await Promise.all([newAccount("fr-ch-a"), newAccount("fr-ch-b"), newAccount("fr-ch-c")]);
  const { room: id } = ok(await a.call({ op: "challenge" }), "challenge");
  assert.equal(ok(await a.call({ op: "challenge" }), "again").room, id, "the same link while it waits");
  let r = await room(id);
  assert.deepEqual([r.state, r.queue, r.playerUids], ["lobby", null, [a.uid]]);
  ok(await a.call({ op: "join", room: id }), "creator reopens");
  assert.equal((await room(id)).state, "lobby");
  assert.equal(code(await a.call({ op: "move", room: id, action: { t: "pass" } })), "invalid-argument");

  ok(await b.call({ op: "join", room: id }), "b joins");
  r = await room(id);
  assert.equal(r.state, "playing");
  assert.equal(r.fronteiras.rated, true);
  ok(await b.call({ op: "join", room: id }), "joining your own game again is not an error");
  assert.equal(code(await c.call({ op: "join", room: id })), "room-started");
});

test("FR-15.4: illegal actions are refused and the room is unchanged; a late move is refused and tick flags it", async () => {
  const [a, b] = await Promise.all([newAccount("fr-il-a"), newAccount("fr-il-b")]);
  const id = await game(a, b);
  let r = await room(id);
  const s = r.fronteiras as FronteirasState;
  const [first, second] = s.order.map((u) => (u === a.uid ? a : b)) as [Account, Account];
  const onBoard = Object.keys(s.values)[0]!;
  const offBoard = ["BR", "JP", "FR", "NG"].find((c) => !(c in s.values))!;
  const refused: [Account, unknown, string][] = [
    [second, { t: "pick", code: onBoard }, "not-your-turn"],
    [first, { t: "pick", code: offBoard }, "illegal-move"],
    [first, { t: "take", code: onBoard }, "illegal-move"],
    [first, { t: "pass" }, "illegal-move"],
    [first, { t: "pick", code: "ZZ" }, "invalid-argument"],
    [first, { t: "pick", code: onBoard, gold: 9 }, "invalid-argument"],
  ];
  for (const [who, action, expect] of refused) {
    assert.equal(code(await who.call({ op: "move", room: id, action })), expect, JSON.stringify(action));
  }
  assert.deepEqual(await room(id), r);

  // In play: not adjacent, not affordable.
  const { adj, mine } = await seedPlay(id, first.uid, { gold: [0, 0] });
  r = await room(id);
  const far = Object.keys(r.fronteiras.values).find((c) => c !== mine && !adj[mine]!.includes(c) && !r.fronteiras.owner[c])!;
  assert.equal(code(await first.call({ op: "move", room: id, action: { t: "take", code: far } })), "illegal-move");
  assert.equal(code(await first.call({ op: "move", room: id, action: { t: "fortify", code: mine } })), "illegal-move");
  assert.deepEqual(await room(id), r);

  // The deadline passes (backdated): a move is refused and writes nothing; the opponent's tick flags it.
  await db.doc(`rooms/${id}`).update({ "fronteiras.deadline": Date.now() - 1 });
  r = await room(id);
  assert.equal(code(await first.call({ op: "move", room: id, action: { t: "pass" } })), "deadline-passed");
  assert.deepEqual(await room(id), r);
  assert.equal(ok(await second.call({ op: "tick", room: id }), "tick").moved, true);
  r = await room(id);
  assert.deepEqual([r.state, r.fronteiras.result.winner, r.fronteiras.result.reason], ["finished", second.uid, "time"]);
  assert.equal((await user(second.uid)).fronteiras.games, 1);
  assert.equal((await user(first.uid)).fronteiras.history[0].result, "l");
  assert.equal(ok(await first.call({ op: "tick", room: id }), "tick again").moved, false);
});

test("FR-15.8: the fourth rated game of a pair inside 24 h is unrated", async () => {
  const [a, b] = await Promise.all([newAccount("fr-cap4-a"), newAccount("fr-cap4-b")]);
  const now = Date.now();
  const seed = (opp: string) => ({ ...newRecord(), games: 3, lastPlayedAt: now - 1000, recent: [1, 2, 3].map((i) => ({ opp, at: now - i * 3_600_000 })) });
  await db.doc(`users/${a.uid}`).set({ ...newProfile(Timestamp.now(), "Quarta A"), fronteiras: seed(b.uid) });
  await db.doc(`users/${b.uid}`).set({ ...newProfile(Timestamp.now(), "Quarta B"), fronteiras: seed(a.uid) });
  const id = await game(a, b);
  assert.equal((await room(id)).fronteiras.rated, false);
  const { theirs } = await seedPlay(id, a.uid);
  ok(await a.call({ op: "move", room: id, action: { t: "attack", code: theirs } }), "capture");
  assert.equal((await room(id)).fronteiras.result.ratings, undefined);
  assert.equal((await user(a.uid)).fronteiras.games, 3);
  assert.equal((await user(b.uid)).fronteiras.games, 3);
});

test("FR-15.7: a guest's game is unrated and leaves no record", async () => {
  const [guest, b] = await Promise.all([newAccount(), newAccount("fr-guest-b")]);
  const id = await game(guest, b);
  let r = await room(id);
  assert.equal(r.players[guest.uid].google, false);
  assert.equal(r.fronteiras.rated, false);
  const { theirs } = await seedPlay(id, b.uid);
  ok(await b.call({ op: "move", room: id, action: { t: "attack", code: theirs } }), "capture");
  r = await room(id);
  assert.deepEqual([r.state, r.fronteiras.result.winner], ["finished", b.uid]);
  assert.equal((await user(guest.uid)).fronteiras, undefined);
  assert.equal((await user(b.uid)).fronteiras, undefined);
});

test("D-112: an abort in the draft writes no user; a draft timeout settles on the player's next call", async () => {
  const [a, b] = await Promise.all([newAccount("fr-ab-a"), newAccount("fr-ab-b")]);
  let id = await game(a, b);
  ok(await a.call({ op: "giveUp", room: id }), "abort");
  let r = await room(id);
  assert.deepEqual([r.state, r.fronteiras.result.reason, r.fronteiras.result.winner], ["finished", "abort", null]);
  const after = await Promise.all([user(a.uid), user(b.uid)]);
  assert.equal(after[0].fronteiras, undefined);
  assert.equal(after[1].fronteiras, undefined);

  // A game left in the draft: the next `bot` settles it first, and says so.
  id = await game(a, b);
  await db.doc(`rooms/${id}`).update({ "fronteiras.deadline": Date.now() - 1 });
  const settled = ok(await b.call({ op: "bot" }), "bot settles");
  assert.deepEqual(settled, { ...settled, room: id, settled: true });
  r = await room(id);
  assert.deepEqual([r.state, r.fronteiras.result.reason], ["finished", "abort"]);
  assert.equal((await user(a.uid)).fronteiras, undefined);
});

test("D-113: the bot, first or second, plays a whole game, unrated, and never has a user doc", async () => {
  const m = await newAccount("fr-bot");
  const seen = new Set<string>();
  for (let tries = 0; seen.size < 2 && tries < 30; tries++) {
    const { room: id } = ok(await m.call({ op: "bot" }), "bot");
    let r = await room(id);
    const s0 = r.fronteiras as FronteirasState;
    const which = s0.order[0] === BOT_UID ? "bot-first" : "bot-second";
    assert.equal(s0.rated, false);
    assert.equal(s0.turnUid, m.uid, "the bot has already moved");
    assert.equal(s0.draftIdx, which === "bot-first" ? 1 : 0);
    if (seen.has(which)) { ok(await m.call({ op: "giveUp", room: id }), "abort a repeat"); continue; }
    seen.add(which);
    const { adj } = boardOf(s0.continent);
    for (let n = 0; r.state === "playing"; n++) {
      assert.ok(n < 40, "the game ends");
      const s = r.fronteiras as FronteirasState;
      assert.equal(s.turnUid, m.uid);
      const legal = legalActions(s, adj, m.uid);
      const action = legal.find((x) => x.t === "attack") ?? legal.find((x) => x.t === "take" || x.t === "pick") ?? legal[0]!;
      ok(await m.call({ op: "move", room: id, action }), `move ${n}`);
      r = await room(id);
    }
    assert.ok(r.fronteiras.result);
    assert.equal(r.fronteiras.result.ratings, undefined);
  }
  assert.equal(seen.size, 2);
  assert.equal((await db.doc(`users/${BOT_UID}`).get()).exists, false);
  assert.equal((await user(m.uid)).fronteiras, undefined);
});

test("FR-15.12: ratings lists settled players only, everyone's or the caller's groups'", async () => {
  const [caller, s1, s2, prov] = await Promise.all([newAccount("fr-lb"), newAccount("fr-lb1"), newAccount("fr-lb2"), newAccount("fr-lb3")]);
  const g1 = `g${Date.now()}aaaaaaaaaaaaaa`.slice(0, 20);
  const g2 = `h${Date.now()}bbbbbbbbbbbbbb`.slice(0, 20);
  const rec = (rating: number, rd: number) => ({ ...newRecord(), rating, rd, settled: rd <= 110, games: 40, lastPlayedAt: Date.now(), recent: [{ opp: "hidden", at: Date.now() }] });
  await Promise.all([
    db.doc(`users/${caller.uid}`).set({ ...newProfile(Timestamp.now(), "Leitor"), groups: [g1] }),
    db.doc(`users/${s1.uid}`).set({ ...newProfile(Timestamp.now(), "Assentado Um"), groups: [g1], fronteiras: rec(2400, 60) }),
    db.doc(`users/${s2.uid}`).set({ ...newProfile(Timestamp.now(), "Assentado Dois"), groups: [g2], fronteiras: rec(2300, 80) }),
    db.doc(`users/${prov.uid}`).set({ ...newProfile(Timestamp.now(), "Provisorio"), groups: [g1], fronteiras: rec(2500, 200) }),
  ]);
  const all = ok(await caller.call({ op: "ratings", scope: "all" }), "all").players as Any[];
  const uids = all.map((p) => p.uid);
  assert.ok(uids.includes(s1.uid) && uids.includes(s2.uid));
  assert.ok(!uids.includes(prov.uid), "provisional players are off the board");
  assert.ok(uids.indexOf(s1.uid) < uids.indexOf(s2.uid), "highest first");
  assert.deepEqual(Object.keys(all[uids.indexOf(s1.uid)]).sort(), ["displayName", "games", "lastPlayedAt", "rating", "uid"]);
  assert.ok(!JSON.stringify(all).includes("hidden") && !JSON.stringify(all).includes(g1));

  const mine = ok(await caller.call({ op: "ratings", scope: "groups" }), "groups").players as Any[];
  assert.deepEqual(mine.map((p) => [p.uid, p.displayName]), [[s1.uid, "Assentado Um"]]);
  assert.deepEqual(ok(await s1.call({ op: "ratings", scope: "groups" }), "s1").players.map((p: Any) => p.uid), [s1.uid]);
  assert.equal(code(await caller.call({ op: "ratings", scope: "friends" })), "invalid-argument");
});

test("D-112: an open queue slot is never matched once its player has joined a challenge", async () => {
  const [q, r1, s] = await Promise.all([newAccount("fr-dbl-q"), newAccount("fr-dbl-r"), newAccount("fr-dbl-s")]);
  const { room: slot } = ok(await q.call({ op: "queue" }), "q queues");
  const { room: link } = ok(await r1.call({ op: "challenge" }), "r challenges");
  ok(await q.call({ op: "join", room: link }), "q joins the link");
  assert.equal((await room(link)).state, "playing");
  const old = await room(slot);
  assert.deepEqual([old.state, old.queue], ["finished", null]);
  assert.equal((await user(q.uid)).fronteirasRoom, link);

  const sq = ok(await s.call({ op: "queue" }), "s queues");
  assert.equal(sq.matched, false);
  assert.notEqual(sq.room, slot);
  assert.equal(code(await q.call({ op: "queue" })), "already-playing");
  ok(await s.call({ op: "leave", room: sq.room }), "s leaves its slot");
  assert.equal((await room(sq.room)).queue, null);

  // Queue, then challenge: the slot becomes the link, out of the queue.
  const t = await newAccount("fr-dbl-t");
  const { room: tslot } = ok(await t.call({ op: "queue" }), "t queues");
  assert.equal(ok(await t.call({ op: "challenge" }), "t challenges").room, tslot);
  assert.equal((await room(tslot)).queue, null);
  ok(await t.call({ op: "leave", room: tslot }), "t leaves");
});
