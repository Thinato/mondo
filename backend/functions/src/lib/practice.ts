/**
 * Practice (FR-9): one kind, one challenge at a time, for as long as the player
 * wants. Pure (NFR-8); `src/practice.ts` does the Firestore part.
 *
 * A practice challenge is **a card of exactly one item**, so nothing about how
 * a challenge behaves is written here: the guess budget, the 400 ms floor
 * (SEC-5), the 0–6 score (D-44) and the line between a prompt and an answer
 * (SEC-1) are all `lib/card.ts`'s, reused rather than restated. A kind that
 * plays correctly in the daily plays correctly here on the day it ships, which
 * is half of why practice is worth having.
 *
 * What practice owns is only what a card has no concept of: an endless
 * sequence, running totals that belong to nobody but the player (FR-9.3), and a
 * subject picker that will not hand out an answer the player is about to be
 * asked for (D-60).
 */

import type { Timestamp } from "firebase-admin/firestore";
import { applyCardGuess, buildCard, giveUpCard, newCardCore, type CardCore, type CardItem, type CardPlayItem } from "./card";
import { mondoError } from "./errors";
import { kindById, MAX_ITEM_POINTS, type KindId, type Prompt } from "./kinds";
import { guessView, type GuessView } from "./round";

/** D-60 — how far ahead of today the daily schedule is withheld from practice. */
export const PRACTICE_EXCLUSION_DAYS = 7;

/** What the player has earned this session. Private to them, for ever (FR-9.3). */
export interface PracticeTotals {
  /** Challenges *finished*. One abandoned half-way counts for nothing. */
  played: number;
  solved: number;
  points: number;
}

/**
 * A practice session — stored at `practice/{uid}`, one per player.
 *
 * `subject` is the answer to the challenge on screen, which is why this
 * collection is denied to everyone in `firestore.rules` including its owner,
 * exactly as `attempts` is and for the same reason (D-51).
 */
