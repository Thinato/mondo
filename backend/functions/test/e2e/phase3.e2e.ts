/**
 * Phase 3 slices 1–2 end-to-end against the emulators (D-33): create a
 * tournament from a preset, join it, start it, play a mixed card, close the
 * round, read the standings.
 *
 * `npm run test:e2e` starts Functions + Firestore + Auth under demo-mondo and
 * runs the Phase 2 file and this one. Every check asserts both the callable
 * response and the Firestore state — the read-after-write bug in Phase 2 was
 * only visible from here, not from the unit tests.
 *
 * Tests share state and run in order.
 */

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { puzzleIdAt } from "../../src/lib/puzzle-day";
import { advanceOpenRoundsNow } from "../../src/tournaments";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
if (getApps().length === 0) initializeApp({ projectId: "demo-mondo" });
const db = getFirestore();

const FUNCTIONS = "http://127.0.0.1:5001/demo-mondo/southamerica-east1";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const TODAY = puzzleIdAt(new Date());

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
interface Res { status: number; result?: Any; error?: Any }
interface Account { uid: string; token: string; call: (fn: string, data?: unknown) => Promise<Res> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(fn: string, data: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${FUNCTIONS}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const text = await r.text();
  let body: Any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: r.status, result: body.result, error: body.error };
}

async function newAccount(label: string): Promise<Account> {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "secret123", returnSecureToken: true }),
  }).then((x) => x.json() as Promise<Any>);
  return { uid: r.localId, token: r.idToken, call: (fn, data = {}) => post(fn, data, r.idToken) };
}

