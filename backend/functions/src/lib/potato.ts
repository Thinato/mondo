/**
 * Batata Quente — the turn-based country-naming race (FR-12.3). Pure: times are
 * epoch milliseconds from the SERVER clock (invariant 3), passed in.
 *
 * Players take turns in a fixed order. On your turn you name a country nobody
 * has named yet; the faster, the more it is worth. Naming one already on the
 * map, or something that is not a country, does NOT pass the turn — you are
 * told and you try again. Running out of time passes it for nothing.
 *
 * A round is over once every active player has had a turn, and each round is a
 * second shorter than the last, down to a floor of three: 20, 19, … 4, 3, 3, 3.
 *
 * There is no elimination. The game ends when every country is on the map, when
 * two full rounds go by with nobody naming anything, or when everyone has given
 * up — and the most points wins, ties to whoever spent less time answering.
 */

import { COUNTRIES } from "./countries";
import { mondoError } from "./errors";

export const FIRST_TURN_S = 20;
export const MIN_TURN_S = 3;
/** Points for an answer sent the instant the turn opened; the floor is 1. */
export const MAX_ANSWER_POINTS = 10;
/** How many silent rounds end the game. */
export const SILENT_ROUNDS = 2;

/** The whole pool: every country Mondo knows is a valid answer exactly once. */
export const POTATO_TOTAL = COUNTRIES.size;

export const turnLimitMs = (round: number): number => Math.max(MIN_TURN_S, FIRST_TURN_S + 1 - round) * 1000;

/** Linear in the time left, never below 1: a right answer is always worth something. */
export function pointsFor(elapsedMs: number, limitMs: number): number {
  const left = 1 - Math.min(Math.max(elapsedMs, 0), limitMs) / limitMs;
  return Math.max(1, Math.round(MAX_ANSWER_POINTS * left));
}

export interface PotatoScore {
  points: number;
  /** Sum of the time each accepted answer took — the tiebreak. */
  timeMs: number;
  named: number;
}

export type PotatoEnd = "map-full" | "silence" | "all-gave-up";

export interface PotatoState {
  order: string[];
  gaveUp: string[];
  round: number;
  turnIdx: number;
  turnUid: string | null;
  turnStartedAt: number;
  limitMs: number;
  deadline: number;
  /** Codes on the map, in the order they were named. Not secret: every unnamed country is a right answer. */
  named: string[];
  /** How many there are to name: the map is full at this many. */
  total: number;
  /** Consecutive turns that timed out. */
  passStreak: number;
  scores: Record<string, PotatoScore>;
  endedAt: number | null;
  endReason: PotatoEnd | null;
}

export function newPotato(order: readonly string[], now: number): PotatoState {
  if (order.length === 0) throw mondoError("invalid-argument", "A game needs players.");
  const limitMs = turnLimitMs(1);
  return {
    order: [...order],
    gaveUp: [],
    round: 1,
    turnIdx: 0,
    turnUid: order[0]!,
    turnStartedAt: now,
    limitMs,
    deadline: now + limitMs,
    named: [],
    total: POTATO_TOTAL,
    passStreak: 0,
    scores: Object.fromEntries(order.map((uid) => [uid, { points: 0, timeMs: 0, named: 0 }])),
    endedAt: null,
    endReason: null,
  };
}

const active = (s: PotatoState) => s.order.filter((uid) => !s.gaveUp.includes(uid));

function requireOpen(s: PotatoState): void {
  if (s.endedAt !== null) throw mondoError("already-completed", "This game is over.");
}

/** The next active player's turn, starting now. Wrapping past the end of the order closes a round. */
function advance(s: PotatoState, now: number): PotatoState {
  let idx = s.turnIdx;
  let round = s.round;
  for (let step = 0; step < s.order.length; step++) {
    idx++;
    if (idx >= s.order.length) {
      idx = 0;
      round++;
    }
    if (!s.gaveUp.includes(s.order[idx]!)) break;
  }
  const limitMs = turnLimitMs(round);
  return { ...s, round, turnIdx: idx, turnUid: s.order[idx]!, turnStartedAt: now, limitMs, deadline: now + limitMs };
}

function end(s: PotatoState, reason: PotatoEnd, now: number): PotatoState {
  return { ...s, turnUid: null, endedAt: now, endReason: reason };
}

/** Whether `code` may be named now — the checks an answer must pass, without applying it. */
export function checkTurn(s: PotatoState, uid: string, now: number): void {
  requireOpen(s);
  if (s.turnUid !== uid) throw mondoError("not-your-turn", "It is not your turn.");
  if (now >= s.deadline) throw mondoError("time-up", "Time is up.");
}

/** One accepted country. The caller has already matched the text and checked it is not on the map. */
export function applyAnswer(s: PotatoState, uid: string, code: string, now: number): { state: PotatoState; points: number } {
  checkTurn(s, uid, now);
  if (s.named.includes(code)) throw mondoError("already-named", "That country is already on the map.");
  // Never negative: two instances' clocks can disagree by a few ms.
  const elapsed = Math.max(0, now - s.turnStartedAt);
  const points = pointsFor(elapsed, s.limitMs);
  const prev = s.scores[uid] ?? { points: 0, timeMs: 0, named: 0 };
  const named = [...s.named, code];
  const after: PotatoState = {
    ...s,
    named,
    passStreak: 0,
    scores: { ...s.scores, [uid]: { points: prev.points + points, timeMs: prev.timeMs + elapsed, named: prev.named + 1 } },
  };
  return { state: named.length >= s.total ? end(after, "map-full", now) : advance(after, now), points };
}

/** The turn ran out. Idempotence is the caller's: it checks the room's version before calling. */
export function applyTimeout(s: PotatoState, now: number): PotatoState {
  requireOpen(s);
  if (now < s.deadline) throw mondoError("invalid-argument", "This turn has not run out.");
  const after = { ...s, passStreak: s.passStreak + 1 };
  if (after.passStreak >= SILENT_ROUNDS * active(after).length) return end(after, "silence", now);
  return advance(after, now);
}

/** A player stops playing: skipped from now on, keeps what they scored. */
export function giveUpPotato(s: PotatoState, uid: string, now: number): PotatoState {
  requireOpen(s);
  if (!s.order.includes(uid)) throw mondoError("permission-denied", "You are not in this game.");
  if (s.gaveUp.includes(uid)) return s;
  const after = { ...s, gaveUp: [...s.gaveUp, uid] };
  const left = active(after).length;
  if (left === 0) return end(after, "all-gave-up", now);
  // A silence that already covers everyone still playing is over too.
  if (after.passStreak >= SILENT_ROUNDS * left) return end(after, "silence", now);
  return after.turnUid === uid ? advance(after, now) : after;
}

/** Most points first, then least time spent answering. */
export function potatoRanking(s: PotatoState): string[] {
  return [...s.order].sort((a, b) => {
    const x = s.scores[a]!;
    const y = s.scores[b]!;
    return y.points - x.points || x.timeMs - y.timeMs;
  });
}
