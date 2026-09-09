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

/** FR-1.3: 3–24 chars, Unicode letters/digits/space/hyphen/underscore, no edge whitespace. Mirrors firestore.rules. */
export const DISPLAY_NAME = /^[\p{L}\p{N} _-]{3,24}$/u;
export function requireDisplayName(v: unknown): string {
  if (typeof v !== "string" || v.trim() !== v || !DISPLAY_NAME.test(v)) {
    throw mondoError("invalid-argument", "Display name must be 3–24 letters, digits, spaces, - or _.");
  }
  return v;
}

export const LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export function requireLocale(v: unknown): Locale {
  if (typeof v !== "string" || !(LOCALES as readonly string[]).includes(v)) {
    throw mondoError("invalid-argument", "Unsupported locale.");
  }
  return v as Locale;
}
