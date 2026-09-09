/**
 * Which puzzle is open at a given instant (FR-2.1, OQ-2, D-9).
 *
 * The day flips at 12:00 America/Sao_Paulo. `puzzleId` names the date the
 * puzzle OPENS, so at 09:00 on the 15th the open puzzle is still "…-14".
 * Same algorithm as tools/lib/schedule.mjs; both are tested against 15:00Z.
 */

import { PUZZLE_ROLLOVER_HOUR, PUZZLE_TIMEZONE } from "./config";

const DAY_MS = 86_400_000;

/** puzzleId of the puzzle open at `now`. */
export function puzzleIdAt(now: Date, tz = PUZZLE_TIMEZONE, rollover = PUZZLE_ROLLOVER_HOUR): string {
  const p = zonedParts(now, tz);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  if (p.hour < rollover) day -= DAY_MS;
  return new Date(day).toISOString().slice(0, 10);
}

/** The instant `puzzleId` opens: 12:00 in the puzzle zone, as a Date. */
export function opensAt(puzzleId: string, tz = PUZZLE_TIMEZONE, rollover = PUZZLE_ROLLOVER_HOUR): Date {
  const [y, m, d] = puzzleId.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, rollover);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - offsetMs(new Date(t), tz);
  return new Date(t);
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zonedParts(date: Date, tz: string): Parts {
  const parts: Record<string, number> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(date)) {
    if (type !== "literal") parts[type] = Number(value);
  }
  return parts as unknown as Parts;
}

/** Zone offset at `date` in ms (negative west of Greenwich). */
function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
