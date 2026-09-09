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
const CAROL = "carolUid0000000000000000003"; // in no group
const PUZZLE = "2026-09-15";
const GROUP = "g1group0000000000001";
const GROUP2 = "g2group0000000000002"; // carol's group; alice and bob are not in it
const TOKEN = "ABCDEFGHJKLMNPQR";

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
    await db.doc(`users/${CAROL}`).set({ ...profile, displayName: "carol-tres", role: "player", groups: [] });
    // Phase 2: alice owns GROUP, bob is a member, carol is not (FR-4.10).
    await db.doc(`groups/${GROUP}`).set({ name: "Almoço", ownerUid: ALICE, memberCount: 2, maxMembers: 200, createdAt: new Date() });
    await db.doc(`groups/${GROUP}/members/${ALICE}`).set({ uid: ALICE, displayName: "alice-um", role: "owner", joinedAt: new Date() });
    await db.doc(`groups/${GROUP}/members/${BOB}`).set({ uid: BOB, displayName: "bob-dois", role: "member", joinedAt: new Date() });
    await db.doc(`groups/${GROUP2}`).set({ name: "Família", ownerUid: CAROL, memberCount: 1, maxMembers: 200, createdAt: new Date() });
    await db.doc(`groups/${GROUP2}/members/${CAROL}`).set({ uid: CAROL, displayName: "carol-tres", role: "owner", joinedAt: new Date() });
    await db.doc(`invites/${TOKEN}`).set({ groupId: GROUP, groupName: "Almoço", createdBy: ALICE, createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), usedBy: null, usedAt: null, revokedAt: null });
  });
});
after(async () => {
  await env.cleanup();
});

const alice = () => env.authenticatedContext(ALICE).firestore();
const bob = () => env.authenticatedContext(BOB).firestore();
const carol = () => env.authenticatedContext(CAROL).firestore();
const anon = () => env.unauthenticatedContext().firestore();

// --- SEC-7 / SEC-6: the answer-bearing collections are unreachable ----------

test("SEC-7: a signed-in player cannot read a puzzle, list puzzles, or write one", async () => {
  await assertFails(alice().doc(`puzzles/${PUZZLE}`).get());
  await assertFails(alice().collection("puzzles").get());
  await assertFails(alice().doc("puzzles/2026-09-16").set({ countryCode: "BR" }));
});

test("challenges are closed to clients", async () => {
  await assertFails(alice().doc("challenges/c1").get());
  await assertFails(alice().doc("challenges/c2").set({ countryCode: "BR" }));
});

