import * as logger from "firebase-functions/logger";
import { onCall, type CallableRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule, type ScheduledEvent } from "firebase-functions/v2/scheduler";
import { ALLOWED_ORIGINS, APP_CHECK_ENFORCED, PUZZLE_TIMEZONE, REGION, RUNTIME_SERVICE_ACCOUNT } from "./config";

/** The emulator mints no App Check tokens, and the e2e suite posts raw HTTP. */
const EMULATED = process.env.FUNCTIONS_EMULATOR === "true";

/**
 * Wraps `onCall` so that region and CORS are set identically everywhere (SEC-9),
 * and so that the auth assertion required by SEC-8 cannot be forgotten.
 *
 * The handler receives a non-null `uid`. If you need an unauthenticated
 * endpoint, you do not — every surface in Mondo is behind sign-in.
 */
export function callable<Req, Res>(
  handler: (uid: string, data: Req, request: CallableRequest<Req>) => Promise<Res>,
  options: { minInstances?: number } = {},
) {
  return onCall<Req, Promise<Res>>(
    {
      region: REGION,
      cors: ALLOWED_ORIGINS,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      // SEC-18 / D-85: with play open to anyone who can mint a uid, App Check is
      // what keeps a script from spending Firestore on the game's behalf.
      enforceAppCheck: APP_CHECK_ENFORCED && !EMULATED,
      // Generous enough for a guess round-trip (NFR-1: p95 < 600ms) without
      // letting a wedged handler burn budget.
      timeoutSeconds: 30,
      memory: "256MiB",
      // Guard against a runaway loop costing real money (SEC-11 is the backstop).
      maxInstances: 10,

      // DO NOT SET minInstances WITHOUT READING docs/05-cost.md.
      //
      // NFR-2 suggests `minInstances: 1` to hide cold starts at lunch. It is the
      // single most expensive line you can add to this codebase. Cloud Run's free
      // tier is 180,000 vCPU-seconds/month (50 vCPU-hours); one always-warm
      // instance occupies ~730 instance-hours/month. That is an order of
      // magnitude outside the free tier, in every region, and it bills whether
      // anyone plays or not.
      //
      // Measure p95 first (NFR-1 is 600ms). Accepting a cold start on the day's
      // first guess is free; a warm instance is not.
      ...(options.minInstances !== undefined ? { minInstances: options.minInstances } : {}),
    },
    async (request) => {
      // SEC-8 — reject unauthenticated calls before touching the payload.
      if (!request.auth?.uid) {
        throw new HttpsError("unauthenticated", "Sign in to play.");
      }
      // Monitor mode (SEC-18): count the calls enforcement would refuse. When
      // this goes quiet for the real site, APP_CHECK_ENFORCED can be flipped.
      if (!request.app && !EMULATED) logger.warn("APP_CHECK_MISSING", { origin: request.rawRequest.headers.origin ?? null });
      return handler(request.auth.uid, request.data, request);
    },
  );
}

/**
 * How the caller signed in — "google.com", or "anonymous" for a guest (FR-10.1).
 * Verified by the SDK with the rest of the ID token, so a client cannot claim
 * to be anything it is not; `rankOf` in lib/authz.ts is its reader.
 */
export function signInProvider(request: CallableRequest<unknown>): string | undefined {
  return request.auth?.token.firebase?.sign_in_provider;
}

/**
 * Wraps `onSchedule` the same way: region, runtime SA and the puzzle time zone
 * (D-11) set once. Cloud Scheduler bills nothing for the first three jobs
 * (docs/05-cost.md §3.4); Mondo has two.
 *
 * The emulator registers these as Pub/Sub triggers (it needs the pubsub
 * emulator running), not as HTTP routes. To exercise a job locally call its
 * exported body (rebuildStandingsNow, healthCheckNow) in-process, as
 * test/e2e/phase2.e2e.ts does, or use the Emulator UI's trigger button.
 */
export function scheduled(schedule: string, handler: (event: ScheduledEvent) => Promise<void>) {
  return onSchedule(
    {
      schedule,
      timeZone: PUZZLE_TIMEZONE,
      region: REGION,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      memory: "256MiB",
      timeoutSeconds: 540,
      retryCount: 1,
      maxInstances: 1,
    },
    handler,
  );
}
