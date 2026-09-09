/**
 * Groups (FR-4 as amended): create, invite by single-use link, accept, leave,
 * remove, rename, list. Every mutation is one Firestore transaction that reads
 * everything first and writes last. Rules in lib/groups.ts, lib/invite.ts,
 * lib/authz.ts; this file is I/O.
 */

import { Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import {
  attemptRef, db, ensureProfile, groupRef, groupsCol, inviteRef, memberRef, membersCol, pendingInvitesOf, puzzleDays, userRef,
} from "./db";
import { canCreateGroup, groupsOf, requireOwner, roleOf } from "./lib/authz";
import { callable } from "./lib/callable";
import { GAME_URL } from "./lib/config";
import { mondoError } from "./lib/errors";
import {
  backfillStats, DEFAULT_MAX_MEMBERS, MAX_GROUPS_PER_USER, newMember, nextOwner, resultOf, WINDOW_30,
  type Group, type Member,
} from "./lib/groups";
import { inviteState, inviteToken, newInvite, type Invite } from "./lib/invite";
import type { Attempt, Profile } from "./lib/round";
import { effectiveStreak, windowDays, type FinishedResult } from "./lib/standings";
import { requireGroupId, requireGroupName, requireInviteToken, requireObject, requireUid } from "./lib/validate";

// ---------------------------------------------------------------------------
// Shared transaction pieces
// ---------------------------------------------------------------------------

/** The caller's finished rounds over the last 30 closed days (§4 "backfill"). 30 reads. */
async function backfillResults(tx: Transaction, uid: string, closedDay: string): Promise<FinishedResult[]> {
  const snaps = await tx.getAll(...windowDays(closedDay, WINDOW_30).map((d) => attemptRef(uid, d)));
  return snaps.flatMap((s) => {
    const r = s.exists ? resultOf(s.data() as Attempt) : null;
    return r ? [r] : [];
  });
}

async function loadGroup(tx: Transaction, gid: string): Promise<Group> {
  const snap = await tx.get(groupRef(gid));
  if (!snap.exists) throw mondoError("not-found", "No such group.");
  return snap.data() as Group;
}

/**
 * Remove `uid` from `gid`, transferring or dissolving ownership (D-23). Shared
 * by leaveGroup, removeMember and deleteAccount. Reads everything it might
 * need before its first write; callers must not have written yet either.
 */
export async function leaveTx(tx: Transaction, gid: string, uid: string): Promise<void> {
  const [groupSnap, memberSnap, profileSnap] = await Promise.all([
    tx.get(groupRef(gid)), tx.get(memberRef(gid, uid)), tx.get(userRef(uid)),
  ]);
  if (!memberSnap.exists) throw mondoError("not-found", "Not a member of this group.");
  const group = groupSnap.exists ? (groupSnap.data() as Group) : null;

  let successor: { uid: string; promote: boolean } | null = null;
  let dissolve = false;
  let pendingInvites: DocumentSnapshot[] = [];
  if (group && group.ownerUid === uid) {
    const others = (await tx.get(membersCol(gid))).docs.filter((d) => d.id !== uid);
    if (others.length === 0) {
      dissolve = true;
      pendingInvites = (await tx.get(pendingInvitesOf(gid))).docs;
    } else {
      const profiles = await tx.getAll(...others.map((d) => userRef(d.id)));
      successor = nextOwner(others.map((d, i) => ({
        uid: d.id,
        joinedAt: (d.data() as Member).joinedAt,
        userRole: roleOf(profiles[i]?.exists ? (profiles[i]!.data() as Profile) : null),
      })));
    }
  }

  // --- writes ---
  tx.delete(memberRef(gid, uid));
  if (profileSnap.exists) {
    tx.update(userRef(uid), { groups: groupsOf(profileSnap.data() as Profile).filter((g) => g !== gid) });
  }
  if (!group) return;
  if (dissolve) {
    tx.delete(groupRef(gid));
    for (const inv of pendingInvites) tx.delete(inv.ref);
    return;
  }
  const patch: Partial<Group> = { memberCount: Math.max(0, group.memberCount - 1) };
  if (successor) {
    patch.ownerUid = successor.uid;
    tx.update(memberRef(gid, successor.uid), { role: "owner" });
    if (successor.promote) tx.update(userRef(successor.uid), { role: "organizer" });
  }
  tx.update(groupRef(gid), patch);
}

// ---------------------------------------------------------------------------
// Callables
// ---------------------------------------------------------------------------

/** createGroup({ name }) → { groupId }. Admin/organizer only (FR-4.1 as amended). */
export const createGroup = callable<{ name: unknown }, { groupId: string }>(async (uid, data) => {
  const name = requireGroupName(requireObject(data).name);
  const now = Timestamp.now();
  const { today, closedDay } = puzzleDays(now);
  const gid = groupsCol().doc().id;

  await db().runTransaction(async (tx) => {
    // ensureProfile may write, so every read — the backfill included — comes first.
    const results = await backfillResults(tx, uid, closedDay);
    const profile = await ensureProfile(tx, uid, now);
    if (!canCreateGroup(profile)) throw mondoError("permission-denied", "Only organizers and admins create groups.");
    const groups = groupsOf(profile);
    if (groups.length >= MAX_GROUPS_PER_USER) throw mondoError("too-many-groups", `At most ${MAX_GROUPS_PER_USER} groups per player.`);

    const group: Group = { name, ownerUid: uid, memberCount: 1, maxMembers: DEFAULT_MAX_MEMBERS, createdAt: now };
    tx.create(groupRef(gid), group);
    tx.create(memberRef(gid, uid), newMember(uid, profile.displayName, "owner", now, backfillStats(results, closedDay), effectiveStreak(profile, closedDay, today)));
    tx.set(userRef(uid), { ...profile, groups: [...groups, gid] });
  });
  return { groupId: gid };
});

/** createInvite({ groupId }) → { token, url, expiresAt }. Owner only. */
export const createInvite = callable<{ groupId: unknown }, { token: string; url: string; expiresAt: string }>(async (uid, data) => {
  const gid = requireGroupId(requireObject(data).groupId);
  const now = Timestamp.now();
  const snap = await groupRef(gid).get();
  if (!snap.exists) throw mondoError("not-found", "No such group.");
  const group = snap.data() as Group;
  requireOwner(group, uid);

  // 32^16 tokens: a collision is not expected in the lifetime of the project,
  // but create() refuses to overwrite one if it ever happens, so try again once.
  for (let attempt = 0; ; attempt++) {
    const token = inviteToken();
    const invite = newInvite(gid, group.name, uid, now);
    try {
      await inviteRef(token).create(invite);
      return { token, url: `${GAME_URL}grupos.html?convite=${token}`, expiresAt: invite.expiresAt.toDate().toISOString() };
    } catch (e) {
      if (attempt >= 1) throw e;
    }
  }
});

/** listInvites({ groupId }) → pending invites, newest first. Owner only. */
export const listInvites = callable<{ groupId: unknown }, { invites: { token: string; url: string; createdAt: string; expiresAt: string }[] }>(async (uid, data) => {
  const gid = requireGroupId(requireObject(data).groupId);
  const now = Timestamp.now();
  const snap = await groupRef(gid).get();
  if (!snap.exists) throw mondoError("not-found", "No such group.");
  requireOwner(snap.data() as Group, uid);

  const docs = (await pendingInvitesOf(gid).get()).docs;
  const invites = docs
    .map((d) => ({ token: d.id, ...(d.data() as Invite) }))
    .filter((i) => inviteState(i, now) === "pending")
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
    .map((i) => ({
      token: i.token,
      url: `${GAME_URL}grupos.html?convite=${i.token}`,
      createdAt: i.createdAt.toDate().toISOString(),
      expiresAt: i.expiresAt.toDate().toISOString(),
    }));
  return { invites };
});

/** revokeInvite({ token }). Owner of the invite's group. Idempotent. */
export const revokeInvite = callable<{ token: unknown }, { ok: true }>(async (uid, data) => {
  const token = requireInviteToken(requireObject(data).token);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(inviteRef(token));
    if (!snap.exists) throw mondoError("invalid-invite", "No such invite.");
    const invite = snap.data() as Invite;
    const group = await loadGroup(tx, invite.groupId);
    requireOwner(group, uid);
    if (inviteState(invite, now) === "pending") tx.update(inviteRef(token), { revokedAt: now });
  });
  return { ok: true };
});

