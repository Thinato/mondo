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
  applyGuess, giveUp as giveUpAttempt, newAttempt, puzzleItems, recordCompletion, roundView,
  type Attempt, type Profile, type Puzzle, type RoundView,
} from "./lib/round";
import { requireObject, requirePuzzleId } from "./lib/validate";

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
 * submitGuess({ puzzleId, guess }) — one guess, evaluated server-side (SEC-1).
 *
 * The guess is passed to the kind unvalidated beyond its shape, because only
 * the kind knows what a guess IS: a country code for three of them, a number
 * for `gdp` (D-53). Every kind validates and throws typed errors (SEC-8), which
 * is where that rule has always lived.
 *
 * `code` is still accepted as a name for it. The site is served from a CDN, so
 * a browser holding yesterday's `game.js` would otherwise lose its lunch.
 * Read-modify-write in a transaction so concurrent calls cannot exceed six
 * guesses (SEC-4); the 400 ms floor is enforced against the previous guess's
 * server timestamp (SEC-5).
 */
export const submitGuess = callable<{ puzzleId: unknown; guess?: unknown; code?: unknown }, RoundView>(async (uid, data) => {
  const input = requireObject(data);
  const puzzleId = requirePuzzleId(input.puzzleId);
  const raw = input.guess ?? input.code;
  // A shape guard only: anything that is not a scalar cannot be any kind's
  // guess, and rejecting it here costs no reads.
  if (typeof raw !== "string" && typeof raw !== "number") throw mondoError("invalid-argument", "A guess must be a country or a number.");
  const now = Timestamp.now();
  const puzzle = await loadOpenPuzzle(puzzleId, now);

  const { attempt, profile } = await db().runTransaction(async (tx) => {
    // Every read before the first write (Firestore transaction rule).
    const [snap, profileSnap] = await Promise.all([tx.get(attemptRef(uid, puzzleId)), tx.get(userRef(uid))]);
    // The invitation is checked before the attempt lookup, so an uninvited
    // caller hears `not-invited` rather than `not-found` (FR-1.7, D-28).
    const before = profileSnap.exists ? (profileSnap.data() as Profile) : null;
    requireCanPlay(before); // losing your last group closes the round too
    if (!snap.exists) throw mondoError("not-found", "Call getRound before guessing.");
    const attempt = applyGuess(snap.data() as Attempt, puzzleItems(puzzle), raw, now);
    tx.set(attemptRef(uid, puzzleId), attempt);
    // The streak the caller is told about must be the one this guess just
    // wrote, not the one it replaced (D-57). The guess that ends a day is
    // exactly the moment the panel beside the game should tick over, and
    // returning the stale profile would make it tick on the next reload
    // instead — which reads as a bug even though nothing is wrong.
    const done = attempt.finishedAt !== null && before !== null;
    const profile = done ? recordCompletion(before!, attempt) : before;
    if (done) tx.set(userRef(uid), profile!);
    return { attempt, profile };
  });

  return roundView(attempt, puzzle, now, profile);
});

/**
 * giveUp({ puzzleId }) — end today's current challenge at zero and see the
 * answer (FR-2.13, D-61).
 *
 * The same transaction `submitGuess` runs, minus the guess: the same gate, the
 * same attempt document, the same `recordCompletion` on the challenge that ends
 * the day — because giving up on the last one finishes the day exactly as a
 * final wrong guess does, and the profile it returns must be the one this call
 * just wrote (D-58).
 */
export const giveUp = callable<{ puzzleId: unknown }, RoundView>(async (uid, data) => {
  const puzzleId = requirePuzzleId(requireObject(data).puzzleId);
  const now = Timestamp.now();
  const puzzle = await loadOpenPuzzle(puzzleId, now);

  const { attempt, profile } = await db().runTransaction(async (tx) => {
    const [snap, profileSnap] = await Promise.all([tx.get(attemptRef(uid, puzzleId)), tx.get(userRef(uid))]);
    const before = profileSnap.exists ? (profileSnap.data() as Profile) : null;
    requireCanPlay(before);
    if (!snap.exists) throw mondoError("not-found", "Call getRound before giving up.");
    const attempt = giveUpAttempt(snap.data() as Attempt, puzzleItems(puzzle), now);
    tx.set(attemptRef(uid, puzzleId), attempt);
    const done = attempt.finishedAt !== null && before !== null;
    const profile = done ? recordCompletion(before!, attempt) : before;
    if (done) tx.set(userRef(uid), profile!);
    return { attempt, profile };
  });

  return roundView(attempt, puzzle, now, profile);
});
