/**
 * Cards: generation and the play state machine (FR-8, docs/06-tournaments.md
 * §4.4, §5). Pure, so no emulator.
 *
 * The load-bearing test in here is the last one: a card play must not carry a
 * `puzzleId` field, because its absence is what keeps tournament results out
 * of the daily boards (FR-5.9, D-40).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CountryGuessView, GuessView } from "../src/lib/round";

/** Narrow where the test already knows the challenge was a country one. */
const asCountryView = (g: GuessView): CountryGuessView => g as CountryGuessView;
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  applyCardGuess, buildCard, cardIntervalsMs, cardView, newCardPlay, totalGuesses,
  type CardItem, type CardPlay, type CardSpec,
} from "../src/lib/card";
import { COUNTRIES } from "../src/lib/countries";
import { SUSPICIOUS_SOLVE_MS } from "../src/lib/config";

const T0 = Timestamp.fromMillis(Date.parse("2026-09-15T15:30:00Z"));
const at = (plusMs: number) => Timestamp.fromMillis(T0.toMillis() + plusMs);
const NONE = new Set<string>();

/** Deterministic "random": walks a fixed sequence, so a fixture is reproducible. */
function seeded(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const FIVE_SHAPES: CardSpec = { items: [{ kind: "shape", count: 5 }], order: "as_listed" };

test("a card has one item per requested challenge, in the order listed", () => {
  const spec: CardSpec = { items: [{ kind: "shape", count: 3 }, { kind: "capital", count: 2 }], order: "as_listed" };
  const card = buildCard(spec, NONE, seeded([0.1, 0.4, 0.7, 0.2, 0.9]));
  assert.deepEqual(card.map((i) => i.kind), ["shape", "shape", "shape", "capital", "capital"]);
});

test("FR-8.5: shuffled order rearranges the kinds but keeps the multiset", () => {
  const spec: CardSpec = { items: [{ kind: "shape", count: 3 }, { kind: "capital", count: 2 }], order: "shuffled" };
  const card = buildCard(spec, NONE, seeded([0.99, 0.01, 0.5, 0.42, 0.8, 0.3, 0.6, 0.15, 0.7]));
  const counts = card.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { shape: 3, capital: 2 });
  assert.equal(card.length, 5);
});

test("subjects are unique within a card", () => {
  const card = buildCard(FIVE_SHAPES, NONE, Math.random);
  assert.equal(new Set(card.map((i) => i.subject)).size, 5);
});

test("SEC-1 / D-53: a gdp prompt names its country, so no other challenge may answer it", () => {
  // This is the leak `gdp` makes possible and no other kind does: its prompt is
  // a country name in plain text. Distinct subjects within a card is what stops
  // "Qual o PIB do Brasil?" sitting beside a silhouette whose answer is Brasil.
  const spec = { items: [{ kind: "gdp" as const, count: 2 }, { kind: "shape" as const, count: 2 }, { kind: "flag" as const, count: 1 }], order: "shuffled" as const };
  for (let i = 0; i < 2_000; i++) {
    const card = buildCard(spec, NONE, Math.random);
    assert.equal(new Set(card.map((c) => c.subject)).size, card.length, JSON.stringify(card));
  }
});

test("FR-5.2: an excluded subject never appears — not even when it is almost everything", () => {
  const all = [...COUNTRIES.keys()];
  const keep = new Set(["PY", "BR", "IT", "JP", "KE"]);
  const exclude = new Set(all.filter((c) => !keep.has(c)));
  const card = buildCard(FIVE_SHAPES, exclude, Math.random);
  assert.deepEqual(new Set(card.map((i) => i.subject)), keep);
});

test("a card that cannot be filled fails loudly rather than repeating a subject", () => {
  const exclude = new Set([...COUNTRIES.keys()].slice(0, COUNTRIES.size - 2));
  rejects(() => buildCard(FIVE_SHAPES, exclude, Math.random), "not-found");
});

test("a spec must ask for at least one challenge and at most ten", () => {
  rejects(() => buildCard({ items: [], order: "as_listed" }, NONE), "invalid-argument");
  rejects(() => buildCard({ items: [{ kind: "shape", count: 11 }], order: "as_listed" }, NONE), "invalid-argument");
  rejects(() => buildCard({ items: [{ kind: "shape", count: 0 }], order: "as_listed" }, NONE), "invalid-argument");
  rejects(() => buildCard({ items: [{ kind: "shape", count: 1.5 }], order: "as_listed" }, NONE), "invalid-argument");
  rejects(() => buildCard({ items: [{ kind: "population" as "shape", count: 1 }], order: "as_listed" }, NONE), "invalid-argument");
});