const code = (r: Res) => r.error?.details?.code ?? r.error?.status ?? null;
const ok = (r: Res, what: string) => { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.error)}`); return r.result; };
const doc = async (path: string) => (await db.doc(path).get()).data() as Any;

let owner: Account;   // organizer, owns the group
let ana: Account;     // member and participant
let bruno: Account;   // member who joins but never plays — the forfeit (FR-5.7)
let carla: Account;   // in NO group: the outsider
let gid: string;
let tid: string;

/** A fresh account with the organizer role, so it can own a group. */
async function withOrganizer(label: string): Promise<Account> {
  const a = await newAccount(label);
  await a.call("getRound", {});
  await db.doc(`users/${a.uid}`).update({ role: "organizer" });
  return a;
}

before(async () => {
  // A puzzle must exist for the daily-schedule exclusion query (FR-5.2) and so
  // getRound works for the profile-creating first call.
  await db.doc(`puzzles/${TODAY}`).set({
    puzzleId: TODAY,
    items: [{ kind: "shape", subject: "PY" }, { kind: "flag", subject: "BR" }, { kind: "capital", subject: "IT" }],
    opensAt: Timestamp.now(),
  });

  owner = await newAccount("t3-owner");
  await owner.call("getRound", {});
  await db.doc(`users/${owner.uid}`).update({ role: "organizer" });
  gid = ok(await owner.call("createGroup", { name: "Torneios e2e" }), "createGroup").groupId;

  for (const label of ["t3-ana", "t3-bruno"]) {
    const a = await newAccount(label);
    const { token } = ok(await owner.call("createInvite", { groupId: gid }), "createInvite");
    ok(await a.call("acceptInvite", { token }), "acceptInvite");
    if (label === "t3-ana") ana = a; else bruno = a;
  }
  carla = await newAccount("t3-carla");
  await carla.call("getRound", {});
});

// ---------------------------------------------------------------------------

test("only the group owner may create a tournament, and only from a shipped preset", async () => {
  assert.equal(code(await ana.call("createTournament", { groupId: gid, name: "Meu torneio", preset: "quintal" })), "permission-denied");
  assert.equal(code(await carla.call("createTournament", { groupId: gid, name: "Meu torneio", preset: "quintal" })), "permission-denied");
  assert.equal(code(await owner.call("createTournament", { groupId: gid, name: "Nope", preset: "nao-existe" })), "invalid-argument");
  assert.equal(code(await owner.call("createTournament", { groupId: gid, name: "ab", preset: "quintal" })), "invalid-argument");
});

test("D-48: creating from `mistura` copies the resolved settings onto the document", async () => {
  tid = ok(await owner.call("createTournament", { groupId: gid, name: "Mistura de sexta", preset: "mistura" }), "createTournament").tournamentId;
  const t = await doc(`tournaments/${tid}`);
  assert.equal(t.status, "draft");
  assert.equal(t.preset, "mistura");
  assert.equal(t.format, "free_for_all");
  assert.equal(t.regime, "aggregate");
  assert.equal(t.config.cardSpec.order, "shuffled");
  assert.deepEqual(t.config.cardSpec.items, [{ kind: "shape", count: 3 }, { kind: "capital", count: 2 }]);
  assert.deepEqual(t.participantUids, [owner.uid], "the creator is in by default");
  assert.ok(t.participants[owner.uid].displayName, "the name is snapshotted at draft time");
  assert.equal(t.currentRound, null);
});

test("FR-5.3: a non-member cannot see the tournament, and a member can", async () => {
  assert.equal(code(await carla.call("getTournament", { tournamentId: tid })), "permission-denied");
  assert.equal(code(await carla.call("listTournaments", { groupId: gid })), "permission-denied");
  const v = ok(await ana.call("getTournament", { tournamentId: tid }), "getTournament");
  assert.equal(v.name, "Mistura de sexta");
  assert.equal(v.canJoin, true);
  assert.equal(v.canManage, false);
  assert.equal(v.itemCount, 5);
});

test("members join while it is a draft; an outsider cannot", async () => {
  ok(await ana.call("setParticipation", { tournamentId: tid, join: true }), "ana joins");
  ok(await bruno.call("setParticipation", { tournamentId: tid, join: true }), "bruno joins");
  assert.equal(code(await carla.call("setParticipation", { tournamentId: tid, join: true })), "permission-denied");
  const t = await doc(`tournaments/${tid}`);
  assert.deepEqual([...t.participantUids].sort(), [owner.uid, ana.uid, bruno.uid].sort());
  // Joining twice is a no-op rather than an error.
  ok(await ana.call("setParticipation", { tournamentId: tid, join: true }), "idempotent join");
  assert.equal((await doc(`tournaments/${tid}`)).participantUids.length, 3);
});

test("leaving a draft removes the participant entirely", async () => {
  ok(await bruno.call("setParticipation", { tournamentId: tid, join: false }), "bruno leaves");
  let t = await doc(`tournaments/${tid}`);
  assert.ok(!t.participantUids.includes(bruno.uid));
  assert.equal(t.participants[bruno.uid], undefined);
  ok(await bruno.call("setParticipation", { tournamentId: tid, join: true }), "and comes back");
  t = await doc(`tournaments/${tid}`);
  assert.ok(t.participantUids.includes(bruno.uid));
});

test("nobody can play a draft, and only the owner may start it", async () => {
  assert.equal(code(await ana.call("getCard", { tournamentId: tid })), "tournament-not-open");
  assert.equal(code(await ana.call("startTournament", { tournamentId: tid })), "permission-denied");
  const res = ok(await owner.call("startTournament", { tournamentId: tid }), "startTournament");
  assert.equal(res.round, 1);
  assert.ok(Date.parse(res.closesAt) > Date.now(), "the round closes in the future");

  const t = await doc(`tournaments/${tid}`);
  assert.equal(t.status, "running");
  assert.equal(t.currentRound, 1);
  assert.equal(t.roundCount, 1);
  assert.deepEqual(Object.values(t.participants).map((p: Any) => p.seed).sort(), [1, 2, 3]);
  assert.equal(code(await owner.call("startTournament", { tournamentId: tid })), "tournament-not-open", "starting twice is refused");
});

test("D-38 / D-42: one stored card per round, five distinct subjects, shuffled kinds", async () => {
  const card = await doc(`cards/${tid}_r1`);
  assert.equal(card.items.length, 5);
  assert.equal(new Set(card.items.map((i: Any) => i.subject)).size, 5);
  const kinds = card.items.map((i: Any) => i.kind);
  assert.equal(kinds.filter((k: string) => k === "shape").length, 3);
  assert.equal(kinds.filter((k: string) => k === "capital").length, 2);
  // FR-5.2: the card must not ask what the daily schedule is about to ask.
  assert.ok(!card.items.some((i: Any) => i.subject === "PY"), "today's daily country must be excluded");

  const round = await doc(`tournaments/${tid}/rounds/1`);
  assert.equal(round.cardId, `${tid}_r1`);
  assert.equal(round.closedAt, null);
  assert.deepEqual(round.results, {}, "an open round holds no results to leak (FR-5.6)");
});

test("getCard serves the first prompt only, starts the server clock, and reveals nothing", async () => {
  const v = ok(await ana.call("getCard", { tournamentId: tid }), "getCard");
  assert.equal(v.cursor, 0);
  assert.equal(v.itemCount, 5);
  assert.equal(v.status, "in_progress");
  assert.ok(v.prompt.kind === "shape" || v.prompt.kind === "capital");
  assert.equal(v.points, null);
  assert.deepEqual(v.items.map((i: Any) => i.answer), [null, null, null, null, null]);

  const card = await doc(`cards/${tid}_r1`);
  const body = JSON.stringify(v);
  for (const item of card.items) assert.ok(!body.includes(`"${item.subject}"`), `SEC-1: the view leaks ${item.subject}`);

  const play = await doc(`attempts/${ana.uid}_${tid}_r1`);
  assert.equal(play.mode, "match");
  assert.ok(play.startedAt, "SEC-3: the clock is a server timestamp");
  assert.equal(play.items.length, 5);
  assert.ok(!("puzzleId" in play), "D-40: a puzzleId here would put this on the daily board");
});

test("leaving the group closes the card too, even with the slot still in the bracket", async () => {
  const quitter = await newAccount("t3-quitter");
  const { token } = ok(await owner.call("createInvite", { groupId: gid }), "createInvite");
  ok(await quitter.call("acceptInvite", { token }), "acceptInvite");
  const t5 = ok(await owner.call("createTournament", { groupId: gid, name: "Saida", preset: "quintal" }), "createTournament").tournamentId;
  ok(await quitter.call("setParticipation", { tournamentId: t5, join: true }), "joins");
  ok(await owner.call("startTournament", { tournamentId: t5 }), "startTournament");
  ok(await quitter.call("getCard", { tournamentId: t5 }), "can play while a member");

  ok(await quitter.call("leaveGroup", { groupId: gid }), "leaveGroup");
  // The slot stays so the standings fold keeps its shape (D-46) ...
  assert.ok((await doc(`tournaments/${t5}`)).participantUids.includes(quitter.uid));
  // ... but the slot is not a licence to keep playing inside a group they left.
  assert.equal(code(await quitter.call("getCard", { tournamentId: t5 })), "permission-denied");
  assert.equal(code(await quitter.call("submitCardGuess", { tournamentId: t5, guess: "BR" })), "permission-denied");
  assert.equal(code(await quitter.call("getTournament", { tournamentId: t5 })), "permission-denied");
  ok(await owner.call("cancelTournament", { tournamentId: t5 }), "cleanup");
});

test("T-9: dissolving a group cancels its tournaments instead of orphaning them", async () => {
  const solo = await withOrganizer("t3-solo");
  const g2 = ok(await solo.call("createGroup", { name: "Grupo efemero" }), "createGroup").groupId;
  const t6 = ok(await solo.call("createTournament", { groupId: g2, name: "Orfao", preset: "quintal" }), "createTournament").tournamentId;
  const mate = await newAccount("t3-mate");
  const { token } = ok(await solo.call("createInvite", { groupId: g2 }), "createInvite");
  ok(await mate.call("acceptInvite", { token }), "acceptInvite");
  ok(await mate.call("setParticipation", { tournamentId: t6, join: true }), "joins");
  ok(await solo.call("startTournament", { tournamentId: t6 }), "startTournament");

  // Both leave; the last one out dissolves the group (D-23).
  ok(await mate.call("leaveGroup", { groupId: g2 }), "mate leaves");
  ok(await solo.call("leaveGroup", { groupId: g2 }), "owner leaves last");
  assert.equal((await db.doc(`groups/${g2}`).get()).exists, false, "the group is gone");
  const t = await doc(`tournaments/${t6}`);
  assert.equal(t.status, "cancelled", "a running tournament must not outlive its group");
  assert.equal(t.currentRound, null);
  // And the nightly sweep must not pick it back up.
  const swept = await advanceOpenRoundsNow(Timestamp.now());
  assert.equal(swept.failed, 0);
});

test("a non-participant is refused the card even inside the group", async () => {
  const outsider = await newAccount("t3-outsider");
  const { token } = ok(await owner.call("createInvite", { groupId: gid }), "createInvite");
  ok(await outsider.call("acceptInvite", { token }), "acceptInvite");
  assert.equal(code(await outsider.call("getCard", { tournamentId: tid })), "not-a-participant");
  assert.equal(code(await outsider.call("submitCardGuess", { tournamentId: tid, guess: "BR" })), "not-a-participant");
});

test("SEC-8 / SEC-5: a bad guess is rejected by the kind, and two guesses inside 400 ms are throttled", async () => {
  assert.equal(code(await ana.call("submitCardGuess", { tournamentId: tid, guess: "ZZ" })), "invalid-argument");
  assert.equal(code(await ana.call("submitCardGuess", { tournamentId: tid, guess: 7 })), "invalid-argument");
  ok(await ana.call("submitCardGuess", { tournamentId: tid, guess: "IS" }), "first guess");
  assert.equal(code(await ana.call("submitCardGuess", { tournamentId: tid, guess: "NO" })), "rate-limited");
});

/** Walk the whole card: solve each item on its first guess by reading the stored card. */
async function playWholeCard(a: Account): Promise<Any> {
  const card = await doc(`cards/${tid}_r1`);
  let v = ok(await a.call("getCard", { tournamentId: tid }), "getCard");
  while (v.status === "in_progress") {
    await sleep(450);
    v = ok(await a.call("submitCardGuess", { tournamentId: tid, guess: card.items[v.cursor].subject }), "submitCardGuess");
  }
  return v;
}

test("playing every item finishes the card and sums the points (FR-8.3, D-44)", async () => {
  const v = await playWholeCard(owner);
  assert.equal(v.status, "finished");
  assert.equal(v.cursor, 5);
  assert.equal(v.prompt, null);
  // Every item solved first guess = 6 points each, whatever the kind (D-44).
  assert.equal(v.points, 30);
  assert.ok(v.elapsedMs > 0);
  assert.deepEqual(v.items.map((i: Any) => i.points), [6, 6, 6, 6, 6]);
  for (const item of v.items) assert.ok(item.answer.name, "a finished item reveals its own answer");
  assert.equal(code(await owner.call("submitCardGuess", { tournamentId: tid, guess: "BR" })), "already-completed");
});

test("FR-5.6: while the round is open, nobody sees anybody else's score", async () => {
  const seen = ok(await ana.call("getTournament", { tournamentId: tid }), "getTournament");
  assert.equal(seen.current.n, 1);
  assert.deepEqual(seen.standings.map((r: Any) => r.points), [0, 0, 0], "nothing counts until the round closes");
  assert.equal(seen.closedRounds, 0);
  const ownerRow = seen.current.players.find((p: Any) => p.uid === owner.uid);
  assert.equal(ownerRow.state, "finished");
  assert.ok(!("points" in ownerRow), "another player's card score must not be in the payload");
  assert.equal(seen.current.myState, "in_progress");
  assert.equal(seen.current.myPoints, null);

  // The viewer's own finished score IS theirs to see.
  const mine = ok(await owner.call("getTournament", { tournamentId: tid }), "getTournament");
  assert.equal(mine.current.myState, "finished");
  assert.equal(mine.current.myPoints, 30);
});

test("closing the round scores it, forfeits whoever did not finish, and ends a one-round tournament", async () => {
  // ana has one guess in and never finishes; bruno never even started.
  assert.equal(code(await ana.call("advanceTournament", { tournamentId: tid })), "permission-denied");
  const res = ok(await owner.call("advanceTournament", { tournamentId: tid }), "advanceTournament");
  assert.equal(res.closed, true);
  assert.equal(res.status, "finished");
  assert.equal(res.round, null);

  const round = await doc(`tournaments/${tid}/rounds/1`);
  assert.ok(round.closedAt);
  assert.equal(round.results[owner.uid].points, 30);
  assert.equal(round.results[owner.uid].played, true);
  assert.equal(round.results[ana.uid].points, 0);
  assert.equal(round.results[ana.uid].played, false, "FR-5.7: started but unfinished is a forfeit");
  assert.equal(round.results[bruno.uid].played, false);

  const t = await doc(`tournaments/${tid}`);
  assert.equal(t.status, "finished");
  assert.ok(t.endedAt);
  assert.equal(t.currentRound, null);
});

test("closing again changes nothing (D-41, D-43: idempotent)", async () => {
  const before = await doc(`tournaments/${tid}/rounds/1`);
  assert.equal(code(await owner.call("advanceTournament", { tournamentId: tid })), "tournament-not-open");
  const after = await advanceOpenRoundsNow(Timestamp.now());
  assert.equal(after.closed, 0, "the nightly sweep must not reopen or rescore a closed round");
  assert.equal(after.failed, 0);
  const round = await doc(`tournaments/${tid}/rounds/1`);
  assert.equal(round.closedAt.toMillis(), before.closedAt.toMillis());
});

test("the standings now rank the closed round", async () => {
  const v = ok(await ana.call("getTournament", { tournamentId: tid }), "getTournament");
  assert.equal(v.status, "finished");
  assert.equal(v.closedRounds, 1);
  assert.equal(v.current, null);
  const rows = v.standings;
  assert.equal(rows[0].uid, owner.uid);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].points, 30);
  // ana and bruno both have 0 points and 0 time: a genuine tie, competition-ranked.
  assert.deepEqual(rows.slice(1).map((r: Any) => r.rank), [2, 2]);
  assert.equal(rows.find((r: Any) => r.isMe).uid, ana.uid);
});

test("a finished tournament refuses play and further starts", async () => {
  assert.equal(code(await owner.call("getCard", { tournamentId: tid })), "tournament-not-open");
  assert.equal(code(await owner.call("startTournament", { tournamentId: tid })), "tournament-not-open");
  assert.equal(code(await ana.call("setParticipation", { tournamentId: tid, join: false })), "tournament-not-open");
});

test("FR-5.9 / D-40: none of this reached the daily board", async () => {
  const board = ok(await owner.call("getLeaderboard", { groupId: gid }), "getLeaderboard");
  const mine = board.rows.find((r: Any) => r.uid === owner.uid);
  assert.equal(mine.allTime.points, 0, "30 tournament points must not appear on the daily board");
  assert.equal(mine.last30.points, 0);
  // And the daily standings range query cannot even see the card plays.
  const inRange = await db.collection("attempts").where("puzzleId", ">=", "2000-01-01").get();
  assert.ok(!inRange.docs.some((d) => d.id.includes(`_${tid}_r`)), "a card play was returned by a puzzleId range query");
});

test("listTournaments shows the group's tournaments and the presets the form needs", async () => {
  const v = ok(await owner.call("listTournaments", { groupId: gid }), "listTournaments");
  assert.equal(v.canManage, true);
  const row = v.tournaments.find((x: Any) => x.tournamentId === tid);
  assert.equal(row.status, "finished");
  assert.equal(row.participantCount, 3);
  assert.equal(row.isParticipant, true);
  assert.deepEqual(v.presets.map((p: Any) => p.id), ["quintal", "capitais", "mistura", "bandeiras", "liga", "mata-mata", "suico", "chave-dupla"]);
  for (const p of v.presets) assert.ok(p.label && p.description, "the create form needs pt-BR copy");
  assert.equal(ok(await ana.call("listTournaments", { groupId: gid }), "as member").canManage, false);
});

test("the nightly sweep closes a round whose deadline has passed, and opens the next", async () => {
  const t2 = ok(await owner.call("createTournament", { groupId: gid, name: "Duas rodadas", preset: "quintal" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: t2, join: true }), "ana joins");
  // Two rounds, so closing round 1 must open round 2 rather than finish.
  await db.doc(`tournaments/${t2}`).update({ "config.rounds": 2 });
  ok(await owner.call("startTournament", { tournamentId: t2 }), "startTournament");
  await db.doc(`tournaments/${t2}`).update({ roundCount: 2 });

  // Nothing is due yet.
  assert.equal((await advanceOpenRoundsNow(Timestamp.now())).closed, 0);

  // Pull the deadline into the past and sweep again.
  await db.doc(`tournaments/${t2}/rounds/1`).update({ closesAt: Timestamp.fromMillis(Date.now() - 1000) });
  assert.equal(code(await ana.call("getCard", { tournamentId: t2 })), "tournament-not-open", "FR-5.7: past the deadline the card is closed");
  const swept = await advanceOpenRoundsNow(Timestamp.now());
  assert.equal(swept.closed, 1);

  const t = await doc(`tournaments/${t2}`);
  assert.equal(t.status, "running");
  assert.equal(t.currentRound, 2);
  assert.ok((await doc(`tournaments/${t2}/rounds/1`)).closedAt);

  // FR-5.2: round 2's card repeats nothing from round 1.
  const [c1, c2] = [await doc(`cards/${t2}_r1`), await doc(`cards/${t2}_r2`)];
  const first = new Set(c1.items.map((i: Any) => i.subject));
  assert.ok(!c2.items.some((i: Any) => first.has(i.subject)), "a subject was reused across rounds");
  ok(await ana.call("getCard", { tournamentId: t2 }), "round 2 is playable");
});

test("cancelling keeps the record and stops play", async () => {
  const t3 = ok(await owner.call("createTournament", { groupId: gid, name: "Cancelado", preset: "capitais" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: t3, join: true }), "ana joins");
  ok(await owner.call("startTournament", { tournamentId: t3 }), "startTournament");
  assert.equal(code(await ana.call("cancelTournament", { tournamentId: t3 })), "permission-denied");
  ok(await owner.call("cancelTournament", { tournamentId: t3 }), "cancelTournament");
  const t = await doc(`tournaments/${t3}`);
  assert.equal(t.status, "cancelled");
  assert.equal(t.currentRound, null);
  assert.equal(code(await ana.call("getCard", { tournamentId: t3 })), "tournament-not-open");
  ok(await owner.call("cancelTournament", { tournamentId: t3 }), "cancelling twice is idempotent");
});

test("the capitais preset asks with a city name and never sends the country", async () => {
  const t4 = ok(await owner.call("createTournament", { groupId: gid, name: "Só capitais", preset: "capitais" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: t4, join: true }), "ana joins");
  ok(await owner.call("startTournament", { tournamentId: t4 }), "startTournament");
  const v = ok(await ana.call("getCard", { tournamentId: t4 }), "getCard");
  assert.equal(v.prompt.kind, "capital");
  assert.ok(v.prompt.capital.length > 1);
  assert.equal(v.guessesMax, 3, "a capital item allows three guesses");
  const card = await doc(`cards/${t4}_r1`);
  const answer = card.items[0].subject;
  assert.ok(!JSON.stringify(v).includes(`"${answer}"`), "SEC-1");

  // Three wrong guesses close the item on zero without ending the card. Picked
  // from four so that the answer being one of them still leaves three.
  const wrong = ["BR", "FR", "JP", "KE"].filter((c) => c !== answer).slice(0, 3);
  assert.equal(wrong.length, 3);
  let out = v;
  for (const g of wrong) { await sleep(450); out = ok(await ana.call("submitCardGuess", { tournamentId: t4, guess: g }), "guess"); }
  assert.equal(out.items[0].status, "failed");
  assert.equal(out.items[0].guessCount, 3);
  assert.equal(out.items[0].points, 0);
  assert.equal(out.cursor, 1);
  assert.equal(out.status, "in_progress");
});

test("the bandeiras preset sends drawing data and nothing that names the country", async () => {
  const t8 = ok(await owner.call("createTournament", { groupId: gid, name: "Só bandeiras", preset: "bandeiras" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: t8, join: true }), "ana joins");
  ok(await owner.call("startTournament", { tournamentId: t8 }), "startTournament");
  const v = ok(await ana.call("getCard", { tournamentId: t8 }), "getCard");
  assert.equal(v.prompt.kind, "flag");
  assert.ok(v.prompt.flag.paths.length > 0, "a flag is at least one path");
  assert.match(v.prompt.flag.viewBox, /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
  assert.equal(v.guessesMax, 3, "a flag item allows three guesses");

  const card = await doc(`cards/${t8}_r1`);
  const answer = card.items[0].subject;
  const json = JSON.stringify(v);
  assert.ok(!json.includes(`"${answer}"`), "SEC-1: the code");
  assert.ok(!/Flag of|<title/i.test(json), "SEC-1: metadata from the vendored file");

  const guess = answer === "BR" ? "AR" : "BR";
  const out = ok(await ana.call("submitCardGuess", { tournamentId: t8, guess }), "guess");
  assert.equal(out.items[0].guessCount, 1);
  assert.ok(out.guesses[0].distanceKm >= 0, "a flag grades on distance, like a silhouette");
});

test("D-31: an admin in the same open round sees a rival's timings but not their score", async () => {
  const admin = await newAccount("t3-admin");
  await admin.call("getRound", {});
  await db.doc(`users/${admin.uid}`).update({ role: "admin" });
  const t7 = ok(await owner.call("createTournament", { groupId: gid, name: "Sigilo", preset: "quintal" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: t7, join: true }), "ana joins");
  ok(await owner.call("startTournament", { tournamentId: t7 }), "startTournament");

  // Ana finishes her card while the round is still open.
  const card = await doc(`cards/${t7}_r1`);
  let v = ok(await ana.call("getCard", { tournamentId: t7 }), "getCard");
  while (v.status === "in_progress") {
    await sleep(450);
    v = ok(await ana.call("submitCardGuess", { tournamentId: t7, guess: card.items[v.cursor].subject }), "guess");
  }
  assert.equal(v.points, 30);

  // The admin has not played this round: timings yes, outcome no.
  const hidden = ok(await admin.call("listAttempts", { uid: ana.uid }), "listAttempts").matches
    .find((m: Any) => m.roundId === `${t7}_r1`);
  assert.equal(hidden.state, "finished");
  assert.ok(hidden.intervalsMs.length > 0, "timings are the point of the panel and stay live");
  assert.equal(hidden.points, null, "FR-5.6: an open round's score is nobody else's business");
  assert.equal(hidden.elapsedMs, null);
  assert.equal(hidden.suspicious, null);

  // Once the round closes, everything is visible.
  ok(await owner.call("advanceTournament", { tournamentId: t7 }), "advanceTournament");
  const shown = ok(await admin.call("listAttempts", { uid: ana.uid }), "listAttempts").matches
    .find((m: Any) => m.roundId === `${t7}_r1`);
  assert.equal(shown.points, 30);
  assert.ok(shown.elapsedMs > 0);
});

test("FR-1.5 / D-46: deleting an account scrubs the name but keeps the bracket slot", async () => {
  const before = await doc(`tournaments/${tid}`);
  assert.notEqual(before.participants[bruno.uid].displayName, "[removido]");
  ok(await bruno.call("deleteAccount", {}), "deleteAccount");
  const after = await doc(`tournaments/${tid}`);
  assert.equal(after.participants[bruno.uid].displayName, "[removido]");
  assert.ok(after.participantUids.includes(bruno.uid), "the slot stays or the standings fold loses its shape");
  assert.equal((await db.collection("attempts").where("uid", "==", bruno.uid).get()).size, 0, "their card plays went with them");
  const v = ok(await owner.call("getTournament", { tournamentId: tid }), "getTournament");
  assert.equal(v.standings.find((r: Any) => r.uid === bruno.uid).displayName, "[removido]");
});

// ---------------------------------------------------------------------------
// Slice 3 — round robin under the `match` regime (§6.2, §7)
//
// Three players, so the circle method adds a ghost and the league runs three
// rounds with one bye each. Odd counts are where these engines break, so the
// e2e uses the odd case rather than a comfortable four.
// ---------------------------------------------------------------------------

let ligaId: string;
let davi: Account;

/** Play every item of the open round's card for one account. */
async function playRound(a: Account, tournamentId: string, n: number): Promise<Any> {
  const card = await doc(`cards/${tournamentId}_r${n}`);
  let v = ok(await a.call("getCard", { tournamentId }), "getCard");
  while (v.status === "in_progress") {
    await sleep(450);
    v = ok(await a.call("submitCardGuess", { tournamentId, guess: card.items[v.cursor].subject }), "submitCardGuess");
  }
  return v;
}

const pairingsOf = async (n: number): Promise<Any[]> => (await doc(`tournaments/${ligaId}/rounds/${n}`)).pairings;

test("a `liga` starts as a round robin whose length comes from the field, not the preset", async () => {
  davi = await newAccount("t3-davi");
  const { token } = ok(await owner.call("createInvite", { groupId: gid }), "createInvite");
  ok(await davi.call("acceptInvite", { token }), "acceptInvite");

  ligaId = ok(await owner.call("createTournament", { groupId: gid, name: "Liga do quintal", preset: "liga" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: ligaId, join: true }), "ana joins");
  ok(await davi.call("setParticipation", { tournamentId: ligaId, join: true }), "davi joins");
  ok(await owner.call("startTournament", { tournamentId: ligaId }), "startTournament");

  const t = await doc(`tournaments/${ligaId}`);
  assert.equal(t.format, "round_robin");
  assert.equal(t.regime, "match");
  // The preset says 1; three players say 3. The field wins.
  assert.equal(t.config.rounds, 1);
  assert.equal(t.roundCount, 3, "an odd field costs a round: n, not n-1");

  const p1 = await pairingsOf(1);
  assert.equal(p1.length, 2, "three players plus a ghost is two fixtures");
  assert.equal(p1.filter((p: Any) => p.b === null).length, 1, "exactly one bye");
  for (const p of p1) assert.equal(p.outcome, null, "an open round has decided nothing");
});

test("the draw is public while the round is open, but its outcomes are not (FR-5.6)", async () => {
  const v = ok(await ana.call("getTournament", { tournamentId: ligaId }), "getTournament");
  assert.equal(v.fixtures.length, 1);
  assert.equal(v.fixtures[0].n, 1);
  assert.equal(v.fixtures[0].closed, false);
  for (const p of v.fixtures[0].pairings) assert.equal(p.outcome, null);
});

test("closing a round decides its fixtures, and a forfeit loses to whoever turned up", async () => {
  // owner and ana play; davi never opens the card.
  await playRound(owner, ligaId, 1);
  await playRound(ana, ligaId, 1);
  ok(await owner.call("advanceTournament", { tournamentId: ligaId }), "advanceTournament");

  const p1 = await pairingsOf(1);
  for (const p of p1) assert.notEqual(p.outcome, null, "every fixture must be decided when the round closes");

  const bye = p1.find((p: Any) => p.b === null)!;
  assert.equal(bye.outcome, "a", "a bye is credited as a win (§7)");

  // Whoever was drawn against davi beat him without needing a single point:
  // he forfeited, and turning up beats not turning up.
  const vsDavi = p1.find((p: Any) => p.b !== null && (p.a === davi.uid || p.b === davi.uid));
  if (vsDavi) {
    const daviWon = (vsDavi.a === davi.uid && vsDavi.outcome === "a") || (vsDavi.b === davi.uid && vsDavi.outcome === "b");
    assert.equal(daviWon, false, "a forfeit must never win a fixture");
    assert.notEqual(vsDavi.outcome, "draw", "nor draw one against a player who finished the card");
  }
});

test("the table ranks on match points, and reports a record rather than a card total", async () => {
  const v = ok(await owner.call("getTournament", { tournamentId: ligaId }), "getTournament");
  assert.equal(v.regime, "match");
  for (const r of v.standings) {
    assert.ok(r.record, "every row needs a W-D-L record under the match regime");
    assert.equal(r.record.won + r.record.drawn + r.record.lost, 1, "one closed round, one result each");
  }
  const total = v.standings.reduce((n: number, r: Any) => n + r.record.matchPoints, 0);
  // One decisive fixture (3) plus one bye credited as a win (3).
  assert.equal(total, 6);
  assert.deepEqual(v.standings.map((r: Any) => r.rank).sort(), [1, 2, 3].sort());
});

test("over the whole league every pair meets exactly once and everybody sits out once", async () => {
  // Rounds 2 and 3, closed without anybody playing: the schedule is what is
  // under test, not the scores.
  ok(await owner.call("advanceTournament", { tournamentId: ligaId }), "close round 2");
  ok(await owner.call("advanceTournament", { tournamentId: ligaId }), "close round 3");

  const t = await doc(`tournaments/${ligaId}`);
  assert.equal(t.status, "finished", "three rounds is the whole league");

  const met: string[] = [];
  const byes: string[] = [];
  for (let n = 1; n <= 3; n++) {
    for (const p of await pairingsOf(n)) {
      if (p.b === null) byes.push(p.a);
      else met.push([p.a, p.b].sort().join("|"));
    }
  }
  const uids = [owner.uid, ana.uid, davi.uid];
  const expected = new Set<string>();
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expected.add([uids[i]!, uids[j]!].sort().join("|"));
  assert.deepEqual(new Set(met), expected, "every pair exactly once");
  assert.equal(met.length, 3, "and no pair twice");
  assert.deepEqual([...byes].sort(), [...uids].sort(), "every player sits out exactly once");
});

test("FR-5.9 holds for league play too: no card play carries a puzzleId", async () => {
  const plays = await db.collection("attempts").where("mode", "==", "match").get();
  assert.ok(plays.size > 0, "the league produced card plays");
  for (const d of plays.docs) assert.equal((d.data() as Any).puzzleId, undefined);
});

// ---------------------------------------------------------------------------
// Slice 4 — single elimination and sudden death (§6.3, §6.4, D-47, D-50)
//
// Three players, bracket of four, so the top seed gets a bye. `mata-mata`
// leaves time out of the tiebreak chain, so two players who both finish the
// card perfectly are genuinely level and sudden death actually fires — which
// is the whole reason the chain is written that way (D-44).
// ---------------------------------------------------------------------------

let mataId: string;

/** Play every item of a specific card for one account. */
async function playCardOf(a: Account, tournamentId: string, cardDocId: string): Promise<Any> {
  const card = await doc(`cards/${cardDocId}`);
  let v = ok(await a.call("getCard", { tournamentId }), "getCard");
  while (v.status === "in_progress") {
    await sleep(450);
    v = ok(await a.call("submitCardGuess", { tournamentId, guess: card.items[v.cursor].subject }), "submitCardGuess");
  }
  return v;
}

const mataRound = async (n: number): Promise<Any> => doc(`tournaments/${mataId}/rounds/${n}`);

test("a knockout seeds into a bracket and hands the spare slots to the top seeds", async () => {
  mataId = ok(await owner.call("createTournament", { groupId: gid, name: "Mata-mata do quintal", preset: "mata-mata" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: mataId, join: true }), "ana joins");
  ok(await davi.call("setParticipation", { tournamentId: mataId, join: true }), "davi joins");
  ok(await owner.call("startTournament", { tournamentId: mataId }), "startTournament");

  const t = await doc(`tournaments/${mataId}`);
  assert.equal(t.format, "single_elim");
  assert.equal(t.roundCount, 2, "three players fit a bracket of four: two rounds");

  const p1 = (await mataRound(1)).pairings;
  assert.equal(p1.length, 2);
  const bye = p1.find((p: Any) => p.b === null);
  assert.ok(bye, "one spare slot, so one bye");
  assert.equal(bye.a, owner.uid, "and it goes to the top seed, who created the tournament first");
});

test("two perfect cards are genuinely level, so closing the round opens sudden death", async () => {
  await playCardOf(ana, mataId, `${mataId}_r1`);
  await playCardOf(davi, mataId, `${mataId}_r1`);
  ok(await owner.call("advanceTournament", { tournamentId: mataId }), "advanceTournament");

  const r1 = await mataRound(1);
  assert.ok(r1.closedAt, "the round's own card is finished with");
  assert.ok(r1.tie, "but a level fixture holds it open");
  assert.equal(r1.tie.k, 1);
  assert.equal(r1.tie.kind, "sudden_death");
  assert.deepEqual([...r1.tie.uids].sort(), [ana.uid, davi.uid].sort());
  assert.equal(r1.tie.closedAt, null);

  // The next round is NOT paired until this resolves.
  assert.equal((await doc(`tournaments/${mataId}`)).currentRound, 1);
  assert.equal((await db.doc(`tournaments/${mataId}/rounds/2`).get()).exists, false);

  // One challenge, not a whole card.
  const card = await doc(`cards/${mataId}_r1_t1`);
  assert.equal(card.items.length, 1);
});

test("only the tied players are served the sudden-death card (D-38)", async () => {
  assert.equal(code(await owner.call("getCard", { tournamentId: mataId })), "tournament-not-open");
  const v = ok(await ana.call("getTournament", { tournamentId: mataId }), "getTournament");
  assert.ok(v.current, "the panel must not vanish mid-knockout");
  assert.equal(v.current.tie.k, 1);
  assert.equal(v.current.tie.amIn, true);
  const asOwner = ok(await owner.call("getTournament", { tournamentId: mataId }), "getTournament");
  assert.equal(asOwner.current.tie.amIn, false, "the bye player is waiting on them");
});

test("the sudden-death card decides it, and the bracket pairs the next round", async () => {
  // ana turns up, davi does not: turning up wins.
  await playCardOf(ana, mataId, `${mataId}_r1_t1`);
  ok(await owner.call("advanceTournament", { tournamentId: mataId }), "advanceTournament");

  const r1 = await mataRound(1);
  assert.ok(r1.tie.closedAt, "the tiebreak is settled");
  const fixture = r1.pairings.find((p: Any) => p.b !== null);
  const winner = fixture.outcome === "a" ? fixture.a : fixture.b;
  assert.equal(winner, ana.uid, "ana played the decider; davi did not");

  const t = await doc(`tournaments/${mataId}`);
  assert.equal(t.currentRound, 2);
  const p2 = (await mataRound(2)).pairings;
  assert.equal(p2.length, 1, "a final");
  assert.deepEqual([p2[0].a, p2[0].b].sort(), [owner.uid, ana.uid].sort());
});

test("D-47: the eliminated player keeps playing the final's card for the side ranking", async () => {
  ok(await davi.call("getCard", { tournamentId: mataId }), "davi is out but consolation is on");
});

test("the last round crowns exactly one champion", async () => {
  await playCardOf(owner, mataId, `${mataId}_r2`);
  ok(await owner.call("advanceTournament", { tournamentId: mataId }), "advanceTournament");

  const t = await doc(`tournaments/${mataId}`);
  assert.equal(t.status, "finished");

  const v = ok(await owner.call("getTournament", { tournamentId: mataId }), "getTournament");
  const standing = v.standings;
  assert.equal(standing[0].uid, owner.uid, "owner played the final; ana did not");
  assert.equal(standing[0].eliminated, false);
  assert.equal(standing.filter((r: Any) => !r.eliminated).length, 1, "exactly one player left standing");
  assert.equal(standing[0].survived, 2);
  // davi went out in round one and stays bottom however much consolation he played.
  assert.equal(standing[standing.length - 1].uid, davi.uid);
});

// ---------------------------------------------------------------------------
// Slice 5 — Swiss (§6.3)
//
// Three players, so `rounds: 4` is capped to 2: nobody has more than two
// possible opponents, and a Swiss must never reach a round where every legal
// pairing is a rematch.
// ---------------------------------------------------------------------------

let swissId: string;

test("a Swiss caps its length at the number of opponents anybody actually has", async () => {
  swissId = ok(await owner.call("createTournament", { groupId: gid, name: "Suíço do quintal", preset: "suico" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: swissId, join: true }), "ana joins");
  ok(await davi.call("setParticipation", { tournamentId: swissId, join: true }), "davi joins");
  ok(await owner.call("startTournament", { tournamentId: swissId }), "startTournament");

  const t = await doc(`tournaments/${swissId}`);
  assert.equal(t.format, "swiss");
  assert.equal(t.regime, "match");
  assert.equal(t.config.rounds, 4, "the preset still says four");
  assert.equal(t.roundCount, 2, "but three players only have two opponents each");

  const p1 = (await doc(`tournaments/${swissId}/rounds/1`)).pairings;
  assert.equal(p1.length, 2, "one fixture and one bye");
  assert.equal(p1.filter((p: Any) => p.b === null).length, 1);
});

test("the second round pairs on the table and repeats nobody", async () => {
  // Whoever is drawn together in round 1 plays it out; the bye sits.
  const p1 = (await doc(`tournaments/${swissId}/rounds/1`)).pairings;
  const fixture = p1.find((p: Any) => p.b !== null)!;
  const byePlayer = p1.find((p: Any) => p.b === null)!.a;
  const accounts: Record<string, Account> = { [owner.uid]: owner, [ana.uid]: ana, [davi.uid]: davi };
  await playCardOf(accounts[fixture.a]!, swissId, `${swissId}_r1`);
  ok(await owner.call("advanceTournament", { tournamentId: swissId }), "advanceTournament");

  const t = await doc(`tournaments/${swissId}`);
  assert.equal(t.currentRound, 2, "a Swiss eliminates nobody, so it just carries on");

  const p2 = (await doc(`tournaments/${swissId}/rounds/2`)).pairings;
  assert.equal(p2.filter((p: Any) => p.b === null).length, 1, "still one bye");
  assert.notEqual(p2.find((p: Any) => p.b === null)!.a, byePlayer, "and not the same player twice");

  const key = (p: Any) => [p.a, p.b].sort().join("|");
  assert.notEqual(key(p2.find((p: Any) => p.b !== null)!), key(fixture), "nor the same fixture twice");
});

test("the Swiss table is a league table, and nobody is ever knocked out of it", async () => {
  const v = ok(await owner.call("getTournament", { tournamentId: swissId }), "getTournament");
  assert.equal(v.regime, "match");
  for (const r of v.standings) {
    assert.ok(r.record, "a Swiss row needs a W-D-L record");
    assert.equal(r.eliminated, undefined, "Swiss has no elimination column at all");
  }
  // Round 1 awarded three points for the fixture and three for the bye.
  const total = v.standings.reduce((n: number, r: Any) => n + r.record.matchPoints, 0);
  assert.equal(total, 6);
});

// ---------------------------------------------------------------------------
// Slice 6 — double elimination (§6.3, T-2)
//
// Three players, bracket of four, so 2·log2(4) = 4 rounds. The winners and
// losers brackets run in the SAME tournament round, which is what D-38's shared
// card buys: one card, fixtures from both halves resolved on it.
// ---------------------------------------------------------------------------

let deId: string;
const deRound = async (n: number): Promise<Any> => doc(`tournaments/${deId}/rounds/${n}`);
const half = (ps: Any[], b: string) => ps.filter((p: Any) => p.bracket === b);

test("a double elimination runs both brackets at once, in 2·log2(S) rounds", async () => {
  deId = ok(await owner.call("createTournament", { groupId: gid, name: "Chave dupla", preset: "chave-dupla" }), "createTournament").tournamentId;
  ok(await ana.call("setParticipation", { tournamentId: deId, join: true }), "ana joins");
  ok(await davi.call("setParticipation", { tournamentId: deId, join: true }), "davi joins");
  ok(await owner.call("startTournament", { tournamentId: deId }), "startTournament");

  const t = await doc(`tournaments/${deId}`);
  assert.equal(t.format, "double_elim");
  assert.equal(t.roundCount, 4, "bracket of four: 2 x log2(4)");
  assert.equal(t.config.grandFinalReset, false);

  const p1 = (await deRound(1)).pairings;
  assert.equal(half(p1, "l").length, 0, "nobody has lost yet, so there is no losers bracket");
  assert.equal(half(p1, "w").length, 2, "one fixture and one bye");
  const bye = half(p1, "w").find((p: Any) => p.b === null)!;
  assert.equal(bye.a, owner.uid, "the spare slot goes to the top seed");
});

test("the loser of round one drops into the losers bracket rather than out", async () => {
  // Whoever was drawn together: one plays, one does not. Turning up wins.
  const p1 = (await deRound(1)).pairings;
  const fixture = half(p1, "w").find((p: Any) => p.b !== null)!;
  const accounts: Record<string, Account> = { [owner.uid]: owner, [ana.uid]: ana, [davi.uid]: davi };
  await playCardOf(accounts[fixture.a]!, deId, `${deId}_r1`);
  ok(await owner.call("advanceTournament", { tournamentId: deId }), "advanceTournament");

  const r1 = await deRound(1);
  const decided = half(r1.pairings, "w").find((p: Any) => p.b !== null)!;
  const loser = decided.outcome === "a" ? decided.b : decided.a;

  const p2 = (await deRound(2)).pairings;
  assert.equal(half(p2, "w").length, 1, "the winners final");
  assert.equal(half(p2, "l").length, 1, "and the losers bracket has opened");
  // With three players only one person drops, so the losers round is a bye.
  assert.equal(half(p2, "l")[0].a, loser, "the beaten player is in the losers bracket, not gone");
  assert.equal(half(p2, "l")[0].b, null);

  // And they are still allowed to play: one defeat is not elimination.
  const v = ok(await accounts[loser]!.call("getTournament", { tournamentId: deId }), "getTournament");
  assert.equal(v.standings.find((r: Any) => r.uid === loser).eliminated, false);
});

test("the whole bracket runs to exactly one champion", async () => {
  const accounts: Record<string, Account> = { [owner.uid]: owner, [ana.uid]: ana, [davi.uid]: davi };
  // Rounds 2, 3 and 4: in each, exactly one side of each fixture turns up, so
  // every fixture is decided without a tie.
  for (let n = 2; n <= 4; n++) {
    const ps = (await deRound(n)).pairings;
    for (const p of ps) {
      if (p.b === null) continue;
      await playCardOf(accounts[p.a]!, deId, `${deId}_r${n}`);
    }
    ok(await owner.call("advanceTournament", { tournamentId: deId }), `advance round ${n}`);
  }

  const t = await doc(`tournaments/${deId}`);
  assert.equal(t.status, "finished");

  const v = ok(await owner.call("getTournament", { tournamentId: deId }), "getTournament");
  const standing = v.standings;
  assert.equal(standing.filter((r: Any) => !r.eliminated).length, 1, "exactly one champion");
  assert.equal(standing[0].eliminated, false, "and they are top of the table");

  // The grand final was played, and it named the two brackets' champions.
  const gf = half((await deRound(4)).pairings, "gf");
  assert.equal(gf.length, 1);
  assert.notEqual(gf[0].outcome, null);
});

test("a group cannot be drowned in open tournaments", async () => {
  // Four already exist in this group (one finished, one running, one cancelled,
  // one running) — only draft and running count toward the cap.
  const active = (await db.collection("tournaments").where("groupId", "==", gid).get()).docs
    .filter((d) => ["draft", "running"].includes((d.data() as Any).status)).length;
  for (let i = active; i < 5; i++) {
    ok(await owner.call("createTournament", { groupId: gid, name: `Enchendo ${i}`, preset: "quintal" }), "createTournament");
  }
  assert.equal(code(await owner.call("createTournament", { groupId: gid, name: "Um a mais", preset: "quintal" })), "invalid-argument");
});
