/**
 * Single-use invite links (FR-4.2/4.3 as amended, D-32). Pure; `src/groups.ts`
 * does the Firestore part.
 */

import { randomInt } from "node:crypto";
import type { Timestamp } from "firebase-admin/firestore";

/** FR-4.2: upper case without 0/1/I/O, so a code read aloud survives. */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_TOKEN_LENGTH = 16;
export const INVITE_TTL_MS = 7 * 86_400_000;

export interface Invite {
  groupId: string;
  /** Denormalised so the confirm dialog needs no second call. */
  groupName: string;
  createdBy: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
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

export function newInvite(groupId: string, groupName: string, createdBy: string, now: Timestamp, ttlMs = INVITE_TTL_MS): Invite {
  return {
    groupId, groupName, createdBy, createdAt: now,
    expiresAt: plus(now, ttlMs),
    usedBy: null, usedAt: null, revokedAt: null,
  };
}

/** Used wins over revoked wins over expired: the most final fact is the state. */
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
