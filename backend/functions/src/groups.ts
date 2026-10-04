/**
 * Groups (FR-4 as amended): create, invite by link, accept, leave,
 * remove, rename, list. Every mutation is one Firestore transaction that reads
 * everything first and writes last. Rules in lib/groups.ts, lib/invite.ts,
 * lib/authz.ts; this file is I/O.
 */

import { Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import {
  attemptRef, db, ensureProfile, groupRef, groupsCol, inviteRef, memberRef, membersCol, pendingInvitesOf, puzzleDays, tournamentsOf, userRef,
} from "./db";
import { canCreateGroup, groupsOf, rankOf, requireCanCreateGroup, requireCanJoinGroup, requireOwner, roleOf, showsAds, type Rank } from "./lib/authz";
import { callable, signInProvider } from "./lib/callable";
import { GAME_URL } from "./lib/config";
import { mondoError } from "./lib/errors";
import {
  backfillStats, DEFAULT_MAX_MEMBERS, MAX_GROUPS_PER_USER, newMember, nextOwner, resultOf, WINDOW_30,
  type Group, type Member,
} from "./lib/groups";
import { inviteMode, inviteState, inviteToken, newInvite, type Invite, type InviteMode } from "./lib/invite";
import type { Attempt, Profile, Role } from "./lib/round";
import { effectiveStreak, windowDays, type FinishedResult } from "./lib/standings";
import { requireGroupId, requireGroupName, requireInviteMode, requireInviteToken, requireObject, requireUid } from "./lib/validate";

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
  const profile = profileSnap.exists ? (profileSnap.data() as Profile) : null;
  const indexed = groupsOf(profile).includes(gid);
  // A membership is the member document; the profile array is an index of it
  // (D-27). If the document is gone but the index still lists the group, this
  // heals the index rather than refusing — otherwise a phantom membership would
  // count against FR-4.4's ten forever and could never be left.
  if (!memberSnap.exists && !indexed) throw mondoError("not-found", "Not a member of this group.");
  const group = groupSnap.exists ? (groupSnap.data() as Group) : null;

  let successor: string | null = null;
  let dissolve = false;
  let pendingInvites: DocumentSnapshot[] = [];
  let liveTournaments: DocumentSnapshot[] = [];
  if (group && group.ownerUid === uid) {
    const others = (await tx.get(membersCol(gid))).docs.filter((d) => d.id !== uid);
    if (others.length === 0) {
      dissolve = true;
      pendingInvites = (await tx.get(pendingInvitesOf(gid))).docs;
      // Tournaments outlive the group document unless something cancels them
      // (docs/06-tournaments.md T-9): they are a top-level collection (D-39),
      // so Firestore would not cascade even if they were nested. Left alone,
      // the 12:05 job would keep closing rounds and generating cards for a
      // group that no longer exists, and nobody could stop it — every
      // management callable checks ownership of a group that is gone.
      liveTournaments = (await tx.get(tournamentsOf(gid))).docs
        .filter((d) => ["draft", "running"].includes((d.data() as { status: string }).status));
    } else {
      successor = nextOwner(others.map((d) => ({ uid: d.id, joinedAt: (d.data() as Member).joinedAt })));
    }
  }

  // --- writes ---
  if (memberSnap.exists) tx.delete(memberRef(gid, uid));
  // `role` is frozen beside the index on every write to it (D-84): a legacy
  // profile's rank is read off its groups until migrate-tiers runs, so leaving
  // the last one must not demote an invited player in that window.
  if (indexed) tx.update(userRef(uid), { groups: groupsOf(profile).filter((g) => g !== gid), role: roleOf(profile) });
  if (!group) return;
  if (dissolve) {
    tx.delete(groupRef(gid));
    for (const inv of pendingInvites) tx.delete(inv.ref);
    const now = Timestamp.now();
    for (const t of liveTournaments) tx.update(t.ref, { status: "cancelled", currentRound: null, endedAt: now });
    return;
  }
  const patch: Partial<Group> = { memberCount: Math.max(0, memberSnap.exists ? group.memberCount - 1 : group.memberCount) };
  if (successor) {
    // The successor owns the group; ownership alone carries the management
    // rights (FR-7.5), so no role is granted here. See nextOwner.
    patch.ownerUid = successor;
    tx.update(memberRef(gid, successor), { role: "owner" });
  }
  tx.update(groupRef(gid), patch);
}

// ---------------------------------------------------------------------------
// Callables
// ---------------------------------------------------------------------------

