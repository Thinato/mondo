import { onCall, type CallableRequest, HttpsError } from "firebase-functions/v2/https";
import { ALLOWED_ORIGINS, REGION } from "./config";

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
      // Generous enough for a guess round-trip (NFR-1: p95 < 600ms) without
      // letting a wedged handler burn budget.
      timeoutSeconds: 30,
      memory: "256MiB",
      // Guard against a runaway loop costing real money (SEC-11 is the backstop).
      maxInstances: 10,
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
