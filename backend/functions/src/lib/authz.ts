/**
 * Who may do what (FR-7, FR-10). Pure; every handler calls one of these before
 * its first Firestore read of anyone else's data.
 *
 *   rank: admin | invited | subscriber | user | guest       (FR-10.1, D-84)
 *   play           = everyone                               (D-84 reversed D-28)
 *   create a group = admin, invited, subscriber
 *   invite         = own the group AND be able to create one (FR-10.3)
 *   join a group   = anyone signed in with Google
 *   manage a group = own it, whatever the rank              (FR-7.5)
 *
 * Only `role` is stored. A guest is a sign-in, not a profile: it stops being one
 * the moment the account links Google, so it is read off the auth token. A
 * subscriber is a date, not a role: it expires on its own at
 * `currentPeriodEnd`, without waiting for a webhook to demote anybody.
 */

import type { Timestamp } from "firebase-admin/firestore";
import { mondoError } from "./errors";
import type { Profile, Role } from "./round";

export type { Role };
export type Rank = "admin" | "invited" | "subscriber" | "user" | "guest";

type RoleBits = Pick<Profile, "role" | "groups"> | null | undefined;
type RankBits = Pick<Profile, "role" | "groups" | "subscription"> | null | undefined;

/** Stripe's statuses that still owe the subscriber an ad-free month (FR-11). */
const PAID = new Set(["active", "trialing"]);

/**
 * The stored role, with the two pre-D-84 values read the way
 * tools/migrate-tiers.mjs writes them: an organizer, or a player somebody had
 * let into a group, was invited; a player nobody let in never was. Phase 1
 * profiles carry no role and read as that player. Once the migration has run
 * nothing legacy is left to read, and a `user` who joins a group stays a user —
 * that is the closed list (D-84).
 */
export function roleOf(profile: RoleBits): Role {
  const role = profile?.role;
  if (role === "admin" || role === "invited" || role === "user") return role;
  if (role === "organizer") return "invited";
  return groupsOf(profile).length > 0 ? "invited" : "user";
}

export function groupsOf(profile: RoleBits): string[] {
  return profile?.groups ?? [];
}

export function isAdmin(profile: RoleBits): boolean {
  return roleOf(profile) === "admin";
}

/**
 * `signInProvider` is the token's `firebase.sign_in_provider`; see callable.ts.
 *
 * An anonymous sign-in is a guest whatever the profile says, and that comes
 * first on purpose: whatever was granted to that uid — a role, a subscription —
 * belongs to an identity one cleared cookie from vanishing, and it takes effect
 * the moment the account links Google, which keeps the uid (FR-10.1, FR-10.5).
 */
export function rankOf(profile: RankBits, signInProvider: string | undefined, now: Timestamp): Rank {
  if (signInProvider === "anonymous") return "guest";
  const role = roleOf(profile);
  if (role !== "user") return role;
  const sub = profile?.subscription;
  // A malformed period end must not throw here: rankOf runs on every screen,
  // so a bad webhook write would lock the player out of the game entirely.
  const end = sub?.currentPeriodEnd;
  if (sub && PAID.has(sub.status) && typeof end?.toMillis === "function" && end.toMillis() > now.toMillis()) return "subscriber";
  return "user";
}

export function canCreateGroup(rank: Rank): boolean {
  return rank === "admin" || rank === "invited" || rank === "subscriber";
}

/** A group needs an identity that outlives the browser it was made in. */
export function canJoinGroup(rank: Rank): boolean {
  return rank !== "guest";
}

/** Not a security control — anyone can block ads. It decides what is drawn. */
export function showsAds(rank: Rank, profile: Pick<Profile, "showAds"> | null | undefined): boolean {
  if (rank === "admin") return profile?.showAds === true;
  return rank === "user" || rank === "guest";
}

export function isOwner(group: { ownerUid: string }, uid: string): boolean {
  return group.ownerUid === uid;
}

export function requireAdmin(profile: RoleBits): void {
  if (!isAdmin(profile)) throw mondoError("permission-denied", "Admins only.");
}

export function requireOwner(group: { ownerUid: string }, uid: string): void {
  if (!isOwner(group, uid)) throw mondoError("permission-denied", "Only the group owner can do that.");
}

export function requireCanCreateGroup(rank: Rank): void {
  if (!canCreateGroup(rank)) throw mondoError("permission-denied", "Creating groups and inviting need an invitation or a subscription.");
}

export function requireCanJoinGroup(rank: Rank): void {
  if (!canJoinGroup(rank)) throw mondoError("permission-denied", "Sign in with Google to join a group.");
}
