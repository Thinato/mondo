/**
 * Shared runtime configuration.
 *
 * Every callable in this codebase is defined with `callable()` below rather than
 * calling `onCall` directly, so region and CORS cannot drift between functions.
 */

/** Players are in São Paulo; so is Firestore. See 02-architecture.md §1. */
export const REGION = "southamerica-east1";

/**
 * Least-privilege runtime identity (Firestore + logging + auth admin only),
 * created by infra/cicd.tf. Without this, functions run as the project's
 * default compute service account, which is far broader than they need.
 */
export const RUNTIME_SERVICE_ACCOUNT =
  "mondo-functions@lisecki-dev.iam.gserviceaccount.com";

/**
 * SEC-9 — only these origins may invoke a callable. The Firebase callable
 * protocol is CORS-enforced, so this is a real boundary, not decoration.
 * localhost is for the emulator only.
 */
export const ALLOWED_ORIGINS = [
  "https://lisecki.dev",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5000",
];

/** OQ-2 — the puzzle day flips at 12:00 in this zone. */
export const PUZZLE_TIMEZONE = "America/Sao_Paulo";

/** OQ-2 — hour of the day boundary, local to PUZZLE_TIMEZONE. */
export const PUZZLE_ROLLOVER_HOUR = 12;

/** FR-2.5 */
export const MAX_GUESSES = 6;

/** SEC-5 — floor between two guesses from the same player. */
export const GUESS_MIN_INTERVAL_MS = 400;

/** A first-guess solve faster than this is flagged, not blocked (02-architecture.md §3.3). */
export const SUSPICIOUS_SOLVE_MS = 2000;
