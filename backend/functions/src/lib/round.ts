/**
 * The round state machine, pure (NFR-8). `src/round.ts` wraps these in
 * Firestore transactions; everything that can be argued about lives here and
 * is unit-tested without an emulator.
 *
 * **D-52 — the daily is a card.** A day is one challenge of every kind, in a
 * shuffled order, and playing it is the same act as playing a tournament round:
 * N challenges, one at a time, on one clock. So the transitions live in
 * `lib/card.ts` and this file holds what is specific to a *day* — the schedule,
 * the streak, the share grid, and the document the standings job reads.
 *
 * This reverses D-45, which said the daily would not be rebuilt on the card
 * engine. D-45 was right while the daily was one silhouette: rewriting a live,
 * tested, playing round to gain nothing is a bad trade. It stopped being right
 * the moment a day had to hold three challenges, because the alternative was a
 * second implementation of the ordering, throttling and per-item timing rules
 * that card.ts already had under test.
 */

import type { Timestamp } from "firebase-admin/firestore";
import { applyCardGuess, newCardCore, cardIntervalsMs, totalGuesses, type CardCore, type CardItem } from "./card";
import { countryByCode, type Country } from "./countries";
import { mondoError } from "./errors";
import { compass8, type Compass } from "./geo";
import { kindById, type KindId, type Prompt } from "./kinds";
import { shareGrid, type ItemForShare } from "./scoring";

// ---------------------------------------------------------------------------
// Stored documents (02-architecture.md §3.2, §3.3)
// ---------------------------------------------------------------------------

export interface Puzzle {
  puzzleId: string;
  /** FR-2.1, D-52 — the day's challenges, in the order they are played. */
  items?: CardItem[];
  opensAt: Timestamp;
  /**
   * Pre-D-52 days: one silhouette. Still present on every day seeded before the
   * switch, so `puzzleItems` reads either shape and a day that was never
   * re-seeded plays as a one-challenge day rather than failing at noon.
   */
  countryCode?: string;
  tier?: 1 | 2 | 3;
}

/** The day's card, whichever generation seeded it (D-52). */
export function puzzleItems(puzzle: Puzzle): CardItem[] {
  if (puzzle.items && puzzle.items.length > 0) return puzzle.items;
  if (puzzle.countryCode) return [{ kind: "shape", subject: puzzle.countryCode }];
  throw mondoError("not-found", "This puzzle has no challenges.");
}

export interface StoredGuess {
  code: string;
  distanceKm: number;
  bearingDeg: number;
  proximity: number;
  at: Timestamp;
}

/**
 * One player's day. A card play (D-52) that additionally carries `puzzleId` —
 * which is precisely how the nightly standings job finds it, and precisely what
 * a tournament play omits so the job cannot (FR-5.9, D-40).
 *
 * `guessCount`, `solved`, `points` and `elapsedMs` stay at the top level even
 * though the per-item detail is in `items`. They are what `resultOf` and the
 * admin dashboard read, and attempts written before D-52 carry the same four —
 * so the boards go on summing days across the switch without a migration.
 */
export interface Attempt extends CardCore {
  puzzleId: string;
  mode: "daily";
  /** Guesses across every challenge of the day. */
  guessCount: number;
  /** Every challenge of the day solved. */
  solved: boolean;
  /** D-30: set only on attempts an admin has reset. Earlier tries, oldest first. */
  history?: AttemptSnapshot[];
  retries?: number;
  /** Pre-D-52 attempts: one country, one flat list. Read, never written. */
  guesses?: StoredGuess[];
}

/** An attempt as it was when an admin granted a retry (D-30). */
export type AttemptSnapshot = Omit<Attempt, "history"> & { retryGrantedBy: string; retryGrantedAt: Timestamp };

/** FR-7.1 — stored on the profile, written only by functions (D-27, D-29). */
export type Role = "admin" | "organizer" | "player";

export interface Profile {
  displayName: string;
  createdAt: Timestamp;
  lastPlayedOn: string | null;
  currentStreak: number;
  longestStreak: number;
  totalPlayed: number;
  totalSolved: number;
  locale: "pt-BR" | "en";
  /** Absent on Phase 1 profiles → "player" (see lib/authz.ts). */
  role?: Role;
  /** Membership index, ≤ 10 (FR-4.4, D-27). Absent on Phase 1 profiles → []. */
  groups?: string[];
}

export type RoundStatus = "in_progress" | "solved" | "failed";

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function newAttempt(uid: string, puzzleId: string, card: readonly CardItem[], now: Timestamp): Attempt {
  return { ...newCardCore(uid, card, now), puzzleId, mode: "daily", guessCount: 0, solved: false };
}

