/**
 * Practice end-to-end against the emulators (FR-9, D-60): choose a kind, play
 * challenges until you are bored, leave, read the total.
 *
 * The unit tests already own the state machine. What only this file can prove
 * is the part that crosses the wire and the database: that the answer is not in
 * any response while the challenge is open, that the invite gate applies, that
 * the document lands where `deleteAccount` will look for it — and D-60, which
 * is a rule about the *schedule* and therefore has nothing to say until there
 * are puzzles in Firestore to be withheld.
 *
 * Shares an emulator with the phase 2 and phase 3 files, and therefore seeds
 * today exactly as they do and nothing else. An extra scheduled day would be
 * invisible here and would fail phase 2's health check, which counts the days
 * still ahead — the three files race, and the loser reads the other's fixture.
 */

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { opensAt, puzzleIdAt } from "../../src/lib/puzzle-day";
import { KINDS } from "../../src/lib/kinds";
import { COUNTRIES } from "../../src/lib/countries";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
if (getApps().length === 0) initializeApp({ projectId: "demo-mondo" });
const db = getFirestore();

const FUNCTIONS = "http://127.0.0.1:5001/demo-mondo/southamerica-east1";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const TODAY = puzzleIdAt(new Date());
/** code → continent, for checking what the wire served (FR-9.9). */
const COUNTRY: Record<string, string> = Object.fromEntries([...COUNTRIES.values()].map((c) => [c.code, c.region]));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
interface Res { status: number; result?: Any; error?: Any }
interface Account { uid: string; token: string; call: (fn: string, data?: unknown) => Promise<Res> }

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (r: Res) => r.error?.details?.code ?? r.error?.status ?? null;
const ok = (r: Res, what: string) => { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.error)}`); return r.result; };
const doc = async (path: string) => (await db.doc(path).get()).data() as Any;

/** The first country of the kind's pool that no seeded puzzle has taken. */
const spare = (kind: keyof typeof KINDS, taken: string[]) => KINDS[kind].pool().find((c) => !taken.includes(c.code))!.code;

/** What the three e2e files agree today's puzzle is; they must seed it identically. */
const TODAY_ITEMS = [
  { kind: "shape", subject: "PY" }, { kind: "flag", subject: "BR" },
  { kind: "capital", subject: "IT" }, { kind: "gdp", subject: "JP" },
];

let ana: Account;      // invited, plays
let carla: Account;    // signed in, never invited
let gid: string;

before(async () => {
  await db.doc(`puzzles/${TODAY}`).set({
    puzzleId: TODAY, items: TODAY_ITEMS, opensAt: Timestamp.fromDate(opensAt(TODAY)),
  });

  const owner = await newAccount("pr-owner");
  await owner.call("getRound", {});
  await db.doc(`users/${owner.uid}`).update({ role: "organizer" });
  gid = ok(await owner.call("createGroup", { name: "Treino e2e" }), "createGroup").groupId;

  ana = await newAccount("pr-ana");
  const { token } = ok(await owner.call("createInvite", { groupId: gid }), "createInvite");
  ok(await ana.call("acceptInvite", { token }), "acceptInvite");

  carla = await newAccount("pr-carla");
  await carla.call("getRound", {});
});

// ---------------------------------------------------------------------------

test("FR-1.7: practice is invite-only, like the day is", async () => {
  assert.equal(code(await carla.call("startPractice", { kind: "shape" })), "not-invited");
  assert.equal(code(await carla.call("nextPractice", {})), "not-invited");
  assert.equal(code(await carla.call("submitPracticeGuess", { guess: "BR" })), "not-invited");
  // No token at all: the wrapper refuses before the payload is read (SEC-8).
  // An HttpsError with no `details` surfaces as the protocol's own status.
  assert.equal(code(await post("startPractice", { kind: "shape" })), "UNAUTHENTICATED");
});

test("a kind that does not exist is refused before anything is written", async () => {
  assert.equal(code(await ana.call("startPractice", { kind: "populacao" })), "invalid-argument");
  assert.equal(code(await ana.call("startPractice", {})), "invalid-argument");
  assert.equal((await db.doc(`practice/${ana.uid}`).get()).exists, false);
});

test("FR-9.9: a continent that is not one is refused before anything is written", async () => {
  for (const bad of [["Antarctica"], ["europe"], [], "Europe", ["Europe", 2]]) {
    assert.equal(code(await ana.call("startPractice", { kind: "shape", regions: bad })), "invalid-argument", JSON.stringify(bad));
  }
  assert.equal((await db.doc(`practice/${ana.uid}`).get()).exists, false);
});

test("guessing before starting is a typed error, not a crash", async () => {
  assert.equal(code(await ana.call("submitPracticeGuess", { guess: "BR" })), "not-found");
  assert.equal(code(await ana.call("nextPractice", {})), "not-found");
  assert.equal(code(await ana.call("endPractice", {})), "not-found");
});

test("SEC-1: starting serves a prompt and never the answer", async () => {
  const v = ok(await ana.call("startPractice", { kind: "shape" }), "startPractice");
  assert.equal(v.status, "in_progress");
  assert.equal(v.item.status, "current");
  assert.equal(v.item.prompt.kind, "shape");
  assert.equal(v.item.answer, null);
  assert.equal(v.item.points, null);
  assert.equal(v.item.guessesMax, KINDS.shape.maxGuesses);
  assert.deepEqual(v.totals, { played: 0, solved: 0, points: 0, maxPoints: 0 });

  // The answer is in Firestore and nowhere in the body — which the rules deny
  // the player anyway (the `practice` case in test/rules).
  const stored = await doc(`practice/${ana.uid}`);
  assert.ok(stored.subject, "the session did not store a subject");
  assert.equal(JSON.stringify(v).includes(stored.subject), false, "the response carried the answer");
  assert.ok(stored.startedAt, "no server clock on the session (SEC-3)");
});

test("a wrong guess spends one and hands back a hint; the right one ends the challenge", async () => {
  const subject = (await doc(`practice/${ana.uid}`)).subject;
  const wrong = spare("shape", [subject]);

  const miss = ok(await ana.call("submitPracticeGuess", { guess: wrong }), "miss");
  assert.equal(miss.item.status, "current");
  assert.equal(miss.item.guessesUsed, 1);
  assert.equal(miss.item.answer, null, "a miss revealed the answer");
  assert.equal(miss.item.guesses[0].compass.length > 0, true);
  assert.equal("bearingDeg" in miss.item.guesses[0], false, "D-36: the exact bearing left the server");

  await sleep(450); // SEC-5's floor is a floor for practice too
  const hit = ok(await ana.call("submitPracticeGuess", { guess: subject }), "hit");
  assert.equal(hit.item.status, "solved");
  assert.equal(hit.item.prompt, null, "the prompt outlived the challenge");
  assert.equal(hit.item.answer.code, subject);
  assert.equal(hit.item.points, 5, "second-guess solve on a six-guess kind");
  assert.equal(hit.item.guesses.length, 2, "the reveal must carry the guess that ended it (D-55)");
  assert.deepEqual(hit.totals, { played: 0, solved: 0, points: 0, maxPoints: 0 }, "counted before it was advanced past");

  await sleep(450);
  assert.equal(code(await ana.call("submitPracticeGuess", { guess: subject })), "already-completed");
});

test("moving on counts the challenge and deals a new one", async () => {
  const before = (await doc(`practice/${ana.uid}`)).subject;
  const v = ok(await ana.call("nextPractice", {}), "nextPractice");
  assert.deepEqual(v.totals, { played: 1, solved: 1, points: 5, maxPoints: 6 });
  assert.equal(v.item.status, "current");
  assert.equal(v.item.guessesUsed, 0);
  assert.notEqual((await doc(`practice/${ana.uid}`)).subject, before, "the same country twice in a row");
});

test("FR-9.4: leaving ends it and reports the total; the session is over for good", async () => {
  const v = ok(await ana.call("endPractice", {}), "endPractice");
  assert.equal(v.status, "ended");
  assert.equal(v.item, null, "the abandoned challenge kept its answer (SEC-1)");
  assert.deepEqual(v.totals, { played: 1, solved: 1, points: 5, maxPoints: 6 });

  assert.equal(code(await ana.call("submitPracticeGuess", { guess: "BR" })), "already-completed");
  assert.equal(code(await ana.call("nextPractice", {})), "already-completed");
  // Idempotent: a second "sair" cannot inflate the total.
  assert.deepEqual(ok(await ana.call("endPractice", {}), "endPractice again").totals, v.totals);
});

test("FR-9.3: nothing about a practice session reaches attempts, the profile or a board", async () => {
  const before = await doc(`users/${ana.uid}`);
  ok(await ana.call("startPractice", { kind: "capital" }), "startPractice");
  const subject = (await doc(`practice/${ana.uid}`)).subject;
  ok(await ana.call("submitPracticeGuess", { guess: subject }), "solve");
  ok(await ana.call("endPractice", {}), "endPractice");

  const attempts = await db.collection("attempts").where("uid", "==", ana.uid).get();
  assert.equal(attempts.docs.some((d) => d.id.startsWith(`${ana.uid}_practice`)), false);
  assert.equal(attempts.size, 0, "practice wrote an attempt");
  const after = await doc(`users/${ana.uid}`);
  assert.equal(after.totalPlayed, before.totalPlayed, "practice moved the daily counters");
  assert.equal(after.currentStreak, before.currentStreak, "practice moved the streak");
});

test("D-60: the session is dealt the schedule's withheld list, and honours it", async () => {
  ok(await ana.call("startPractice", { kind: "flag" }), "startPractice");
  const stored = await doc(`practice/${ana.uid}`);

  // The wiring, deterministically: every subject on a day inside the window is
  // on the session's blocked list. Without it, practising `gdp` is a machine
  // for grinding out today's answer — the prompt names the country, so the
  // player need only click until it comes up.
  for (const it of TODAY_ITEMS) {
    assert.ok(stored.blocked.includes(it.subject), `${it.subject} is scheduled today and was not withheld`);
  }
  assert.equal(stored.blocked.includes(stored.subject), false, "the first challenge was a withheld subject");

  // And then it holds over a run. The exhaustive version of this lives in the
  // unit tests, which can block all but three countries; here the point is that
  // the list that crossed the wire is the one the picker used.
  const seen = [stored.subject];
  for (let i = 0; i < 20; i++) {
    ok(await ana.call("nextPractice", {}), `nextPractice ${i}`);
    seen.push((await doc(`practice/${ana.uid}`)).subject);
  }
  assert.deepEqual(seen.filter((c) => stored.blocked.includes(c)), []);
  assert.ok(new Set(seen).size >= 15, "the picker is barely varying");
});

test("FR-2.13: giving up ends the challenge at zero and hands over the answer", async () => {
  ok(await ana.call("startPractice", { kind: "capital" }), "startPractice");
  const subject = (await doc(`practice/${ana.uid}`)).subject;

  const v = ok(await ana.call("giveUpPractice", {}), "giveUpPractice");
  assert.equal(v.item.status, "failed");
  assert.equal(v.item.points, 0);
  assert.equal(v.item.answer.code, subject);
  assert.equal(v.item.prompt, null, "the prompt outlived the challenge");
  assert.deepEqual(v.item.guesses, [], "giving up invented a guess");

  // Over, and counted once the player moves on.
  assert.equal(code(await ana.call("giveUpPractice", {})), "already-completed");
  assert.equal(code(await ana.call("submitPracticeGuess", { guess: subject })), "already-completed");
  const next = ok(await ana.call("nextPractice", {}), "nextPractice");
  assert.equal(next.totals.played, 1);
  assert.equal(next.totals.solved, 0);
  assert.equal(next.totals.points, 0);

  // And it is refused to someone who was never let in (FR-1.7).
  assert.equal(code(await carla.call("giveUpPractice", {})), "not-invited");
  ok(await ana.call("endPractice", {}), "endPractice");
});

test("FR-1.5: deleting the account takes the practice session with it", async () => {
  const gone = await newAccount("pr-gone");
  const owner = await newAccount("pr-owner2");
  await owner.call("getRound", {});
  await db.doc(`users/${owner.uid}`).update({ role: "organizer" });
  const g = ok(await owner.call("createGroup", { name: "Treino saida" }), "createGroup").groupId;
  const { token } = ok(await owner.call("createInvite", { groupId: g }), "createInvite");
  ok(await gone.call("acceptInvite", { token }), "acceptInvite");

  ok(await gone.call("startPractice", { kind: "shape" }), "startPractice");
  assert.equal((await db.doc(`practice/${gone.uid}`).get()).exists, true);
  ok(await gone.call("deleteAccount", {}), "deleteAccount");
  assert.equal((await db.doc(`practice/${gone.uid}`).get()).exists, false);
});

test("FR-8.7: a pick crosses the wire as an index, and the options carry no country", async () => {
  const start = ok(await ana.call("startPractice", { kind: "flagPick" }), "startPractice");
  assert.equal(start.item.prompt.kind, "flagPick");
  assert.equal(start.item.prompt.options.length, 8);
  assert.equal(start.item.guessesMax, 2);

  // SEC-1, over the wire rather than in a unit test: the response holds eight
  // flags and nothing that says which is whose. The subject is server-side, so
  // the check is against the stored session rather than against a guess.
  const session = await doc(`practice/${ana.uid}`);
  assert.equal(session.options.length, 8);
  assert.ok(session.options.includes(session.subject));
  const wire = JSON.stringify(start.item.prompt.options);
  for (const c of session.options) assert.ok(!wire.includes(`"${c}"`), `the wire leaks ${c}`);
  // Only artwork: every option is exactly a flag and nothing else.
  for (const o of start.item.prompt.options) assert.deepEqual(Object.keys(o), ["flag"]);

  const right = session.options.indexOf(session.subject);
  const wrong = (right + 1) % 8;

  // A guess that is not an index is refused and spends nothing.
  assert.equal(code(await ana.call("submitPracticeGuess", { guess: session.subject })), "invalid-argument");
  assert.equal(code(await ana.call("submitPracticeGuess", { guess: 8 })), "invalid-argument");
  assert.equal((await doc(`practice/${ana.uid}`)).item.guesses.length, 0);

  await sleep(450);
  const missed = ok(await ana.call("submitPracticeGuess", { guess: wrong }), "wrong pick");
  assert.equal(missed.item.status, "current");
  assert.equal(missed.item.guesses.length, 1);
  assert.deepEqual(missed.item.guesses[0], { kind: "choice", pick: wrong, proximity: 0 });
  assert.equal(missed.item.answer, null, "a wrong pick must not reveal the answer");

  await sleep(450);
  const done = ok(await ana.call("submitPracticeGuess", { guess: right }), "right pick");
  assert.equal(done.item.status, "solved");
  // D-64: six for the first pick, two for the second.
  assert.equal(done.item.points, 2);
  assert.equal(done.item.answer.pick, right, "the reveal says which option it was");

  ok(await ana.call("endPractice", {}), "endPractice");
});

test("FR-9.9: a filtered session stores its continents and stays inside them", async () => {
  const v = ok(await ana.call("startPractice", { kind: "capital", regions: ["Europe"] }), "startPractice");
  assert.equal(v.status, "in_progress");
  const stored = await doc(`practice/${ana.uid}`);
  assert.deepEqual(stored.regions, ["Europe"]);
  // Ten challenges over the wire, every answer read out of Firestore rather
  // than the response — which still must not carry it (SEC-1).
  for (let i = 0; i < 10; i++) {
    const s = await doc(`practice/${ana.uid}`);
    assert.equal(COUNTRY[s.subject], "Europe", `served ${s.subject}`);
    ok(await ana.call("giveUpPractice", {}), "giveUpPractice");
    ok(await ana.call("nextPractice", {}), "nextPractice");
  }
  ok(await ana.call("endPractice", {}), "endPractice");
});

test("FR-9.9: omitting regions is every continent, as it was before the filter", async () => {
  ok(await ana.call("startPractice", { kind: "shape" }), "startPractice");
  assert.deepEqual((await doc(`practice/${ana.uid}`)).regions, ["Africa", "Americas", "Asia", "Europe", "Oceania"]);
  ok(await ana.call("endPractice", {}), "endPractice");
});
