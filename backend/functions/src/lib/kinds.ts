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
 * The daily is built on this too, since D-52 reversed D-45: a day is a card of
 * one challenge per kind, so `lib/round.ts` composes these through `lib/card.ts`
 * exactly as a tournament round does and keeps only what a *day* has — the
 * schedule, the streak, the share grid and the `puzzleId`.
 */

import type { Timestamp } from "firebase-admin/firestore";
import { MAX_GUESSES } from "./config";
import { COUNTRIES, countryByCode, flagFor, gdpFor, shapeFor, GDP_YEAR, type Country, type Flag, type Shape } from "./countries";
import { mondoError } from "./errors";
import { bearingDeg, distanceKm, proximity } from "./geo";
import { isChoiceGuess, isCountryGuess, isNumberGuess, type StoredGuess } from "./round";

export const KIND_IDS = ["shape", "capital", "flag", "gdp", "flagPick"] as const;
export type KindId = (typeof KIND_IDS)[number];

/**
 * One resolved challenge: the kind, the answer, and — for a multiple-choice
 * kind — the options (FR-8.7). Server-only: `subject` IS the answer (SEC-1),
 * and for a choice kind so is the *position* of `subject` inside `options`.
 *
 * Defined here rather than in `card.ts` because every `Kind` method takes one,
 * and `card.ts` already imports this module. It is re-exported there as
 * `CardItem`, which is what the rest of the codebase calls it.
 */
export interface Challenge {
  kind: KindId;
  subject: string;
  /**
   * The options in **display order**, one of which is `subject`. Absent for
   * every kind whose answer is typed rather than picked.
   *
   * The order is the answer, so it is fixed when the card is built and stored
   * (D-42, D-64): deriving it on read would reshuffle a challenge that someone
   * has open the moment the pool changes, and their struck-out picks would then
   * point at flags they never chose.
   */
  options?: readonly string[];
}

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
  | { kind: "flag"; flag: Flag }
  /**
   * The only prompt that names its own country, and legitimately: for `gdp` the
   * country is the question and the figure is the answer (D-53). `buildCard`
   * keeps subjects distinct within a card, which is what stops a `gdp` prompt
   * from naming the answer to the silhouette sitting next to it.
   */
  | { kind: "gdp"; country: string; year: number }
  /**
   * FR-8.7 — the question is a set of options and the answer is *which one*.
   * The country is named, like `gdp`'s, because here the country is the
   * question; what must not appear is any hint of which option is its flag.
   * So the options carry artwork and nothing else — no code, no name, no id.
   * Position is the only handle the client has, and the guess is an index.
   */
  | { kind: "flagPick"; country: string; options: { flag: Flag }[] };

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
  /**
   * FR-8.7 — a multiple-choice kind chooses its options here, once, when the
   * card is built. `exclude` holds every other subject on the same card plus
   * the caller's own exclusion window, so a distractor is never something the
   * player is about to be asked about: without that, a flag named by a struck
   * out pick could answer the `flag` challenge sitting next to it.
   *
   * **Return them in any order.** `buildCard` shuffles the result, so no kind
   * can put the answer at a predictable index and none has to remember not to.
   *
   * Absent on kinds whose answer is typed.
   */
  buildOptions?(subject: string, exclude: ReadonlySet<string>, rand: () => number): string[];
  prompt(item: Challenge): Prompt;
  /** Validate and grade one raw guess from the client (SEC-8). */
  grade(item: Challenge, raw: unknown, now: Timestamp): Graded;
  /**
   * Was this stored guess the right one? Read back out of a finished item, by
   * the share grid — which cannot ask `grade` again because grading needs the
   * clock. Only the kind knows what right means: the same country code, a
   * number inside D-53's tolerance, or the index the answer happens to sit at.
   */
  wasCorrect(item: Challenge, guess: StoredGuess): boolean;
  /**
   * Shown once the item is over, never before.
   *
   * `pick` is the index of the right option, for a choice kind only. The
   * country name alone would be no reveal at all there: the prompt already
   * named it, and what the player does not know is which flag was its.
   */
  reveal(item: Challenge): { code: string; name: string; pick?: number };
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
export function gradeCountryGuess(item: Challenge, raw: unknown, now: Timestamp): Graded {
  const answer = mustCountry(item.subject);
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

const countryWasCorrect = (item: Challenge, guess: StoredGuess): boolean =>
  isCountryGuess(guess) && guess.code === item.subject;

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
  prompt: ({ subject }) => {
    const s = shapeFor(subject);
    if (!s) throw mondoError("not-found", "No silhouette for this challenge.");
    return { kind: "shape", shape: s };
  },
  grade: gradeCountryGuess,
  wasCorrect: countryWasCorrect,
  reveal: ({ subject }) => nameOf(subject),
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
  prompt: ({ subject }) => ({ kind: "capital", capital: mustCountry(subject).capital["pt-BR"] }),
  grade: gradeCountryGuess,
  wasCorrect: countryWasCorrect,
  reveal: ({ subject }) => nameOf(subject),
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
  prompt: ({ subject }) => ({ kind: "flag", flag: mustFlag(subject) }),
  grade: gradeCountryGuess,
  wasCorrect: countryWasCorrect,
  reveal: ({ subject }) => nameOf(subject),
};

