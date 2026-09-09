import { HttpsError, type FunctionsErrorCode } from "firebase-functions/v2/https";

/**
 * Typed errors from 02-architecture.md §4. The client switches on
 * `error.details.code`, which is always one of these strings; the gRPC-style
 * `HttpsError` code is chosen so the SDK's own semantics stay honest
 * (a rate limit is `resource-exhausted`, a finished round is `failed-precondition`).
 */
export type MondoErrorCode =
  | "unauthenticated"
  | "invalid-argument"
  | "not-found"
  | "already-completed"
  | "no-guesses-remaining"
  | "rate-limited"
  | "puzzle-not-open"
  | "group-full"
  | "challenge-expired";

const HTTPS_CODE: Record<MondoErrorCode, FunctionsErrorCode> = {
  unauthenticated: "unauthenticated",
  "invalid-argument": "invalid-argument",
  "not-found": "not-found",
  "already-completed": "failed-precondition",
  "no-guesses-remaining": "failed-precondition",
  "rate-limited": "resource-exhausted",
  "puzzle-not-open": "failed-precondition",
  "group-full": "failed-precondition",
  "challenge-expired": "failed-precondition",
};

export function mondoError(code: MondoErrorCode, message: string): HttpsError {
  return new HttpsError(HTTPS_CODE[code], message, { code });
}
