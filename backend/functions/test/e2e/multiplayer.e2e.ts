/**
 * Multijogador end-to-end against the emulators (FR-12). Three players — an invited
 * host, a plain account and a guest — play a whole Batata Quente to a full map,
 * then a whole Clássico.
 *
 * The unit tests own the rules. What only this file can prove is the wire: that
 * a rank gates hosting and nothing gates joining, that the room document and
 * the prompt documents carry no answer while a challenge is open, that the map
 * fills in one document per country, and that `tick` moves a room on only once
 * the server's own clock has passed the deadline.
 *
 * Shares an emulator with the other e2e files and seeds nothing they read.
 */

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { COUNTRIES } from "../../src/lib/countries";
import { newProfile } from "../../src/lib/round";

// From the environment `emulators:exec` sets, never a default: a default of
// :8080 would point the Admin SDK at whatever dev stack is running there.
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

/** An email account, or — with no label — a guest (anonymous sign-in, FR-10.1). */
async function newAccount(label?: string): Promise<Account> {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(label
      ? { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "secret123", returnSecureToken: true }
      : { returnSecureToken: true }),
  }).then((x) => x.json() as Promise<Any>);
  return { uid: r.localId, call: (data) => post(data, r.idToken) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (r: Res) => r.error?.details?.code ?? r.error?.status ?? null;
const ok = (r: Res, what: string) => { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.error)}`); return r.result; };
const room = async (id: string) => (await db.doc(`rooms/${id}`).get()).data() as Any;
const ptName = (c: string) => COUNTRIES.get(c)!.names["pt-BR"];

let host: Account;   // invited: may host
let bia: Account;    // signed in, plain `user`: may join, may not host
let guest: Account;  // anonymous: may join
let late: Account;   // arrives after the start: refused, then seated between games

before(async () => {
  [host, bia, guest] = await Promise.all([newAccount("vs-host"), newAccount("vs-bia"), newAccount()]);
  // A plain account first: refused, and the refusal rolls its profile back with it.
  assert.equal(code(await host.call({ op: "create", presetId: "mundo" })), "permission-denied");
  // `invited` is granted by an admin (D-84), which here is the Admin SDK.
  await db.doc(`users/${host.uid}`).set({ ...newProfile(Timestamp.now(), "Anfitriã"), role: "invited" });
});

test("FR-12.1: only a ranked player hosts; a plain account and a guest are refused", async () => {
  assert.equal(code(await bia.call({ op: "create", presetId: "mundo" })), "permission-denied");
  assert.equal(code(await guest.call({ op: "create", presetId: "mundo" })), "permission-denied");
  assert.equal(code(await host.call({ op: "create", presetId: "nope" })), "invalid-argument");
  assert.equal(code(await host.call({ op: "dance" })), "invalid-argument");
});

test("FR-12.3: Batata Quente, three players, to a full map", async () => {
  const { room: id } = ok(await host.call({ op: "create", presetId: "mundo" }), "create");
  assert.equal(code(await host.call({ op: "start", room: id })), "invalid-argument"); // alone
  ok(await bia.call({ op: "join", room: id }), "bia joins");
  ok(await guest.call({ op: "join", room: id }), "guest joins");
  ok(await guest.call({ op: "join", room: id }), "joining twice is not an error");
  assert.equal(code(await bia.call({ op: "start", room: id })), "permission-denied"); // not the host
  ok(await host.call({ op: "start", room: id }), "start");
  late = await newAccount("vs-late");
  assert.equal(code(await late.call({ op: "join", room: id })), "room-started");

  const base = (await db.doc(`rooms/${id}/map/_base`).get()).data() as Any;
  assert.ok(base.land.startsWith("M") && base.viewBox);

  const players: Record<string, Account> = { [host.uid]: host, [bia.uid]: bia, [guest.uid]: guest };
  let r = await room(id);
  assert.equal(r.state, "playing");
  assert.equal(r.potato.turnUid, host.uid);
  assert.equal(r.potato.limitMs, 20_000);

  // Not your turn.
  assert.equal(code(await bia.call({ op: "answer", room: id, names: ["Brasil"] })), "not-your-turn");
  // Not due: a tick before the deadline moves nothing.
  assert.equal(ok(await bia.call({ op: "tick", room: id }), "early tick").moved, false);

  // One queued name and the box (D-95): a third name is a hedge, and refused.
  assert.equal(code(await host.call({ op: "answer", room: id, names: ["Peru", "Chile", "Japão"] })), "invalid-argument");
  // The queue: nonsense is dropped, a name without its accent is still Japão.
  let a = ok(await host.call({ op: "answer", room: id, names: ["Atlântida", "Japao"] }), "host answers");
  assert.deepEqual(a.accepted.map((x: Any) => x.code), ["JP"]);
  assert.deepEqual(a.dropped, [{ name: "Atlântida", reason: "unknown" }]);
  // Already on the map: dropped, and the turn stays with bia.
  a = ok(await bia.call({ op: "answer", room: id, names: ["Japão"] }), "bia repeats");
  assert.deepEqual(a.accepted, []);
  assert.deepEqual(a.dropped, [{ name: "Japão", reason: "already-named" }]);
  assert.equal((await room(id)).potato.turnUid, bia.uid);
  await sleep(450); // SEC-5's floor, within a turn
  // One wrong letter is forgiven.
  a = ok(await bia.call({ op: "answer", room: id, names: ["Brazil"] }), "bia, one typo");
  assert.deepEqual(a.accepted.map((x: Any) => x.code), ["BR"]);

  for (;;) {
    r = await room(id);
    if (r.state !== "playing") break;
    const next = [...COUNTRIES.keys()].find((c) => !r.potato.named.includes(c))!;
    ok(await players[r.potato.turnUid]!.call({ op: "answer", room: id, names: [ptName(next)] }), `answer ${next}`);
  }

  assert.equal(r.state, "finished");
  assert.equal(r.potato.endReason, "map-full");
  assert.equal(r.potato.named.length, COUNTRIES.size);
  const map = await db.collection(`rooms/${id}/map`).get();
  assert.equal(map.size, COUNTRIES.size + 1); // every country, and the land
  const jp = map.docs.find((d) => d.id === "JP")!.data();
  assert.equal(jp.by, host.uid);
  assert.ok(jp.d || jp.dot);
  const total = Object.values(r.potato.scores as Record<string, { named: number }>).reduce((n, s) => n + s.named, 0);
  assert.equal(total, COUNTRIES.size);
  // D-105: the one player with the most points takes a trophy; a tie at the top, nobody.
  const pts = Object.entries(r.potato.scores as Record<string, { points: number }>).map(([uid, s]) => [uid, s.points] as const);
  const best = Math.max(...pts.map(([, p]) => p));
  const top = pts.filter(([, p]) => p === best).map(([uid]) => uid);
  for (const uid of r.playerUids) assert.equal(r.players[uid].wins ?? 0, top.length === 1 && top[0] === uid ? 1 : 0, `wins of ${uid}`);
  // D-104: the game is over and the room is a lobby again, open two more hours.
  assert.equal(r.expiresAt, r.finishedAt + 2 * 3_600_000);
  ok(await late.call({ op: "join", room: id }), "a newcomer joins between games");
  assert.deepEqual((await room(id)).playerUids, [host.uid, bia.uid, guest.uid, late.uid]);
  // Nothing about Multijogador reaches the daily's collection (FR-12.1, D-40).
  assert.equal((await db.collection("attempts").where("uid", "in", [host.uid, bia.uid, guest.uid]).get()).size, 0);
});

test("D-103, D-104: the host's standing room, set to Clássico, plays again with whoever is still there", async () => {
  // Opening Multijogador goes back to the room the Batata Quente was played in.
  const { room: id } = ok(await host.call({ op: "create" }), "create, no preset");
  const before = await room(id);
  assert.equal(before.state, "finished");
  assert.equal(before.mode, "potato");
  assert.equal(ok(await host.call({ op: "create" }), "again").room, id, "clicking twice makes one room");

  // FR-12.7: only the host picks the next game, never training.
  assert.equal(code(await bia.call({ op: "configure", room: id, presetId: "capitais" })), "permission-denied");
  assert.equal(code(await host.call({ op: "configure", room: id, presetId: "treino" })), "invalid-argument");
  assert.equal(code(await host.call({ op: "configure", room: id, presetId: "nope" })), "invalid-argument");
  ok(await host.call({ op: "configure", room: id, presetId: "capitais" }), "configure");
  assert.equal((await room(id)).mode, "classic");

  // FR-12.8: the host takes away the seats nobody is using. Never their own.
  assert.equal(code(await bia.call({ op: "remove", room: id, uid: guest.uid })), "permission-denied");
  assert.equal(code(await host.call({ op: "remove", room: id, uid: host.uid })), "invalid-argument");
  ok(await host.call({ op: "remove", room: id, uid: guest.uid }), "remove the guest");
  ok(await host.call({ op: "remove", room: id, uid: late.uid }), "remove late");
  assert.deepEqual((await room(id)).playerUids, [host.uid, bia.uid]);
  assert.equal(code(await guest.call({ op: "tick", room: id })), "permission-denied", "a removed player is out");

  ok(await bia.call({ op: "join", room: id }), "bia is already in");
  ok(await host.call({ op: "start", room: id }), "start");
  // Nothing of the Batata Quente is left: the map is gone with the land, and the scores are new.
  assert.equal((await db.collection(`rooms/${id}/map`).get()).size, 0);
  const fresh = await room(id);
  assert.equal(fresh.potato, null);
  assert.equal(fresh.players[host.uid].score, 0);
  assert.ok(fresh.startedAt > before.finishedAt);
  const hostWins: number = fresh.players[host.uid].wins ?? 0;
  const { items } = (await db.doc(`roomSecrets/${id}`).get()).data() as Any;
  assert.equal(items.length, 5);

  for (let i = 0; i < items.length; i++) {
    const subject: string = items[i].subject;
    const quoted = `"${subject}"`;
    let r = await room(id);
    assert.equal(r.classic.index, i);
    assert.equal(r.classic.phase, "question");
    const prompt = (await db.doc(`rooms/${id}/prompts/${i}`).get()).data() as Any;
    assert.equal(prompt.reveal, null);
    for (const doc of [r, prompt]) assert.ok(!JSON.stringify(doc).includes(quoted), `item ${i}: ${subject} on an open document`);

    const wrong = subject === "BR" ? "AR" : "BR";
    const miss = ok(await bia.call({ op: "guess", room: id, guess: wrong }), "bia misses");
    assert.ok(!JSON.stringify(miss).includes(quoted), "the answer in a guess reply");
    assert.equal(miss.mine.guesses.length, 1);
    const hit = ok(await host.call({ op: "guess", room: id, guess: subject }), "host solves");
    assert.equal(hit.mine.solved, true);
    assert.equal(code(await host.call({ op: "guess", room: id, guess: subject })), "already-completed");
    await sleep(450);
    ok(await bia.call({ op: "giveUp", room: id }), "bia gives up");

    // Everyone is done, so the answer is up without waiting for the clock.
    r = await room(id);
    assert.equal(r.classic.phase, "reveal");
    assert.equal(((await db.doc(`rooms/${id}/prompts/${i}`).get()).data() as Any).reveal.code, subject);
    assert.equal(ok(await bia.call({ op: "tick", room: id }), "early tick").moved, false);
    await sleep(r.classic.deadline - Date.now() + 300);
    assert.equal(ok(await bia.call({ op: "tick", room: id }), "tick").moved, true);
  }

  const r = await room(id);
  assert.equal(r.state, "finished");
  assert.ok(r.players[host.uid].score >= 5 * 6, "five solves, each at least 6");
  assert.equal(r.players[bia.uid].score, 0);
  assert.equal(r.players[host.uid].wins, hostWins + 1, "D-105: the host won this one outright");

  // And once more, the same card size: the last game's five prompts make way for the new one's.
  ok(await host.call({ op: "start", room: id }), "rematch");
  const prompts = await db.collection(`rooms/${id}/prompts`).get();
  assert.deepEqual(prompts.docs.map((d) => d.id), ["0"]);
  assert.equal(prompts.docs[0]!.data().reveal, null, "the new first challenge, not the old one's answer");
});

test("FR-12.10, FR-12.11, D-106: a custom game, dealt in order from its continents; a host's own saved games", async () => {
  const cust = await newAccount("vs-cust");
  await db.doc(`users/${cust.uid}`).set({ ...newProfile(Timestamp.now(), "Custom"), role: "invited" });
  const { room: id } = ok(await cust.call({ op: "create" }), "create");
  ok(await bia.call({ op: "join", room: id }), "bia joins");

  const custom = { name: "Europa 3", kinds: ["capital", "flag", "shape"], shuffled: false, regions: ["Europe"] };
  assert.equal(code(await bia.call({ op: "configure", room: id, custom })), "permission-denied", "only the host");
  assert.equal(code(await cust.call({ op: "configure", room: id, custom: { ...custom, kinds: ["flags"] } })), "invalid-argument");
  assert.equal(code(await cust.call({ op: "configure", room: id, custom: { ...custom, kinds: Array(15).fill("capital"), regions: ["Oceania"] } })),
    "no-countries-left", "refused at configure, not at start");
  ok(await cust.call({ op: "configure", room: id, custom }), "configure custom");
  const set = await room(id);
  assert.equal(set.presetId, "custom");
  assert.deepEqual(set.custom, custom);

  ok(await cust.call({ op: "start", room: id }), "start");
  const { items } = (await db.doc(`roomSecrets/${id}`).get()).data() as Any;
  assert.deepEqual(items.map((i: Any) => i.kind), custom.kinds, "in the order given");
  assert.deepEqual((await room(id)).classic.kinds, custom.kinds);
  for (const i of items) assert.equal(COUNTRIES.get(i.subject)!.region, "Europe", `${i.kind}: ${i.subject}`);

  // Saved games: hosting's rank to save, and each player sees only their own.
  const p = (name: string) => ({ ...custom, name });
  assert.equal(code(await bia.call({ op: "savePreset", preset: p("Minha") })), "permission-denied");
  assert.equal(code(await cust.call({ op: "savePreset", preset: { ...custom, name: "" } })), "invalid-argument");
  let list: Any[] = [];
  for (let i = 0; i < 10; i++) list = ok(await cust.call({ op: "savePreset", preset: p(`P${i}`) }), `save ${i}`).presets;
  assert.equal(list.length, 10);
  assert.equal(code(await cust.call({ op: "savePreset", preset: p("Onze") })), "invalid-argument", "ten at most");
  list = ok(await cust.call({ op: "savePreset", preset: { ...p(" p3 "), kinds: ["gdp"] } }), "overwrite").presets;
  assert.equal(list.length, 10, "same name overwrites");
  assert.deepEqual(list[3].kinds, ["gdp"]);
  assert.deepEqual(ok(await cust.call({ op: "join", room: id }), "host rejoins").presets, list);
  assert.deepEqual(ok(await bia.call({ op: "join", room: id }), "bia rejoins").presets, [], "never another player's");
  assert.equal(ok(await cust.call({ op: "deletePreset", name: "P0" }), "delete").presets.length, 9);
  assert.equal(ok(await cust.call({ op: "deletePreset", name: "P0" }), "delete again").presets.length, 9);
});

test("D-93: a guest trains alone — started on create, no clock, nobody else gets in", async () => {
  const { room: id } = ok(await guest.call({ op: "create", presetId: "treino" }), "guest creates a training room");
  let r = await room(id);
  assert.equal(r.state, "playing");
  assert.deepEqual(r.playerUids, [guest.uid]);
  assert.equal(r.potato.deadline, null);
  assert.ok((await db.doc(`rooms/${id}/map/_base`).get()).exists, "the land is there from the start");
  assert.equal(ok(await guest.call({ op: "create", presetId: "treino" }), "again").room, id, "one open training room: asking again goes back to it");

  // Every acceptable name is taken, not just the first, and back to back: no turn, no floor.
  const a = ok(await guest.call({ op: "answer", room: id, names: ["Brasil", "Jpão", "brasil", "Peru"] }), "answer");
  assert.deepEqual(a.accepted.map((x: Any) => [x.code, x.points]), [["BR", 1], ["JP", 1], ["PE", 1]]);
  assert.deepEqual(a.dropped, [{ name: "brasil", reason: "already-named" }]);
  assert.deepEqual(ok(await guest.call({ op: "answer", room: id, names: ["Chile"] }), "at once").accepted.map((x: Any) => x.code), ["CL"]);
  assert.equal((await db.collection(`rooms/${id}/map`).get()).size, 5, "the land and four countries");
  assert.equal(ok(await guest.call({ op: "tick", room: id }), "tick").moved, false, "nothing to time out");
  assert.equal(code(await bia.call({ op: "join", room: id })), "room-started");

  ok(await guest.call({ op: "giveUp", room: id }), "stop");
  r = await room(id);
  assert.equal(r.state, "finished");
  assert.equal(r.potato.scores[guest.uid].named, 4);
  assert.notEqual(ok(await guest.call({ op: "create", presetId: "treino" }), "a new one").room, id, "a finished one is not reopened");
});
