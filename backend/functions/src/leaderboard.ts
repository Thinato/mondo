/**
 * getLeaderboard({ groupId }) — a group's board (FR-4.6, FR-4.7, FR-4.10,
 * FR-4.11). Members see their own groups; an admin may read any board
 * (FR-7.2). The projection is lib/groups.ts `leaderboardView`; this is I/O.
 */

import { Timestamp } from "firebase-admin/firestore";
import { attemptRef, db, groupRef, memberRef, membersCol, puzzleDays, userRef } from "./db";
import { isAdmin } from "./lib/authz";
import { callable } from "./lib/callable";
import { mondoError } from "./lib/errors";
import { leaderboardView, type Group, type LeaderboardView, type Member } from "./lib/groups";
import type { Attempt, Profile } from "./lib/round";
import { requireGroupId, requireObject } from "./lib/validate";

export const getLeaderboard = callable<{ groupId: unknown }, LeaderboardView>(async (uid, data) => {
  const gid = requireGroupId(requireObject(data).groupId);
  const now = Timestamp.now();
  const { today, closedDay } = puzzleDays(now);

  const [groupSnap, profileSnap, memberSnap] = await Promise.all([
    groupRef(gid).get(), userRef(uid).get(), memberRef(gid, uid).get(),
  ]);
  if (!groupSnap.exists) throw mondoError("not-found", "No such group.");
  const profile = profileSnap.exists ? (profileSnap.data() as Profile) : null;
  // FR-4.10: nobody else's data is read until the caller is known to be allowed.
  if (!memberSnap.exists && !isAdmin(profile)) throw mondoError("permission-denied", "Members only.");
  const group = groupSnap.data() as Group;

  const members = (await membersCol(gid).get()).docs.map((d) => d.data() as Member);
  const todayAttempts = new Map<string, Attempt | null>();
  if (members.length > 0) {
    const snaps = await db().getAll(...members.map((m) => attemptRef(m.uid, today)));
    members.forEach((m, i) => todayAttempts.set(m.uid, snaps[i]?.exists ? (snaps[i]!.data() as Attempt) : null));
  }

  return leaderboardView({ groupId: gid, group, members, todayAttempts, viewerUid: uid, today, closedDay });
});
