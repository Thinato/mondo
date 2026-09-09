/**
 * deleteAccount({}) — FR-1.5. Sequential and idempotent: every step tolerates
 * what an earlier, interrupted run already removed, and the Auth record goes
 * last so a half-finished deletion can still be re-invoked by the same user.
 */

import { getAuth } from "firebase-admin/auth";
import { type Query } from "firebase-admin/firestore";
import { db, invitesCol, userRef } from "./db";
import { leaveTx } from "./groups";
import { groupsOf } from "./lib/authz";
import { callable } from "./lib/callable";
import type { Profile } from "./lib/round";

const BATCH = 400;

async function deleteAll(query: Query): Promise<void> {
  for (;;) {
    const snap = await query.limit(BATCH).get();
    if (snap.empty) return;
    const batch = db().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export const deleteAccount = callable<unknown, { ok: true }>(async (uid) => {
  // a. memberships, with D-23 succession per group.
  //
  // This trusts `users.groups` as the index of memberships. A member document
  // for a group the index never listed would survive, keeping a name on that
  // board — but the two are only ever written together inside a transaction, so
  // reaching that state needs a write from outside this code. Catching it would
  // mean a collection-group query on `members`, which needs a collection-group
  // scoped index and buys nothing against a state the code cannot produce.
  // `leaveTx` already heals the opposite drift (index listing a group with no
  // member document behind it).
  const profileSnap = await userRef(uid).get();
  for (const gid of groupsOf(profileSnap.exists ? (profileSnap.data() as Profile) : null)) {
    try {
      await db().runTransaction((tx) => leaveTx(tx, gid, uid));
    } catch (e) {
      if ((e as { details?: { code?: string } }).details?.code !== "not-found") throw e;
    }
  }

  // b. every invite that names them, in either field: pending ones stop working
  //    and spent ones stop carrying the uid (FR-1.5). A token whose document is
  //    gone is `invalid-invite` just like a consumed one.
  await deleteAll(invitesCol().where("createdBy", "==", uid));
  await deleteAll(invitesCol().where("usedBy", "==", uid));

  // c. every round they ever played
  await deleteAll(db().collection("attempts").where("uid", "==", uid));

  // d. the profile
  await userRef(uid).delete();

  // e. the Auth record, last
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
  }
  return { ok: true };
});
