import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  canCreateGroup, canJoinGroup, groupsOf, isAdmin, isOwner, rankOf, requireAdmin, requireCanCreateGroup,
  requireCanJoinGroup, requireOwner, roleOf, showsAds, type Rank,
} from "../src/lib/authz";
import { newProfile, type Profile } from "../src/lib/round";

const code = (fn: () => unknown) => {
  try { fn(); return null; } catch (e) { return (e as { details: { code: string } }).details.code; }
};
const NOW = Timestamp.fromMillis(1_000_000);
const base = newProfile(NOW);
const paid = (status: string, endMs: number): Profile => ({ ...base, subscription: { status, currentPeriodEnd: Timestamp.fromMillis(endMs) } });

test("D-84: a new profile is a user; legacy roles read the way the migration writes them", () => {
  assert.equal(base.role, "user");
  assert.equal(roleOf(base), "user");
  assert.equal(roleOf({ ...base, role: "organizer" }), "invited");
  assert.equal(roleOf({ ...base, role: "player", groups: ["g"] }), "invited");
  assert.equal(roleOf({ ...base, role: "player", groups: [] }), "user");
  const phase1 = { ...base };
  delete phase1.role;
  delete phase1.groups;
  assert.equal(roleOf(phase1), "user");
  assert.deepEqual(groupsOf(phase1), []);
  assert.equal(roleOf({ ...phase1, groups: ["g"] }), "invited");
  assert.equal(roleOf(null), "user");
});

test("D-84: Invited is a closed list — a user who joins a group stays a user", () => {
  assert.equal(roleOf({ ...base, role: "user", groups: ["g1", "g2"] }), "user");
  assert.equal(rankOf({ ...base, role: "user", groups: ["g1"] }, "google.com", NOW), "user");
});

test("FR-10.1: rank from role, subscription and sign-in", () => {
  assert.equal(rankOf({ ...base, role: "admin" }, "google.com", NOW), "admin");
  assert.equal(rankOf({ ...base, role: "invited" }, "google.com", NOW), "invited");
  assert.equal(rankOf(paid("active", NOW.toMillis() + 1), "google.com", NOW), "subscriber");
  assert.equal(rankOf(paid("trialing", NOW.toMillis() + 1), "google.com", NOW), "subscriber");
  assert.equal(rankOf(base, "google.com", NOW), "user");
  assert.equal(rankOf(base, "anonymous", NOW), "guest");
  assert.equal(rankOf(null, "anonymous", NOW), "guest");
  assert.equal(rankOf(null, undefined, NOW), "user");
  // A guest whatever is stored: grants wait for the account to link Google (same uid).
  assert.equal(rankOf({ ...base, role: "invited" }, "anonymous", NOW), "guest");
  assert.equal(rankOf({ ...base, role: "admin" }, "anonymous", NOW), "guest");
  assert.equal(rankOf(paid("active", NOW.toMillis() + 1), "anonymous", NOW), "guest");
});

test("FR-11: a subscription is a date — it lapses on its own, and only paid statuses count", () => {
  assert.equal(rankOf(paid("active", NOW.toMillis()), "google.com", NOW), "user", "ends exactly now");
  assert.equal(rankOf(paid("active", NOW.toMillis() - 1000), "google.com", NOW), "user", "a second late");
  for (const s of ["past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
    assert.equal(rankOf(paid(s, NOW.toMillis() + 86_400_000), "google.com", NOW), "user", s);
  }
  // A period end that is not a Timestamp — a webhook bug — reads as no subscription rather than throwing on every screen.
  for (const end of [1_900_000_000, "2030-01-01", null, undefined, {}]) {
    const p = { ...base, subscription: { status: "active", currentPeriodEnd: end } } as unknown as Profile;
    assert.equal(rankOf(p, "google.com", NOW), "user", String(end));
  }
  // A role outranks a subscription: an invited player who also pays is still invited.
  assert.equal(rankOf({ ...paid("active", NOW.toMillis() + 1), role: "invited" }, "google.com", NOW), "invited");
});

test("FR-10: the rank × permission matrix", () => {
  const matrix: Record<Rank, { create: boolean; join: boolean; ads: boolean }> = {
    admin: { create: true, join: true, ads: false },
    invited: { create: true, join: true, ads: false },
    subscriber: { create: true, join: true, ads: false },
    user: { create: false, join: true, ads: true },
    guest: { create: false, join: false, ads: true },
  };
  for (const [rank, want] of Object.entries(matrix) as [Rank, typeof matrix[Rank]][]) {
    assert.equal(canCreateGroup(rank), want.create, `${rank} create`);
    assert.equal(canJoinGroup(rank), want.join, `${rank} join`);
    assert.equal(showsAds(rank, base), want.ads, `${rank} ads`);
    assert.equal(code(() => requireCanCreateGroup(rank)), want.create ? null : "permission-denied");
    assert.equal(code(() => requireCanJoinGroup(rank)), want.join ? null : "permission-denied");
  }
});

test("FR-10.4: an admin sees ads only by choice; nobody else's switch does anything", () => {
  assert.equal(showsAds("admin", { showAds: true }), true);
  assert.equal(showsAds("admin", { showAds: false }), false);
  assert.equal(showsAds("admin", null), false);
  assert.equal(showsAds("invited", { showAds: true }), false);
  assert.equal(showsAds("user", { showAds: false }), true);
});

test("FR-7.2: admin gate", () => {
  assert.equal(isAdmin(base), false);
  assert.equal(code(() => requireAdmin({ ...base, role: "invited" })), "permission-denied");
  assert.equal(code(() => requireAdmin({ ...base, role: "organizer" })), "permission-denied");
  assert.equal(code(() => requireAdmin({ ...base, role: "admin" })), null);
});

test("FR-7.5: management is ownership, not role", () => {
  const g = { ownerUid: "o" };
  assert.equal(isOwner(g, "o"), true);
  assert.equal(isOwner(g, "x"), false);
  assert.equal(code(() => requireOwner(g, "x")), "permission-denied");
  assert.equal(code(() => requireOwner(g, "o")), null);
});
