/**
 * Points and share text (FR-3.1, FR-2.11). Pure and unit-tested because this is
 * the part people will argue about over lunch (NFR-8, FR-3.7).
 */

import { MAX_GUESSES } from "./config";
import type { Compass } from "./geo";

/**
 * FR-3.1: solved on guess n → 7 − n points (6 … 1); not solved → 0.
 */
export function pointsFor(solved: boolean, guessCount: number): number {
  if (!solved) return 0;
  if (guessCount < 1 || guessCount > MAX_GUESSES) throw new RangeError(`guessCount ${guessCount} out of range`);
  return MAX_GUESSES + 1 - guessCount;
}

const ARROW: Record<Compass, string> = {
  N: "⬆️", NE: "↗️", E: "➡️", SE: "↘️", S: "⬇️", SW: "↙️", W: "⬅️", NW: "↖️",
};

export interface GuessForShare {
  correct: boolean;
  /** 0..1, from geo.proximity */
  proximity: number;
  compass: Compass;
}

/**
 * One row per guess: five squares filled by proximity, then the arrow (or 🎉).
 * Contains the puzzle date and the guess count, never the answer or any guess name.
 * The client appends the link (FR-2.11).
 *
 *   Mondo 2026-09-15 3/6
 *   🟩🟩🟨⬜⬜ ↗️
 *   🟩🟩🟩🟩⬜ ↘️
 *   🟩🟩🟩🟩🟩 🎉
 */
export function shareGrid(puzzleId: string, guesses: readonly GuessForShare[], solved: boolean): string {
  const score = solved ? String(guesses.length) : "X";
  const rows = guesses.map((g) => `${squares(g.proximity)} ${g.correct ? "🎉" : ARROW[g.compass]}`);
  return [`Mondo ${puzzleId} ${score}/${MAX_GUESSES}`, ...rows].join("\n");
}

/** 5 squares: 20 % each; a half-step (≥ 10 % of the way to the next) shows yellow. */
export function squares(proximity: number): string {
  const p = Math.min(1, Math.max(0, proximity));
  const full = Math.floor(p * 5);
  const half = full < 5 && p * 5 - full >= 0.5 ? 1 : 0;
  return "🟩".repeat(full) + "🟨".repeat(half) + "⬜".repeat(5 - full - half);
}
