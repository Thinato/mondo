import { onCall, type CallableRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule, type ScheduledEvent } from "firebase-functions/v2/scheduler";
import { ALLOWED_ORIGINS, PUZZLE_TIMEZONE, REGION, RUNTIME_SERVICE_ACCOUNT } from "./config";

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
      return handler(request.auth.uid, request.data, request);
    },
  );
}

/**
 * Wraps `onSchedule` the same way: region, runtime SA and the puzzle time zone
 * (D-11) set once. Cloud Scheduler bills nothing for the first three jobs
 * (docs/05-cost.md §3.4); Mondo has two.
 *
 * In the emulator a job runs on POST to
 * http://127.0.0.1:5001/demo-mondo/southamerica-east1/<name>.
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
