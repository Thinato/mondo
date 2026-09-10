/**
 * Points and share text (FR-3.1, FR-2.11). Pure and unit-tested because this is
 * the part people will argue about over lunch (NFR-8, FR-3.7).
 */

import type { Compass } from "./geo";
import type { KindId } from "./kinds";

const ARROW: Record<Compass, string> = {
  N: "⬆️", NE: "↗️", E: "➡️", SE: "↘️", S: "⬇️", SW: "↙️", W: "⬅️", NW: "↖️",
};

export interface GuessForShare {
  correct: boolean;
  /** 0..1, from geo.proximity */
  proximity: number;
  compass: Compass;
}

/** One challenge of a day, as the share text sees it. No name, no code. */
export interface ItemForShare {
  kind: KindId;
  solved: boolean;
  maxGuesses: number;
  guesses: readonly GuessForShare[];
}

/**
 * D-52: a day is three challenges, so the grid gained a column rather than a
 * pile of rows. Each challenge is one line — its icon, then one square per
 * allowed guess — and the wrong ones still carry the direction they pointed,
 * which is the part people actually compare at lunch.
 *
 * Contains the date and the score, never an answer, a name or a country code.
 * The client appends the link (FR-2.11).
 *
 *   Mondo 2026-09-15 12/18
 *   🗺️ 🟨↗️ 🟩🎉 ⬛ ⬛ ⬛ ⬛
 *   🏳️ 🟩🎉 ⬛ ⬛
 *   🏙️ 🟥⬅️ 🟨➡️ 🟥↘️
 *
 * A challenge nobody reached is all ⬛, which is how a share still reads when
 * the day was abandoned halfway.
 */
export function shareGrid(puzzleId: string, items: readonly ItemForShare[], points: number, maxPoints: number): string {
  const rows = items.map((it) => {
    const played = it.guesses.map((g) => `${band(g.proximity)}${g.correct ? "🎉" : ARROW[g.compass]}`);
    const unused = Array(Math.max(0, it.maxGuesses - it.guesses.length)).fill("⬛");
    return [ICON[it.kind], ...played, ...unused].join(" ");
  });
  return [`Mondo ${puzzleId} ${points}/${maxPoints}`, ...rows].join("\n");
}

/** What kind of question it was — never which question. */
const ICON: Record<KindId, string> = { shape: "🗺️", capital: "🏙️", flag: "🏳️", gdp: "💰" };

/** One square for how close a guess landed: the five-square bar, collapsed. */
export function band(proximity: number): string {
  const p = Math.min(1, Math.max(0, proximity));
  return p >= 0.8 ? "🟩" : p >= 0.4 ? "🟨" : "🟥";
}

/** 5 squares: 20 % each; a half-step (≥ 10 % of the way to the next) shows yellow. */
export function squares(proximity: number): string {
  const p = Math.min(1, Math.max(0, proximity));
  const full = Math.floor(p * 5);
  const half = full < 5 && p * 5 - full >= 0.5 ? 1 : 0;
  return "🟩".repeat(full) + "🟨".repeat(half) + "⬜".repeat(5 - full - half);
}