/** createGroup({ name }) → { groupId }. Admin, invited or subscriber (FR-4.1 as amended by D-84). */
export const createGroup = callable<{ name: unknown }, { groupId: string }>(async (uid, data, request) => {
  const name = requireGroupName(requireObject(data).name);
  const now = Timestamp.now();
  const { today, closedDay } = puzzleDays(now);
  const gid = groupsCol().doc().id;

  await db().runTransaction(async (tx) => {
    // ensureProfile may write, so every read — the backfill included — comes first.
    const results = await backfillResults(tx, uid, closedDay);
    const profile = await ensureProfile(tx, uid, now);
    requireCanCreateGroup(rankOf(profile, signInProvider(request), now));
    const groups = groupsOf(profile);
    if (groups.length >= MAX_GROUPS_PER_USER) throw mondoError("too-many-groups", `At most ${MAX_GROUPS_PER_USER} groups per player.`);

    const group: Group = { name, ownerUid: uid, memberCount: 1, maxMembers: DEFAULT_MAX_MEMBERS, createdAt: now };
    tx.create(groupRef(gid), group);
    tx.create(memberRef(gid, uid), newMember(uid, profile.displayName, "owner", now, backfillStats(results, closedDay), effectiveStreak(profile, closedDay, today)));
    tx.set(userRef(uid), { ...profile, role: roleOf(profile), groups: [...groups, gid] });
  });
  return { groupId: gid };
});

/** How many invites one group may have outstanding at once (finding 8). */
const MAX_PENDING_INVITES = 20;

/**
 * createInvite({ groupId, mode? }) → { token, url, expiresAt, mode }. The owner,
 * and only while they could create a group themselves (FR-10.3, D-84): owning is
 * what lets you into THIS group's invites (FR-7.5), the rank is what lets you
 * grow anything. A subscriber who lapses, or a user who inherited a group under
 * D-23, keeps a group that plays on and cannot grow until they resubscribe.
 * Revoking and listing stay owner-only, so they can always shut a link.
 *
 * `mode` is FR-4.12 and defaults to the single-use link this has always minted.
 */
export const createInvite = callable<
  { groupId: unknown; mode?: unknown },
  { token: string; url: string; expiresAt: string; mode: InviteMode }
>(async (uid, data, request) => {
  const body = requireObject(data);
  const gid = requireGroupId(body.groupId);
  const mode = requireInviteMode(body.mode);
  const now = Timestamp.now();
  const [snap, profileSnap] = await Promise.all([groupRef(gid).get(), userRef(uid).get()]);
  if (!snap.exists) throw mondoError("not-found", "No such group.");
  const group = snap.data() as Group;
  requireOwner(group, uid);
  requireCanCreateGroup(rankOf(profileSnap.exists ? (profileSnap.data() as Profile) : null, signInProvider(request), now));

  const pending = (await pendingInvitesOf(gid).limit(MAX_PENDING_INVITES + 1).get()).docs
    .filter((d) => inviteState(d.data() as Invite, now) === "pending");
  if (pending.length >= MAX_PENDING_INVITES) {
    throw mondoError("invalid-argument", `This group already has ${MAX_PENDING_INVITES} invites waiting. Revoke one first.`);
  }

  // 32^16 tokens: a collision is not expected in the lifetime of the project,
  // but create() refuses to overwrite one if it ever happens, so try again once.
  for (let attempt = 0; ; attempt++) {
    const token = inviteToken();
    const invite = newInvite(gid, group.name, uid, now, mode);
    try {
      await inviteRef(token).create(invite);
      return { token, url: `${GAME_URL}grupos.html?convite=${token}`, expiresAt: invite.expiresAt.toDate().toISOString(), mode };
    } catch (e) {
      if (attempt >= 1) throw e;
    }
  }
});

/**
 * listInvites({ groupId }) → live invites, newest first. Owner only.
 *
 * Both kinds in one list: an owner deciding whether to revoke a link cares what
 * it does and when it dies, not which button made it. `uses` is the only thing
 * a broadcast link tells on itself (FR-4.12).
 */
export const listInvites = callable<
  { groupId: unknown },
  { invites: { token: string; url: string; createdAt: string; expiresAt: string; mode: InviteMode; uses: number }[] }
