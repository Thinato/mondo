/**
 * Security rules tests (SEC-6, SEC-7, FR-1.3, FR-1.4). Needs the Firestore
 * emulator: `npm run test:rules`. The negative cases are the point — an
 * untested allow is how a Firebase project gets owned.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

const ALICE = "aliceUid00000000000000000001";
const BOB = "bobUid0000000000000000000002";
const PUZZLE = "2026-09-15";

let env: RulesTestEnvironment;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-mondo",
    firestore: {
      rules: readFileSync(join(__dirname, "../../../../firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const profile = { displayName: "x", createdAt: new Date(), lastPlayedOn: null, currentStreak: 0, longestStreak: 0, totalPlayed: 0, totalSolved: 0, locale: "pt-BR" };
    await db.doc(`users/${ALICE}`).set({ ...profile, displayName: "alice-um" });
    await db.doc(`users/${BOB}`).set({ ...profile, displayName: "bob-dois" });
    await db.doc(`puzzles/${PUZZLE}`).set({ puzzleId: PUZZLE, countryCode: "PY", tier: 1, opensAt: new Date() });
    await db.doc(`attempts/${ALICE}_${PUZZLE}`).set({ uid: ALICE, puzzleId: PUZZLE, guesses: [], guessCount: 0 });
    await db.doc(`attempts/${BOB}_${PUZZLE}`).set({ uid: BOB, puzzleId: PUZZLE, guesses: [], guessCount: 0 });
    await db.doc("challenges/c1").set({ countryCode: "PY" });
    await db.doc("inviteCodes/ABCD2345").set({ groupId: "g1" });
  });
});
after(async () => {
  await env.cleanup();
});

const alice = () => env.authenticatedContext(ALICE).firestore();
const anon = () => env.unauthenticatedContext().firestore();

// --- SEC-7 / SEC-6: the answer-bearing collections are unreachable ----------

test("SEC-7: a signed-in player cannot read a puzzle, list puzzles, or write one", async () => {
  await assertFails(alice().doc(`puzzles/${PUZZLE}`).get());
  await assertFails(alice().collection("puzzles").get());
  await assertFails(alice().doc("puzzles/2026-09-16").set({ countryCode: "BR" }));
});

test("challenges and inviteCodes are closed to clients", async () => {
  await assertFails(alice().doc("challenges/c1").get());
  await assertFails(alice().doc("inviteCodes/ABCD2345").get());
  await assertFails(alice().doc("inviteCodes/NEWCODE1").set({ groupId: "g1" }));
});

test("SEC-6: attempts cannot be created, updated or deleted by a client, even their own", async () => {
  await assertFails(alice().doc(`attempts/${ALICE}_${PUZZLE}`).update({ guessCount: 0, solved: true, points: 6 }));
  await assertFails(alice().doc(`attempts/${ALICE}_2026-09-16`).set({ uid: ALICE, solved: true }));
  await assertFails(alice().doc(`attempts/${ALICE}_${PUZZLE}`).delete());
});

test("attempts: own is readable, another player's is not, and listing is not", async () => {
  await assertSucceeds(alice().doc(`attempts/${ALICE}_${PUZZLE}`).get());
  await assertFails(alice().doc(`attempts/${BOB}_${PUZZLE}`).get());
  await assertFails(alice().collection("attempts").get());
  await assertFails(anon().doc(`attempts/${ALICE}_${PUZZLE}`).get());
});

// --- users ------------------------------------------------------------------

test("users: any signed-in player reads any profile; anonymous reads nothing", async () => {
  await assertSucceeds(alice().doc(`users/${BOB}`).get());
  await assertFails(anon().doc(`users/${ALICE}`).get());
});

test("FR-1.3: a player may change their own displayName and locale", async () => {
  await assertSucceeds(alice().doc(`users/${ALICE}`).update({ displayName: "Capivara Veloz_2" }));
  await assertSucceeds(alice().doc(`users/${ALICE}`).update({ locale: "en" }));
  await assertSucceeds(alice().doc(`users/${ALICE}`).update({ displayName: "Ana", locale: "pt-BR" }));
});

test("FR-1.3: displayName limits are enforced by the rules, not just the UI", async () => {
  const me = alice().doc(`users/${ALICE}`);
  await assertFails(me.update({ displayName: "ab" }));                        // too short
  await assertFails(me.update({ displayName: "a".repeat(25) }));             // too long
  await assertFails(me.update({ displayName: " capivara" }));                // leading space
  await assertFails(me.update({ displayName: "capivara " }));                // trailing space
  await assertFails(me.update({ displayName: "capi@vara" }));                // symbol
  await assertFails(me.update({ displayName: "a@b.com" }));                  // looks like an email
  await assertFails(me.update({ displayName: 123 }));                        // not a string
  await assertFails(me.update({ locale: "fr" }));                            // unknown locale
});

test("users: nobody edits another player's profile, and counters are functions-only", async () => {
  await assertFails(alice().doc(`users/${BOB}`).update({ displayName: "hacked-bob" }));
  await assertFails(alice().doc(`users/${ALICE}`).update({ currentStreak: 999 }));
  await assertFails(alice().doc(`users/${ALICE}`).update({ displayName: "Ana Paula", totalSolved: 500 }));
  await assertFails(alice().doc(`users/${ALICE}`).update({ email: "a@b.com" }));   // FR-1.4
});

test("users: clients cannot create or delete profiles", async () => {
  await assertFails(alice().doc("users/newUid000000000000000000003").set({ displayName: "novo-um", locale: "pt-BR" }));
  await assertFails(alice().doc(`users/${ALICE}`).delete());
});

// --- default deny -----------------------------------------------------------

test("anything not listed is denied", async () => {
  await assertFails(alice().doc("groups/g1").get());
  await assertFails(alice().doc("groups/g1/standings/x").get());
  await assertFails(alice().doc("anything/at-all").set({ a: 1 }));
  assert.ok(true);
});