export function newProfile(now: Timestamp, displayName = randomHandle()): Profile {
  return {
    displayName, createdAt: now, lastPlayedOn: null,
    currentStreak: 0, longestStreak: 0, totalPlayed: 0, totalSolved: 0, locale: "pt-BR",
    role: "player", groups: [],
  };
}

/**
 * D-30 — an admin's "extra chance": the round starts over now, and the old try
 * is kept in `history` so the dashboard can still show what happened.
 */
export function resetAttempt(attempt: Attempt, card: readonly CardItem[], now: Timestamp, byUid: string): Attempt {
  const { history = [], ...current } = attempt;
  return {
    ...newAttempt(attempt.uid, attempt.puzzleId, card, now),
    retries: (attempt.retries ?? 0) + 1,
    history: [...history, { ...current, retryGrantedBy: byUid, retryGrantedAt: now }],
  };
}

/**
 * An attempt written before D-52, read as the one-challenge day it was.
 *
 * The D-52 change made `puzzles` backward compatible and forgot to do the same
 * for `attempts`, which broke production: anyone who had already started the day
 * when the new code went out had a document with no `items`, and `roundView`
 * read `.length` off it. A TypeError reaches the player as `INTERNAL`, which
 * tells them nothing and tells us nothing either.
 *
 * Upgrading on read rather than migrating is the same trade the puzzle side
 * makes: the daily only ever loads today, so at most one day of documents is
 * ever in the old shape, and the first guess after this rewrites it anyway.
 */
export function upgradeAttempt(attempt: Attempt): Attempt {
  if (attempt.items) return attempt;
  const { guesses = [], ...rest } = attempt;
  return {
    ...rest,
    // A finished legacy attempt is a finished one-challenge day, so the cursor
    // sits past the end exactly as `applyCardGuess` would have left it.
    cursor: attempt.finishedAt === null ? 0 : 1,
    items: [{
      kind: "shape",
      guesses,
      solved: attempt.solved,
      points: attempt.points,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      elapsedMs: attempt.elapsedMs,
    }],
  };
}

/**
 * Gaps between consecutive server timestamps: served→first guess, then
 * guess→guess, concatenated across the day's challenges. Still one flat list,
 * because that is what the admin table draws and what a suspiciously fast
 * answer looks like either way (D-31).
 *
 * Reads a pre-D-52 attempt too: those have one flat `guesses` and no `items`.
 */
export function intervalsMs(attempt: Pick<Attempt, "startedAt" | "items" | "guesses">): number[] {
  if (attempt.items) return cardIntervalsMs(attempt as CardCore).flat();
  let prev = attempt.startedAt.toMillis();
  return (attempt.guesses ?? []).map((g) => {
    const d = g.at.toMillis() - prev;
    prev = g.at.toMillis();
    return d;
  });
}

/**
 * Apply one guess to the day's current challenge. The rules — order, the 400 ms
 * floor, per-item clocks, scoring — are `applyCardGuess`'s, shared with
 * tournaments (D-52); what this adds is the three summary fields the boards and
 * the dashboard read off the top of the document.
 */
export function applyGuess(legacyOrCurrent: Attempt, card: readonly CardItem[], raw: unknown, now: Timestamp): Attempt {
  // Upgrading here rather than at the call site is deliberate: this and
  // `roundView` are the two doors into a day, and the production bug was a
  // caller forgetting. A caller cannot forget something it does not do.
  const attempt = upgradeAttempt(legacyOrCurrent);
  const core = applyCardGuess(attempt, card, raw, now);
  return {
    ...attempt,
    ...core,
    guessCount: totalGuesses(core),
    // A "solved" day is a day where every challenge fell. It is what
    // `profile.totalSolved` counts and what the result line celebrates; the
    // points are the honest measure, and they are separate.
    solved: core.items.every((it) => it.solved),
  };
}

/** Profile after a round completes (FR-3.6, §3.1 counters). */
export function recordCompletion(profile: Profile, attempt: Attempt): Profile {
  if (attempt.finishedAt === null) throw new Error("recordCompletion on an unfinished attempt");
  if (profile.lastPlayedOn === attempt.puzzleId) {
    // D-30: this day was already counted by the try an admin reset. Streak and
    // totalPlayed stand; only "solved" may have changed.
    const before = attempt.history?.at(-1)?.solved ? 1 : 0;
    return { ...profile, totalSolved: profile.totalSolved - before + (attempt.solved ? 1 : 0) };
  }
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
  /**
   * Deliberately no `bearingDeg` (SEC-1, SEC-2). An exact distance AND an exact
   * bearing from a guess whose centroid is public is a closed-form solve for the
   * answer's centroid, so one guess plus an offline Natural Earth table named the
   * country. The UI only ever drew the 8-point arrow from `compass`, so nothing
   * is lost; a determined player must now trilaterate over several guesses.
   */
  compass: Compass;
  proximity: number;
}

