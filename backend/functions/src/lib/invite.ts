/**
 * Invite links (FR-4.2/4.3 as amended, D-32, D-71). Pure; `src/groups.ts` does
 * the Firestore part.
 *
 * An invitation has two lives and one shape. Single-use dies on the first
 * accept and lasts a week; multi-use lasts 48 hours and is spent by nothing but
 * time or a revoke (FR-4.12). Same 16-char token either way: "multi-use" is not
 * "guessable", and FR-4.2's no-public-code rule is about the token, not the
 * count.
 */

import { randomInt } from "node:crypto";
import type { Timestamp } from "firebase-admin/firestore";

/** FR-4.2: upper case without 0/1/I/O, so a code read aloud survives. */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_TOKEN_LENGTH = 16;
export const INVITE_TTL_MS = 7 * 86_400_000;
/** FR-4.12: a quarter of the single-use life, because it admits everyone holding it. */
export const MULTI_INVITE_TTL_MS = 2 * 86_400_000;

export type InviteMode = "single" | "multi";
export const INVITE_TTL: Record<InviteMode, number> = { single: INVITE_TTL_MS, multi: MULTI_INVITE_TTL_MS };

export interface Invite {
  groupId: string;
  /** Denormalised so the confirm dialog needs no second call. */
  groupName: string;
  createdBy: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  mode: InviteMode;
  /** How many accounts joined through it. 1 at most for a single-use token. */
  uses: number;
  usedBy: string | null;
  usedAt: Timestamp | null;
  revokedAt: Timestamp | null;
}

export type InviteState = "pending" | "used" | "revoked" | "expired";

/** `pick(n)` returns an integer in [0, n); defaults to a CSPRNG. */
export function inviteToken(pick: (n: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < INVITE_TOKEN_LENGTH; i++) s += INVITE_ALPHABET[pick(INVITE_ALPHABET.length)];
  return s;
}

export function newInvite(groupId: string, groupName: string, createdBy: string, now: Timestamp, mode: InviteMode = "single"): Invite {
  return {
    groupId, groupName, createdBy, createdAt: now,
    expiresAt: plus(now, INVITE_TTL[mode]),
    mode, uses: 0,
    usedBy: null, usedAt: null, revokedAt: null,
  };
}

/** Invites written before FR-4.12 carry no `mode`; they are the single-use kind. */
export function inviteMode(invite: { mode?: InviteMode | undefined }): InviteMode {
  return invite.mode ?? "single";
}

/**
 * Used wins over revoked wins over expired: the most final fact is the state.
 *
 * Unchanged by FR-4.12, because a multi-use token never gets a `usedBy` — being
 * accepted is not something that happens *to* it. That is also what keeps it in
 * `pendingInvitesOf`, whose query filters on `usedBy == null` (db.ts).
 */
export function inviteState(invite: Pick<Invite, "usedBy" | "revokedAt" | "expiresAt">, now: Timestamp): InviteState {
  if (invite.usedBy !== null) return "used";
  if (invite.revokedAt !== null) return "revoked";
  if (now.toMillis() >= invite.expiresAt.toMillis()) return "expired";
  return "pending";
}

function plus(t: Timestamp, ms: number): Timestamp {
  // Constructed through the instance's own class so the emulator and production
  // Timestamp implementations both round-trip.
  return (t.constructor as unknown as { fromMillis(ms: number): Timestamp }).fromMillis(t.toMillis() + ms);
}
