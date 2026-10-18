/**
 * Mondo — Cloud Functions entry point.
 *
 * Every export here is a *callable* function (D-4), never a raw HTTP endpoint,
 * so the SDK verifies the caller's ID token and we never hand-roll JWT checks.
 *
 * `ping` is the Phase 0 smoke test and stays as a cheap end-to-end probe.
 * `getRound` and `submitGuess` are the daily game (Phase 1); see round.ts.
 * `updateProfile` lets a player rename themselves (FR-1.3) and `getProfile` reads
 * anyone's last 30 days (FR-13); see profile.ts.
 * Groups and invites are Phase 2 (FR-4, FR-7); ranks are FR-10 (lib/authz.ts); see groups.ts.
 * Boards: leaderboard.ts. Admin dashboard: admin.ts. Account deletion: account.ts.
 * Scheduled jobs (D-11, NFR-6): standings.ts, health.ts.
 * Tournaments are Phase 3 (FR-5 as rewritten, FR-8); see tournaments.ts and
 * docs/06-tournaments.md. Slices 1-2: free-for-all, shape and capital kinds.
 * Practice is FR-9: one kind, one challenge at a time, scored for nobody but
 * the player; see practice.ts.
 * Multijogador is FR-12: live rooms, Clássico and Batata Quente, one callable (D-92);
 * see multiplayer.ts.
 */

import { initializeApp } from "firebase-admin/app";
import { callable } from "./lib/callable";
import { REGION } from "./lib/config";

initializeApp();

export { getRound, submitGuess, giveUp } from "./round";
export { updateProfile, getProfile } from "./profile";
export {
  createGroup, createInvite, listInvites, revokeInvite, acceptInvite, leaveGroup, removeMember, renameGroup, listGroups,
} from "./groups";
export { getLeaderboard } from "./leaderboard";
export { listUsers, setRole, setShowAds, listAllGroups, listAttempts, grantRetry, setCheated } from "./admin";
export { deleteAccount } from "./account";
export {
  createTournament, setParticipation, startTournament, advanceTournament, cancelTournament,
  listTournaments, getTournament, getCard, submitCardGuess,
} from "./tournaments";
export { startPractice, nextPractice, submitPracticeGuess, giveUpPractice, endPractice } from "./practice";
export { multiplayer } from "./multiplayer";
// D-102: the old name, for one release. The site and the functions deploy in
// parallel, and a cached sala.html keeps calling `versus` until it reloads.
// Remove in the next backend PR; `deploy --force` then deletes the service.
export { multiplayer as versus } from "./multiplayer";
export { rebuildStandings } from "./standings";
export { scheduleHealthCheck } from "./health";

/**
 * Phase 0 smoke test (roadmap "Done when").
 *
 * Authenticated, like everything else — SEC-8 has no exceptions, so proving the
 * deploy works also proves sign-in works. Returns nothing about the caller
 * beyond their own uid, and nothing about any puzzle.
 */
export const ping = callable<void, { ok: true; region: string; serverTime: string; uid: string }>(
  async (uid) => ({
    ok: true,
    region: REGION,
    serverTime: new Date().toISOString(),
    uid,
  }),
);
