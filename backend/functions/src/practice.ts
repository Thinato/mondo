/**
 * Practice — FR-9. Four callables around one document per player,
 * `practice/{uid}`; the rules are in lib/practice.ts and this file is I/O.
 *
 * It is the daily's shape with the day taken out: `startPractice` and
 * `nextPractice` serve a challenge with a server `startedAt` the way `getRound`
 * does, and `submitPracticeGuess` grades one guess inside a transaction the way
 * `submitGuess` does, for the same two reasons (SEC-3, SEC-4).
 *
 * Two things are deliberately missing. **Nothing reaches `attempts`, `users` or
 * any board**: a practice session is scored for its own player and for nobody
 * else (FR-9.3), so there is no counter to bump and no fan-out to do. And
 * **there is no resume**: reopening the page starts a session, which overwrites
 * whatever was there. A lost practice run costs a player nothing, and the
 * alternative is a whole second entry path through a screen that has no state
 * worth defending.
 */

import { Timestamp } from "firebase-admin/firestore";
import { dailySubjects, db, ensureProfile, practiceRef, userRef } from "./db";
import { requireCanPlay } from "./lib/authz";
import { callable } from "./lib/callable";
import { mondoError } from "./lib/errors";
import { kindById } from "./lib/kinds";
import {
  applyPracticeGuess, endSession, giveUpPractice as giveUpSession, newSession, practiceView, serveNext,
  PRACTICE_EXCLUSION_DAYS, type PracticeSession, type PracticeView,
} from "./lib/practice";
import { puzzleIdAt } from "./lib/puzzle-day";
import type { Profile } from "./lib/round";
import { nextDay } from "./lib/standings";
import { requireObject } from "./lib/validate";

/**
 * D-60 — the daily subjects a session will not ask about: today's, and the
 * week ahead. Without this, "practise the `gdp` kind" is a machine for grinding
 * out today's answer: the daily's `gdp` prompt names its country, so a player
 * need only click through the pool until that country comes up and read the
 * figure off the reveal. `capital` leaks the same way in the other direction.
 *
 * Read once, at the start of the session, and carried on the document: eight
 * documents per session rather than eight per challenge. A session left open
 * across the week would go stale, and a stale window is still seven days wide
 * measured from a day that has passed — it under-blocks the far end by a day
 * at a time, and never under-blocks today.
 */
async function withheld(now: Timestamp): Promise<string[]> {
  const today = puzzleIdAt(now.toDate());
  let to = today;
  for (let i = 0; i < PRACTICE_EXCLUSION_DAYS; i++) to = nextDay(to);
  return [...(await dailySubjects(today, to))];
}

/**
 * startPractice({ kind }) — a new session of one kind, showing its first
 * challenge. Replaces whatever session the player had: one at a time, and the
 * old one was worth nothing to anyone.
 *
 * Invite-only, like the daily (FR-1.7, D-28). Practice is a thing the game
 * gives its players, not a demo; letting any signed-in Google account drill
 * against the pool would also let it write to Firestore for free.
 */
export const startPractice = callable<{ kind: unknown }, PracticeView>(async (uid, data) => {
  const raw = requireObject(data).kind;
  if (typeof raw !== "string") throw mondoError("invalid-argument", "Choose a challenge kind.");
  // kindById rejects an unknown id (SEC-8), which is the whole validation a
  // kind name needs: the set of kinds IS the schema.
  const kind = kindById(raw).id;
  const now = Timestamp.now();

  const profile = await db().runTransaction((tx) => ensureProfile(tx, uid, now));
  requireCanPlay(profile);

  const session = newSession(uid, kind, await withheld(now), now);
  await practiceRef(uid).set(session);
  return practiceView(session, now);
});

/**
 * nextPractice({}) — the next challenge, and the point at which the one on
 * screen is counted. In a transaction because it both reads the totals and
 * writes them.
 */
export const nextPractice = callable<unknown, PracticeView>(async (uid) => {
  const now = Timestamp.now();
  const session = await db().runTransaction(async (tx) => {
    const [snap, profileSnap] = await Promise.all([tx.get(practiceRef(uid)), tx.get(userRef(uid))]);
    requireCanPlay(profileSnap.exists ? (profileSnap.data() as Profile) : null);
    if (!snap.exists) throw mondoError("not-found", "Start a practice session first.");
    const after = serveNext(snap.data() as PracticeSession, now);
    tx.set(practiceRef(uid), after);
    return after;
  });
  return practiceView(session, now);
});

/**
 * submitPracticeGuess({ guess }) — one guess, evaluated server-side (SEC-1).
 * `guess` is untyped here for the same reason it is in the daily: only the kind
 * knows what a guess is, and a numeric kind will not take a country code.
 */
export const submitPracticeGuess = callable<{ guess: unknown }, PracticeView>(async (uid, data) => {
  const raw = requireObject(data).guess;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw mondoError("invalid-argument", "A guess must be a country or a number.");
  }
  const now = Timestamp.now();
  const session = await db().runTransaction(async (tx) => {
    const [snap, profileSnap] = await Promise.all([tx.get(practiceRef(uid)), tx.get(userRef(uid))]);
    requireCanPlay(profileSnap.exists ? (profileSnap.data() as Profile) : null);
    if (!snap.exists) throw mondoError("not-found", "Start a practice session first.");
    const after = applyPracticeGuess(snap.data() as PracticeSession, raw, now);
    tx.set(practiceRef(uid), after);
    return after;
  });
  return practiceView(session, now);
});

/**
 * giveUpPractice({}) — end the challenge on screen at zero and see the answer
 * (FR-2.13, D-61). The session runs on; `nextPractice` counts this challenge
 * like any other finished one.
 */
export const giveUpPractice = callable<unknown, PracticeView>(async (uid) => {
  const now = Timestamp.now();
  const session = await db().runTransaction(async (tx) => {
    const [snap, profileSnap] = await Promise.all([tx.get(practiceRef(uid)), tx.get(userRef(uid))]);
    requireCanPlay(profileSnap.exists ? (profileSnap.data() as Profile) : null);
    if (!snap.exists) throw mondoError("not-found", "Start a practice session first.");
    const after = giveUpSession(snap.data() as PracticeSession, now);
    tx.set(practiceRef(uid), after);
    return after;
  });
  return practiceView(session, now);
});

/**
 * endPractice({}) — leave, and see the total (FR-9.4). The session document
 * stays: it is the player's own, it is one document, and the next
 * `startPractice` overwrites it. Deleting it would only make `deleteAccount`'s
 * job look smaller than it is.
 */
export const endPractice = callable<unknown, PracticeView>(async (uid) => {
  const now = Timestamp.now();
  const session = await db().runTransaction(async (tx) => {
    const snap = await tx.get(practiceRef(uid));
    if (!snap.exists) throw mondoError("not-found", "Start a practice session first.");
    const after = endSession(snap.data() as PracticeSession, now);
    tx.set(practiceRef(uid), after);
    return after;
  });
  return practiceView(session, now);
});