test("D-32: invites are unreadable and unwritable, even by their creator or the invitee", async () => {
  await assertFails(alice().doc(`invites/${TOKEN}`).get());          // creator
  await assertFails(carol().doc(`invites/${TOKEN}`).get());          // someone holding the link
  await assertFails(carol().collection("invites").get());
  await assertFails(carol().doc(`invites/${TOKEN}`).update({ usedBy: CAROL }));
  await assertFails(alice().doc("invites/ZZZZZZZZZZZZZZZZ").set({ groupId: GROUP }));
  await assertFails(alice().doc(`invites/${TOKEN}`).delete());
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

test("users: a player reads their own profile only; anonymous reads nothing", async () => {
  await assertSucceeds(alice().doc(`users/${ALICE}`).get());
  await assertFails(alice().doc(`users/${BOB}`).get());
  await assertFails(anon().doc(`users/${ALICE}`).get());
});

test("FR-4.10: the profile collection cannot be listed or queried, so membership cannot be enumerated", async () => {
  // `read: if signedIn()` would have allowed all of these: a condition that
  // mentions neither `resource` nor {uid} authorizes a list, and `groups` is an
  // array, so array-contains would have handed out any group's member list.
  await assertFails(alice().collection("users").get());
  await assertFails(alice().collection("users").where("groups", "array-contains", GROUP).get());
  await assertFails(alice().collection("users").where("role", "==", "admin").get());
  await assertFails(alice().collection("users").limit(1).get());
  await assertFails(carol().collection("users").where("groups", "array-contains", GROUP).get());
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

test("FR-7.1 / D-27: a player cannot grant themselves a role or a group", async () => {
  await assertFails(carol().doc(`users/${CAROL}`).update({ role: "admin" }));
  await assertFails(carol().doc(`users/${CAROL}`).update({ role: "organizer" }));
  await assertFails(carol().doc(`users/${CAROL}`).update({ groups: [GROUP] }));
  await assertFails(carol().doc(`users/${CAROL}`).update({ displayName: "carol-tres", groups: [GROUP] }));
});

// --- groups (FR-4.10) --------------------------------------------------------

test("FR-4.10: members read the group and its member list; a non-member reads neither", async () => {
  await assertSucceeds(alice().doc(`groups/${GROUP}`).get());
  await assertSucceeds(bob().doc(`groups/${GROUP}`).get());
  await assertSucceeds(bob().collection(`groups/${GROUP}/members`).get());
  await assertSucceeds(bob().doc(`groups/${GROUP}/members/${ALICE}`).get());
  await assertFails(carol().doc(`groups/${GROUP}`).get());
  await assertFails(carol().collection(`groups/${GROUP}/members`).get());
  await assertFails(carol().doc(`groups/${GROUP}/members/${ALICE}`).get());
});

test("FR-4.10: membership is per group — being in one group opens nothing about another", async () => {
  await assertSucceeds(carol().doc(`groups/${GROUP2}`).get());
  await assertFails(bob().doc(`groups/${GROUP2}`).get());
  await assertFails(alice().doc(`groups/${GROUP2}/members/${CAROL}`).get());
  await assertFails(alice().collection(`groups/${GROUP2}/members`).get());
});

test("FR-4.10: anonymous visitors see no group data at all", async () => {
  await assertFails(anon().doc(`groups/${GROUP}`).get());
  await assertFails(anon().collection(`groups/${GROUP}/members`).get());
  await assertFails(anon().collection("groups").get());
  await assertFails(anon().doc(`invites/${TOKEN}`).get());
});

test("no client can enumerate groups or invites", async () => {
  await assertFails(alice().collection("groups").get());
  await assertFails(alice().collection("groups").where("ownerUid", "==", ALICE).get());
  await assertFails(alice().collection("invites").where("createdBy", "==", ALICE).get());
});

test("SEC-6: not even the owner writes a group document from the client", async () => {
  await assertFails(alice().doc(`groups/${GROUP}`).update({ name: "Renamed" }));
  await assertFails(alice().doc(`groups/${GROUP}`).update({ memberCount: 1 }));
  await assertFails(alice().doc(`groups/${GROUP}`).delete());
  await assertFails(alice().doc("groups/newGroup000000000002").set({ name: "Novo", ownerUid: ALICE, memberCount: 1, maxMembers: 200 }));
});

test("SEC-6: member documents are functions-only — own, another's, or a new one", async () => {
  await assertFails(bob().doc(`groups/${GROUP}/members/${BOB}`).update({ last30: { points: 9999 } }));
  await assertFails(bob().doc(`groups/${GROUP}/members/${BOB}`).update({ role: "owner" }));
  await assertFails(alice().doc(`groups/${GROUP}/members/${BOB}`).delete());
  await assertFails(alice().doc(`groups/${GROUP}/members/${CAROL}`).set({ uid: CAROL, displayName: "carol-tres", role: "member" }));
  await assertFails(carol().doc(`groups/${GROUP}/members/${CAROL}`).set({ uid: CAROL, displayName: "carol-tres", role: "member" }));
});

test("D-21 / D-22: no results or standings subcollections exist; the catch-all denies them even to members", async () => {
  await assertFails(bob().doc(`groups/${GROUP}/results/x`).get());
  await assertFails(bob().doc(`groups/${GROUP}/standings/${BOB}`).get());
  await assertFails(alice().doc(`groups/${GROUP}/standings/${ALICE}`).set({ points: 1 }));
  await assertFails(bob().collection(`groups/${GROUP}/results`).get());
});

test("users: clients cannot create or delete profiles", async () => {
  await assertFails(alice().doc("users/newUid000000000000000000003").set({ displayName: "novo-um", locale: "pt-BR" }));
  await assertFails(alice().doc(`users/${ALICE}`).delete());
});

// --- default deny -----------------------------------------------------------

test("anything not listed is denied", async () => {
  await assertFails(alice().doc("groups/unknownGroup000000001").get());
  await assertFails(alice().doc("inviteCodes/ABCD2345").get()); // §3.8 collection was never created
  await assertFails(alice().doc("anything/at-all").set({ a: 1 }));
  assert.ok(true);
});
