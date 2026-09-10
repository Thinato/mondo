/**
 * Challenge kinds (FR-8, docs/06-tournaments.md §5). Pure (NFR-8).
 *
 * A kind is "how one question is asked and graded". It knows nothing about
 * cards, rounds, formats or Firestore — `lib/card.ts` composes kinds into a
 * playable card and `src/tournaments.ts` does the I/O.
 *
 * SEC-1 applies here without exception: `prompt()` is the only thing a kind
 * ever hands the client while the item is unsolved, and it must not identify
 * the answer. What differs between kinds is only how *hard the answer is to
 * look up elsewhere* (SEC-13) — that is never treated as a security control.
 *
 * The shipped daily is deliberately NOT built on this (D-45). `lib/round.ts` is
 * live, tested and playing; the `shape` kind reuses the same pure geo and
 * scoring helpers instead, which duplicates a dozen lines and no logic.
 */

import type { Timestamp } from "firebase-admin/firestore";
import { MAX_GUESSES } from "./config";
import { COUNTRIES, countryByCode, flagFor, shapeFor, type Country, type Flag, type Shape } from "./countries";
import { mondoError } from "./errors";
import { bearingDeg, distanceKm, proximity } from "./geo";
import type { StoredGuess } from "./round";

export const KIND_IDS = ["shape", "capital", "flag"] as const;
export type KindId = (typeof KIND_IDS)[number];

/** FR-8.2 / D-44 — every kind scores one challenge on the same 0..6 scale, so a
 *  card of mixed kinds is summable and a first-guess solve is worth what a
 *  first-guess daily is worth (FR-3.1). */
export const MAX_ITEM_POINTS = 6;

/**
 * What the client may see while the item is open (FR-8.4). Discriminated by
 * kind so the UI can render without guessing, and carrying nothing else.
 */
export type Prompt =
  | { kind: "shape"; shape: Shape }
  | { kind: "capital"; capital: string }
  | { kind: "flag"; flag: Flag };

export interface Graded {
  guess: StoredGuess;
  correct: boolean;
}

export interface Kind {
  id: KindId;
  maxGuesses: number;
  /**
   * Points for solving on guess n, 1-based. `[0]` is MAX_ITEM_POINTS and the
   * sequence decreases; `assertKinds()` below enforces both, because a kind
   * that scored 7 or that got *better* with more guesses would silently break
   * every cross-kind comparison.
   */
  pointsByGuess: readonly number[];
  /** The countries this kind can ask about. */
  pool(): readonly Country[];
  prompt(subject: string): Prompt;
  /** Validate and grade one raw guess from the client (SEC-8). */
  grade(subject: string, raw: unknown, now: Timestamp): Graded;
  /** Shown once the item is over, never before. */
  reveal(subject: string): { code: string; name: string };
}

// ---------------------------------------------------------------------------
// Shared by every kind whose answer is a country and whose guess is a country
// ---------------------------------------------------------------------------

/**
 * Every kind shipped so far asks "which country is this?" and takes a country
 * code as the guess, so they grade identically: great-circle distance between
 * the two centroids, plus the 8-point compass the UI draws.
 *
 * `bearingDeg` is stored and never sent (D-36): an exact distance and an exact
 * bearing from a guess whose centroid is public solve for the answer's centroid
 * in closed form. `lib/round.ts` GuessView is what strips it.
 *
 * A numeric kind (`gdp`) will not fit this signature — its guess is a number
 * and its feedback is "higher/lower". That is exactly why `grade` lives on the
 * kind rather than in card.ts: this function is a shared implementation, not
 * the interface.
 */
export function gradeCountryGuess(subject: string, raw: unknown, now: Timestamp): Graded {
  const answer = mustCountry(subject);
  const guessed = requireGuessCode(raw);
  const correct = guessed.code === answer.code;
  const km = correct ? 0 : distanceKm(guessed.centroid, answer.centroid);
  return {
    correct,
    guess: {
      code: guessed.code,
      distanceKm: km,
      bearingDeg: correct ? 0 : bearingDeg(guessed.centroid, answer.centroid),
      proximity: proximity(km),
      at: now,
    },
  };
}

function requireGuessCode(raw: unknown): Country {
  if (typeof raw !== "string") throw mondoError("invalid-argument", "A guess must be a country code.");
  const c = countryByCode(raw);
  if (!c) throw mondoError("invalid-argument", "Unknown country code.");
  return c;
}

function mustCountry(code: string): Country {
  const c = countryByCode(code);
  if (!c) throw mondoError("not-found", "This challenge references a country that is no longer in the pool.");
  return c;
}

const ALL = () => [...COUNTRIES.values()];

/** Diacritic- and case-insensitive, like the client's autocomplete matching. */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * FR-8.4 — a prompt that contains the answer is not a question.
 *
 * Fifteen countries name themselves in their own capital: Brasília/Brasil,
 * Cidade do México/México, Singapura/Singapura, Cidade da Guatemala/Guatemala,
 * Bissau/Guiné-Bissau, Argel/Argélia, Túnis/Tunísia and the city-states. For
 * four of them the prompt is byte-identical to an entry in the client's
 * autocomplete, so typing the prompt back solves the item. That is SEC-1
 * broken by the prompt itself, not the cheap-lookup residual SEC-13 concedes.
 */
export function capitalNamesItsCountry(c: Country): boolean {
  const cap = fold(c.capital?.["pt-BR"] ?? "");
  const name = fold(c.names["pt-BR"]);
  return cap.length > 0 && (cap.includes(name) || name.includes(cap));
}

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