/**
 * acceptInvite({ token }) → { groupId, name }. The single write path into a
 * group, and what unlocks play (D-28). Consumes the token (FR-4.3 as amended).
 */
export const acceptInvite = callable<{ token: unknown }, { groupId: string; name: string }>(async (uid, data) => {
  const token = requireInviteToken(requireObject(data).token);
  const now = Timestamp.now();
  const { today, closedDay } = puzzleDays(now);

  return db().runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef(token));
    if (!inviteSnap.exists) throw mondoError("invalid-invite", "This invite does not exist.");
    const invite = inviteSnap.data() as Invite;
    if (inviteState(invite, now) !== "pending") throw mondoError("invalid-invite", "This invite has already been used, revoked or has expired.");
    const groupSnap = await tx.get(groupRef(invite.groupId));
    if (!groupSnap.exists) throw mondoError("invalid-invite", "The group no longer exists.");
    const group = groupSnap.data() as Group;
    // ensureProfile may write (first sign-in through a link), so the backfill reads come before it.
    const results = await backfillResults(tx, uid, closedDay);
    const profile = await ensureProfile(tx, uid, now);
    const groups = groupsOf(profile);

    if (groups.includes(invite.groupId)) {
      tx.update(inviteRef(token), { usedBy: uid, usedAt: now });
      return { groupId: invite.groupId, name: group.name };
    }
    if (groups.length >= MAX_GROUPS_PER_USER) throw mondoError("too-many-groups", `At most ${MAX_GROUPS_PER_USER} groups per player.`);
    if (group.memberCount >= group.maxMembers) throw mondoError("group-full", "This group is full.");

    tx.create(memberRef(invite.groupId, uid), newMember(uid, profile.displayName, "member", now, backfillStats(results, closedDay), effectiveStreak(profile, closedDay, today)));
    tx.update(groupRef(invite.groupId), { memberCount: group.memberCount + 1 });
    tx.set(userRef(uid), { ...profile, groups: [...groups, invite.groupId] });
    tx.update(inviteRef(token), { usedBy: uid, usedAt: now });
    return { groupId: invite.groupId, name: group.name };
  });
});