>(async (uid, data) => {
  const gid = requireGroupId(requireObject(data).groupId);
  const now = Timestamp.now();
  const snap = await groupRef(gid).get();
  if (!snap.exists) throw mondoError("not-found", "No such group.");
  requireOwner(snap.data() as Group, uid);

  const docs = (await pendingInvitesOf(gid).limit(MAX_PENDING_INVITES).get()).docs;
  const invites = docs
    .map((d) => ({ token: d.id, ...(d.data() as Invite) }))
    .filter((i) => inviteState(i, now) === "pending")
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
    .map((i) => ({
      token: i.token,
      url: `${GAME_URL}grupos.html?convite=${i.token}`,
      createdAt: i.createdAt.toDate().toISOString(),
      expiresAt: i.expiresAt.toDate().toISOString(),
      mode: inviteMode(i),
      uses: i.uses ?? 0,
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
 * group. It grants membership and nothing else: Invited is a closed list, so a
 * user who joins stays a user and still sees ads (D-84). A guest is refused —
 * a board needs an identity that outlives the browser. Consumes a single-use token (FR-4.3 as
 * amended); a multi-use one it only counts (FR-4.12). Every other gate — state,
 * group full, too many groups — is the same for both, which is the point of
 * modes being a field rather than a second path in.
 */
export const acceptInvite = callable<{ token: unknown }, { groupId: string; name: string }>(async (uid, data, request) => {
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
    // ensureProfile may write (first sign-in through a link), so the owner and
    // the backfill are read before it.
    const ownerSnap = await tx.get(userRef(group.ownerUid));
    const results = await backfillResults(tx, uid, closedDay);
    const profile = await ensureProfile(tx, uid, now);
    requireCanJoinGroup(rankOf(profile, signInProvider(request), now));
    const groups = groupsOf(profile);

    if (groups.includes(invite.groupId)) {
      // Already in: send them to the board without consuming the token, so a
      // forwarded link is not burned on someone who did not need it.
      return { groupId: invite.groupId, name: group.name };
    }
    // FR-10.3 at the door as well as at createInvite: a link minted while the
    // owner could grow the group must not keep growing it after they lapse, are
    // demoted, or hand the group to an heir who cannot — single-use links live a
    // week, and a lapsing subscription has no event to revoke them on.
    if (!canCreateGroup(rankOf(ownerSnap.exists ? (ownerSnap.data() as Profile) : null, undefined, now))) {
      throw mondoError("invalid-invite", "This group is not taking new members right now.");
    }
    if (groups.length >= MAX_GROUPS_PER_USER) throw mondoError("too-many-groups", `At most ${MAX_GROUPS_PER_USER} groups per player.`);
    if (group.memberCount >= group.maxMembers) throw mondoError("group-full", "This group is full.");

    tx.create(memberRef(invite.groupId, uid), newMember(uid, profile.displayName, "member", now, backfillStats(results, closedDay), effectiveStreak(profile, closedDay, today)));
    tx.update(groupRef(invite.groupId), { memberCount: group.memberCount + 1 });
    // roleOf BEFORE the group is added, frozen into the document: a legacy
    // player nobody had let in is a user, and joining must not make them read
    // as invited once they have a group (FR-10.2, D-84).
    tx.set(userRef(uid), { ...profile, role: roleOf(profile), groups: [...groups, invite.groupId] });
    // FR-4.12: a multi-use token is not spent by being used, only counted —
    // leaving `usedBy` null is what keeps `inviteState` calling it pending and
    // `pendingInvitesOf` still listing it for the owner.
    const spent = inviteMode(invite) === "single" ? { usedBy: uid, usedAt: now } : {};
    tx.update(inviteRef(token), { ...spent, uses: (invite.uses ?? 0) + 1 });
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
/**
 * `me` is here for the same reason `getRound` carries one: the profile is
 * already read to work out `canCreate`, so the display name and the role are
 * two fields off a document that is in hand. Every page but the daily gets its
 * chrome from this call — the initials on the avatar, whether the Painel link
 * shows, and the name the Perfil dialog prefills — and before it existed those
 * pages fell back to the Google account's name, which is not the name the game
 * knows anyone by.
 *
 * It authorizes nothing. `admin` here only decides whether a link is drawn;
 * admin.ts asserts the role itself on every call behind it (SEC-8). `ads` is
 * the same: it decides what the page draws (FR-10.4).
 */
export const listGroups = callable<unknown, { groups: { groupId: string; name: string; memberCount: number; isOwner: boolean }[]; canCreate: boolean; me: { displayName: string; role: Role; rank: Rank; ads: boolean } | null }>(async (uid, _data, request) => {
  const profileSnap = await userRef(uid).get();
  const profile = profileSnap.exists ? (profileSnap.data() as Profile) : null;
  const rank = rankOf(profile, signInProvider(request), Timestamp.now());
  const canCreate = canCreateGroup(rank);
  const me = profile ? { displayName: profile.displayName, role: roleOf(profile), rank, ads: showsAds(rank, profile) } : null;
  const gids = groupsOf(profile);
  if (gids.length === 0) return { groups: [], canCreate, me };
  const snaps = await db().getAll(...gids.map(groupRef));
  return {
    canCreate,
    me,
    groups: snaps.flatMap((s) => {
      if (!s.exists) return []; // index and group out of step; the nightly job does not fix this, leaveTx does
      const g = s.data() as Group;
      return [{ groupId: s.id, name: g.name, memberCount: g.memberCount, isOwner: g.ownerUid === uid }];
    }),
  };
});
