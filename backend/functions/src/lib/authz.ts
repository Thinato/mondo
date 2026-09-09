/**
 * Who may do what (FR-7, FR-1.7). Pure; every handler calls one of these before
 * its first Firestore read of anyone else's data.
 *
 *   admin      > organizer > player            (FR-7.1)
 *   play       = not a bare player, or in ≥ 1 group   (D-28)
 *   manage a group = own it, whatever the role         (FR-7.5)
 */

import { mondoError } from "./errors";
import type { Profile, Role } from "./round";

export type { Role };

type RoleBits = Pick<Profile, "role" | "groups"> | null | undefined;

/** Phase 1 profiles have no `role`; they are players. */
export function roleOf(profile: RoleBits): Role {
  return profile?.role ?? "player";
}

export function groupsOf(profile: RoleBits): string[] {
  return profile?.groups ?? [];
}

export function isAdmin(profile: RoleBits): boolean {
  return roleOf(profile) === "admin";
}

/** D-28 / FR-1.7 */
export function canPlay(profile: RoleBits): boolean {
  return roleOf(profile) !== "player" || groupsOf(profile).length > 0;
}

/** FR-4.1 as amended */
export function canCreateGroup(profile: RoleBits): boolean {
  return roleOf(profile) !== "player";
}

export function isOwner(group: { ownerUid: string }, uid: string): boolean {
  return group.ownerUid === uid;
}

export function requireCanPlay(profile: RoleBits): void {
  if (!canPlay(profile)) throw mondoError("not-invited", "You need an invitation to play.");
}

export function requireAdmin(profile: RoleBits): void {
  if (!isAdmin(profile)) throw mondoError("permission-denied", "Admins only.");
}

export function requireOwner(group: { ownerUid: string }, uid: string): void {
  if (!isOwner(group, uid)) throw mondoError("permission-denied", "Only the group owner can do that.");
}
