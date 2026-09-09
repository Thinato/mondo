/**
 * Cards: N challenges in an order, played by one player, producing one score
 * (docs/06-tournaments.md §1, §4.4, FR-8). Pure (NFR-8); `src/tournaments.ts`
 * does the Firestore part.
 *
 * A card is generated once per round and served identically to everyone still
 * in it (D-38), which is what makes comparing two players' scores fair. It is
 * *stored*, not regenerated from a seed (D-42).
 *
 * The card is played strictly in order, one item at a time: a player cannot
 * read all five prompts and then look five things up in parallel. It does not
 * stop them looking up the current one — see SEC-13/SEC-14, which say so out
 * loud rather than pretending otherwise.
 */

import type { Timestamp } from "firebase-admin/firestore";
import { GUESS_MIN_INTERVAL_MS, SUSPICIOUS_SOLVE_MS } from "./config";
import type { Country } from "./countries";
import { mondoError } from "./errors";
import { kindById, scoreItem, type KindId, type Prompt } from "./kinds";
import { guessView, type GuessView, type StoredGuess } from "./round";

export const MAX_CARD_ITEMS = 10;

// ---------------------------------------------------------------------------
// Specification and generation
// ---------------------------------------------------------------------------

/** FR-8.5 — the manager's multiset of kinds, and whether the order is shuffled. */
export interface CardSpec {
  items: { kind: KindId; count: number }[];
  order: "as_listed" | "shuffled";
}

/** One resolved challenge. Server-only: `subject` IS the answer (SEC-1). */
export interface CardItem {
  kind: KindId;
  subject: string;
}

/**
 * FR-2.4's recognisability mix, reused so a tournament card feels like the
 * daily rather than a parade of obscurities. Uniform sampling over the pool
 * would land near 47/33/20, which is a third more tier-3 questions than the
 * daily serves — small on paper, brutal in a five-item card.
 *
 * The tiers rate how recognisable a country's SHAPE is (03-geo-data-pipeline.md),
 * so for `shape` this is the considered difficulty curve and for every other
 * kind it is a borrowed approximation: Kazakhstan has a distinctive outline and
 * an obscure capital. Good enough to avoid a card of five microstates; not a
 * difficulty model for `capital`. Per-kind tiers if anyone ever complains.
 */
const TIER_WEIGHT: Record<1 | 2 | 3, number> = { 1: 0.5, 2: 0.35, 3: 0.15 };

/**
 * Build a card. `exclude` is FR-5.2: subjects already used in this tournament
 * plus the daily schedule's ±60 day window, so a tournament never asks what
 * the group is about to be asked at lunch. Subjects are unique within a card.
 *
 * `rand` is injected so tests are deterministic.
 */
export function buildCard(spec: CardSpec, exclude: ReadonlySet<string>, rand: () => number = Math.random): CardItem[] {
  const kinds = expand(spec);
  if (kinds.length === 0) throw mondoError("invalid-argument", "A card needs at least one challenge.");
  if (kinds.length > MAX_CARD_ITEMS) throw mondoError("invalid-argument", `A card holds at most ${MAX_CARD_ITEMS} challenges.`);
  if (spec.order === "shuffled") shuffle(kinds, rand);

  const used = new Set(exclude);
  return kinds.map((kind) => {
    const subject = pickSubject(kind, used, rand);
    used.add(subject);
    return { kind, subject };
  });
}

function expand(spec: CardSpec): KindId[] {
  const out: KindId[] = [];
  for (const { kind, count } of spec.items) {
    kindById(kind); // rejects an unknown kind before anything is generated
    if (!Number.isInteger(count) || count < 1) throw mondoError("invalid-argument", "Each card entry needs a positive count.");
    for (let i = 0; i < count; i++) out.push(kind);
  }
  return out;
}

