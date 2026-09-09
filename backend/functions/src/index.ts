/**
 * Mondo — Cloud Functions entry point.
 *
 * Every export here is a *callable* function (D-4), never a raw HTTP endpoint,
 * so the SDK verifies the caller's ID token and we never hand-roll JWT checks.
 *
 * `ping` is the Phase 0 smoke test and stays as a cheap end-to-end probe.
 * `getRound` and `submitGuess` are the daily game (Phase 1); see round.ts.
 * `updateProfile` lets a player rename themselves (FR-1.3); see profile.ts.
 */

import { initializeApp } from "firebase-admin/app";
import { callable } from "./lib/callable";
import { REGION } from "./lib/config";

initializeApp();

export { getRound, submitGuess } from "./round";
export { updateProfile } from "./profile";

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