/** leaveGroup({ groupId }). FR-4.9; D-23 for owners. */
export const leaveGroup = callable<{ groupId: unknown }, { ok: true }>(async (uid, data) => {
  const gid = requireGroupId(requireObject(data).groupId);
  await db().runTransaction((tx) => leaveTx(tx, gid, uid));
  return { ok: true };
});

/** removeMember({ groupId, uid }). Owner only; use leaveGroup for yourself. */
export const removeMember = callable<{ groupId: unknown; uid: unknown }, { ok: true }>(async (uid, data) => {
  const input = requireObject(data);
  const gid = requireGroupId(input.groupId);
  const target = requireUid(input.uid);
  if (target === uid) throw mondoError("invalid-argument", "Use leaveGroup to leave.");
  await db().runTransaction(async (tx) => {
    requireOwner(await loadGroup(tx, gid), uid);
    await leaveTx(tx, gid, target);
  });
  return { ok: true };
});

/** renameGroup({ groupId, name }). Owner only (FR-4.8). Pending invites keep the old name for ≤ 7 days; harmless. */
export const renameGroup = callable<{ groupId: unknown; name: unknown }, { ok: true }>(async (uid, data) => {
  const input = requireObject(data);
  const gid = requireGroupId(input.groupId);
  const name = requireGroupName(input.name);
  await db().runTransaction(async (tx) => {
    requireOwner(await loadGroup(tx, gid), uid);
    tx.update(groupRef(gid), { name });
  });
  return { ok: true };
});

/**
 * listGroups({}) → the caller's groups, plus whether they may create one, so
 * `grupos.html` can hide a form the server would refuse anyway (FR-4.1).
 */
export const listGroups = callable<unknown, { groups: { groupId: string; name: string; memberCount: number; isOwner: boolean }[]; canCreate: boolean }>(async (uid) => {
  const profileSnap = await userRef(uid).get();
  const profile = profileSnap.exists ? (profileSnap.data() as Profile) : null;
  const canCreate = canCreateGroup(profile);
  const gids = groupsOf(profile);
  if (gids.length === 0) return { groups: [], canCreate };
  const snaps = await db().getAll(...gids.map(groupRef));
  return {
    canCreate,
    groups: snaps.flatMap((s) => {
      if (!s.exists) return []; // index and group out of step; the nightly job does not fix this, leaveTx does
      const g = s.data() as Group;
      return [{ groupId: s.id, name: g.name, memberCount: g.memberCount, isOwner: g.ownerUid === uid }];
    }),
  };
});
