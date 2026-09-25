/**
 * Windowed group standings (FR-3.2, FR-3.4, FR-3.5, FR-3.6), pure (NFR-8).
 *
 * Semantics are decision D-24 and are what regras.html promises:
 *   - a window is a list of puzzle days ending at the last CLOSED day (D-25);
 *   - a day never played scores 0 and still counts as a day;
 *   - `drop` lowest daily scores are removed before summing (2 for the 30-day window, 0 elsewhere);
 *   - played / avgGuesses / totalElapsedMs count finished rounds only, before any drop;
 *   - ties in points break on totalElapsedMs, lower first; ranks are competition style (1, 2, 2, 4).
 */

import { previousDay } from "./round";

/** One finished daily round, as the standings job sees it. */
export interface FinishedResult {
  puzzleId: string;
  points: number;
  guessCount: number;
  elapsedMs: number;
}

export interface WindowStats {
  points: number;
  played: number;
  totalGuesses: number;
  /** totalGuesses / played to one decimal, null when nothing was played. */
  avgGuesses: number | null;
  totalElapsedMs: number;
}

export const EMPTY_STATS: WindowStats = { points: 0, played: 0, totalGuesses: 0, avgGuesses: null, totalElapsedMs: 0 };

/** The day after `puzzleId`. */
export function nextDay(puzzleId: string): string {
  return new Date(Date.parse(`${puzzleId}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The `n` puzzle days ending at `closedDay`, ascending. */
export function windowDays(closedDay: string, n: number): string[] {
  const days: string[] = [];
  let d = closedDay;
  for (let i = 0; i < n; i++) {
    days.unshift(d);
    d = previousDay(d);
  }
  return days;
}

export function statsFor(results: readonly FinishedResult[], days: readonly string[], drop: number): WindowStats {
  const inWindow = new Set(days);
  const byDay = new Map<string, FinishedResult>();
  for (const r of results) if (inWindow.has(r.puzzleId)) byDay.set(r.puzzleId, r);

  const daily = days.map((d) => byDay.get(d)?.points ?? 0).sort((a, b) => a - b);
  const points = daily.slice(Math.min(drop, daily.length)).reduce((s, p) => s + p, 0);

  let played = 0, totalGuesses = 0, totalElapsedMs = 0;
  for (const r of byDay.values()) {
    played++;
    totalGuesses += r.guessCount;
    totalElapsedMs += r.elapsedMs;
  }
  return { points, played, totalGuesses, avgGuesses: average(totalGuesses, played), totalElapsedMs };
}

export interface AllTime {
  allTime: WindowStats;
  /** Last puzzle day already folded into `allTime`; null before the first run. */
  allTimeThrough: string | null;
}

/**
 * Fold the results for days in (allTimeThrough, closedDay] into the running total.
 * Re-running with the same closedDay adds nothing (D-25). No drop (FR-3.5 is 30-day only).
 */
export function advanceAllTime(prev: AllTime, results: readonly FinishedResult[], closedDay: string): AllTime {
  const since = prev.allTimeThrough;
  const fresh = results.filter((r) => (since === null || r.puzzleId > since) && r.puzzleId <= closedDay);
  const seen = new Set<string>();
  let { points, played, totalGuesses, totalElapsedMs } = prev.allTime;
  for (const r of fresh) {
    if (seen.has(r.puzzleId)) continue;
    seen.add(r.puzzleId);
    points += r.points;
    played++;
    totalGuesses += r.guessCount;
    totalElapsedMs += r.elapsedMs;
  }
  return {
    allTime: { points, played, totalGuesses, avgGuesses: average(totalGuesses, played), totalElapsedMs },
    allTimeThrough: since !== null && since > closedDay ? since : closedDay,
  };
}

/**
 * Competition ranks aligned with the input order: points desc, totalElapsedMs asc,
 * equal on both → same rank, next distinct row skips accordingly (1, 2, 2, 4).
 */
export function rankBy<T>(rows: readonly T[], stat: (row: T) => Pick<WindowStats, "points" | "totalElapsedMs">): number[] {
  const order = rows.map((row, i) => ({ i, s: stat(row) }))
    .sort((a, b) => b.s.points - a.s.points || a.s.totalElapsedMs - b.s.totalElapsedMs);
  const ranks = new Array<number>(rows.length);
  let rank = 0;
  order.forEach((o, pos) => {
    const prev = order[pos - 1];
    if (!prev || prev.s.points !== o.s.points || prev.s.totalElapsedMs !== o.s.totalElapsedMs) rank = pos + 1;
    ranks[o.i] = rank;
  });
  return ranks;
}

/**
 * FR-3.6: the streak breaks on a day with no completed attempt. `recordCompletion`
 * only runs when someone plays, so a stale `currentStreak` must be read as 0
 * unless the last play was the just-closed day or today (still live).
 */
export function effectiveStreak(
  profile: { lastPlayedOn: string | null; currentStreak: number },
  closedDay: string,
  today: string,
): number {
  return profile.lastPlayedOn === closedDay || profile.lastPlayedOn === today ? profile.currentStreak : 0;
}

function average(total: number, n: number): number | null {
  return n === 0 ? null : Math.round((total / n) * 10) / 10;
}

/**
 * Move one finished day into or out of a running all-time total (D-82).
 *
 * `advanceAllTime` folds a day in exactly once, past a watermark, and never
 * looks at it again (D-25) — which is the right design for a total that only
 * grows, and no help at all when a day stops counting after the fact. So an
 * admin voiding a day the nightly job has already eaten moves it by hand here,
 * and un-voiding moves it back. `last7` and `last30` need none of this: they are
 * recomputed from the attempts themselves every time.
 *
 * Exact inverses at `sign` 1 and -1, which is what makes void/un-void a
 * round trip rather than an approximation.
 */
export function shiftAllTime(prev: WindowStats, day: FinishedResult, sign: 1 | -1): WindowStats {
  const played = prev.played + sign;
  const totalGuesses = prev.totalGuesses + sign * day.guessCount;
  return {
    points: prev.points + sign * day.points,
    played,
    totalGuesses,
    avgGuesses: average(totalGuesses, played),
    totalElapsedMs: prev.totalElapsedMs + sign * day.elapsedMs,
  };
}

/**
 * FR-3.6 recomputed from the record rather than nudged.
 *
 * `recordCompletion` maintains the streak forwards, one day at a time, so it can
 * say "another day" but never "that day did not happen after all" — which is
 * exactly what voiding one is (D-82). So this walks back instead: the streak is
 * the run of consecutive days that *count*, and `lastPlayedOn` is the day that
 * run ends on.
 *
 * `days` is contiguous and ascending and `counts` answers "did this day happen"
 * for each. Anything older than `days[0]` is unknown, so a run reaching the
 * start returns what it found rather than guessing. The caller reads back far
 * enough that this can only bite on a streak longer than it asked for, where
 * under-counting is the safe direction: the player's next day starts fresh
 * instead of inheriting a streak they may not have.
 */
export function streakFrom(days: readonly string[], counts: (day: string) => boolean): { lastPlayedOn: string | null; currentStreak: number } {
  let end = -1;
  for (let i = days.length - 1; i >= 0; i--) {
    if (counts(days[i]!)) { end = i; break; }
  }
  if (end < 0) return { lastPlayedOn: null, currentStreak: 0 };
  let n = 0;
  while (end - n >= 0 && counts(days[end - n]!)) n++;
  return { lastPlayedOn: days[end]!, currentStreak: n };
}
