/**
 * The Fronteiras bot (FR-15.10, D-113). Pure; seeded, so a failure replays.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { botAction } from "../src/lib/bot";
import {
  applyAction, boardOf, legalActions, newFronteiras, valuesOf, CONTINENTS, TRUCE_PLIES,
  type Adjacency, type FronteirasState,
} from "../src/lib/fronteiras";
import gdpJson from "../src/data/gdp.json";

const T0 = 1_800_000_000_000;

/** mulberry32: a seeded PRNG, so every random state here is the same on every run. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const totals = (gdpJson as unknown as { totals: { values: Record<string, number> } }).totals;

test("D-113: the bot's move is legal in 500 random states on the real boards", () => {
  const rand = mulberry32(107);
  let checked = 0;
  for (let n = 0; checked < 500; n++) {
    const continent = CONTINENTS[n % CONTINENTS.length]!;
    const { adj } = boardOf(continent);
    let s = newFronteiras({ order: ["a", "b"], continent, values: valuesOf(continent, totals), rated: false, now: T0 });
    const plies = Math.floor(rand() * 66);
    for (let i = 0; i < plies && !s.result; i++) {
      const legal = legalActions(s, adj, s.turnUid!);
      s = applyAction(s, adj, s.turnUid!, legal[Math.floor(rand() * legal.length)]!, T0 + i);
    }
    if (s.result) continue;
    const a = botAction(s, adj, rand);
    assert.ok(legalActions(s, adj, s.turnUid!).some((x) => JSON.stringify(x) === JSON.stringify(a)), JSON.stringify(a));
    checked++;
  }
});

// P1 - P2 - P3 - P4 - P5 - P6 - P7 - P8
const CHAIN = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];
const ADJ: Adjacency = Object.fromEntries(CHAIN.map((c, i) => [c, [CHAIN[i - 1], CHAIN[i + 1]].filter((x): x is string => !!x)]));
const VALUES = { P1: 3, P2: 2, P3: 1, P4: 4, P5: 5, P6: 1, P7: 2, P8: 3 };

function inPlay(owner: Record<string, 0 | 1>, gold: [number, number], fort: Record<string, number> = {}): FronteirasState {
  return {
    ...newFronteiras({ order: ["a", "b"], continent: "Europe", values: VALUES, rated: false, now: T0 }),
    phase: "play", draftIdx: 6, ply: TRUCE_PLIES, owner, gold, fort, capital: ["P1", "P8"],
  };
}

test("D-113: the bot takes the enemy capital whenever it can afford to", () => {
  const s = inPlay({ P1: 0, P5: 0, P7: 0, P2: 1, P8: 1 }, [20, 0]);
  assert.deepEqual(botAction(s, ADJ, mulberry32(1)), { t: "attack", code: "P8" });
});

test("D-113: the bot fortifies its capital when the enemy could take it next turn", () => {
  // B holds P2 (beside A's capital), has 12 and is paid 3 (three territories) next turn: P1 costs it 3 + 0 + 12.
  const exposed = inPlay({ P1: 0, P5: 0, P2: 1, P7: 1, P8: 1 }, [10, 12]);
  assert.deepEqual(botAction(exposed, ADJ, mulberry32(1)), { t: "fortify", code: "P1" });
  // One gold short is no threat: best gain per gold instead — P2 back, 2×2 for 2.
  assert.deepEqual(botAction({ ...exposed, gold: [10, 11] }, ADJ, mulberry32(1)), { t: "attack", code: "P2" });
  // Walls of 3 put it out of reach (3 + 3 + 12 > 15): the same.
  const walled = { ...exposed, fort: { P1: 3 } };
  assert.deepEqual(botAction(walled, ADJ, mulberry32(1)), { t: "attack", code: "P2" });
});

test("D-113: nothing worth taking means the cheapest move, and no gold means a pass", () => {
  const s = inPlay({ P1: 0, P2: 0, P3: 0, P4: 0, P5: 0, P6: 0, P7: 0, P8: 1 }, [2, 0], { P8: 99 });
  assert.equal(botAction(s, ADJ, mulberry32(1)).t, "fortify");
  assert.deepEqual(botAction({ ...s, gold: [0, 0] }, ADJ, mulberry32(1)), { t: "pass" });
});

test("D-113: in the draft the capital is the best legal value with the fewest ways in, then the best value", () => {
  // Q1, Q3 and Q5 are worth 5: Q1 has three neighbours, Q3 two, Q5 one (too few for a capital).
  const adj: Adjacency = { Q1: ["Q2", "Q3", "Q4"], Q2: ["Q1", "Q3"], Q3: ["Q1", "Q2"], Q4: ["Q1", "Q6"], Q5: ["Q6"], Q6: ["Q4", "Q5"] };
  const values = { Q1: 5, Q2: 1, Q3: 5, Q4: 4, Q5: 5, Q6: 2 };
  const s = newFronteiras({ order: ["a", "b"], continent: "Europe", values, rated: false, now: T0 });
  assert.deepEqual(botAction(s, adj, mulberry32(1)), { t: "pick", code: "Q3" });
  // B's capital: Q1 and Q2 border A's Q3 and Q5 is too small, so Q4 (4) over Q6 (2).
  const b1 = applyAction(s, adj, "a", { t: "pick", code: "Q3" }, T0 + 1);
  assert.deepEqual(botAction(b1, adj, mulberry32(1)), { t: "pick", code: "Q4" });
  // Then any spaced pick: Q5's 5 with one way in is fine now.
  const b2 = applyAction(b1, adj, "b", { t: "pick", code: "Q4" }, T0 + 2);
  assert.deepEqual(botAction(b2, adj, mulberry32(1)), { t: "pick", code: "Q5" });
});