/** Tier-weighted pick from the kind's pool, skipping anything excluded. */
function pickSubject(kindId: KindId, exclude: ReadonlySet<string>, rand: () => number): string {
  const available = kindById(kindId).pool().filter((c) => !exclude.has(c.code));
  if (available.length === 0) throw mondoError("not-found", "No country left to ask about.");

  // The weight of one COUNTRY is its tier's target share divided by how many
  // countries share that tier. Giving every tier-1 country a weight of 0.5
  // instead hands the tier its share TIMES its size: 93 tier-1 countries came
  // out at 62% of picks rather than 50%, and tier 3 at 8% rather than 15%.
  // Counted from `available`, so an exclusion that empties a tier renormalises
  // the rest rather than skewing them.
  const inTier: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  for (const c of available) inTier[c.tier]++;
  const weight = (c: Country) => (inTier[c.tier] > 0 ? TIER_WEIGHT[c.tier] / inTier[c.tier] : 0);
  const total = available.reduce((n, c) => n + weight(c), 0);
  // Every tier carries weight, so `total` is only 0 if the data is broken.
  if (total <= 0) return available[Math.floor(rand() * available.length)]!.code;
  let r = rand() * total;
  for (const c of available) {
    r -= weight(c);
    if (r <= 0) return c.code;
  }
  return available[available.length - 1]!.code;
}

function shuffle<T>(xs: T[], rand: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
}

// ---------------------------------------------------------------------------
// Play state — stored at attempts/{uid}_{tid}_r{n} (§4.4)
// ---------------------------------------------------------------------------

export interface CardPlayItem {
  kind: KindId;
  guesses: StoredGuess[];
  solved: boolean;
  points: number;
  /** Server clock, set when this item is served (SEC-3). */
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  elapsedMs: number | null;
}

/**
 * A card in progress or finished.
 *
 * **There is deliberately no `puzzleId` field, and adding one would be a bug
 * with consequences.** The daily standings job selects with
 * `where("puzzleId", ">=", …)`, and a Firestore inequality filter never returns
 * a document that lacks the field — so its absence is what keeps tournament
 * results out of the daily boards (FR-5.9, D-40), with no filter to remember
 * and no composite index. `test/card.test.ts` pins it.
 */
export interface CardPlay {
  uid: string;
  tournamentId: string;
  roundId: string;
  mode: "match";
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  /** Index of the item being played; === items.length once finished. */
  cursor: number;
  items: CardPlayItem[];
  points: number;
  elapsedMs: number | null;
  suspicious: boolean;
}

export function newCardPlay(uid: string, tournamentId: string, roundId: string, card: readonly CardItem[], now: Timestamp): CardPlay {
  if (card.length === 0) throw mondoError("not-found", "This round is not ready.");
  return {
    uid,
    tournamentId,
    roundId,
    mode: "match",
    startedAt: now,
    finishedAt: null,
    cursor: 0,
    items: card.map((item, i) => ({
      kind: item.kind,
      guesses: [],
      solved: false,
      points: 0,
      // Only the first item's clock starts now; the rest start as they are served.
      startedAt: i === 0 ? now : null,
      finishedAt: null,
      elapsedMs: null,
    })),
    points: 0,
    elapsedMs: null,
    suspicious: false,
  };
}

/**
 * Apply one guess to the current item. Returns a new play; never mutates.
 * Throws the same typed errors the daily does, for the same reasons (FR-2.10,
 * SEC-4 via the caller's transaction, SEC-5's 400 ms floor).
 */
export function applyCardGuess(play: CardPlay, card: readonly CardItem[], raw: unknown, now: Timestamp): CardPlay {
  if (play.finishedAt !== null) throw mondoError("already-completed", "This card is finished.");
  if (play.items.length !== card.length) throw mondoError("not-found", "This round is not ready.");

  const i = play.cursor;
  const item = play.items[i];
  const cardItem = card[i];
  if (!item || !cardItem) throw mondoError("already-completed", "This card is finished.");
  const kind = kindById(cardItem.kind);

  // SEC-5 is a floor per PLAYER, not per item: falling back to the previous
  // item's finish keeps the first guess of item n+1 throttled too, which is
  // otherwise a free un-throttled guess at every boundary.
  const since = item.guesses.at(-1)?.at ?? play.items[i - 1]?.finishedAt ?? null;
  if (since && now.toMillis() - since.toMillis() < GUESS_MIN_INTERVAL_MS) {
    throw mondoError("rate-limited", "Too fast. Try again.");
  }
  if (item.guesses.length >= kind.maxGuesses) throw mondoError("no-guesses-remaining", "No guesses left on this challenge.");

  const { guess, correct } = kind.grade(cardItem.subject, raw, now);
  const guesses = [...item.guesses, guess];
  const items = [...play.items];

  if (!correct && guesses.length < kind.maxGuesses) {
    items[i] = { ...item, guesses };
    return { ...play, items };
  }

  // The item is over: score it, and start the next one's clock now so that
  // per-item elapsed time is contiguous and the total is honest.
  const startedAt = item.startedAt ?? play.startedAt;
  items[i] = {
    ...item,
    guesses,
    solved: correct,
    points: scoreItem(kind, correct, guesses.length),
    startedAt,
    finishedAt: now,
    elapsedMs: now.toMillis() - startedAt.toMillis(),
  };

  const cursor = i + 1;
  if (cursor < items.length) {
    items[cursor] = { ...items[cursor]!, startedAt: now };
    return { ...play, items, cursor };
  }

  return {
    ...play,
    items,
    cursor,
    finishedAt: now,
    points: items.reduce((n, it) => n + it.points, 0),
    elapsedMs: now.toMillis() - play.startedAt.toMillis(),
    // Same threshold as the daily: a first-guess solve this fast is flagged,
    // never blocked. It is material for lunch, not enforcement (OQ-8).
    suspicious: items.some((it) => it.solved && it.guesses.length === 1 && (it.elapsedMs ?? Infinity) < SUSPICIOUS_SOLVE_MS),
  };
}