/**
 * `gdp` — "what is this country's GDP per capita?". The one kind that inverts
 * the others: the country is public and the number is the secret (D-53).
 *
 * **GDP per capita, PPP, in current international dollars, for one pinned
 * year**, shown in the prompt. That combination was chosen over the three
 * alternatives because it is the only one a player can reason about without
 * already knowing the answer: a 133x spread from Burundi to Luxembourg, against
 * 520 000x for total GDP, which is mostly a population quiz. PPP also keeps the
 * figure from moving with exchange rates between vintages.
 *
 * **A guess counts when it is within 10 % of the answer** — `min/max >= 0.9`,
 * which is symmetric, so there is no argument about "10 % of which number".
 * Everything closer than that and still wrong scores nothing, exactly as a
 * silhouette guess 200 km away scores what one 10 000 km away scores. The
 * consolation is the same too: you are told how close you were.
 */
const gdp: Kind = {
  id: "gdp",
  maxGuesses: 3,
  pointsByGuess: [6, 4, 2],
  pool: () => ALL().filter((c) => gdpFor(c.code) !== undefined),
  prompt: ({ subject }) => ({ kind: "gdp", country: mustCountry(subject).names["pt-BR"], year: GDP_YEAR }),
  grade: gradeNumberGuess,
  wasCorrect: (_item, guess) => isNumberGuess(guess) && guess.proximity >= GDP_CORRECT_WITHIN,
  // The country was never secret here, so the reveal is the figure — with the
  // country beside it, because the finished list shows one row per challenge
  // and a bare number there says nothing.
  //
  // D-54: and with its unit. The figure was always in international dollars and
  // only regras.html said so, so the first players read both the prompt and this
  // as reais — roughly five times out, which does not make the question hard, it
  // makes it unanswerable.
  reveal: ({ subject }) => ({ code: subject, name: `${mustCountry(subject).names["pt-BR"]}: US$ ${mustGdp(subject).toLocaleString("pt-BR")}` }),
};

/** FR-8.7 — how many flags are on offer. */
export const FLAG_PICK_OPTIONS = 8;

/**
 * How many of the eight are the answer's own neighbourhood, **the answer
 * included** — so four neighbours and four strangers (D-65).
 *
 * Uniform distractors made the question easier than it looks: seven countries
 * drawn from the whole world are seven different design traditions, and the
 * answer usually stood out by elimination. Flags cluster regionally — the Arab
 * tricolours, the Nordic crosses, the blue-and-white of Central America, the
 * pan-African palette — so the near half is where the confusion lives, and the
 * far half keeps a card from being a geography lesson with one plausible
 * answer.
 */
export const FLAG_PICK_NEAR = 5;

/**
 * `flagPick` — "which of these eight is the flag of X?". The inverse of `flag`:
 * same pool, same artwork, opposite direction (D-64).
 *
 * **Two guesses, [6, 2], and that is the whole difficulty model.** Picking one
 * of eight is nothing like naming one of 196: at three guesses a player who
 * knows nothing at all scores on 40 % of items, which would make a mixed card
 * unsummable in the sense FR-8.2 means. At two it is 25 % — still generous, and
 * the second pick at least costs two thirds of the points.
 *
 * The country is named in the prompt, as `gdp`'s is and for the same reason:
 * here the country is the question. What is secret is only *which option* is
 * its flag, which is why `prompt` sends artwork with no code and no name beside
 * it and the guess is an index into a list the server chose the order of.
 *
 * SEC-13 applies exactly as it does to `flag`, and a little more sharply: eight
 * flags in front of you is eight image searches rather than one. Time is the
 * cost of a cheat (FR-8.3) and the admin timing surface is the detection story.
 */