export type RoundItemStatus = "pending" | "current" | "solved" | "failed";

export interface RoundItemView {
  kind: KindId;
  status: RoundItemStatus;
  guessCount: number;
  /** Both only once the challenge itself is over (SEC-1). */
  points: number | null;
  answer: { code: string; name: string } | null;
}

export interface RoundView {
  puzzleId: string;
  mode: "daily";
  itemCount: number;
  cursor: number;
  /** The current challenge's prompt; null once the day is finished. */
  prompt: Prompt | null;
  /** Guesses used and allowed on the CURRENT challenge, not on the day. */
  guessesUsed: number;
  guessesMax: number;
  /** Guesses on the current challenge only. */
  guesses: GuessView[];
  items: RoundItemView[];
  status: RoundStatus;
  /** Day totals, only once every challenge is done. */
  points: number | null;
  maxPoints: number;
  elapsedMs: number | null;
  shareGrid: string | null;
  serverTime: string;
  /** The caller's own profile bits the UI needs (FR-1.2, FR-1.3, FR-7). Never anyone else's. */
  me: { displayName: string; role: Role; groupCount: number } | null;
}

export function statusOf(attempt: Attempt): RoundStatus {
  return attempt.finishedAt === null ? "in_progress" : attempt.solved ? "solved" : "failed";
}

/**
 * Project a day for its own player. A challenge's answer appears only once that
 * challenge is over, and never the ones still to come (SEC-1) — the same line
 * `cardView` draws, for the same reason.
 */
export function roundView(legacyOrCurrent: Attempt, puzzle: Puzzle, now: Timestamp, profile: Profile | null = null): RoundView {
  const attempt = upgradeAttempt(legacyOrCurrent);
  const card = puzzleItems(puzzle);
  // A day whose puzzle was re-seeded under a play already in progress. Rare and
  // self-inflicted (re-seed future days, not today), but a typed error says so
  // where a TypeError would just read INTERNAL.
  if (attempt.items.length !== card.length) throw mondoError("not-found", "Today's challenges changed while this round was open.");
  const finished = attempt.finishedAt !== null;
  const current = attempt.items[attempt.cursor];
  const currentCard = card[attempt.cursor];
  const kind = currentCard ? kindById(currentCard.kind) : null;

  return {
    puzzleId: puzzle.puzzleId,
    mode: "daily",
    itemCount: attempt.items.length,
    cursor: attempt.cursor,
    prompt: kind && currentCard && !finished ? kind.prompt(currentCard.subject) : null,
    guessesUsed: current?.guesses.length ?? 0,
    guessesMax: kind?.maxGuesses ?? 0,
    guesses: (current?.guesses ?? []).map(guessView),
    items: attempt.items.map((it, i) => {
      const over = it.finishedAt !== null;
      return {
        kind: it.kind,
        status: over ? (it.solved ? "solved" : "failed") : i === attempt.cursor && !finished ? "current" : "pending",
        guessCount: it.guesses.length,
        points: over ? it.points : null,
        answer: over ? kindById(it.kind).reveal(card[i]!.subject) : null,
      };
    }),
    status: statusOf(attempt),
    points: finished ? attempt.points : null,
    maxPoints: maxPointsFor(card),
    elapsedMs: finished ? attempt.elapsedMs : null,
    shareGrid: finished ? shareGrid(puzzle.puzzleId, shareItems(attempt, card), attempt.points, maxPointsFor(card)) : null,
    serverTime: now.toDate().toISOString(),
    me: profile ? { displayName: profile.displayName, role: profile.role ?? "player", groupCount: profile.groups?.length ?? 0 } : null,
  };
}

/** The best a day could have gone: every challenge on the first guess (D-44). */
export function maxPointsFor(card: readonly CardItem[]): number {
  return card.reduce((n, it) => n + kindById(it.kind).pointsByGuess[0]!, 0);
}

/** One share row per guess, grouped by challenge. Carries no name and no code. */
function shareItems(attempt: Attempt, card: readonly CardItem[]): ItemForShare[] {
  return attempt.items.map((it, i) => ({
    kind: it.kind,
    solved: it.solved,
    maxGuesses: kindById(it.kind).maxGuesses,
    guesses: it.guesses.map((g) => ({
      correct: g.code === card[i]!.subject,
      proximity: g.proximity,
      compass: compass8(g.bearingDeg),
    })),
  }));
}

export function guessView(g: StoredGuess): GuessView {
  return {
    code: g.code,
    name: mustCountry(g.code).names["pt-BR"],
    distanceKm: g.distanceKm,
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