/** Total guesses across the card, for the standings' display column. */
export function totalGuesses(play: CardPlay): number {
  return play.items.reduce((n, it) => n + it.guesses.length, 0);
}

/**
 * Gaps between consecutive server timestamps, per item: served→first guess,
 * then guess→guess. The same telemetry `intervalsMs` gives the daily, and the
 * whole detection story for tournament cheating (SEC-13, SEC-14) — a card whose
 * capital items all came back in 1.5 s is a conversation at lunch.
 */
export function cardIntervalsMs(play: CardPlay): number[][] {
  return play.items.map((it) => {
    let prev = (it.startedAt ?? play.startedAt).toMillis();
    return it.guesses.map((g) => {
      const d = g.at.toMillis() - prev;
      prev = g.at.toMillis();
      return d;
    });
  });
}

// ---------------------------------------------------------------------------
// What the client sees
// ---------------------------------------------------------------------------

export type CardItemStatus = "pending" | "current" | "solved" | "failed";

export interface CardItemView {
  kind: KindId;
  status: CardItemStatus;
  guessCount: number;
  /** Both only once the item itself is over. */
  points: number | null;
  answer: { code: string; name: string } | null;
}

export interface CardView {
  tournamentId: string;
  roundId: string;
  itemCount: number;
  cursor: number;
  status: "in_progress" | "finished";
  /** The current item's prompt; null once the card is finished. */
  prompt: Prompt | null;
  guessesUsed: number;
  guessesMax: number;
  /** Guesses on the current item only. */
  guesses: GuessView[];
  items: CardItemView[];
  /** Card totals, only once every item is done. */
  points: number | null;
  elapsedMs: number | null;
  serverTime: string;
}

/**
 * Project a play for its own player. An item's answer appears only once that
 * item is over — the same line the daily draws (SEC-1). Other players' results
 * are not this function's business: FR-5.6 is enforced in `getTournament`.
 */
export function cardView(play: CardPlay, card: readonly CardItem[], now: Timestamp): CardView {
  // Same guard as applyCardGuess: a play and a card of different lengths is a
  // typed error, not a TypeError deep in the item map (which would reach the
  // player as an untyped `internal`).
  if (play.items.length !== card.length) throw mondoError("not-found", "This round is not ready.");
  const finished = play.finishedAt !== null;
  const current = play.items[play.cursor];
  const currentCard = card[play.cursor];
  const kind = currentCard ? kindById(currentCard.kind) : null;

  return {
    tournamentId: play.tournamentId,
    roundId: play.roundId,
    itemCount: play.items.length,
    cursor: play.cursor,
    status: finished ? "finished" : "in_progress",
    prompt: kind && currentCard && !finished ? kind.prompt(currentCard.subject) : null,
    guessesUsed: current?.guesses.length ?? 0,
    guessesMax: kind?.maxGuesses ?? 0,
    guesses: (current?.guesses ?? []).map(guessView),
    items: play.items.map((it, i) => {
      const over = it.finishedAt !== null;
      return {
        kind: it.kind,
        status: over ? (it.solved ? "solved" : "failed") : i === play.cursor && !finished ? "current" : "pending",
        guessCount: it.guesses.length,
        points: over ? it.points : null,
        answer: over ? kindById(it.kind).reveal(card[i]!.subject) : null,
      };
    }),
    points: finished ? play.points : null,
    elapsedMs: finished ? play.elapsedMs : null,
    serverTime: now.toDate().toISOString(),
  };
}
