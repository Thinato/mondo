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