const flagPick: Kind = {
  id: "flagPick",
  maxGuesses: 2,
  pointsByGuess: [6, 2],
  // Exactly `flag`'s pool: a country needs artwork to be the answer here, and
  // the same artwork is what makes it usable as a distractor.
  pool: () => flag.pool(),
  buildOptions: (subject, exclude, rand) => {
    const answer = mustCountry(subject);
    const others = flag.pool().filter((c) => c.code !== subject);
    // Prefer distractors from outside the exclusion window; fall back to the
    // rest of the pool if that leaves too few. A tournament excludes ±60 days
    // of daily subjects (FR-5.2) — 120 codes out of a pool of about 170 — so
    // "too few" is a real case and not a defensive flourish.
    const free = others.filter((c) => !exclude.has(c.code));
    const bag = free.length >= FLAG_PICK_OPTIONS - 1 ? free : others;

    // The neighbourhood (D-65): the nearest by centroid, which is the same
    // measure the compass hint uses. Not "shares a border" — that would need
    // adjacency data the pipeline does not carry, and it would leave an island
    // nation with no neighbours at all, which is exactly the case that most
    // needs company.
    const near = [...bag]
      .sort((a, b) => distanceKm(answer.centroid, a.centroid) - distanceKm(answer.centroid, b.centroid))
      .slice(0, FLAG_PICK_NEAR - 1);

    const nearby = new Set(near.map((c) => c.code));
    const picked = [subject, ...nearby];
    const rest = bag.filter((c) => !nearby.has(c.code));
    while (picked.length < FLAG_PICK_OPTIONS && rest.length > 0) {
      picked.push(rest.splice(Math.floor(rand() * rest.length), 1)[0]!.code);
    }
    // Deliberately NOT shuffled here: `buildCard` does that for every choice
    // kind, so the answer cannot sit at a fixed index even if a kind forgets.
    return picked;
  },
  prompt: (item) => ({
    kind: "flagPick",
    country: mustCountry(item.subject).names["pt-BR"],
    options: mustOptions(item).map((code) => ({ flag: mustFlag(code) })),
  }),
  grade: gradeChoiceGuess,
  wasCorrect: (item, guess) => isChoiceGuess(guess) && mustOptions(item)[guess.pick] === item.subject,
  // The name is for the finished list, which shows one row per challenge; the
  // index is what the reveal actually needs, because the prompt already named
  // the country and "Era Brasil" answers a question nobody asked.
  reveal: (item) => ({ ...nameOf(item.subject), pick: mustOptions(item).indexOf(item.subject) }),
};

export const KINDS: Readonly<Record<KindId, Kind>> = { shape, capital, flag, gdp, flagPick };

/**
 * Grade a pick: which option, and whether it was the right one.
 *
 * `proximity` is 0 or 1 rather than a scale, because there is no such thing as
 * nearly picking the right flag. The share grid and the colour bands read that
 * field without knowing this kind exists, so a wrong pick is a red square and a
 * right one is green — which is exactly what happened.
 */
export function gradeChoiceGuess(item: Challenge, raw: unknown, now: Timestamp): Graded {
  const options = mustOptions(item);
  const pick = requirePick(raw, options.length);
  const correct = options[pick] === item.subject;
  return { correct, guess: { pick, proximity: correct ? 1 : 0, at: now } };
}

function requirePick(raw: unknown, count: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw mondoError("invalid-argument", "A guess must be one of the options.");
  if (raw < 0 || raw >= count) throw mondoError("invalid-argument", "That is not one of the options.");
  return raw;
}

/**
 * The stored options, or a typed error. A choice item without them is a card
 * built by code that did not know this kind existed — which is a bug, but one
 * the player should hear as "this challenge is broken" rather than as INTERNAL.
 */
function mustOptions(item: Challenge): readonly string[] {
  if (!item.options || item.options.length === 0) throw mondoError("not-found", "This challenge has no options.");
  return item.options;
}

function mustFlag(code: string): Flag {
  const f = flagFor(code);
  if (!f) throw mondoError("not-found", "No flag for this challenge.");
  return f;
}

/**
 * A guess is right when it and the answer are within 10 % of each other. Stated
 * as a ratio rather than a percentage of one side, so "10 % of what?" has no
 * answer to argue about (D-53).
 */
export const GDP_CORRECT_WITHIN = 0.9;

/** Anything above this per-capita figure is a typo, not a guess. */
const MAX_GDP_GUESS = 1e9;

/**
 * Grade a numeric guess: how close as a ratio, and which way to go.
 *
 * `proximity` is `min/max`, which lands on the same 0..1 scale the geo kinds
 * use — so the proximity bar, the colour bands and the share grid all work
 * without knowing this kind exists. It is also the honest shape for a quantity
 * spanning two orders of magnitude: being 2x out reads as 50 %, not as 99.99 %
 * of the way from zero.
 */
export function gradeNumberGuess(item: Challenge, raw: unknown, now: Timestamp): Graded {
  const answer = mustGdp(item.subject);
  const value = requireGuessNumber(raw);
  const proximity = Math.min(value, answer) / Math.max(value, answer);
  return {
    correct: proximity >= GDP_CORRECT_WITHIN,
    guess: { value, higher: answer > value, proximity, at: now },
  };
}

function requireGuessNumber(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw mondoError("invalid-argument", "A guess must be a number.");
  if (raw <= 0 || raw > MAX_GDP_GUESS) throw mondoError("invalid-argument", "That is not a plausible figure.");
  return Math.round(raw);
}

function mustGdp(code: string): number {
  const v = gdpFor(code);
  if (v === undefined) throw mondoError("not-found", "No figure for this challenge.");
  return v;
}

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
