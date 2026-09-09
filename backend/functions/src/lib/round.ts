/**
 * The round state machine, pure (NFR-8). `src/round.ts` wraps these in
 * Firestore transactions; everything that can be argued about lives here and
 * is unit-tested without an emulator.
 */

import type { Timestamp } from "firebase-admin/firestore";
import { GUESS_MIN_INTERVAL_MS, MAX_GUESSES, SUSPICIOUS_SOLVE_MS } from "./config";
import { countryByCode, shapeFor, type Country, type Shape } from "./countries";
import { mondoError } from "./errors";
import { bearingDeg, compass8, distanceKm, proximity, type Compass } from "./geo";
import { pointsFor, shareGrid } from "./scoring";

// ---------------------------------------------------------------------------
// Stored documents (02-architecture.md §3.2, §3.3)
// ---------------------------------------------------------------------------

export interface Puzzle {
  puzzleId: string;
  countryCode: string;
  tier: 1 | 2 | 3;
  opensAt: Timestamp;
}

export interface StoredGuess {
  code: string;
  distanceKm: number;
  bearingDeg: number;
  proximity: number;
  at: Timestamp;
}

export interface Attempt {
  uid: string;
  puzzleId: string;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  guesses: StoredGuess[];
  guessCount: number;
  solved: boolean;
  points: number;
  elapsedMs: number | null;
  mode: "daily";
  suspicious: boolean;
}

export interface Profile {
  displayName: string;
  createdAt: Timestamp;
  lastPlayedOn: string | null;
  currentStreak: number;
  longestStreak: number;
  totalPlayed: number;
  totalSolved: number;
  locale: "pt-BR" | "en";
}

export type RoundStatus = "in_progress" | "solved" | "failed";

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function newAttempt(uid: string, puzzleId: string, now: Timestamp): Attempt {
  return {
    uid, puzzleId, startedAt: now, finishedAt: null, guesses: [], guessCount: 0,
    solved: false, points: 0, elapsedMs: null, mode: "daily", suspicious: false,
  };
}

export function newProfile(now: Timestamp, displayName = randomHandle()): Profile {
  return {
    displayName, createdAt: now, lastPlayedOn: null,
    currentStreak: 0, longestStreak: 0, totalPlayed: 0, totalSolved: 0, locale: "pt-BR",
  };
}

/**
 * Apply one guess. Throws typed errors for every rejected case (FR-2.10,
 * SEC-4, SEC-5); returns a new attempt, never mutating the input.
 */
export function applyGuess(attempt: Attempt, puzzle: Puzzle, code: string, now: Timestamp): Attempt {
  if (attempt.finishedAt !== null) throw mondoError("already-completed", "This round is over.");
  if (attempt.guessCount >= MAX_GUESSES) throw mondoError("no-guesses-remaining", "No guesses left.");
  const last = attempt.guesses.at(-1);
  if (last && now.toMillis() - last.at.toMillis() < GUESS_MIN_INTERVAL_MS) {
    throw mondoError("rate-limited", "Too fast. Try again.");
  }
  const guessed = mustCountry(code);
  const answer = mustCountry(puzzle.countryCode);

  const correct = guessed.code === answer.code;
  const km = correct ? 0 : distanceKm(guessed.centroid, answer.centroid);
  const guess: StoredGuess = {
    code: guessed.code,
    distanceKm: km,
    bearingDeg: correct ? 0 : bearingDeg(guessed.centroid, answer.centroid),
    proximity: proximity(km),
    at: now,
  };

  const guesses = [...attempt.guesses, guess];
  const guessCount = guesses.length;
  const finished = correct || guessCount >= MAX_GUESSES;
  if (!finished) return { ...attempt, guesses, guessCount };

  const elapsedMs = now.toMillis() - attempt.startedAt.toMillis();
  return {
    ...attempt, guesses, guessCount,
    finishedAt: now,
    solved: correct,
    points: pointsFor(correct, guessCount),
    elapsedMs,
    suspicious: correct && guessCount === 1 && elapsedMs < SUSPICIOUS_SOLVE_MS,
  };
}

