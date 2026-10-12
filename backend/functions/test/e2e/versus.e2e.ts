/**
 * Versus end-to-end against the emulators (FR-12). Three players — an invited
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

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
if (getApps().length === 0) initializeApp({ projectId: "demo-mondo" });
const db = getFirestore();

const FUNCTIONS = "http://127.0.0.1:5001/demo-mondo/southamerica-east1";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
interface Res { status: number; result?: Any; error?: Any }
interface Account { uid: string; call: (data: unknown) => Promise<Res> }

async function post(data: unknown, token: string): Promise<Res> {
  const r = await fetch(`${FUNCTIONS}/versus`, {
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
  const late = await newAccount("vs-late");
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

  // The queue: nonsense is dropped, a name without its accent is still Japão.
  let a = ok(await host.call({ op: "answer", room: id, names: ["Atlântida", "Japao"] }), "host answers");
  assert.deepEqual(a.accepted.code, "JP");
  assert.deepEqual(a.dropped, [{ name: "Atlântida", reason: "unknown" }]);
  // Already on the map: dropped, and the turn stays with bia.
  a = ok(await bia.call({ op: "answer", room: id, names: ["Japão"] }), "bia repeats");
  assert.equal(a.accepted, null);
  assert.deepEqual(a.dropped, [{ name: "Japão", reason: "already-named" }]);
  assert.equal((await room(id)).potato.turnUid, bia.uid);
  await sleep(450); // SEC-5's floor, within a turn
  // One wrong letter is forgiven.
  a = ok(await bia.call({ op: "answer", room: id, names: ["Brazil"] }), "bia, one typo");
  assert.equal(a.accepted.code, "BR");

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
  // Nothing about Versus reaches the daily's collection (FR-12.1, D-40).
  assert.equal((await db.collection("attempts").where("uid", "in", [host.uid, bia.uid, guest.uid]).get()).size, 0);
});

test("FR-12.2: Clássico, played to the end; no answer on the wire before its reveal", async () => {
  const { room: id } = ok(await host.call({ op: "create", presetId: "capitais" }), "create");
  ok(await bia.call({ op: "join", room: id }), "bia joins");
  ok(await host.call({ op: "start", room: id }), "start");
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
});