test("tier weighting follows FR-2.4 rather than the raw pool shape", () => {
  // 20 000 single-item cards; tier 1 should land near 50%, not the pool's ~47%.
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < 20_000; i++) {
    const [item] = buildCard({ items: [{ kind: "shape", count: 1 }], order: "as_listed" }, NONE, Math.random);
    counts[COUNTRIES.get(item!.subject)!.tier]++;
  }
  const share = (n: number) => n / 20_000;
  assert.ok(Math.abs(share(counts[1]) - 0.5) < 0.03, `tier 1 share ${share(counts[1])}`);
  assert.ok(Math.abs(share(counts[2]) - 0.35) < 0.03, `tier 2 share ${share(counts[2])}`);
  assert.ok(Math.abs(share(counts[3]) - 0.15) < 0.03, `tier 3 share ${share(counts[3])}`);
});

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

const CARD: CardItem[] = [
  { kind: "shape", subject: "PY" },
  { kind: "capital", subject: "IT" },
];
const fresh = () => newCardPlay("u1", "t1", "t1_r1", CARD, T0);

/** Play a list of [guess, atMs] pairs in order. */
function play(steps: [string, number][], p: CardPlay = fresh()): CardPlay {
  return steps.reduce<CardPlay>((acc, [code, ms]) => ({ ...acc, ...applyCardGuess(acc, CARD, code, at(ms)) }), p);
}

test("only the first item's clock starts when the card is created (SEC-3)", () => {
  const p = fresh();
  assert.equal(p.cursor, 0);
  assert.equal(p.items[0]!.startedAt?.toMillis(), T0.toMillis());
  assert.equal(p.items[1]!.startedAt, null);
  assert.equal(p.finishedAt, null);
  assert.equal(p.mode, "match");
});

test("a wrong guess stays on the same item and burns one of its guesses", () => {
  const p = play([["AR", 1000]]);
  assert.equal(p.cursor, 0);
  assert.equal(p.items[0]!.guesses.length, 1);
  assert.equal(p.items[0]!.finishedAt, null);
  assert.equal(p.points, 0);
});

test("solving an item scores it, closes it and starts the next one's clock", () => {
  const p = play([["AR", 1000], ["PY", 2000]]);
  assert.equal(p.items[0]!.solved, true);
  assert.equal(p.items[0]!.points, 5); // second guess on a shape
  assert.equal(p.items[0]!.elapsedMs, 2000);
  assert.equal(p.cursor, 1);
  assert.equal(p.items[1]!.startedAt?.toMillis(), at(2000).toMillis());
  assert.equal(p.finishedAt, null, "the card is not over until every item is");
});

test("running out of guesses on an item scores it zero and moves on", () => {
  const wrong: [string, number][] = [["AR", 1000], ["BR", 2000], ["CL", 3000], ["PE", 4000], ["BO", 5000], ["UY", 6000]];
  const p = play(wrong);
  assert.equal(p.items[0]!.solved, false);
  assert.equal(p.items[0]!.points, 0);
  assert.equal(p.items[0]!.guesses.length, 6);
  assert.equal(p.cursor, 1);
});

test("the card finishes when the last item does, summing points and total time", () => {
  const p = play([["PY", 1000], ["FR", 2000], ["IT", 3000]]);
  assert.equal(p.finishedAt?.toMillis(), at(3000).toMillis());
  assert.equal(p.cursor, 2);
  assert.equal(p.items[0]!.points, 6); // shape, first guess
  assert.equal(p.items[1]!.points, 4); // capital, second guess
  assert.equal(p.points, 10);
  assert.equal(p.elapsedMs, 3000, "card time runs from the card's own start");
  assert.equal(totalGuesses(p), 3);
});

test("a capital item allows three guesses and no more", () => {
  const p = play([["PY", 1000], ["FR", 2000], ["DE", 3000], ["ES", 4000]]);
  assert.equal(p.items[1]!.guesses.length, 3);
  assert.equal(p.items[1]!.solved, false);
  assert.equal(p.points, 6);
  assert.equal(p.finishedAt?.toMillis(), at(4000).toMillis());
});

test("a finished card refuses further guesses (FR-2.10's rule, one card up)", () => {
  const p = play([["PY", 1000], ["IT", 2000]]);
  rejects(() => applyCardGuess(p, CARD, "BR", at(3000)), "already-completed");
});

test("SEC-5: two guesses inside 400 ms on the same item are rejected", () => {
  const p = play([["AR", 1000]]);
  rejects(() => applyCardGuess(p, CARD, "BR", at(1200)), "rate-limited");
  assert.equal(applyCardGuess(p, CARD, "BR", at(1400)).items[0]!.guesses.length, 2);
});