/**
 * `shape` — the daily's question, as a tournament item. Six guesses and the
 * FR-3.1 ladder, so a shape item and a daily round score identically.
 *
 * SEC-12's conceded residual applies unchanged: a determined player can
 * geometry-match the silhouette against public map data.
 */
const shape: Kind = {
  id: "shape",
  // FR-3.1's ladder, and since D-52 the daily's too: a silhouette scores the
  // same whether it is asked on its own or as one challenge of a day.
  maxGuesses: MAX_GUESSES,
  pointsByGuess: [6, 5, 4, 3, 2, 1],
  pool: () => ALL().filter((c) => shapeFor(c.code) !== undefined),
  prompt: (subject) => {
    const s = shapeFor(subject);
    if (!s) throw mondoError("not-found", "No silhouette for this challenge.");
    return { kind: "shape", shape: s };
  },
  grade: gradeCountryGuess,
  reveal: (subject) => nameOf(subject),
};

/**
 * `capital` — "which country's capital is this?". Three guesses, because the
 * prompt is a name rather than a shape: there is no gradual recognition to
 * reward, and a fourth guess is just a slower coin toss.
 *
 * Honest about SEC-13: a capital city is one search away, far cheaper to look
 * up than a silhouette. Time is what costs a cheat here (FR-8.3), and the
 * admin timing surface is the detection story.
 */
const capital: Kind = {
  id: "capital",
  maxGuesses: 3,
  pointsByGuess: [6, 4, 2],
  pool: () => ALL().filter((c) => c.capital?.["pt-BR"] && !capitalNamesItsCountry(c)),
  prompt: (subject) => ({ kind: "capital", capital: mustCountry(subject).capital["pt-BR"] }),
  grade: gradeCountryGuess,
  reveal: (subject) => nameOf(subject),
};

/**
 * `flag` — "which country's flag is this?". Three guesses, like `capital`:
 * either you know a flag or you are guessing, and the distance feedback is
 * what turns the second and third guesses into something better than a coin
 * toss.
 *
 * The pool is smaller than every other kind's, and deliberately: 24 of the 196
 * countries have no flag in `flags.json`. Most were dropped by the build's byte
 * budget, which — not by coincidence — is the same measure as "the artwork is a
 * coat of arms", and a coat of arms is usually where a flag writes its own
 * country's name. Bolivia, Costa Rica, the Dominican Republic, El Salvador,
 * Guatemala, Nicaragua, Paraguay and Peru all do. FR-8.4 says a prompt must not
 * name its own answer, and a player who zooms an inlined SVG reads it at any
 * size; the three that were small enough to slip past the budget are excluded
 * by hand in tools/flags.json.
 *
 * SEC-13 applies as it does to `capital`: a flag is one image search away, and
 * time is what a cheat costs (FR-8.3).
 */
const flag: Kind = {
  id: "flag",
  maxGuesses: 3,
  pointsByGuess: [6, 4, 2],
  pool: () => ALL().filter((c) => flagFor(c.code) !== undefined),
  prompt: (subject) => {
    const f = flagFor(subject);
    if (!f) throw mondoError("not-found", "No flag for this challenge.");
    return { kind: "flag", flag: f };
  },
  grade: gradeCountryGuess,
  reveal: (subject) => nameOf(subject),
};

export const KINDS: Readonly<Record<KindId, Kind>> = { shape, capital, flag };

/**
 * Look up a kind by id.
 *
 * The allowlist check is not decoration: `KINDS` is an object literal, so a
 * plain `KINDS[id]` lookup answers `"constructor"` and `"toString"` with
 * something truthy off Object's prototype, and the caller would then read
 * `maxGuesses` off a Function and get `undefined`. Ids reach here from stored
 * card items and from a card spec, so it screens by membership of KIND_IDS.
 */
export function kindById(id: string): Kind {
  if (!(KIND_IDS as readonly string[]).includes(id)) throw mondoError("invalid-argument", "Unknown challenge kind.");
  return KINDS[id as KindId];
}

/** FR-8.2 — points when solved on guess `n` (1-based); 0 when not solved. */
export function scoreItem(kind: Kind, solved: boolean, guessCount: number): number {
  if (!solved) return 0;
  const p = kind.pointsByGuess[guessCount - 1];
  if (p === undefined) throw new RangeError(`${kind.id}: guessCount ${guessCount} out of range`);
  return p;
}

function nameOf(code: string): { code: string; name: string } {
  const c = mustCountry(code);
  return { code: c.code, name: c.names["pt-BR"] };
}

/**
 * The cross-kind invariant, checked once at import so a bad table cannot ship:
 * every kind scores its first guess at MAX_ITEM_POINTS, has exactly one entry
 * per allowed guess, and never rewards a later guess more than an earlier one.
 * Without this, summing a mixed-kind card (D-44) is meaningless.
 */
function assertKinds(): void {
  for (const id of KIND_IDS) {
    const k = KINDS[id];
    if (k.id !== id) throw new Error(`kind ${id} registered under the wrong key`);
    if (k.pointsByGuess.length !== k.maxGuesses) throw new Error(`kind ${id}: pointsByGuess must have maxGuesses entries`);
    if (k.pointsByGuess[0] !== MAX_ITEM_POINTS) throw new Error(`kind ${id}: a first-guess solve must be worth ${MAX_ITEM_POINTS}`);
    for (let i = 1; i < k.pointsByGuess.length; i++) {
      if (k.pointsByGuess[i]! >= k.pointsByGuess[i - 1]!) throw new Error(`kind ${id}: pointsByGuess must decrease`);
    }
    if (k.pointsByGuess.some((p) => p < 1)) throw new Error(`kind ${id}: a solve is always worth at least 1`);
  }
}
assertKinds();
