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

// ---------------------------------------------------------------------------
// Phase 2 — groups, invites, roles (FR-4, FR-7)
// ---------------------------------------------------------------------------

/** FR-4.1: 3–40 chars, no edge whitespace, no control characters. */
export function requireGroupName(v: unknown): string {
  if (typeof v !== "string" || v.trim() !== v || v.length < 3 || v.length > 40 || /[\p{C}]/u.test(v)) {
    throw mondoError("invalid-argument", "Group name must be 3–40 characters.");
  }
  return v;
}

/** D-32: 16 chars from the ambiguity-free alphabet. Lower case is accepted and normalised. */
export const INVITE_TOKEN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/;
export function requireInviteToken(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!INVITE_TOKEN.test(s)) throw mondoError("invalid-argument", "Invalid invite token.");
  return s;
}

/** Firestore auto-ids are 20 URL-safe alphanumerics. */
export function requireGroupId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9]{20}$/.test(v)) throw mondoError("invalid-argument", "Invalid group id.");
  return v;
}

/** Firebase Auth uids: 1–128 alphanumerics (emulator ids included). */
export function requireUid(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(v)) throw mondoError("invalid-argument", "Invalid uid.");
  return v;
}

// ---------------------------------------------------------------------------
// Phase 3 — tournaments (FR-5 as rewritten, FR-8)
// ---------------------------------------------------------------------------

/** Same shape as a group id: a Firestore auto-id. */
export function requireTournamentId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9]{20}$/.test(v)) throw mondoError("invalid-argument", "Invalid tournament id.");
  return v;
}

/**
 * FR-5.1 / D-48 — the only thing the client may say about a tournament's
 * settings is which built-in preset it wants. Membership of the shipped set is
 * checked by `presetById`, which owns the list; this only screens the shape so
 * a hostile string never reaches a lookup.
 */
export function requirePresetId(v: unknown): string {
  if (typeof v !== "string" || !/^[a-z][a-z0-9-]{1,23}$/.test(v)) throw mondoError("invalid-argument", "Invalid preset id.");
  return v;
}

export function requireBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw mondoError("invalid-argument", `${field} must be true or false.`);
  return v;
}

/** FR-7.2: the API grants organizer or player. Admin comes only from tools/set-role.mjs (D-29). */
export const GRANTABLE_ROLES = ["organizer", "player"] as const;
export function requireRole(v: unknown): (typeof GRANTABLE_ROLES)[number] {
  if (typeof v !== "string" || !(GRANTABLE_ROLES as readonly string[]).includes(v)) {
    throw mondoError("invalid-argument", "Role must be organizer or player.");
  }
  return v as (typeof GRANTABLE_ROLES)[number];
}