export interface PracticeSession {
  uid: string;
  kind: KindId;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  subject: string;
  /**
   * FR-8.7 — the options, in display order, for a choice kind. Present for a
   * whole session or for none of it, because the kind is fixed when the session
   * starts; that is what lets the two writers below use a conditional spread
   * rather than having to clear a stale field.
   */
  options?: readonly string[];
  item: CardPlayItem;
  /** Subjects already asked this session; emptied when the pool runs dry. */
  asked: string[];
  /** D-60: daily subjects this session will not ask about. Never emptied. */
  blocked: string[];
  totals: PracticeTotals;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** A fresh session, already showing its first challenge. */
export function newSession(
  uid: string,
  kind: KindId,
  blocked: readonly string[],
  now: Timestamp,
  rand: () => number = Math.random,
): PracticeSession {
  const { challenge, asked } = pick(kind, blocked, [], rand);
  return {
    uid,
    kind,
    startedAt: now,
    endedAt: null,
    subject: challenge.subject,
    ...optionsOf(challenge),
    item: freshItem(uid, kind, challenge.subject, now),
    asked,
    blocked: [...blocked],
    totals: { played: 0, solved: 0, points: 0 },
  };
}

/**
 * The next challenge. The one on screen is rolled into the totals first — which
 * is also why `next` is a call and not something the client decides: a finished
 * challenge that nobody advanced past has not been counted yet.
 */
export function serveNext(s: PracticeSession, now: Timestamp, rand: () => number = Math.random): PracticeSession {
  if (s.endedAt !== null) throw mondoError("already-completed", "This practice session is over.");
  const { challenge, asked } = pick(s.kind, s.blocked, s.asked, rand);
  return {
    ...s,
    subject: challenge.subject,
    ...optionsOf(challenge),
    item: freshItem(s.uid, s.kind, challenge.subject, now),
    asked,
    totals: rolled(s),
  };
}

/**
 * One guess on the challenge on screen.
 *
 * `applyCardGuess` guards the *card's* finish, and a one-item card's card-level
 * finish is not stored here — so the item's own finish is guarded first, or a
 * solved challenge would take a second guess and score twice.
 */
export function applyPracticeGuess(s: PracticeSession, raw: unknown, now: Timestamp): PracticeSession {
  if (s.endedAt !== null) throw mondoError("already-completed", "This practice session is over.");
  if (s.item.finishedAt !== null) throw mondoError("already-completed", "This challenge is over.");
  const after = applyCardGuess(coreOf(s), [challengeOf(s)], raw, now);
  return { ...s, item: after.items[0]! };
}

/**
 * Give up on the challenge on screen (FR-2.13, D-61): zero points, and the
 * answer arrives through the same reveal a challenge with no guesses left gets.
 * The session runs on; `next` counts this one like any other finished challenge.
 */
export function giveUpPractice(s: PracticeSession, now: Timestamp): PracticeSession {
  if (s.endedAt !== null) throw mondoError("already-completed", "This practice session is over.");
  if (s.item.finishedAt !== null) throw mondoError("already-completed", "This challenge is over.");
  const after = giveUpCard(coreOf(s), [challengeOf(s)], now);
  return { ...s, item: after.items[0]! };
}

/**
 * Leave (FR-9.4). A challenge that was finished but never advanced past counts;
 * one abandoned mid-way does not, and keeps its answer to itself (SEC-1).
 * Idempotent, so a double-tap on "sair" cannot count the last challenge twice.
 */
export function endSession(s: PracticeSession, now: Timestamp): PracticeSession {
  if (s.endedAt !== null) return s;
  return { ...s, endedAt: now, totals: rolled(s) };
}

const rolled = (s: PracticeSession): PracticeTotals =>
  s.item.finishedAt === null
    ? s.totals
    : {
        played: s.totals.played + 1,
        solved: s.totals.solved + (s.item.solved ? 1 : 0),
        points: s.totals.points + s.item.points,
      };

/** The one-item card `lib/card.ts` transitions operate on. */
const coreOf = (s: PracticeSession): CardCore => ({
  uid: s.uid,
  startedAt: s.item.startedAt ?? s.startedAt,
  finishedAt: null,
  cursor: 0,
  items: [s.item],
  points: 0,
  elapsedMs: null,
  suspicious: false,
});

/**
 * The challenge on screen, as `lib/card.ts` and `lib/kinds.ts` want it. A
 * session is a card of one item (D-60), and this is that item's other half —
 * the part that says what the question was rather than how it is going.
 */
const challengeOf = (s: PracticeSession): CardItem =>
  ({ kind: s.kind, subject: s.subject, ...(s.options ? { options: s.options } : {}) });

/** Firestore rejects an explicit `undefined`, so an absent field stays absent. */
const optionsOf = (c: CardItem) => (c.options ? { options: c.options } : {});

/** Built through `newCardCore` so a new field on a card item cannot be missed here. */
const freshItem = (uid: string, kind: KindId, subject: string, now: Timestamp): CardPlayItem =>
  newCardCore(uid, [{ kind, subject }], now).items[0]!;

/**
 * Pick the next subject, tier-weighted by `buildCard` so practice feels like
 * the daily rather than a parade of microstates.
 *
 * Two exclusions, and only one of them recycles. `blocked` is D-60 and holds
 * for the life of the session. `asked` is only "don't repeat yourself", so when
 * the kind's pool is exhausted it starts over rather than refusing to deal —
 * a player who has been through 180 flags has earned another lap, not an error.
 */
function pick(
  kind: KindId,
  blocked: readonly string[],
  asked: readonly string[],
  rand: () => number,
): { challenge: CardItem; asked: string[] } {
  const block = new Set(blocked);
  const exhausted = !kindById(kind).pool().some((c) => !block.has(c.code) && !asked.includes(c.code));
  const memory = exhausted ? [] : asked;
  // The whole item, not just its subject: for a choice kind `buildCard` also
  // chose the options and shuffled them, and that order is the answer (FR-8.7).
  const challenge = buildCard({ items: [{ kind, count: 1 }], order: "as_listed" }, new Set([...memory, ...block]), rand)[0]!;
  return { challenge, asked: [...memory, challenge.subject] };
}

// ---------------------------------------------------------------------------
// What the client sees
// ---------------------------------------------------------------------------

export interface PracticeItemView {
  kind: KindId;
  status: "current" | "solved" | "failed";
  /** Null once the challenge is over: there is nothing left to show but the answer. */
  prompt: Prompt | null;
  guessesUsed: number;
  guessesMax: number;
  guesses: GuessView[];
  /** Both only once the challenge is over (SEC-1). */
  points: number | null;
  /** `pick` only for a choice kind: which option was the right one (FR-8.7). */
  answer: { code: string; name: string; pick?: number } | null;
}

export interface PracticeView {
  kind: KindId;
  status: "in_progress" | "ended";
  /** Null once the session is over — the summary is all that is left. */
  item: PracticeItemView | null;
  totals: PracticeTotals & { maxPoints: number };
  serverTime: string;
}

export function practiceView(s: PracticeSession, now: Timestamp): PracticeView {
  const kind = kindById(s.kind);
  const over = s.item.finishedAt !== null;
  return {
    kind: s.kind,
    status: s.endedAt === null ? "in_progress" : "ended",
    item:
      s.endedAt !== null
        ? null
        : {
            kind: s.kind,
            status: over ? (s.item.solved ? "solved" : "failed") : "current",
            prompt: over ? null : kind.prompt(challengeOf(s)),
            guessesUsed: s.item.guesses.length,
            guessesMax: kind.maxGuesses,
            guesses: s.item.guesses.map(guessView),
            points: over ? s.item.points : null,
            answer: over ? kind.reveal(challengeOf(s)) : null,
          },
    // Computed, never stored: the denominator is "six a challenge" (D-44) and
    // storing it would be one more thing that could disagree with the score.
    totals: { ...s.totals, maxPoints: s.totals.played * MAX_ITEM_POINTS },
    serverTime: now.toDate().toISOString(),
  };
}