/** Profile after a round completes (FR-3.6, §3.1 counters). */
export function recordCompletion(profile: Profile, attempt: Attempt): Profile {
  if (attempt.finishedAt === null) throw new Error("recordCompletion on an unfinished attempt");
  const consecutive = profile.lastPlayedOn === previousDay(attempt.puzzleId);
  const currentStreak = consecutive ? profile.currentStreak + 1 : 1;
  return {
    ...profile,
    lastPlayedOn: attempt.puzzleId,
    currentStreak,
    longestStreak: Math.max(profile.longestStreak, currentStreak),
    totalPlayed: profile.totalPlayed + 1,
    totalSolved: profile.totalSolved + (attempt.solved ? 1 : 0),
  };
}

// ---------------------------------------------------------------------------
// What the client sees (02-architecture.md §4). The answer is present ONLY
// once the round is over (SEC-1). Nothing else here can identify the country.
// ---------------------------------------------------------------------------

export interface GuessView {
  code: string;
  name: string;
  distanceKm: number;
  bearingDeg: number;
  compass: Compass;
  proximity: number;
}

export interface RoundView {
  puzzleId: string;
  mode: "daily";
  shape: Shape;
  guessesUsed: number;
  guessesMax: number;
  guesses: GuessView[];
  status: RoundStatus;
  answer: { code: string; name: string } | null;
  points: number | null;
  elapsedMs: number | null;
  shareGrid: string | null;
  serverTime: string;
  /** The caller's own profile bits the UI needs (FR-1.2, FR-1.3). Never anyone else's. */
  me: { displayName: string } | null;
}

export function statusOf(attempt: Attempt): RoundStatus {
  return attempt.finishedAt === null ? "in_progress" : attempt.solved ? "solved" : "failed";
}

export function roundView(attempt: Attempt, puzzle: Puzzle, now: Timestamp, profile: Profile | null = null): RoundView {
  const status = statusOf(attempt);
  const finished = status !== "in_progress";
  const shape = shapeFor(puzzle.countryCode);
  if (!shape) throw mondoError("not-found", "No silhouette for this puzzle.");
  const guesses = attempt.guesses.map(guessView);
  const answer = mustCountry(puzzle.countryCode);
  return {
    puzzleId: puzzle.puzzleId,
    mode: "daily",
    shape,
    guessesUsed: attempt.guessCount,
    guessesMax: MAX_GUESSES,
    guesses,
    status,
    answer: finished ? { code: answer.code, name: answer.names["pt-BR"] } : null,
    points: finished ? attempt.points : null,
    elapsedMs: finished ? attempt.elapsedMs : null,
    shareGrid: finished
      ? shareGrid(
          puzzle.puzzleId,
          attempt.guesses.map((g) => ({ correct: g.code === answer.code, proximity: g.proximity, compass: compass8(g.bearingDeg) })),
          attempt.solved,
        )
      : null,
    serverTime: now.toDate().toISOString(),
    me: profile ? { displayName: profile.displayName } : null,
  };
}

export function guessView(g: StoredGuess): GuessView {
  return {
    code: g.code,
    name: mustCountry(g.code).names["pt-BR"],
    distanceKm: g.distanceKm,
    bearingDeg: g.bearingDeg,
    compass: compass8(g.bearingDeg),
    proximity: g.proximity,
  };
}

// ---------------------------------------------------------------------------
// FR-1.2: random handle, never derived from the email. Adjectives are the
// gender-invariant kind so "capivara veloz" and "jacaré veloz" both read right.
// Longest combination is 23 characters, inside FR-1.3's 24.
// ---------------------------------------------------------------------------

const ANIMALS = ["pinguim", "jacaré", "tucano", "capivara", "onça", "arara", "tamanduá", "lobo", "coruja", "golfinho", "tatu", "boto", "gato", "cavalo", "quati", "mico", "sapo", "peixe", "leão", "urso", "lontra", "gavião", "raposa", "cabra", "ema"];
const ADJECTIVES = ["veloz", "feliz", "gentil", "forte", "brilhante", "valente", "alegre", "audaz", "sagaz", "tenaz", "ágil", "leve", "doce", "breve", "verde", "azul", "sutil", "fiel", "hábil", "jovem", "astuto", "sereno", "curioso", "esperto"];

export function randomHandle(rand: () => number = Math.random): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const n = String(Math.floor(rand() * 10000)).padStart(4, "0");
  return `${pick(ANIMALS)}-${pick(ADJECTIVES)}-${n}`;
}

// ---------------------------------------------------------------------------

function mustCountry(code: string): Country {
  const c = countryByCode(code);
  if (!c) throw mondoError("invalid-argument", "Unknown country code.");
  return c;
}

export function previousDay(puzzleId: string): string {
  return new Date(Date.parse(`${puzzleId}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
