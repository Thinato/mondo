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

/**
 * Cost ceiling, deliberate and accepted (plan R-4, docs/05-cost.md §2): a board
 * read is 3 + 2N documents, N being the member count. That is ~23 for a group
 * of ten and 403 for the 200-member maximum (FR-4.5), and no callable is rate
 * limited, so a signed-in member looping this in devtools can spend the daily
 * free read tier. The budget alert (SEC-11) is the backstop.
 *
 * ponytail: the fix is to stamp today's state onto the member documents as
 * rounds start and finish, which halves the reads — but that is the per-group
 * fan-out D-21 removed on purpose, trading writes and a consistency surface for
 * reads. Do not switch without re-deciding D-21, and measure first (NFR-2).
 */
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
