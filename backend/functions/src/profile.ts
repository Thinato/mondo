/**
 * updateProfile({ displayName?, locale? }) — FR-1.3.
 * getProfile({ uid?, day? }) — FR-13, below.
 *
 * A callable rather than a direct Firestore write so the client never needs the
 * Firestore SDK (NFR-5: the game payload stays small). The rules allow the same
 * two fields for the same player, so either path is equally safe.
 *
 * D-26: the new name is copied to the caller's member documents so boards show
 * it at once; per-group uniqueness is resolved when the board is read.
 */

import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { attemptRef, db, memberRef, puzzleDays, userRef } from "./db";
import { groupsOf } from "./lib/authz";
import { callable } from "./lib/callable";
import { mondoError } from "./lib/errors";
import { todayState } from "./lib/groups";
import { PROFILE_DAYS, profileView, recapAllowed, recapGate, recapView, type DayRecapView, type ProfileView } from "./lib/profile";
import { newProfile, type Attempt, type Profile, type Puzzle } from "./lib/round";
import { windowDays } from "./lib/standings";
import { requireDisplayName, requireLocale, requireObject, requirePuzzleId, requireUid } from "./lib/validate";

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
      // Reads first: a group id left in the index with no member document
      // behind it must not abort the rename (tx.update requires the document).
      const gids = patch.displayName === undefined ? [] : groupsOf(current);
      const members = gids.length === 0 ? [] : await tx.getAll(...gids.map((gid) => memberRef(gid, uid)));
      tx.set(userRef(uid), next);
      for (const m of members) if (m.exists) tx.update(m.ref, { displayName: patch.displayName });
      return { displayName: next.displayName, locale: next.locale };
    });
  },
);

/**
 * getProfile({ uid?, day? }) — FR-13, D-97. Anyone signed in may read anyone's.
 *
 * Without `day`: the profile and its last 30 days, from ONE getAll — the user
 * document, the viewer's own today attempt (FR-4.11 needs to know whether the
 * viewer has finished; skipped for the owner, whose slot it would be), and the
 * 30 attempts by id. 32 billed reads, 31 for your own, missing documents
 * included. Nothing is stored.
 *
 * With `day`: that day's recap. `recapAllowed` refuses a day outside the window
 * and anyone's today but the owner's BEFORE anything is read, and the puzzle —
 * the only document here that holds an answer — is read only after `recapGate` has
 * passed on the attempt. Do not read the two in parallel.
 */
export const getProfile = callable<{ uid?: unknown; day?: unknown }, ProfileView | DayRecapView>(async (caller, data) => {
  const input = requireObject(data);
  const uid = input.uid === undefined ? caller : requireUid(input.uid);
  const day = input.day === undefined ? null : requirePuzzleId(input.day);
  const now = Timestamp.now();
  const { today, closedDay } = puzzleDays(now);
  const isOwner = uid === caller;

  if (day !== null) {
    const v = { isOwner, today };
    let attempt: Attempt | null = null;
    try {
      // A day outside the window, or anyone's today but the owner's: refused before any read.
      if (recapAllowed(day, v)) {
        const snap = await attemptRef(uid, day).get();
        attempt = snap.exists ? (snap.data() as Attempt) : null;
      }
      recapGate(day, attempt, v); // the puzzle is read only past this line
    } catch (e) {
      logger.info("getProfile", { isOwner, recap: true, refused: true });
      throw e;
    }
    const puzzle = await db().doc(`puzzles/${day}`).get();
    logger.info("getProfile", { isOwner, recap: true, refused: false });
    return recapView(day, attempt, puzzle.exists ? (puzzle.data() as Puzzle) : null, v);
  }

  const days = windowDays(today, PROFILE_DAYS);
  const [user, ...rest] = await db().getAll(
    userRef(uid),
    ...(isOwner ? [] : [attemptRef(caller, today)]),
    ...days.map((d) => attemptRef(uid, d)),
  );
  const viewerToday = isOwner ? null : rest.shift();
  const view = profileView({
    uid,
    profile: user!.exists ? (user!.data() as Profile) : null,
    attempts: rest.map((s) => (s.exists ? (s.data() as Attempt) : null)),
    isOwner,
    today,
    closedDay,
    viewerFinishedToday: viewerToday?.exists ? todayState(viewerToday.data() as Attempt) === "finished" : false,
  });
  logger.info("getProfile", { isOwner, recap: false, rows: view.days.length });
  return view;
});
