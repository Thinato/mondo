/**
 * getRound / submitGuess — the daily round (02-architecture.md §4).
 *
 * All state changes happen inside Firestore transactions on the deterministic
 * attempt document `attempts/{uid}_{puzzleId}` (SEC-4), with server timestamps
 * only (SEC-3). The pure rules live in lib/round.ts; this file is I/O.
 */

import { getFirestore, Timestamp, type Transaction } from "firebase-admin/firestore";
import { callable } from "./lib/callable";
import { mondoError } from "./lib/errors";
import { puzzleIdAt } from "./lib/puzzle-day";
import {
  applyGuess, newAttempt, newProfile, recordCompletion, roundView,
  type Attempt, type Profile, type Puzzle, type RoundView,
} from "./lib/round";
import { requireCountryCode, requireObject, requirePuzzleId } from "./lib/validate";

const db = () => getFirestore();
const attemptRef = (uid: string, puzzleId: string) => db().doc(`attempts/${uid}_${puzzleId}`);
const profileRef = (uid: string) => db().doc(`users/${uid}`);

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

/** FR-1.2 — first contact creates the profile with a random handle. */
async function ensureProfile(tx: Transaction, uid: string, now: Timestamp): Promise<Profile> {
  const snap = await tx.get(profileRef(uid));
  if (snap.exists) return snap.data() as Profile;
  const profile = newProfile(now);
  tx.create(profileRef(uid), profile);
  return profile;
}

/**
 * getRound({ puzzleId? }) — the round the caller should see; creates the
 * attempt with a server `startedAt` on first call, which starts the clock.
 */
export const getRound = callable<{ puzzleId?: unknown } | undefined, RoundView>(async (uid, data) => {
  const input = data === undefined ? {} : requireObject(data);
  const requested = input.puzzleId === undefined ? undefined : requirePuzzleId(input.puzzleId);
  const now = Timestamp.now();
  const puzzle = await loadOpenPuzzle(requested, now);

  const attempt = await db().runTransaction(async (tx) => {
    const snap = await tx.get(attemptRef(uid, puzzle.puzzleId));
    await ensureProfile(tx, uid, now); // reads, then maybe creates — after every read above
    if (snap.exists) return snap.data() as Attempt;
    const fresh = newAttempt(uid, puzzle.puzzleId, now);
    tx.create(attemptRef(uid, puzzle.puzzleId), fresh);
    return fresh;
  });

  return roundView(attempt, puzzle, now);
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
    const snap = await tx.get(attemptRef(uid, puzzleId));
    if (!snap.exists) throw mondoError("not-found", "Call getRound before guessing.");
    const before = snap.data() as Attempt;
    const after = applyGuess(before, puzzle, code, now);
    // Firestore transactions demand every read before the first write, so the
    // profile is read (when needed) before the attempt is written.
    const profile = after.finishedAt !== null ? await ensureProfile(tx, uid, now) : null;
    tx.set(attemptRef(uid, puzzleId), after);
    if (profile !== null) tx.set(profileRef(uid), recordCompletion(profile, after));
    return after;
  });

  return roundView(attempt, puzzle, now);
});
