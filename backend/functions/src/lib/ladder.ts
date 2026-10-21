/**
 * The Fronteiras ladder (FR-15.7–15.9, D-110, D-111). Pure: `now` is epoch
 * milliseconds from the SERVER clock (invariant 3), passed in.
 *
 * A rated game updates both players' `users/{uid}.fronteiras` once: each is
 * first grown by the whole days since their last game (`preRate`), then rated
 * on this one game without a second inflation. The pair cap stops two accounts
 * farming each other, and the queue window widens the longer someone waits.
 */

import { glicko2, preRate, PROVISIONAL_RD, START, TAU, type Rating } from "./glicko";

/** Rated games against the same opponent allowed in `PAIR_WINDOW_MS`. */
export const PAIR_CAP = 3;
export const PAIR_WINDOW_MS = 86_400_000;
/** A queue slot not polled for this long is someone who left (D-111). */
export const QUEUE_STALE_MS = 25_000;
/** How many games `history` keeps, newest first. */
export const HISTORY_MAX = 30;
const DAY_MS = 86_400_000;

/** `users/{uid}.fronteiras`. `recent` is never public; `history.opp` is a display name. */
export interface LadderRecord extends Rating {
  settled: boolean;
  games: number;
  lastPlayedAt: number;
  history: { at: number; rating: number; opp: string; result: "w" | "d" | "l" }[];
  recent: { opp: string; at: number }[];
}

export function newRecord(): LadderRecord {
  return { ...START, settled: false, games: 0, lastPlayedAt: 0, history: [], recent: [] };
}

/** True once `rec` has played `oppUid` `PAIR_CAP` rated times in the last 24 h. */
export function pairCapped(rec: LadderRecord | undefined, oppUid: string, now: number): boolean {
  const n = (rec?.recent ?? []).filter((r) => r.opp === oppUid && now - r.at < PAIR_WINDOW_MS).length;
  return n >= PAIR_CAP;
}

/**
 * Rate one finished game. `score` is A's: 1 A won, 0.5 draw, 0 B won. Returns
 * both new records and both ratings before and after, for the room's result.
 */
export function rateGame(
  recA: LadderRecord | undefined,
  recB: LadderRecord | undefined,
  score: number,
  now: number,
  names: { a: string; b: string },
  uids: { a: string; b: string },
) {
  const pre = (rec: LadderRecord | undefined) =>
    rec ? preRate(rec, Math.max(0, Math.floor((now - rec.lastPlayedAt) / DAY_MS))) : START;
  const pA = pre(recA);
  const pB = pre(recB);

  const next = (rec: LadderRecord, p: Rating, opp: Rating, s: number, oppName: string, oppUid: string): LadderRecord => {
    const r = glicko2(p, [{ rating: opp.rating, rd: opp.rd, score: s }], TAU, false);
    const result: "w" | "d" | "l" = s === 1 ? "w" : s === 0 ? "l" : "d";
    return {
      ...r,
      settled: r.rd <= PROVISIONAL_RD,
      games: rec.games + 1,
      lastPlayedAt: now,
      history: [{ at: now, rating: r.rating, opp: oppName, result }, ...rec.history].slice(0, HISTORY_MAX),
      recent: [...rec.recent.filter((x) => now - x.at < PAIR_WINDOW_MS), { opp: oppUid, at: now }],
    };
  };
  const a = next(recA ?? newRecord(), pA, pB, score, names.b, uids.b);
  const b = next(recB ?? newRecord(), pB, pA, 1 - score, names.a, uids.a);
  return { a, b, before: { a: pA.rating, b: pB.rating }, after: { a: a.rating, b: b.rating } };
}

/** The rating gap a waiting player accepts: 150, plus 50 for every 10 s waited. */
export function queueWindow(waitMs: number): number {
  return 150 + 50 * Math.floor(waitMs / 10_000);
}

/**
 * The nearest-rated live queue slot both sides' windows allow, or null.
 * The wider of the two windows decides, so a long wait on either side helps.
 */
export function pickOpponent<C extends { id: string; uid: string; rating: number; since: number; seenAt: number }>(
  me: { uid: string; rating: number; since: number },
  candidates: C[],
  now: number,
): C | null {
  let best: C | null = null;
  for (const c of candidates) {
    if (c.uid === me.uid || now - c.seenAt > QUEUE_STALE_MS) continue;
    const gap = Math.abs(c.rating - me.rating);
    if (gap > Math.max(queueWindow(now - me.since), queueWindow(now - c.since))) continue;
    if (!best || gap < Math.abs(best.rating - me.rating)) best = c;
  }
  return best;
}
