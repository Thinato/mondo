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
const TOURNAMENT = "t1tournament0000001";
const ROOM = "ROOMABCDEFGHJKLM"; // alice hosts, bob is in it, carol is not

let env: RulesTestEnvironment;
before(async () => {
  // `clearFirestore()` below wipes whatever it points at, so the host comes from
  // the emulator this run started (`emulators:exec` sets it) and never a default.
  const hostPort = process.env.FIRESTORE_EMULATOR_HOST;
  if (!hostPort) throw new Error("FIRESTORE_EMULATOR_HOST is not set; run under emulators:exec.");
  const at = hostPort.lastIndexOf(":");
  env = await initializeTestEnvironment({
    projectId: "demo-mondo",
    firestore: {
      rules: readFileSync(join(__dirname, "../../../../firestore.rules"), "utf8"),
      host: hostPort.slice(0, at),
      port: Number(hostPort.slice(at + 1)),
    },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const profile = { displayName: "x", createdAt: new Date(), lastPlayedOn: null, currentStreak: 0, longestStreak: 0, totalPlayed: 0, totalSolved: 0, locale: "pt-BR" };
    await db.doc(`users/${ALICE}`).set({ ...profile, displayName: "alice-um" });
    await db.doc(`users/${BOB}`).set({ ...profile, displayName: "bob-dois" });
    await db.doc(`puzzles/${PUZZLE}`).set({ puzzleId: PUZZLE, items: [{ kind: "shape", subject: "PY" }], opensAt: new Date() });
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
    // Phase 3: a tournament in alice's group, its round, and the card that
    // holds the answers (D-39). Alice and bob are participants.
    await db.doc(`tournaments/${TOURNAMENT}`).set({ groupId: GROUP, name: "Quintal", preset: "quintal", format: "free_for_all", regime: "aggregate", status: "running", createdBy: ALICE, participantUids: [ALICE, BOB], currentRound: 1 });
    await db.doc(`tournaments/${TOURNAMENT}/rounds/1`).set({ n: 1, cardId: `${TOURNAMENT}_r1`, closedAt: null, results: {} });
    await db.doc(`cards/${TOURNAMENT}_r1`).set({ tournamentId: TOURNAMENT, round: 1, items: [{ kind: "shape", subject: "PY" }] });
    await db.doc(`attempts/${ALICE}_${TOURNAMENT}_r1`).set({ uid: ALICE, tournamentId: TOURNAMENT, roundId: `${TOURNAMENT}_r1`, mode: "match", items: [], cursor: 0 });
    await db.doc(`attempts/${BOB}_${TOURNAMENT}_r1`).set({ uid: BOB, tournamentId: TOURNAMENT, roundId: `${TOURNAMENT}_r1`, mode: "match", items: [], cursor: 0 });
    // FR-9: a practice session, whose `subject` is the answer on alice's screen.
    await db.doc(`practice/${ALICE}`).set({ uid: ALICE, kind: "shape", subject: "PY", asked: ["PY"], blocked: [], totals: { played: 0, solved: 0, points: 0 } });
    // FR-12: a Multijogador room alice and bob are in, its first prompt, a named
    // country on its map, and the card that holds the answers.
    await db.doc(`rooms/${ROOM}`).set({ mode: "classic", hostUid: ALICE, state: "playing", playerUids: [ALICE, BOB], players: {} });
    await db.doc(`rooms/${ROOM}/prompts/0`).set({ index: 0, prompt: { kind: "capital", capital: "Lima" }, reveal: null });
    await db.doc(`rooms/${ROOM}/map/BR`).set({ code: "BR", by: ALICE, points: 9 });
    await db.doc(`roomSecrets/${ROOM}`).set({ items: [{ kind: "capital", subject: "PE" }], plays: {} });
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

test("D-51: no attempt is client-readable — not another player's, not the collection, not even your own", async () => {
  // Own attempts used to be readable, on the reasoning that the player already
  // knows their own guesses. They do not know `bearingDeg`, which the document
  // stores beside `distanceKm`; together those two solve for the answer's
  // centroid in closed form, which is exactly what D-36 forbids sending. The
  // Firestore REST API needs no SDK, so the rule is the only control.
  await assertFails(alice().doc(`attempts/${ALICE}_${PUZZLE}`).get());
  await assertFails(alice().doc(`attempts/${BOB}_${PUZZLE}`).get());
  await assertFails(alice().collection("attempts").get());
  await assertFails(anon().doc(`attempts/${ALICE}_${PUZZLE}`).get());
});

test("FR-9: a practice session is closed to its own player — `subject` is the answer", async () => {
  // The one field that matters is `subject`. A player who could read their own
  // session document would read the answer to the challenge on their screen,
  // which makes the whole of practice a lookup table. Same rule as `attempts`,
  // same reason (D-51), and the client never reads Firestore anyway.
  await assertFails(alice().doc(`practice/${ALICE}`).get());
  await assertFails(alice().doc(`practice/${BOB}`).get());
  await assertFails(alice().collection("practice").get());
  await assertFails(anon().doc(`practice/${ALICE}`).get());
  await assertFails(alice().doc(`practice/${ALICE}`).update({ totals: { played: 99, solved: 99, points: 999 } }));
  await assertFails(alice().doc(`practice/${ALICE}`).delete());
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

test("FR-10 / FR-11 / D-84: nobody grants themselves a rank, an ad switch or a subscription", async () => {
  const me = carol().doc(`users/${CAROL}`);
  await assertFails(me.update({ role: "invited" }));
  await assertFails(me.update({ role: "user" }));
  await assertFails(me.update({ showAds: true }));
  await assertFails(me.update({ showAds: false }));
  await assertFails(me.update({ subscription: { status: "active", currentPeriodEnd: new Date(4102444800000) } }));
  await assertFails(me.update({ displayName: "carol-tres", subscription: { status: "active" } }));
  await assertFails(me.set({ displayName: "carol-tres", locale: "pt-BR", role: "invited" }, { merge: true }));
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

// --- Phase 3: tournaments (D-39, D-40) -------------------------------------

test("D-39: a tournament and its rounds are closed to the client, members included", async () => {
  await assertFails(alice().doc(`tournaments/${TOURNAMENT}`).get());
  await assertFails(bob().doc(`tournaments/${TOURNAMENT}`).get());
  await assertFails(carol().doc(`tournaments/${TOURNAMENT}`).get());
  await assertFails(alice().doc(`tournaments/${TOURNAMENT}/rounds/1`).get());
  await assertFails(bob().collection(`tournaments/${TOURNAMENT}/rounds`).get());
  await assertFails(alice().collection("tournaments").get());
  await assertFails(alice().collection("tournaments").where("groupId", "==", GROUP).get());
});

test("D-39: nobody may write a tournament, its rounds, or its participant list", async () => {
  await assertFails(alice().doc(`tournaments/${TOURNAMENT}`).update({ status: "finished" }));
  await assertFails(bob().doc(`tournaments/${TOURNAMENT}`).update({ participantUids: [BOB] }));
  await assertFails(alice().doc(`tournaments/${TOURNAMENT}/rounds/1`).update({ results: { [ALICE]: { points: 30 } } }));
  await assertFails(alice().doc(`tournaments/new0000000000000002`).set({ groupId: GROUP, name: "meu" }));
  await assertFails(bob().doc(`tournaments/${TOURNAMENT}/rounds/2`).set({ n: 2 }));
});

test("SEC-1: the card holds the answers and is unreadable, exactly like puzzles", async () => {
  await assertFails(alice().doc(`cards/${TOURNAMENT}_r1`).get());
  await assertFails(bob().doc(`cards/${TOURNAMENT}_r1`).get());
  await assertFails(alice().collection("cards").get());
  await assertFails(alice().doc(`cards/${TOURNAMENT}_r1`).set({ items: [] }));
});

test("D-51: a tournament card play is closed to everyone, its own player included", async () => {
  // The player must NOT be able to read this: the stored guess carries
  // bearingDeg beside distanceKm, and the two together solve for the answer's
  // centroid in closed form (D-36). One REST call with their own ID token would
  // have named all five answers on the card.
  await assertFails(alice().doc(`attempts/${ALICE}_${TOURNAMENT}_r1`).get());
  await assertFails(alice().doc(`attempts/${BOB}_${TOURNAMENT}_r1`).get());
  await assertFails(carol().doc(`attempts/${ALICE}_${TOURNAMENT}_r1`).get());
  await assertFails(anon().doc(`attempts/${ALICE}_${TOURNAMENT}_r1`).get());
  await assertFails(alice().doc(`attempts/${ALICE}_${TOURNAMENT}_r1`).update({ points: 30 }));
  await assertFails(alice().doc(`attempts/${ALICE}_${TOURNAMENT}_r1`).set({ uid: ALICE, mode: "match", points: 30 }));
});

test("users: clients cannot create or delete profiles", async () => {
  await assertFails(alice().doc("users/newUid000000000000000000003").set({ displayName: "novo-um", locale: "pt-BR" }));
  await assertFails(alice().doc(`users/${ALICE}`).delete());
});

// --- Multijogador (FR-12, D-87) ---------------------------------------------------

test("D-87: a room's players can read the room, its prompts and its map", async () => {
  await assertSucceeds(alice().doc(`rooms/${ROOM}`).get());
  await assertSucceeds(bob().doc(`rooms/${ROOM}`).get());
  await assertSucceeds(bob().doc(`rooms/${ROOM}/prompts/0`).get());
  await assertSucceeds(bob().collection(`rooms/${ROOM}/prompts`).get()); // what a listener does
  await assertSucceeds(alice().collection(`rooms/${ROOM}/map`).get());
});

test("D-87: anyone outside the room reads none of it", async () => {
  await assertFails(carol().doc(`rooms/${ROOM}`).get());
  await assertFails(carol().doc(`rooms/${ROOM}/prompts/0`).get());
  await assertFails(carol().collection(`rooms/${ROOM}/map`).get());
  await assertFails(anon().doc(`rooms/${ROOM}`).get());
  await assertFails(anon().collection(`rooms/${ROOM}/map`).get());
  // A room that does not exist is not readable either — not an error that leaks.
  await assertFails(alice().doc("rooms/NOSUCHROOM234567").get());
  await assertFails(alice().collection("rooms/NOSUCHROOM234567/map").get());
});

test("D-87: nobody can list rooms — the id is the invite", async () => {
  await assertFails(alice().collection("rooms").get());
  await assertFails(alice().collection("rooms").where("playerUids", "array-contains", ALICE).get());
  await assertFails(carol().collection("rooms").get());
});

test("FR-12.8: a player the host removed reads none of the room from then on", async () => {
  const GONE = "ROOMGONE23456789";
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`rooms/${GONE}`).set({ mode: "potato", hostUid: ALICE, state: "finished", playerUids: [ALICE, BOB], players: {} });
    await ctx.firestore().doc(`rooms/${GONE}/map/BR`).set({ code: "BR", by: BOB, points: 9 });
  });
  await assertSucceeds(bob().doc(`rooms/${GONE}`).get());
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`rooms/${GONE}`).update({ playerUids: [ALICE] });
  });
  await assertFails(bob().doc(`rooms/${GONE}`).get());
  await assertFails(bob().collection(`rooms/${GONE}/map`).get());
  await assertSucceeds(alice().collection(`rooms/${GONE}/map`).get());
});

test("SEC-1: roomSecrets, where the Clássico answers are, is closed to its own players", async () => {
  await assertFails(alice().doc(`roomSecrets/${ROOM}`).get());
  await assertFails(bob().doc(`roomSecrets/${ROOM}`).get());
  await assertFails(alice().collection("roomSecrets").get());
});

test("SEC-6: no client writes anything in a room, its host included", async () => {
  await assertFails(alice().doc(`rooms/${ROOM}`).update({ state: "finished" }));
  await assertFails(alice().doc(`rooms/${ROOM}`).set({ playerUids: [ALICE, CAROL] }));
  await assertFails(carol().doc(`rooms/${ROOM}`).update({ playerUids: [ALICE, BOB, CAROL] }));
  await assertFails(alice().doc("rooms/NEWROOM234567890").set({ playerUids: [ALICE] }));
  await assertFails(bob().doc(`rooms/${ROOM}/map/AR`).set({ code: "AR", by: BOB, points: 10 }));
  await assertFails(bob().doc(`rooms/${ROOM}/prompts/0`).update({ reveal: { code: "PE" } }));
  await assertFails(alice().doc(`roomSecrets/${ROOM}`).set({ items: [] }));
  await assertFails(alice().doc(`rooms/${ROOM}`).delete());
});

// --- FR-15: Fronteiras --------------------------------------------------------

const FRONT = "FRONTABCDEFGHJKL"; // alice and bob are playing; carol is not in it

test("FR-15, D-87: Fronteiras players read their room and its board; outsiders, lists and writes are refused", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`rooms/${FRONT}`).set({ mode: "fronteiras", hostUid: null, state: "playing", playerUids: [ALICE, BOB], players: {}, queue: null, fronteiras: { continent: "Europe", values: { PT: 3, ES: 5 } } });
    await db.doc(`rooms/${FRONT}/map/_board`).set({ viewBox: "0 0 1 1", paths: { PT: { d: "M0 0Z" } }, adj: { PT: ["ES"], ES: ["PT"] }, labels: {} });
  });
  await assertSucceeds(alice().doc(`rooms/${FRONT}`).get());
  await assertSucceeds(bob().doc(`rooms/${FRONT}/map/_board`).get());
  await assertSucceeds(bob().collection(`rooms/${FRONT}/map`).get());
  await assertFails(carol().doc(`rooms/${FRONT}`).get());
  await assertFails(carol().doc(`rooms/${FRONT}/map/_board`).get());
  await assertFails(anon().doc(`rooms/${FRONT}/map/_board`).get());
  await assertFails(alice().collection("rooms").where("queue.open", "==", true).get());
  await assertFails(alice().doc(`rooms/${FRONT}`).update({ "fronteiras.values.PT": 5 }));
  await assertFails(alice().doc(`rooms/${FRONT}/map/_board`).set({ adj: {} }));
  await assertFails(carol().doc("rooms/FRONTNEWROOM2345").set({ mode: "fronteiras", playerUids: [CAROL], queue: { open: true } }));
});

test("FR-15.7, D-110: a player cannot write their own rating or Fronteiras room", async () => {
  await assertFails(alice().doc(`users/${ALICE}`).update({ fronteiras: { rating: 3000, rd: 30, vol: 0.06, settled: true } }));
  await assertFails(alice().doc(`users/${ALICE}`).update({ "fronteiras.rating": 3000 }));
  await assertFails(alice().doc(`users/${ALICE}`).update({ fronteirasRoom: FRONT }));
  await assertFails(alice().doc(`users/${ALICE}`).update({ displayName: "alice-um", fronteirasRoom: FRONT }));
  await assertFails(bob().doc(`users/${ALICE}`).update({ fronteiras: null }));
});

// --- default deny -----------------------------------------------------------

test("anything not listed is denied", async () => {
  await assertFails(alice().doc("groups/unknownGroup000000001").get());
  await assertFails(alice().doc("inviteCodes/ABCD2345").get()); // §3.8 collection was never created
  await assertFails(alice().doc("anything/at-all").set({ a: 1 }));
  assert.ok(true);
});
