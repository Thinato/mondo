/**
 * updateProfile({ displayName?, locale? }) — FR-1.3.
 *
 * A callable rather than a direct Firestore write so the client never needs the
 * Firestore SDK (NFR-5: the game payload stays small). The rules allow the same
 * two fields for the same player, so either path is equally safe.
 *
 * D-26: the new name is copied to the caller's member documents so boards show
 * it at once; per-group uniqueness is resolved when the board is read.
 */

import { Timestamp } from "firebase-admin/firestore";
import { db, memberRef, userRef } from "./db";
import { groupsOf } from "./lib/authz";
import { callable } from "./lib/callable";
import { mondoError } from "./lib/errors";
import { newProfile, type Profile } from "./lib/round";
import { requireDisplayName, requireLocale, requireObject } from "./lib/validate";

export const updateProfile = callable<{ displayName?: unknown; locale?: unknown }, { displayName: string; locale: string }>(
  async (uid, data) => {
    const input = requireObject(data);
    const patch: Partial<Pick<Profile, "displayName" | "locale">> = {};
    if (input.displayName !== undefined) patch.displayName = requireDisplayName(input.displayName);
    if (input.locale !== undefined) patch.locale = requireLocale(input.locale);
    if (Object.keys(patch).length === 0) throw mondoError("invalid-argument", "Nothing to update.");

    return db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef(uid));
      const current = snap.exists ? (snap.data() as Profile) : newProfile(Timestamp.now());
      const next = { ...current, ...patch };
      tx.set(userRef(uid), next);
      if (patch.displayName !== undefined) {
        for (const gid of groupsOf(current)) tx.update(memberRef(gid, uid), { displayName: patch.displayName });
      }
      return { displayName: next.displayName, locale: next.locale };
    });
  },
);
