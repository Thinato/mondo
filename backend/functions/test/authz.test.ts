import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { canCreateGroup, canPlay, groupsOf, isAdmin, isOwner, requireAdmin, requireCanPlay, requireOwner, roleOf } from "../src/lib/authz";
import { newProfile } from "../src/lib/round";

const code = (fn: () => unknown) => {
  try { fn(); return null; } catch (e) { return (e as { details: { code: string } }).details.code; }
};
const NOW = Timestamp.fromMillis(0);

test("Phase 1 profiles without role/groups are players with no groups", () => {
  const legacy = { ...newProfile(NOW) };
  delete legacy.role;
  delete legacy.groups;
  assert.equal(roleOf(legacy), "player");
  assert.deepEqual(groupsOf(legacy), []);
  assert.equal(canPlay(legacy), false);
  assert.equal(roleOf(null), "player");
  assert.equal(canPlay(undefined), false);
});

test("D-28: play needs a group or a role above player", () => {
  const p = newProfile(NOW);
  assert.equal(canPlay(p), false);
  assert.equal(canPlay({ ...p, groups: ["g"] }), true);
  assert.equal(canPlay({ ...p, role: "organizer" }), true);
  assert.equal(canPlay({ ...p, role: "admin" }), true);
  assert.equal(code(() => requireCanPlay(p)), "not-invited");
  assert.equal(code(() => requireCanPlay({ ...p, groups: ["g"] })), null);
});

test("FR-4.1 as amended: only admin and organizer create groups", () => {
  const p = newProfile(NOW);
  assert.equal(canCreateGroup(p), false);
  assert.equal(canCreateGroup({ ...p, groups: ["g"] }), false);
  assert.equal(canCreateGroup({ ...p, role: "organizer" }), true);
  assert.equal(canCreateGroup({ ...p, role: "admin" }), true);
});

test("FR-7.2: admin gate", () => {
  const p = newProfile(NOW);
  assert.equal(isAdmin(p), false);
  assert.equal(code(() => requireAdmin({ ...p, role: "organizer" })), "permission-denied");
  assert.equal(code(() => requireAdmin({ ...p, role: "admin" })), null);
});

test("FR-7.5: management is ownership, not role", () => {
  const g = { ownerUid: "o" };
  assert.equal(isOwner(g, "o"), true);
  assert.equal(isOwner(g, "x"), false);
  assert.equal(code(() => requireOwner(g, "x")), "permission-denied");
  assert.equal(code(() => requireOwner(g, "o")), null);
});
