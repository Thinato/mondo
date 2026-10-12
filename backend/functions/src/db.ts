/**
 * Firestore document references and the two or three reads every handler
 * shares. I/O only; no business rule lives here (CLAUDE.md conventions).
 */

import { getFirestore, Timestamp, type Transaction } from "firebase-admin/firestore";
import { PRACTICE_EXCLUSION_DAYS } from "./lib/practice";
import { puzzleIdAt } from "./lib/puzzle-day";
import { nextDay } from "./lib/standings";
import { newProfile, previousDay, puzzleItems, type Profile, type Puzzle } from "./lib/round";

export const db = () => getFirestore();

export const userRef = (uid: string) => db().doc(`users/${uid}`);
export const attemptRef = (uid: string, puzzleId: string) => db().doc(`attempts/${uid}_${puzzleId}`);
export const groupsCol = () => db().collection("groups");
export const groupRef = (gid: string) => groupsCol().doc(gid);
export const membersCol = (gid: string) => groupRef(gid).collection("members");
export const memberRef = (gid: string, uid: string) => membersCol(gid).doc(uid);
export const invitesCol = () => db().collection("invites");
export const inviteRef = (token: string) => invitesCol().doc(token);

// Tournaments (docs/06-tournaments.md §4). Top level, NOT under groups/{gid}:
// the cards hold answers and `groups/{gid}` is member-readable, Firestore does
// not delete subcollections with their parent, and the client never loads the
// Firestore SDK anyway, so `inGroup` would buy nothing (D-39).
export const tournamentsCol = () => db().collection("tournaments");
export const tournamentRef = (tid: string) => tournamentsCol().doc(tid);
export const roundsCol = (tid: string) => tournamentRef(tid).collection("rounds");
export const roundRef = (tid: string, n: number) => roundsCol(tid).doc(String(n));
/** Server-only, a sibling of `puzzles`: this is where the answers live (SEC-7, D-39). */
export const cardRef = (cardId: string) => db().collection("cards").doc(cardId);
/** A card in progress lives in `attempts` with no `puzzleId` field (D-40). */
export const playRef = (playDocId: string) => db().collection("attempts").doc(playDocId);
/**
 * One practice session per player (FR-9, D-60). A sibling of `puzzles` and
 * `cards` for the same reason they are: it holds the subject of the challenge
 * on screen, which IS the answer (SEC-1, SEC-7). Never in `attempts` — nothing
 * here is scored, shared or counted.
 */
export const practiceRef = (uid: string) => db().doc(`practice/${uid}`);
export const tournamentsOf = (gid: string) => tournamentsCol().where("groupId", "==", gid);
export const runningTournaments = () => tournamentsCol().where("status", "==", "running");

/**
 * Versus (FR-12, D-87). `rooms/{id}` and everything under it is readable by the
 * room's players — the one collection the client LISTENS to — so it must never
 * hold an answer. The Clássico card lives beside it in `roomSecrets`, which no
 * client can read, for the reason `cards` sits beside `tournaments` (D-39).
 */
export const roomRef = (id: string) => db().doc(`rooms/${id}`);
export const roomSubRef = (id: string, sub: "map" | "prompts", docId: string) => roomRef(id).collection(sub).doc(docId);
export const roomSecretsRef = (id: string) => db().doc(`roomSecrets/${id}`);

/** Pending = never used and never revoked; expiry is checked in memory (lib/invite.ts). */
export const pendingInvitesOf = (gid: string) =>
  invitesCol().where("groupId", "==", gid).where("usedBy", "==", null).where("revokedAt", "==", null);

/**
 * Every subject the daily schedule uses between two puzzle days, inclusive.
 *
 * Two features withhold a window of the schedule for the same reason — never
 * ask about a country the player is about to be asked about — and disagree
 * only on how wide it should be: tournaments take ±60 days (FR-5.2), because a
 * tournament is scored against other people; practice takes today to +7 days
 * (D-60), because it is scored against nobody and a wide window would empty
 * the pool it exists to drill. The window is the caller's; the read is shared.
 *
 * Admin SDK only, like every read of `puzzles` (SEC-7).
 */
export async function dailySubjects(from: string, to: string): Promise<Set<string>> {
  const snap = await db().collection("puzzles").where("puzzleId", ">=", from).where("puzzleId", "<=", to).get();
  return new Set(snap.docs.flatMap((d) => puzzleItems(d.data() as Puzzle).map((it) => it.subject)));
}

/**
 * D-60, D-91 — the daily subjects practice and Versus will not ask about: today's, and the
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
export async function dailyAhead(now: Timestamp): Promise<string[]> {
  const today = puzzleIdAt(now.toDate());
  let to = today;
  for (let i = 0; i < PRACTICE_EXCLUSION_DAYS; i++) to = nextDay(to);
  return [...(await dailySubjects(today, to))];
}

/** The live puzzle day and the last closed one (D-25), from the server clock. */
export function puzzleDays(now: Timestamp): { today: string; closedDay: string } {
  const today = puzzleIdAt(now.toDate());
  return { today, closedDay: previousDay(today) };
}

/** FR-1.2 — first contact creates the profile with a random handle. Reads, then maybe creates. */
export async function ensureProfile(tx: Transaction, uid: string, now: Timestamp): Promise<Profile> {
  const snap = await tx.get(userRef(uid));
  if (snap.exists) return snap.data() as Profile;
  const profile = newProfile(now);
  tx.create(userRef(uid), profile);
  return profile;
}
