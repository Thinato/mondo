/**
 * Phase 2 end-to-end against the emulators (D-33): invite-only play, groups,
 * boards, admin, jobs, deletion. `npm run test:e2e` builds, starts
 * Functions + Firestore + Auth under demo-mondo and runs this file.
 *
 * Every check asserts both the callable response and the Firestore state.
 * Tests share state and run in order (node:test runs one file serially).
 */

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { healthCheckNow, sweepExpiredInvites } from "../../src/health";
import { opensAt, puzzleIdAt } from "../../src/lib/puzzle-day";
import { gdpFor } from "../../src/lib/countries";
import { previousDay } from "../../src/lib/round";
import { rebuildStandingsNow } from "../../src/standings";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
initializeApp({ projectId: "demo-mondo" });
const db = getFirestore();

const FUNCTIONS = "http://127.0.0.1:5001/demo-mondo/southamerica-east1";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const TODAY = puzzleIdAt(new Date());
const YESTERDAY = previousDay(TODAY);

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
  const token: string = r.idToken;
  return { uid: r.localId, token, call: (fn, data = {}) => post(fn, data, token) };
}

const code = (r: Res) => r.error?.details?.code ?? r.error?.status ?? null;
const ok = (r: Res, what: string) => { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.error)}`); return r.result; };

/** Creates the profile (getRound fails not-invited for a fresh player) then sets the role. */
async function withRole(label: string, role: "admin" | "organizer"): Promise<Account> {
  const a = await newAccount(label);
  await a.call("getRound", {});
  await db.doc(`users/${a.uid}`).update({ role });
  return a;
}

async function play(a: Account, guesses: (string | number)[]): Promise<Res> {
  let r = await a.call("getRound", {});
  for (const g of guesses) {
    await sleep(450);
    // `code` rather than `guess`, on purpose: this is the field an older cached
    // client sends, and D-53 kept accepting it (src/round.ts).
    r = await a.call("submitGuess", { puzzleId: TODAY, code: g });
  }
  return r;
}

const doc = async (path: string) => (await db.doc(path).get()).data() as Any;
const exists = async (path: string) => (await db.doc(path).get()).exists;

function seedFinishedAttempt(uid: string, puzzleId: string, guessCodes: string[], points: number) {
  const start = Timestamp.fromDate(opensAt(puzzleId));
  const at = (i: number) => Timestamp.fromMillis(start.toMillis() + (i + 1) * 5_000);
  return db.doc(`attempts/${uid}_${puzzleId}`).set({
    uid, puzzleId, startedAt: start, finishedAt: at(guessCodes.length - 1),
    guesses: guessCodes.map((c, i) => ({ code: c, distanceKm: i === guessCodes.length - 1 ? 0 : 1000, bearingDeg: 0, proximity: 0.95, at: at(i) })),
    guessCount: guessCodes.length, solved: points > 0, points, elapsedMs: guessCodes.length * 5_000, mode: "daily", suspicious: false,
  });
}

// ---------------------------------------------------------------------------

let organizer: Account, player: Account, third: Account, admin: Account;
let gid: string;

before(async () => {
  // Today is a D-52 day: one challenge of each kind. Yesterday is deliberately
  // left in the pre-D-52 shape, so the compatibility path is exercised rather
  // than asserted about.
  await db.doc(`puzzles/${TODAY}`).set({
    puzzleId: TODAY,
    items: [{ kind: "shape", subject: "PY" }, { kind: "flag", subject: "BR" }, { kind: "capital", subject: "IT" }, { kind: "gdp", subject: "JP" }],
    opensAt: Timestamp.fromDate(opensAt(TODAY)),
  });
  await db.doc(`puzzles/${YESTERDAY}`).set({ puzzleId: YESTERDAY, countryCode: "AR", tier: 1, opensAt: Timestamp.fromDate(opensAt(YESTERDAY)) });
  organizer = await withRole("org", "organizer");
  player = await newAccount("player");
  third = await newAccount("third");
  await third.call("getRound", {}); // profile exists, still uninvited
});

test("1. FR-1.7: a fresh player is not invited — profile exists, no attempt is created", async () => {
  const r = await player.call("getRound", {});
  assert.equal(code(r), "not-invited");
  assert.equal(await exists(`users/${player.uid}`), true);
  assert.equal(await exists(`attempts/${player.uid}_${TODAY}`), false);
  const g = await player.call("submitGuess", { puzzleId: TODAY, code: "PY" });
  assert.ok(["not-invited", "not-found"].includes(code(g)), `submitGuess for an outsider: ${code(g)}`);
});

test("2. FR-4.1: organizer creates a group; a player cannot", async () => {
  const r = ok(await organizer.call("createGroup", { name: "Almoço" }), "createGroup");
  gid = r.groupId;
  assert.match(gid, /^[A-Za-z0-9]{20}$/);
  const g = await doc(`groups/${gid}`);
  assert.equal(g.ownerUid, organizer.uid);
  assert.equal(g.memberCount, 1);
  const m = await doc(`groups/${gid}/members/${organizer.uid}`);
  assert.equal(m.role, "owner");
  assert.deepEqual((await doc(`users/${organizer.uid}`)).groups, [gid]);

  const denied = await player.call("createGroup", { name: "Meu grupo" });
  assert.equal(code(denied), "permission-denied");
  assert.equal(code(await organizer.call("createGroup", { name: "ab" })), "invalid-argument");
});

test("3. FR-4.3: invite link → accept → the player can play", async () => {
  // Yesterday's result exists before the join so the backfill and the nightly job agree.
  await seedFinishedAttempt(player.uid, YESTERDAY, ["BR", "AR"], 5);

  const inv = ok(await organizer.call("createInvite", { groupId: gid }), "createInvite");
  assert.match(inv.token, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/);
  assert.ok(inv.url.endsWith(`grupos.html?convite=${inv.token}`));
  assert.equal(code(await player.call("createInvite", { groupId: gid })), "permission-denied");

  const acc = ok(await player.call("acceptInvite", { token: inv.token.toLowerCase() }), "acceptInvite");
  assert.deepEqual(acc, { groupId: gid, name: "Almoço" });
  const m = await doc(`groups/${gid}/members/${player.uid}`);
  assert.equal(m.role, "member");
  assert.equal(m.allTime.points, 5, "backfill picked up yesterday");
  assert.equal(m.last30.points, 5);
  assert.equal(m.allTimeThrough, YESTERDAY);
  assert.equal((await doc(`groups/${gid}`)).memberCount, 2);
  assert.equal((await doc(`invites/${inv.token}`)).usedBy, player.uid);
  assert.deepEqual((await doc(`users/${player.uid}`)).groups, [gid]);

  const round = ok(await player.call("getRound", {}), "getRound after invite");
  assert.equal(round.status, "in_progress");
  assert.deepEqual(round.me, { displayName: (await doc(`users/${player.uid}`)).displayName, role: "player", groupCount: 1 });
  assert.equal(round.itemCount, 4, "D-52/D-53: a day is one challenge of every kind");
  const jp = gdpFor("JP")!;
  const done = ok(await play(player, ["PY", "BR", "IT", jp]), "solve the day");
  assert.equal(done.status, "solved");
  assert.equal(done.points, 24);
  assert.equal(done.maxPoints, 24);
  assert.deepEqual(done.items.map((i: Any) => i.answer.name), ["Paraguai", "Brasil", "Itália", `Japão: ${jp.toLocaleString("pt-BR")}`]);

  const list = ok(await player.call("listGroups", {}), "listGroups");
  assert.deepEqual(list.groups, [{ groupId: gid, name: "Almoço", memberCount: 2, isOwner: false }]);
});

test("4. D-32: tokens are single-use, revocable, expiring, and race-safe", async () => {
  const used = (await db.collection("invites").where("usedBy", "==", player.uid).get()).docs[0]!.id;
  assert.equal(code(await third.call("acceptInvite", { token: used })), "invalid-invite");

  const rev = ok(await organizer.call("createInvite", { groupId: gid }), "createInvite");
  assert.equal(ok(await organizer.call("listInvites", { groupId: gid }), "listInvites").invites.map((i: Any) => i.token).includes(rev.token), true);
  assert.equal(code(await player.call("revokeInvite", { token: rev.token })), "permission-denied");
  ok(await organizer.call("revokeInvite", { token: rev.token }), "revokeInvite");
  assert.notEqual((await doc(`invites/${rev.token}`)).revokedAt, null);
  assert.equal(code(await third.call("acceptInvite", { token: rev.token })), "invalid-invite");
  assert.equal(ok(await organizer.call("listInvites", { groupId: gid }), "listInvites").invites.some((i: Any) => i.token === rev.token), false);

  // finding 8: a group cannot hold unlimited pending invites
  const g3 = ok(await organizer.call("createGroup", { name: "Cap" }), "createGroup").groupId;
  const minted = [];
  for (let i = 0; i < 20; i++) minted.push(ok(await organizer.call("createInvite", { groupId: g3 }), `mint ${i}`).token);
  assert.equal(code(await organizer.call("createInvite", { groupId: g3 })), "invalid-argument", "21st invite refused");
  ok(await organizer.call("revokeInvite", { token: minted[0]! }), "revoke one");
  ok(await organizer.call("createInvite", { groupId: g3 }), "and now one fits");
  ok(await organizer.call("leaveGroup", { groupId: g3 }), "dissolve the cap group");

  const expired = "EXPRED2EXPRED2XX"; // alphabet has no I
  await db.doc(`invites/${expired}`).set({
    groupId: gid, groupName: "Almoço", createdBy: organizer.uid, createdAt: Timestamp.fromMillis(Date.now() - 8 * 86_400_000),
    expiresAt: Timestamp.fromMillis(Date.now() - 86_400_000), usedBy: null, usedAt: null, revokedAt: null,
  });
  assert.equal(code(await third.call("acceptInvite", { token: expired })), "invalid-invite");
  assert.equal(code(await third.call("acceptInvite", { token: "ZZZZZZZZZZZZZZZZ" })), "invalid-invite");
  assert.equal(code(await third.call("acceptInvite", { token: "short" })), "invalid-argument");

  // A member who opens a forwarded link is sent to the board, and the token
  // survives for whoever it was meant for (finding 5).
  const spare = ok(await organizer.call("createInvite", { groupId: gid }), "createInvite");
  ok(await player.call("acceptInvite", { token: spare.token }), "member re-accepts");
  assert.equal((await doc(`invites/${spare.token}`)).usedBy, null, "an existing member does not consume the token");
  const meant = await newAccount("meant");
  ok(await meant.call("acceptInvite", { token: spare.token }), "the token still works for its intended holder");
  ok(await meant.call("leaveGroup", { groupId: gid }), "tidy up");

  const race = ok(await organizer.call("createInvite", { groupId: gid }), "createInvite");
  const [a, b] = await Promise.all([newAccount("raceA"), newAccount("raceB")]);
  const results = await Promise.all([a.call("acceptInvite", { token: race.token }), b.call("acceptInvite", { token: race.token })]);
  const winners = results.filter((r) => r.status === 200);
  assert.equal(winners.length, 1, JSON.stringify(results.map(code)));
  assert.equal(code(results.find((r) => r.status !== 200)!), "invalid-invite");
  assert.equal((await doc(`groups/${gid}`)).memberCount, 3);
});

test("5. FR-4.10 / FR-4.11: the board is members-only and hides today's scores until you finish", async () => {
  assert.equal(code(await third.call("getLeaderboard", { groupId: gid })), "permission-denied");

  ok(await organizer.call("getRound", {}), "organizer starts today");
  const before = ok(await organizer.call("getLeaderboard", { groupId: gid }), "getLeaderboard unfinished");
  assert.equal(before.today.viewerFinished, false);
  assert.equal(before.today.puzzleId, TODAY);
  assert.equal(before.closedThrough, YESTERDAY);
  const states = Object.fromEntries(before.today.players.map((p: Any) => [p.uid, p]));
  assert.equal(states[player.uid].state, "finished");
  assert.equal(states[organizer.uid].state, "in_progress");
  assert.ok(before.today.players.every((p: Any) => p.points === null && p.guessCount === null));
  const json = JSON.stringify(before);
  for (const needle of ["Paraguai", "Brasil", "Itália", "countryCode", "subject", '"code"', "@"]) assert.ok(!json.includes(needle), needle);
  assert.equal(before.group.isOwner, true);
  assert.equal(before.group.memberCount, 3);

  // A ratio guess: half the real figure is wrong, then the figure itself.
  const jp = gdpFor("JP")!;
  const solved = ok(await play(organizer, ["AR", "PY", "BR", "IT", Math.round(jp / 2), jp]), "organizer solves");
  assert.equal(solved.status, "solved");
  assert.equal(solved.points, 21, "5 + 6 + 6 + 4");
  const after = ok(await organizer.call("getLeaderboard", { groupId: gid }), "getLeaderboard finished");
  assert.equal(after.today.viewerFinished, true);
  const p = after.today.players.find((x: Any) => x.uid === player.uid);
  assert.deepEqual([p.state, p.points, p.guessCount], ["finished", 24, 4]);
  const me = after.rows.find((r: Any) => r.uid === organizer.uid);
  assert.equal(me.isMe, true);
  for (const w of ["allTime", "last7", "last30"]) assert.equal(typeof me[w].rank, "number");
  // Backfilled yesterday puts the player first in every window; the organizer has nothing yet.
  assert.equal(after.rows.find((r: Any) => r.uid === player.uid).last30.rank, 1);
  assert.equal(me.last30.rank, 2);

  const viewByPlayer = ok(await player.call("getLeaderboard", { groupId: gid }), "member view");
  assert.equal(viewByPlayer.group.isOwner, false);
});

test("6. FR-7.2: admin dashboard callables, gates, retry", async () => {
  admin = await withRole("admin", "admin");

  const users = ok(await admin.call("listUsers", {}), "listUsers");
  assert.ok(users.users.length >= 4);
  assert.ok(!JSON.stringify(users).includes("@"), "no e-mail leaves listUsers (FR-1.4)");
  assert.equal(users.users.find((u: Any) => u.uid === organizer.uid).role, "organizer");
  assert.equal(users.users.find((u: Any) => u.uid === player.uid).groupCount, 1);

  const groups = ok(await admin.call("listAllGroups", {}), "listAllGroups");
  const g = groups.groups.find((x: Any) => x.groupId === gid);
  assert.equal(g.ownerUid, organizer.uid);
  assert.equal(g.memberCount, 3);
  assert.equal(ok(await admin.call("getLeaderboard", { groupId: gid }), "admin reads any board").group.isOwner, false);

  const today = ok(await admin.call("listAttempts", { puzzleId: TODAY }), "listAttempts today");
  assert.ok(today.attempts.length >= 2);
  for (const a of today.attempts) {
    assert.equal("guesses" in a, false, "D-31: today's guesses hidden until the admin plays");
    assert.equal(a.points, null, "D-31: today's outcome hidden until the admin plays");
    assert.equal(a.solved, null);
    assert.equal(a.suspicious, null, "suspicious is only set on a solve, so it would leak the outcome");
    assert.ok(Array.isArray(a.intervalsMs));
    assert.equal(typeof a.displayName, "string");
  }
  const yesterday = ok(await admin.call("listAttempts", { puzzleId: YESTERDAY }), "listAttempts yesterday");
  const seeded = yesterday.attempts.find((a: Any) => a.uid === player.uid);
  assert.equal(seeded.points, 5, "a closed day carries its outcome");
  assert.equal(seeded.solved, true);
  assert.deepEqual(seeded.guesses.map((x: Any) => x.code), ["BR", "AR"]);
  assert.equal(seeded.guesses[1].name, "Argentina");
  assert.deepEqual(seeded.intervalsMs, [5000, 5000]);
  const byUid = ok(await admin.call("listAttempts", { uid: player.uid }), "listAttempts by uid");
  assert.deepEqual(byUid.attempts.map((a: Any) => a.puzzleId).sort(), [YESTERDAY, TODAY].sort());
  assert.equal(code(await admin.call("listAttempts", {})), "invalid-argument");
  assert.equal(code(await admin.call("listAttempts", { uid: player.uid, puzzleId: TODAY })), "invalid-argument");

  for (const fn of ["listUsers", "listAllGroups"]) assert.equal(code(await organizer.call(fn, {})), "permission-denied", fn);
  assert.equal(code(await organizer.call("setRole", { uid: player.uid, role: "organizer" })), "permission-denied");
  assert.equal(code(await player.call("grantRetry", { uid: player.uid, puzzleId: TODAY })), "permission-denied");
  assert.equal(code(await admin.call("setRole", { uid: player.uid, role: "admin" })), "invalid-argument");
  assert.equal(code(await admin.call("setRole", { uid: admin.uid, role: "player" })), "invalid-argument");
  // FR-7.6: an admin is not demotable through the API either, only by tools/set-role.mjs.
  await db.doc(`users/${third.uid}`).update({ role: "admin" });
  assert.equal(code(await admin.call("setRole", { uid: third.uid, role: "player" })), "invalid-argument", "admin cannot demote an admin");
  await db.doc(`users/${third.uid}`).update({ role: "player" });
  assert.equal(code(await admin.call("setRole", { uid: "nobodyHere000000000000000001", role: "player" })), "not-found");
  ok(await admin.call("setRole", { uid: third.uid, role: "organizer" }), "setRole");
  assert.equal((await doc(`users/${third.uid}`)).role, "organizer");
  ok(await admin.call("setRole", { uid: third.uid, role: "player" }), "setRole back");

  assert.equal(code(await admin.call("grantRetry", { uid: player.uid, puzzleId: YESTERDAY })), "puzzle-not-open");
  assert.equal(code(await admin.call("grantRetry", { uid: admin.uid, puzzleId: TODAY })), "invalid-argument", "no self-granted retry");
  assert.equal(code(await admin.call("grantRetry", { uid: third.uid, puzzleId: TODAY })), "not-found");
  ok(await admin.call("grantRetry", { uid: player.uid, puzzleId: TODAY }), "grantRetry");
  const fresh = ok(await player.call("getRound", {}), "getRound after retry");
  assert.equal(fresh.guessesUsed, 0);
  assert.equal(fresh.status, "in_progress");
  const a = await doc(`attempts/${player.uid}_${TODAY}`);
  assert.equal(a.retries, 1);
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].points, 24, "the whole day it replaced is on the record");
  assert.equal(a.history[0].items.length, 4);
  assert.equal(a.cursor, 0, "a retry starts at the first challenge again");
  assert.equal(a.history[0].retryGrantedBy, admin.uid);
  // The whole day again: silhouette on the second guess, then the rest first time.
  const again = ok(await play(player, ["BR", "PY", "BR", "IT", gdpFor("JP")!]), "replay");
  assert.equal(again.points, 23, "5 + 6 + 6 + 6");
  const prof = await doc(`users/${player.uid}`);
  assert.equal(prof.totalPlayed, 1, "D-30: a retried day is counted once");
  assert.equal(prof.totalSolved, 1);
});

test("7. D-11 / D-25: rebuildStandings is consistent with the attempts and idempotent; health check runs", async () => {
  // Scheduled functions are Pub/Sub triggers in the emulator, so the job bodies
  // run in-process here against the same emulated Firestore.
  const run1 = await rebuildStandingsNow(Timestamp.now());
  assert.ok(run1.groups >= 1 && run1.members >= 3, JSON.stringify(run1));
  const strip = (m: Any) => { const { updatedAt, ...rest } = m; void updatedAt; return JSON.stringify(rest); };
  const p1 = await doc(`groups/${gid}/members/${player.uid}`);
  assert.equal(p1.last30.points, 5);
  assert.equal(p1.last30.played, 1);
  assert.equal(p1.last30.avgGuesses, 2);
  assert.equal(p1.last7.points, 5);
  assert.equal(p1.allTime.points, 5);
  assert.equal(p1.allTime.played, 1);
  assert.equal(p1.allTimeThrough, YESTERDAY);
  assert.equal(p1.currentStreak, 1, "played today → streak stands");
  const o1 = await doc(`groups/${gid}/members/${organizer.uid}`);
  assert.equal(o1.last30.points, 0);
  assert.equal(o1.last30.avgGuesses, null);

  const run2 = await rebuildStandingsNow(Timestamp.now());
  assert.deepEqual(run2, run1);
  assert.equal(strip(await doc(`groups/${gid}/members/${player.uid}`)), strip(p1));
  assert.equal(strip(await doc(`groups/${gid}/members/${organizer.uid}`)), strip(o1));

  assert.equal(await healthCheckNow(Timestamp.now()), 1, "only today's puzzle is ahead → SCHEDULE_LOW logged");
});

test("8. D-23: owner succession and dissolution", async () => {
  const owner = await withRole("owner2", "organizer");
  const member = await newAccount("member2");
  const g2 = ok(await owner.call("createGroup", { name: "Família" }), "createGroup").groupId;
  const inv = ok(await owner.call("createInvite", { groupId: g2 }), "createInvite");
  ok(await member.call("acceptInvite", { token: inv.token }), "acceptInvite");
  assert.equal(code(await member.call("removeMember", { groupId: g2, uid: owner.uid })), "permission-denied");
  assert.equal(code(await owner.call("removeMember", { groupId: g2, uid: owner.uid })), "invalid-argument");

  ok(await owner.call("leaveGroup", { groupId: g2 }), "owner leaves");
  assert.equal((await doc(`groups/${g2}`)).ownerUid, member.uid);
  assert.equal((await doc(`groups/${g2}`)).memberCount, 1);
  assert.equal((await doc(`groups/${g2}/members/${member.uid}`)).role, "owner");
  assert.equal(await exists(`groups/${g2}/members/${owner.uid}`), false);
  assert.equal((await doc(`users/${member.uid}`)).role, "player", "no global role is granted: ownership carries the rights (FR-7.5)");
  assert.equal(code(await member.call("createGroup", { name: "Outro" })), "permission-denied", "owning a group does not unlock creating them (FR-4.1)");
  assert.deepEqual((await doc(`users/${owner.uid}`)).groups, []);
  assert.equal(code(await owner.call("leaveGroup", { groupId: g2 })), "not-found");

  ok(await member.call("renameGroup", { groupId: g2, name: "Família Nova" }), "new owner renames despite being a player");
  const pending = ok(await member.call("createInvite", { groupId: g2 }), "new owner invites");
  ok(await member.call("leaveGroup", { groupId: g2 }), "last member leaves");
  assert.equal(await exists(`groups/${g2}`), false);
  assert.equal(await exists(`invites/${pending.token}`), false, "pending invites go with the group");
  assert.deepEqual((await doc(`users/${member.uid}`)).groups, []);
});

test("8b. finding 6: expired invites are swept and deletion takes the uid with it", async () => {
  const stale = "SWEEPME2SWEEPME2";
  await db.doc(`invites/${stale}`).set({
    groupId: gid, groupName: "Almoço", createdBy: organizer.uid, createdAt: Timestamp.fromMillis(Date.now() - 9 * 86_400_000),
    expiresAt: Timestamp.fromMillis(Date.now() - 2 * 86_400_000), usedBy: null, usedAt: null, revokedAt: null,
  });
  assert.ok(await sweepExpiredInvites(Timestamp.now()) >= 1);
  assert.equal(await exists(`invites/${stale}`), false);
  assert.equal((await db.collection("invites").where("expiresAt", "<", Timestamp.now()).get()).empty, true);
});

test("9. FR-1.5: deleteAccount removes the user everywhere and hands the group over", async () => {
  const owner = await withRole("owner3", "organizer");
  const other = await newAccount("member3");
  const g3 = ok(await owner.call("createGroup", { name: "Escritório" }), "createGroup").groupId;
  ok(await other.call("acceptInvite", { token: ok(await owner.call("createInvite", { groupId: g3 }), "inv").token }), "join");
  const pending = ok(await owner.call("createInvite", { groupId: g3 }), "pending invite");
  ok(await play(owner, ["AR"]), "owner starts today");
  assert.equal(await exists(`attempts/${owner.uid}_${TODAY}`), true);

  ok(await owner.call("deleteAccount", {}), "deleteAccount");
  assert.equal(await exists(`users/${owner.uid}`), false);
  assert.equal((await db.collection("attempts").where("uid", "==", owner.uid).get()).size, 0);
  assert.equal(await exists(`groups/${g3}/members/${owner.uid}`), false);
  assert.equal((await doc(`groups/${g3}`)).ownerUid, other.uid);
  assert.equal((await doc(`groups/${g3}`)).memberCount, 1);
  // finding 6: invites naming the deleted user go with them, in either field.
  assert.equal(await exists(`invites/${pending.token}`), false, "their pending invite is gone, not just revoked");
  assert.equal((await db.collection("invites").where("createdBy", "==", owner.uid).get()).size, 0);
  assert.equal((await db.collection("invites").where("usedBy", "==", owner.uid).get()).size, 0);
  const lookup = await fetch(`${AUTH}/accounts:lookup?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: owner.token }),
  });
  assert.ok(!lookup.ok || ((await lookup.json()) as Any).users === undefined, "Auth record gone");
});
