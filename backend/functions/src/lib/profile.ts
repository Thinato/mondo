/**
 * A player's profile (FR-13, D-97): the last 30 days of their daily, read on
 * view, stored nowhere. Pure, so the one rule that matters can be tested
 * exhaustively — **an open day's answers never reach anyone but its finisher**.
 *
 * Why the list is safe by construction: an attempt carries no answer. Its items
 * hold the kind, the guesses, solved and points; the subjects live on
 * `puzzles/{id}`. So rows, stats, chart and grid are built from attempts alone,
 * and only `recapView` — behind `recapGate` — ever sees a puzzle. Do not make
 * recaps eager: that would put a gate on every row instead of one gate on one read.
 */

import { mondoError } from "./errors";
import { compass8 } from "./geo";
import { resultOf } from "./groups";
import { KIND_IDS, kindById, type KindId, type Reveal } from "./kinds";
import {
  guessView, isChoiceGuess, isNumberGuess, maxPointsFor, puzzleItems, upgradeAttempt,
  type Attempt, type GuessView, type Profile, type Puzzle,
} from "./round";
import { shareGrid, type ItemForShare } from "./scoring";
import { effectiveStreak, windowDays } from "./standings";

/** How far back a profile looks (FR-13.2). The trend splits it in two halves. */
export const PROFILE_DAYS = 30;
/** A half with fewer of a kind than this says nothing about that kind. */
export const TREND_MIN_ITEMS = 3;
/** Average points per challenge must move at least this much to be a trend. */
export const TREND_FLAT_BELOW = 0.5;

/**
 * What a viewer may see of one day.
 *
 * - `hidden`: not a row. Unfinished days (past or present) are not rows — the
 *   boards ignore them too (`resultOf`) — and nothing after today exists yet.
 * - `score`: points and grid, no recap. Another player's today, once the viewer
 *   has finished today too (FR-4.11's rule, the group board's).
 * - `full`: the recap may be fetched. Any closed day, and the owner's own today
 *   once finished — which is exactly what the daily already shows them.
 *
 * A non-owner NEVER gets `full` for today, whatever the viewer has done: today's
 * recap is the day's answers, and a viewer who finished has seen only their own.
 */
export type Visibility = "hidden" | "score" | "full";

export interface Viewing {
  isOwner: boolean;
  /** `puzzleDays(now).today` — the one puzzle still open. */
  today: string;
  /** The VIEWER's own attempt for today is finished. Irrelevant for the owner. */
  viewerFinishedToday: boolean;
}

export function visibilityOf(a: Pick<Attempt, "puzzleId" | "finishedAt">, v: Viewing): Visibility {
  if (a.finishedAt === null) return "hidden";
  if (a.puzzleId < v.today) return "full";
  if (a.puzzleId === v.today) return v.isOwner ? "full" : v.viewerFinishedToday ? "score" : "hidden";
  return "hidden";
}

export type Trend = "up" | "flat" | "down";

export interface ProfileDay {
  puzzleId: string;
  points: number;
  /** That day's own maximum — 30, 36 or 42 across the seams (D-75, D-79). */
  maxPoints: number;
  pct: number;
  /** The share grid's challenge lines, without its header. No name, no code. */
  grid: string[];
  /** D-82: voided. Shown, never counted. */
  cheated: boolean;
  /** The viewer may fetch this day's recap. */
  recap: boolean;
}

export interface KindStat {
  kind: KindId;
  played: number;
  /** Mean points per challenge, out of 6, one decimal. Null when none played. */
  avgPoints: number | null;
  /** Integer percentages. Null when none played. */
  solvedPct: number | null;
  firstGuessPct: number | null;
  trend: Trend | null;
}

export interface ProfileView {
  found: boolean;
  isOwner: boolean;
  today: string;
  profile: { uid: string; displayName: string; currentStreak: number; longestStreak: number } | null;
  /** Newest first. */
  days: ProfileDay[];
  /** KIND_IDS order. Empty when not found. */
  kinds: KindStat[];
  /** One slot per window day, oldest first: % of that day's max, or null (not played, hidden, voided). */
  chart: (number | null)[];
}

export interface ProfileInput extends Viewing {
  uid: string;
  profile: Profile | null;
  /** Whatever was read for the window; nulls and other days are ignored. */
  attempts: readonly (Attempt | null | undefined)[];
  closedDay: string;
}

export function profileView(input: ProfileInput): ProfileView {
  const { uid, profile, isOwner, today, closedDay } = input;
  const window = windowDays(today, PROFILE_DAYS);
  if (!profile) return { found: false, isOwner, today, profile: null, days: [], kinds: [], chart: window.map(() => null) };

  const inWindow = new Set(window);
  const seen = input.attempts
    .filter((a): a is Attempt => Boolean(a) && a!.mode === "daily" && inWindow.has(a!.puzzleId))
    .map((a) => ({ a: upgradeAttempt(a), vis: visibilityOf(a, input) }))
    .filter((d) => d.vis !== "hidden");
  // What counts: visible and not voided — the same `resultOf` the boards use.
  const counted = seen.filter((d) => resultOf(d.a) !== null).map((d) => d.a);

  const pctOf = (a: Attempt) => {
    const max = maxPointsFor(a.items);
    return max === 0 ? 0 : Math.round((100 * a.points) / max);
  };
  const byDay = new Map(counted.map((a) => [a.puzzleId, pctOf(a)]));

  const latest = new Set(window.slice(PROFILE_DAYS / 2));
  return {
    found: true,
    isOwner,
    today,
    profile: {
      uid,
      displayName: profile.displayName,
      currentStreak: effectiveStreak(profile, closedDay, today),
      longestStreak: profile.longestStreak,
    },
    days: seen
      .sort((x, y) => (x.a.puzzleId < y.a.puzzleId ? 1 : -1))
      .map(({ a, vis }) => ({
        puzzleId: a.puzzleId,
        points: a.points,
        maxPoints: maxPointsFor(a.items),
        pct: pctOf(a),
        grid: gridOf(a),
        cheated: Boolean(a.cheated),
        recap: vis === "full",
      })),
    kinds: KIND_IDS.map((kind) => kindStat(kind, counted, latest)),
    chart: window.map((d) => byDay.get(d) ?? null),
  };
}

