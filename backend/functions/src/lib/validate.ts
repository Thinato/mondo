/**
 * Input validation for callables (SEC-8). Hand-written and tiny on purpose: the
 * inputs are two strings. Every check throws a typed `invalid-argument`.
 */

import { MAX_CARD_ITEMS } from "./card";
import { COUNTRIES, REGIONS, type Region } from "./countries";
import { mondoError } from "./errors";
import type { InviteMode } from "./invite";
import { KIND_IDS, type KindId } from "./kinds";
import type { CustomGame } from "./room";
import type { Action } from "./fronteiras";

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

/**
 * FR-4.12. Absent means the single-use kind, so a client that has never heard of
 * modes keeps minting exactly what it used to (the same reason `requireRegions`
 * defaults to every continent, D-70).
 */
export function requireInviteMode(v: unknown): InviteMode {
  if (v === undefined || v === null) return "single";
  if (v !== "single" && v !== "multi") throw mondoError("invalid-argument", "Unknown invite mode.");
  return v;
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

/**
 * FR-9.9 — which continents a practice session may ask about.
 *
 * Absent means all of them, which is what every client sent before the filter
 * existed and what the page sends when nothing is unticked. An empty array is
 * rejected rather than read as "all": it is what a UI bug looks like, and
 * silently widening a filter the player narrowed is the wrong way to be wrong.
 * Duplicates are collapsed, because "Europe twice" is not an error worth a
 * message.
 */
export function requireRegions(v: unknown): Region[] {
  if (v === undefined || v === null) return [...REGIONS];
  if (!Array.isArray(v) || v.length === 0) throw mondoError("invalid-argument", "Choose at least one continent.");
  const out = new Set<Region>();
  for (const r of v) {
    if (typeof r !== "string" || !(REGIONS as readonly string[]).includes(r)) {
      throw mondoError("invalid-argument", "Unknown continent.");
    }
    out.add(r as Region);
  }
  return [...out];
}

export function requireBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw mondoError("invalid-argument", `${field} must be true or false.`);
  return v;
}

/**
 * FR-7.2: the API grants invited or user (D-84). Admin comes only from
 * tools/set-role.mjs (D-29). Granting `invited` is how an admin comps somebody
 * ad-free — the one door into the closed list after the migration.
 */
export const GRANTABLE_ROLES = ["invited", "user"] as const;
export function requireRole(v: unknown): (typeof GRANTABLE_ROLES)[number] {
  if (typeof v !== "string" || !(GRANTABLE_ROLES as readonly string[]).includes(v)) {
    throw mondoError("invalid-argument", "Role must be invited or user.");
  }
  return v as (typeof GRANTABLE_ROLES)[number];
}

/** FR-12.11 — a saved preset's name: 1–24 characters once trimmed, no control characters. */
export function requirePresetName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < 1 || s.length > 24 || /[\p{C}]/u.test(s)) throw mondoError("invalid-argument", "A preset name is 1–24 characters.");
  return s;
}

/**
 * FR-12.10, D-106 — a custom Clássico: the kinds in order, whether to shuffle
 * them, and the continents. Closed shape: nothing else the client sends is
 * kept, and above all no country. The name is optional (a game played without
 * saving has none).
 */
export function requireCustomGame(v: unknown): CustomGame {
  const o = requireObject(v);
  const kinds = o.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > MAX_CARD_ITEMS) {
    throw mondoError("invalid-argument", `A game holds 1–${MAX_CARD_ITEMS} challenges.`);
  }
  for (const k of kinds) {
    if (!(KIND_IDS as readonly unknown[]).includes(k)) throw mondoError("invalid-argument", "Unknown challenge kind.");
  }
  if (typeof o.shuffled !== "boolean") throw mondoError("invalid-argument", "shuffled must be a boolean.");
  return {
    name: o.name === undefined || o.name === null ? null : requirePresetName(o.name),
    kinds: kinds as KindId[],
    shuffled: o.shuffled,
    regions: requireRegions(o.regions),
  };
}

// ---------------------------------------------------------------------------
// FR-15 — Fronteiras
// ---------------------------------------------------------------------------

const ACTION_TYPES = ["pick", "take", "attack", "fortify", "pass"] as const;

/**
 * FR-15.4 — one Fronteiras action. Closed shape: `{ t: "pass" }`, or a kind and
 * a pool country code; any other key is refused. Whether the code is on the
 * board, adjacent and affordable is the game's to judge (lib/fronteiras.ts).
 */
export function requireFronteirasAction(v: unknown): Action {
  const o = requireObject(v);
  if (!(ACTION_TYPES as readonly unknown[]).includes(o.t)) throw mondoError("invalid-argument", "Unknown action.");
  const keys = Object.keys(o);
  if (o.t === "pass") {
    if (keys.length !== 1) throw mondoError("invalid-argument", "A pass carries nothing else.");
    return { t: "pass" };
  }
  if (keys.length !== 2 || !keys.includes("code")) throw mondoError("invalid-argument", "An action is { t, code }.");
  return { t: o.t as Exclude<Action["t"], "pass">, code: requireCountryCode(o.code) };
}

/** FR-15.12 — the leaderboard: everyone, or the caller's groups. */
export function requireRatingsScope(v: unknown): "all" | "groups" {
  if (v !== "all" && v !== "groups") throw mondoError("invalid-argument", "scope must be all or groups.");
  return v;
}
