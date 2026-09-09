/**
 * Input validation for callables (SEC-8). Hand-written and tiny on purpose: the
 * inputs are two strings. Every check throws a typed `invalid-argument`.
 */

import { COUNTRIES } from "./countries";
import { mondoError } from "./errors";

const PUZZLE_ID = /^\d{4}-\d{2}-\d{2}$/;

export function requireObject(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw mondoError("invalid-argument", "Expected an object.");
  }
  return data as Record<string, unknown>;
}

/** "YYYY-MM-DD" that is a real calendar date. */
export function requirePuzzleId(v: unknown): string {
  if (typeof v !== "string" || !PUZZLE_ID.test(v)) throw mondoError("invalid-argument", "puzzleId must be YYYY-MM-DD.");
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) {
    throw mondoError("invalid-argument", "puzzleId is not a calendar date.");
  }
  return v;
}

/** An ISO alpha-2 code that is in the country pool. */
export function requireCountryCode(v: unknown): string {
  if (typeof v !== "string" || !COUNTRIES.has(v)) {
    throw mondoError("invalid-argument", "Unknown country code.");
  }
  return v;
}