function kindStat(kind: KindId, attempts: readonly Attempt[], latest: ReadonlySet<string>): KindStat {
  const now: number[] = [];
  const before: number[] = [];
  let solved = 0;
  let first = 0;
  for (const a of attempts) {
    for (const it of a.items) {
      if (it.kind !== kind) continue;
      (latest.has(a.puzzleId) ? now : before).push(it.points);
      if (it.solved) solved++;
      if (it.solved && it.guesses.length === 1) first++;
    }
  }
  const played = now.length + before.length;
  if (played === 0) return { kind, played, avgPoints: null, solvedPct: null, firstGuessPct: null, trend: null };
  return {
    kind,
    played,
    avgPoints: Math.round((sum(now) + sum(before)) / played * 10) / 10,
    solvedPct: Math.round((100 * solved) / played),
    firstGuessPct: Math.round((100 * first) / played),
    trend: trendOf(before, now),
  };
}

/** Latest half against the one before, in mean points per challenge. */
export function trendOf(before: readonly number[], now: readonly number[]): Trend | null {
  if (before.length < TREND_MIN_ITEMS || now.length < TREND_MIN_ITEMS) return null;
  const delta = sum(now) / now.length - sum(before) / before.length;
  return Math.abs(delta) < TREND_FLAT_BELOW ? "flat" : delta > 0 ? "up" : "down";
}

const sum = (xs: readonly number[]) => xs.reduce((n, x) => n + x, 0);

/**
 * The share grid from the attempt alone. An item closes on its correct guess,
 * so "correct" is "solved, and this was the last guess" — no subject needed,
 * which is what lets a row be drawn without reading its puzzle. A test pins it
 * equal to `roundView`'s grid, which does read the puzzle.
 */
function gridOf(a: Attempt): string[] {
  const items: ItemForShare[] = a.items.map((it) => ({
    kind: it.kind,
    solved: it.solved,
    maxGuesses: kindById(it.kind).maxGuesses,
    guesses: it.guesses.map((g, j) => ({
      correct: it.solved && j === it.guesses.length - 1,
      proximity: g.proximity,
      compass: isChoiceGuess(g) ? null : isNumberGuess(g) ? (g.higher ? "N" : "S") : compass8(g.bearingDeg),
    })),
  }));
  return shareGrid(a.puzzleId, items, a.points, maxPointsFor(a.items)).split("\n").slice(1);
}

// ---------------------------------------------------------------------------
// The recap of one day — the only path that reads a puzzle.
// ---------------------------------------------------------------------------

export interface RecapItem {
  kind: KindId;
  points: number;
  solved: boolean;
  /** Null only if the day was re-seeded under the play. */
  answer: Reveal | null;
  guesses: GuessView[];
}

export interface DayRecapView {
  puzzleId: string;
  points: number;
  maxPoints: number;
  cheated: boolean;
  items: RecapItem[];
}

/** One refusal for every reason, so a stranger cannot tell "not yet" from "never played". */
const notYet = () => mondoError("permission-denied", "Ainda não.");

/**
 * Decided BEFORE anything is read: a day outside the window, and today for
 * anyone but its owner, are refused without touching Firestore.
 */
export function recapAllowed(day: string, v: Pick<Viewing, "isOwner" | "today">): boolean {
  return windowDays(v.today, PROFILE_DAYS).includes(day) && (day !== v.today || v.isOwner);
}

/**
 * Throws unless this attempt's recap may be shown. The handler calls it on the
 * attempt BEFORE reading the puzzle, so a refused day never touches an answer.
 */
export function recapGate(day: string, attempt: Attempt | null, v: Pick<Viewing, "isOwner" | "today">): Attempt {
  if (!recapAllowed(day, v)) throw notYet();
  if (!attempt || attempt.mode !== "daily" || attempt.puzzleId !== day) throw notYet();
  if (visibilityOf(attempt, { ...v, viewerFinishedToday: false }) !== "full") throw notYet();
  return attempt;
}

export function recapView(day: string, attempt: Attempt | null, puzzle: Puzzle | null, v: Pick<Viewing, "isOwner" | "today">): DayRecapView {
  const a = upgradeAttempt(recapGate(day, attempt, v));
  if (!puzzle) throw notYet();
  const card = puzzleItems(puzzle);
  const same = card.length === a.items.length;
  // Field by field, never a spread: `history` (D-30) holds the earlier tries.
  return {
    puzzleId: a.puzzleId,
    points: a.points,
    maxPoints: maxPointsFor(a.items),
    cheated: Boolean(a.cheated),
    items: a.items.map((it, i) => ({
      kind: it.kind,
      points: it.points,
      solved: it.solved,
      answer: same ? kindById(card[i]!.kind).reveal(card[i]!) : null,
      guesses: it.guesses.map(guessView),
    })),
  };
}
