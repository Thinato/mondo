// One row per player, for the four places that list people (D-57).
//
// The daily's desktop panel, the tournament card's panel, the group board's
// "Hoje" and the tournament detail's round all draw the same thing: a name, and
// sometimes a score beside it. Two copies of this already existed — groups.js
// and tournaments.js — and the panels would have made four. `guessRow` is the
// precedent for what happens when that is allowed to drift.
//
// Whether a score may be shown is NOT decided here. The server decides it:
// FR-4.11 withholds today's points until the viewer has finished their own day,
// and FR-5.6 withholds a round's until it closes, so `points` simply arrives
// null and the caller passes `withScore: false`. This function only draws.

import { t } from "./i18n.js";

/** @param {{displayName:string, points?:number|null, guessCount?:number|null, cheated?:boolean}} p */
export function playerRow(p, withScore = false) {
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = p.displayName;
  li.append(name);
  // FR-7.7, D-82 — an admin voided this day, and the group is told. Not gated on
  // `withScore`: it is not a score, and a zero nobody can explain is exactly what
  // OQ-8 was trying to avoid. A tournament row never carries the field.
  if (p.cheated) {
    const b = document.createElement("span");
    b.className = "badge warn";
    b.textContent = t("badgeCheated");
    li.append(b);
  }
  if (withScore && p.points !== null && p.points !== undefined) {
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = t("todayScore", { points: p.points, n: p.guessCount });
    li.append(score);
  }
  return li;
}

/** The three buckets every "who is playing" list splits into, in the same order. */
export function fillBuckets({ players, finished, playing, waiting, withScore = false }) {
  const by = (state) => players.filter((p) => p.state === state).map((p) => playerRow(p, withScore));
  finished.replaceChildren(...by("finished"));
  playing.replaceChildren(...by("in_progress"));
  waiting.replaceChildren(...by("not_started"));
}
