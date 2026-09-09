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
  | "permission-denied"
  | "not-invited"
  | "already-completed"
  | "no-guesses-remaining"
  | "rate-limited"
  | "puzzle-not-open"
  | "group-full"
  | "too-many-groups"
  | "invalid-invite"
  | "challenge-expired"
  // Phase 3 — tournaments (docs/06-tournaments.md §9)
  | "tournament-not-open"
  | "not-a-participant";

const HTTPS_CODE: Record<MondoErrorCode, FunctionsErrorCode> = {
  unauthenticated: "unauthenticated",
  "invalid-argument": "invalid-argument",
  "not-found": "not-found",
  "permission-denied": "permission-denied",
  "not-invited": "permission-denied", // FR-1.7: signed in, but nobody let them in yet
  "already-completed": "failed-precondition",
  "no-guesses-remaining": "failed-precondition",
  "rate-limited": "resource-exhausted",
  "puzzle-not-open": "failed-precondition",
  "group-full": "failed-precondition",
  "too-many-groups": "failed-precondition",
  "invalid-invite": "not-found",
  "challenge-expired": "failed-precondition",
  // Reused for a round whose deadline has passed, too: the caller can no longer
  // act, and there is nothing they can retry (FR-5.7).
  "tournament-not-open": "failed-precondition",
  "not-a-participant": "permission-denied",
};

export function mondoError(code: MondoErrorCode, message: string): HttpsError {
  return new HttpsError(HTTPS_CODE[code], message, { code });
}