test("SEC-5: the 400 ms floor holds across an item boundary too", () => {
  // This originally asserted the opposite — that the first guess of the next
  // item was unthrottled — which handed a scripted client one free guess per
  // item. SEC-5 is a floor per player, so it now measures from the previous
  // item's finish when the current item has no guesses yet.
  const p = play([["PY", 1000]]);
  assert.equal(p.cursor, 1);
  rejects(() => applyCardGuess(p, CARD, "FR", at(1100)), "rate-limited");
  assert.equal(applyCardGuess(p, CARD, "FR", at(1450)).items[1]!.guesses.length, 1);
});

test("a first-guess solve faster than the daily's threshold flags the card, never blocks it", () => {
  // Item 1 solved 100 ms in; item 2 starts then and is solved 500 ms later —
  // both under SUSPICIOUS_SOLVE_MS, and 500 ms clears the SEC-5 floor.
  const fast = play([["PY", 100], ["IT", 600]]);
  assert.equal(fast.suspicious, true);
  assert.ok(SUSPICIOUS_SOLVE_MS > 500);
  const slow = play([["PY", 5000], ["IT", 10_000]]);
  assert.equal(slow.suspicious, false);
});

test("applyCardGuess never mutates its input", () => {
  const before = fresh();
  const snapshot = JSON.stringify(before);
  applyCardGuess(before, CARD, "AR", at(1000));
  assert.equal(JSON.stringify(before), snapshot);
});

test("timings are recorded per item, served→guess then guess→guess (SEC-13, SEC-14)", () => {
  const p = play([["AR", 1000], ["PY", 2500], ["IT", 3000]]);
  assert.deepEqual(cardIntervalsMs(p), [[1000, 1500], [500]]);
});

// ---------------------------------------------------------------------------
// What the player sees
// ---------------------------------------------------------------------------

test("SEC-1: the view carries the current prompt and reveals no answer while the item is open", () => {
  const v = cardView(play([["AR", 1000]]), CARD, at(1000));
  assert.equal(v.status, "in_progress");
  assert.equal(v.prompt?.kind, "shape");
  assert.equal(v.guessesUsed, 1);
  assert.equal(v.guessesMax, 6);
  assert.equal(v.items[0]!.status, "current");
  assert.equal(v.items[0]!.answer, null);
  assert.equal(v.items[0]!.points, null);
  assert.equal(v.items[1]!.status, "pending");
  assert.equal(v.points, null, "no card total until the card is done");
  const json = JSON.stringify(v);
  assert.ok(!json.includes("Paraguai") && !json.includes('"PY"'), "the open answer must not appear");
});

test("a finished item reveals its own answer; a pending one still hides its kind's subject", () => {
  const v = cardView(play([["PY", 1000]]), CARD, at(1000));
  assert.deepEqual(v.items[0]!.answer, { code: "PY", name: "Paraguai" });
  assert.equal(v.items[0]!.status, "solved");
  assert.equal(v.items[1]!.answer, null);
  assert.equal(v.prompt?.kind, "capital");
  assert.ok(!JSON.stringify(v).includes("Itália"));
});

test("D-36: the view gives the compass, never the exact bearing", () => {
  const v = cardView(play([["AR", 1000]]), CARD, at(1000));
  const g = asCountryView(v.guesses[0]!);
  assert.ok(g.compass.length <= 2);
  assert.ok(!("bearingDeg" in g), "an exact bearing plus an exact distance solves for the centroid");
});

test("guesses in the view are the current item's only", () => {
  const v = cardView(play([["AR", 1000], ["PY", 2000], ["FR", 3000]]), CARD, at(3000));
  assert.equal(v.cursor, 1);
  assert.equal(v.guesses.length, 1);
  assert.equal(asCountryView(v.guesses[0]!).code, "FR");
});

test("a finished card shows totals and no prompt", () => {
  const v = cardView(play([["PY", 1000], ["IT", 2000]]), CARD, at(2000));
  assert.equal(v.status, "finished");
  assert.equal(v.prompt, null);
  assert.equal(v.points, 12);
  assert.equal(v.elapsedMs, 2000);
});

// ---------------------------------------------------------------------------
// FR-5.9 / D-40 — the structural guarantee
// ---------------------------------------------------------------------------

test("D-40: a card play carries no puzzleId, at any point in its life", () => {
  const states = [fresh(), play([["AR", 1000]]), play([["PY", 1000], ["IT", 2000]])];
  for (const p of states) {
    assert.ok(!("puzzleId" in p), "a puzzleId field would put tournament scores on the daily board");
    for (const item of p.items) assert.ok(!("puzzleId" in item));
  }
  // The daily standings job selects with where("puzzleId", ">=", …), and a
  // Firestore inequality filter never returns a document lacking the field.
  // Verified against the emulator 2026-09-09; this test is the cheap guard that
  // the field never creeps back in.
  assert.equal(states[0]!.mode, "match");
});
