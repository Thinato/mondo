/**
 * Mondo — Cloud Functions entry point.
 *
 * Every export here is a *callable* function (D-4), never a raw HTTP endpoint,
 * so the SDK verifies the caller's ID token and we never hand-roll JWT checks.
 *
 * Phase 0 ships exactly one function: `ping`. Its only job is to prove the whole
 * chain works end to end — Terraform-built project, WIF-authenticated CI deploy,
 * correct region, CORS allowlist, and Firebase Auth — before any game logic
 * exists to confuse the diagnosis.
 */

import { initializeApp } from "firebase-admin/app";
import { callable } from "./lib/callable";
import { REGION } from "./lib/config";

initializeApp();

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
