/**
 * getRound / submitGuess — the daily round (02-architecture.md §4).
 *
 * A day is a card of one challenge per kind since D-52, so `submitGuess` walks
 * a cursor rather than a single guess list. The callable's shape did not change:
 * every shipped kind still takes a country code as its guess.
 *
 * All state changes happen inside Firestore transactions on the deterministic
 * attempt document `attempts/{uid}_{puzzleId}` (SEC-4), with server timestamps
 * only (SEC-3). The pure rules live in lib/round.ts; this file is I/O.
 *
 * Phase 2: playing needs an invitation (FR-1.7, D-28). The gate runs before the
 * attempt is created, so an outsider never starts a clock.
 */

import { Timestamp } from "firebase-admin/firestore";
import { attemptRef, db, ensureProfile, userRef } from "./db";
import { requireCanPlay } from "./lib/authz";
import { callable } from "./lib/callable";
import { mondoError } from "./lib/errors";
import { puzzleIdAt } from "./lib/puzzle-day";
import {
  applyGuess, newAttempt, puzzleItems, recordCompletion, roundView,
  type Attempt, type Profile, type Puzzle, type RoundView,
} from "./lib/round";
import { requireCountryCode, requireObject, requirePuzzleId } from "./lib/validate";

/**
 * Phase 1 serves only today's puzzle (FR-2.12 archive play is Phase 4).
 * Reads `puzzles/{id}` with the Admin SDK — clients cannot (SEC-7).
 */
async function loadOpenPuzzle(requested: string | undefined, now: Timestamp): Promise<Puzzle> {
  const today = puzzleIdAt(now.toDate());
  if (requested !== undefined && requested !== today) {
    throw mondoError("puzzle-not-open", `Only today's puzzle (${today}) is open.`);
  }
  const snap = await db().doc(`puzzles/${today}`).get();
  if (!snap.exists) throw mondoError("not-found", `No puzzle scheduled for ${today}.`);
  return snap.data() as Puzzle;
}

/**
 * getRound({ puzzleId? }) — the round the caller should see; creates the
 * attempt with a server `startedAt` on first call, which starts the clock.
 */
export const getRound = callable<{ puzzleId?: unknown } | null | undefined, RoundView>(async (uid, data) => {
  // The web SDK sends `null` when the caller passes no argument.
  const input = data == null ? {} : requireObject(data);
  const requested = input.puzzleId === undefined ? undefined : requirePuzzleId(input.puzzleId);
  const now = Timestamp.now();

  // The profile is created in its own transaction so that an uninvited sign-in
  // still leaves a profile for the admin to see, while the gate keeps them from
  // starting a round (FR-1.7). Both come before the puzzle is read: an outsider
  // costs one read, not two, and hears the same answer whatever is scheduled.
  const profile = await db().runTransaction((tx) => ensureProfile(tx, uid, now));
  requireCanPlay(profile);
  const puzzle = await loadOpenPuzzle(requested, now);

  const attempt = await db().runTransaction(async (tx) => {
    const snap = await tx.get(attemptRef(uid, puzzle.puzzleId));
    if (snap.exists) return snap.data() as Attempt;
    const fresh = newAttempt(uid, puzzle.puzzleId, puzzleItems(puzzle), now);
    tx.create(attemptRef(uid, puzzle.puzzleId), fresh);
    return fresh;
  });

  return roundView(attempt, puzzle, now, profile);
});

/**
 * submitGuess({ puzzleId, code }) — one guess, evaluated server-side (SEC-1).
 * Read-modify-write in a transaction so concurrent calls cannot exceed six
 * guesses (SEC-4); the 400 ms floor is enforced against the previous guess's
 * server timestamp (SEC-5).
 */
export const submitGuess = callable<{ puzzleId: unknown; code: unknown }, RoundView>(async (uid, data) => {
  const input = requireObject(data);
  const puzzleId = requirePuzzleId(input.puzzleId);
  const code = requireCountryCode(input.code);
  const now = Timestamp.now();
  const puzzle = await loadOpenPuzzle(puzzleId, now);

  const attempt = await db().runTransaction(async (tx) => {
    // Every read before the first write (Firestore transaction rule).
    const [snap, profileSnap] = await Promise.all([tx.get(attemptRef(uid, puzzleId)), tx.get(userRef(uid))]);
    // The invitation is checked before the attempt lookup, so an uninvited
    // caller hears `not-invited` rather than `not-found` (FR-1.7, D-28).
    const profile = profileSnap.exists ? (profileSnap.data() as Profile) : null;
    requireCanPlay(profile); // losing your last group closes the round too
    if (!snap.exists) throw mondoError("not-found", "Call getRound before guessing.");
    const before = snap.data() as Attempt;
    const after = applyGuess(before, puzzleItems(puzzle), code, now);
    tx.set(attemptRef(uid, puzzleId), after);
    if (after.finishedAt !== null && profile !== null) tx.set(userRef(uid), recordCompletion(profile, after));
    return after;
  });

  return roundView(attempt, puzzle, now);
});
