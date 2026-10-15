/**
 * The profile end-to-end against the emulators (FR-13, D-97).
 *
 * The unit tests own the visibility rules. What only this file can prove is
 * that the callable applies them to what is really in Firestore: that the
 * viewer's own today attempt — not the target's — decides FR-4.11, that today's
 * recap is refused to everyone but its owner, and that nothing private crosses
 * the wire.
 *
 * Shares an emulator with the other e2e files, so it seeds today exactly as
 * they do — and yesterday exactly as phase 2 does (one silhouette, Argentina):
 * the files run at once, and whichever writes last is the puzzle everyone reads.
 */

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { opensAt, puzzleIdAt } from "../../src/lib/puzzle-day";
import { previousDay } from "../../src/lib/round";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
if (getApps().length === 0) initializeApp({ projectId: "demo-mondo" });
const db = getFirestore();

const FUNCTIONS = "http://127.0.0.1:5001/demo-mondo/southamerica-east1";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const TODAY = puzzleIdAt(new Date());
const YESTERDAY = previousDay(TODAY);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
interface Res { status: number; result?: Any; error?: Any }
interface Account { uid: string; email: string; call: (fn: string, data?: unknown) => Promise<Res> }

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
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }),
  }).then((x) => x.json() as Promise<Any>);
  return { uid: r.localId, email, call: (fn, data = {}) => post(fn, data, r.idToken) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (r: Res) => r.error?.details?.code ?? r.error?.status ?? null;
const ok = (r: Res, what: string) => { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.error)}`); return r.result; };

/** What the e2e files agree today's puzzle is; they must seed it identically. */
const TODAY_ITEMS = [
  { kind: "shape", subject: "PY" }, { kind: "flag", subject: "BR" },
  { kind: "capital", subject: "IT" }, { kind: "gdp", subject: "JP" },
];

/** Give up on every challenge: the day ends, with real attempts on both sides. */
async function finishToday(a: Account): Promise<void> {
  ok(await a.call("getRound", {}), "getRound");
  for (let i = 0; i < TODAY_ITEMS.length; i++) {
    await sleep(450);
    ok(await a.call("giveUp", { puzzleId: TODAY }), `giveUp ${i}`);
  }
}

let ana: Account;   // the profile being looked at
let bia: Account;   // somebody else

before(async () => {
  await db.doc(`puzzles/${TODAY}`).set({ puzzleId: TODAY, items: TODAY_ITEMS, opensAt: Timestamp.fromDate(opensAt(TODAY)) });
  await db.doc(`puzzles/${YESTERDAY}`).set({ puzzleId: YESTERDAY, countryCode: "AR", tier: 1, opensAt: Timestamp.fromDate(opensAt(YESTERDAY)) });

  ana = await newAccount("pf-ana");
  bia = await newAccount("pf-bia");
  ok(await ana.call("updateProfile", { displayName: "Ana Perfil" }), "ana's profile");
  await db.doc(`users/${ana.uid}`).update({ role: "admin" });

  // Ana played yesterday: one wrong guess, then Argentina.
  const start = Timestamp.fromDate(opensAt(YESTERDAY));
  const t = (s: number) => Timestamp.fromMillis(start.toMillis() + s * 1000);
  await db.doc(`attempts/${ana.uid}_${YESTERDAY}`).set({
    uid: ana.uid, puzzleId: YESTERDAY, mode: "daily", startedAt: start, finishedAt: t(20), cursor: 1,
    items: [{
      kind: "shape", solved: true, points: 5, startedAt: start, finishedAt: t(20), elapsedMs: 20_000,
      guesses: [
        { code: "UY", distanceKm: 900, bearingDeg: 225, proximity: 0.7, at: t(10) },
        { code: "AR", distanceKm: 0, bearingDeg: 0, proximity: 1, at: t(20) },
      ],
    }],
    points: 5, guessCount: 2, solved: true, elapsedMs: 20_000, suspicious: false,
  });

  await finishToday(ana);
});

// ---------------------------------------------------------------------------

test("FR-4.11: another player's today appears only once the viewer has finished, and never its recap", async () => {
  const before = ok(await bia.call("getProfile", { uid: ana.uid }), "bia reads ana before playing");
  assert.equal(before.found, true);
  assert.equal(before.isOwner, false);
  assert.deepEqual(before.days.map((d: Any) => d.puzzleId), [YESTERDAY]);

  assert.equal(code(await bia.call("getProfile", { uid: ana.uid, day: TODAY })), "permission-denied");

  await finishToday(bia);
  const after = ok(await bia.call("getProfile", { uid: ana.uid }), "bia reads ana after playing");
  assert.deepEqual(after.days.map((d: Any) => [d.puzzleId, d.recap]), [[TODAY, false], [YESTERDAY, true]]);
  assert.equal(after.days[0].grid.length, TODAY_ITEMS.length);

  // Having finished changes nothing for the recap: today's answers are ana's to see, not bia's.
  assert.equal(code(await bia.call("getProfile", { uid: ana.uid, day: TODAY })), "permission-denied");
});

test("the owner sees today's recap; anyone sees a closed day's", async () => {
  const own = ok(await ana.call("getProfile", { day: TODAY }), "ana's own today");
  assert.deepEqual(own.items.map((it: Any) => it.answer.code), ["PY", "BR", "IT", "JP"]);

  const past = ok(await bia.call("getProfile", { uid: ana.uid, day: YESTERDAY }), "bia reads ana's yesterday");
  assert.equal(past.items[0].answer.code, "AR");
  assert.deepEqual(past.items[0].guesses.map((g: Any) => g.code), ["UY", "AR"]);
  assert.equal(past.points, 5);
});

test("nothing private crosses the wire", async () => {
  const bodies = [
    await bia.call("getProfile", { uid: ana.uid }),
    await bia.call("getProfile", { uid: ana.uid, day: YESTERDAY }),
    await ana.call("getProfile", {}),
    await ana.call("getProfile", { day: TODAY }),
  ].map((r) => JSON.stringify(ok(r, "read")));
  for (const json of bodies) {
    assert.ok(!json.includes(ana.email) && !json.includes(bia.email), "no email");
    for (const key of ["bearingDeg", "email", "role", "rank", "subscription", "groups", "history"]) {
      assert.ok(!json.includes(`"${key}"`), `${key} must not appear`);
    }
    assert.ok(!json.includes("admin"), "ana's role is not anyone's business");
  }
});

test("the owner's view: own stats, and a guest with no profile still owns their page", async () => {
  const own = ok(await ana.call("getProfile", {}), "ana reads herself");
  assert.equal(own.isOwner, true);
  assert.equal(own.profile.displayName, "Ana Perfil");
  assert.deepEqual(own.days.map((d: Any) => [d.puzzleId, d.recap]), [[TODAY, true], [YESTERDAY, true]]);
  assert.equal(own.kinds.find((k: Any) => k.kind === "shape").played, 2);

  const fresh = await newAccount("pf-fresh");
  const empty = ok(await fresh.call("getProfile", {}), "a brand-new account");
  assert.deepEqual([empty.found, empty.isOwner, empty.days.length], [false, true, 0]);
});

test("bad input is refused, unknown players are not found, and a session is required", async () => {
  const nobody = ok(await bia.call("getProfile", { uid: "nobodyHere123" }), "unknown uid");
  assert.deepEqual([nobody.found, nobody.isOwner], [false, false]);
  assert.equal(code(await bia.call("getProfile", { uid: "../x" })), "invalid-argument");
  assert.equal(code(await bia.call("getProfile", { uid: ana.uid, day: "ontem" })), "invalid-argument");
  assert.equal(code(await bia.call("getProfile", { uid: ana.uid, day: "2020-01-01" })), "permission-denied");
  assert.equal(code(await post("getProfile", {})), "UNAUTHENTICATED");
});
