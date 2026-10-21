/**
 * Fronteiras rules (FR-15.2–15.6, D-108, D-112). Pure. A synthetic chain board
 * for the rules; the real boards for `boardOf` and `valuesOf`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpsError } from "firebase-functions/v2/https";
import {
  abort, applyAction, applyTimeout, boardOf, legalActions, newFronteiras, resign, valuesOf,
  BOT_DEADLINE, BOT_UID, CAPITAL_DEFENCE, CLOCK_MS, CONTINENTS, DRAFT_PICK_MS, FORTIFY_COST, INCREMENT_MS, TRUCE_PLIES, TURNS_EACH,
  type Action, type Adjacency, type FronteirasState,
} from "../src/lib/fronteiras";
import { gdpFor } from "../src/lib/countries";
import gdpJson from "../src/data/gdp.json";

const T0 = 1_800_000_000_000;

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

// P1 - P2 - P3 - P4 - P5 - P6 - P7 - P8, plus P1–P3 and P6–P8 so every P has
// two neighbours (a capital needs them), and an island X linked to nothing.
const CHAIN = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];
const ADJ: Adjacency = Object.fromEntries(CHAIN.map((c, i) => [c, [CHAIN[i - 1], CHAIN[i + 1]].filter((x): x is string => !!x)]));
ADJ.P1!.push("P3");
ADJ.P3!.push("P1");
ADJ.P6!.push("P8");
ADJ.P8!.push("P6");
ADJ.X = [];
const VALUES = { P1: 3, P2: 2, P3: 1, P4: 4, P5: 5, P6: 1, P7: 2, P8: 3, X: 1 };

const fresh = (order: [string, string] = ["a", "b"]) => newFronteiras({ order, continent: "Europe", values: VALUES, rated: true, now: T0 });

/** A: P1 (capital), P2, P3. B: P8 (capital), P7, P6. A to move in play, at T0 + 6. */
function drafted(order: [string, string] = ["a", "b"]): FronteirasState {
  let s = fresh(order);
  const picks: [number, string][] = [[0, "P1"], [1, "P8"], [1, "P7"], [0, "P2"], [0, "P3"], [1, "P6"]];
  picks.forEach(([seat, code], i) => { s = applyAction(s, ADJ, order[seat]!, { t: "pick", code }, T0 + i + 1); });
  return s;
}

const act = (s: FronteirasState, uid: string, a: Action, now = s.turnStartedAt + 1000) => applyAction(s, ADJ, uid, a, now);

// --- draft -------------------------------------------------------------------

test("FR-15.3: the draft snakes A B B A A B, and a first pick is the capital", () => {
  let s = fresh();
  assert.equal(s.phase, "draft");
  assert.equal(s.deadline, T0 + DRAFT_PICK_MS);
  assert.deepEqual(s.clock, { a: CLOCK_MS, b: CLOCK_MS });
  const seen: string[] = [];
  for (const code of ["P1", "P8", "P7", "P2", "P3", "P6"]) {
    seen.push(s.turnUid!);
    s = act(s, s.turnUid!, { t: "pick", code }, T0 + 5);
    if (s.phase === "draft") assert.equal(s.deadline, T0 + 5 + DRAFT_PICK_MS, "each pick has its own 30 s");
  }
  assert.deepEqual(seen, ["a", "b", "b", "a", "a", "b"]);
  assert.deepEqual(s.capital, ["P1", "P8"]);
  assert.equal(s.phase, "play");
  assert.equal(s.ply, 0);
  assert.equal(s.turnUid, "a");
  assert.deepEqual(s.gold, [3, 0], "A is paid one per territory as its first turn starts; B has not started one");
  assert.equal(s.deadline, T0 + 5 + CLOCK_MS, "the draft spends no clock");
});

test("FR-15.3: a pick is an unowned board territory, and nothing else", () => {
  const s = act(fresh(), "a", { t: "pick", code: "P1" });
  rejects(() => act(s, "b", { t: "pick", code: "P1" }), "illegal-move");
  rejects(() => act(s, "b", { t: "pick", code: "ZZ" }), "illegal-move");
  rejects(() => act(s, "b", { t: "take", code: "P2" }), "illegal-move");
  rejects(() => act(s, "b", { t: "pass" }), "illegal-move");
  // Not P2/P3 (they border A's P1), not X (a capital needs two neighbours).
  assert.deepEqual(legalActions(s, ADJ, "b"), ["P4", "P5", "P6", "P7", "P8"].map((code) => ({ t: "pick", code })));
});

test("FR-15.3: a pick may not border the opponent while a free one doesn't; otherwise any free one", () => {
  let s = act(fresh(), "a", { t: "pick", code: "P1" });
  s = act(s, "b", { t: "pick", code: "P8" });
  rejects(() => act(s, "b", { t: "pick", code: "P2" }), "illegal-move");
  rejects(() => act(s, "b", { t: "pick", code: "P3" }), "illegal-move");
  assert.equal(act(s, "b", { t: "pick", code: "X" }).owner.X, 1, "after the capital, an island with no link is a pick");
  // Every free territory borders A: the spacing gives way, and any free one is legal.
  const hemmed: FronteirasState = { ...s, owner: { P1: 0, P3: 0, P5: 0, P7: 0, P8: 1, X: 1 } };
  assert.deepEqual(legalActions(hemmed, ADJ, "b"), ["P2", "P4", "P6"].map((code) => ({ t: "pick", code })));
  assert.equal(act(hemmed, "b", { t: "pick", code: "P2" }).owner.P2, 1);
});

test("FR-15.3: a capital borders at least two territories, unless no spaced pick does", () => {
  // Q1 - Q2 - Q3, and Q4 - Q5 apart.
  const adj: Adjacency = { Q1: ["Q2"], Q2: ["Q1", "Q3"], Q3: ["Q2"], Q4: ["Q5"], Q5: ["Q4"] };
  const s = newFronteiras({ order: ["a", "b"], continent: "Europe", values: { Q1: 1, Q2: 1, Q3: 1, Q4: 1, Q5: 1 }, rated: true, now: T0 });
  rejects(() => applyAction(s, adj, "a", { t: "pick", code: "Q1" }, T0 + 1), "illegal-move");
  assert.deepEqual(legalActions(s, adj, "a"), [{ t: "pick", code: "Q2" }]);
  // B: Q1 and Q3 border A, and neither Q4 nor Q5 has two neighbours — a spaced one will do.
  const b = applyAction(s, adj, "a", { t: "pick", code: "Q2" }, T0 + 1);
  assert.deepEqual(legalActions(b, adj, "b"), [{ t: "pick", code: "Q4" }, { t: "pick", code: "Q5" }]);
  // And with no spaced one at all, any free one.
  const hemmed: FronteirasState = { ...b, owner: { Q2: 0, Q4: 0 } };
  assert.deepEqual(legalActions(hemmed, adj, "b"), ["Q1", "Q3", "Q5"].map((code) => ({ t: "pick", code })));
});

// --- actions -------------------------------------------------------------------

test("FR-15.4: each play turn pays one gold per territory held, whatever it is worth", () => {
  const s = drafted(); // A: P1 3 + P2 2 + P3 1, three territories.
  assert.equal(s.gold[0], 3);
  assert.equal(act(s, "a", { t: "pass" }).gold[1], 3);
  assert.equal(act({ ...s, owner: { ...s.owner, X: 1 } }, "a", { t: "pass" }).gold[1], 4);
});

test("FR-15.4: take an adjacent neutral for its value; not a far one, not beyond your gold", () => {
  const s = { ...drafted(), gold: [6, 0] as [number, number] };
  rejects(() => act(s, "a", { t: "take", code: "P5" }), "illegal-move"); // not next to A
  rejects(() => act(s, "a", { t: "take", code: "X" }), "illegal-move"); // linked to nothing
  rejects(() => act(s, "a", { t: "take", code: "P7" }), "illegal-move"); // not neutral
  const t = act(s, "a", { t: "take", code: "P4" });
  assert.equal(t.owner.P4, 0);
  assert.deepEqual(t.gold, [2, 3], "6 − 4 for A; B paid 3 for its 3 territories as its turn starts");
  assert.equal(t.turnUid, "b");
  assert.equal(t.ply, 1);
  const poor = { ...s, gold: [3, 0] as [number, number] };
  rejects(() => act(poor, "a", { t: "take", code: "P4" }), "illegal-move");
  assert.ok(!legalActions(poor, ADJ, "a").some((x) => x.t === "take"));
});

test("FR-15.4: attack an adjacent enemy for value + fort, + CAPITAL_DEFENCE on a capital", () => {
  // A holds P1–P4, B holds P5–P8; P4|P5 is the front.
  const base: FronteirasState = { ...drafted(), ply: TRUCE_PLIES, owner: { P1: 0, P2: 0, P3: 0, P4: 0, P5: 1, P6: 1, P7: 1, P8: 1 }, gold: [20, 20] };
  rejects(() => act(base, "a", { t: "attack", code: "P6" }), "illegal-move"); // not adjacent
  rejects(() => act(base, "a", { t: "attack", code: "P4" }), "illegal-move"); // own
  const fortified = { ...base, fort: { P5: 2 } };
  const won = act(fortified, "a", { t: "attack", code: "P5" });
  assert.equal(won.owner.P5, 0);
  assert.equal(won.fort.P5, undefined, "a captured territory's walls are gone");
  assert.equal(won.gold[0], 20 - (5 + 2));
  rejects(() => act({ ...fortified, gold: [6, 20] }, "a", { t: "attack", code: "P5" }), "illegal-move");
  // B's capital, next to P7 held by A.
  const atCapital: FronteirasState = { ...base, owner: { ...base.owner, P7: 0 }, fort: { P8: 1 } };
  assert.equal(CAPITAL_DEFENCE, 12);
  const cost = VALUES.P8 + 1 + CAPITAL_DEFENCE;
  rejects(() => act({ ...atCapital, gold: [cost - 1, 0] }, "a", { t: "attack", code: "P8" }), "illegal-move");
  const end = act({ ...atCapital, gold: [cost, 0] }, "a", { t: "attack", code: "P8" });
  assert.deepEqual(end.result, { winner: "a", reason: "capital" });
  assert.equal(end.turnUid, null);
});

test("FR-15.4: no attacks in each player's first two play turns", () => {
  const front: FronteirasState = { ...drafted(), owner: { P1: 0, P2: 0, P3: 0, P4: 0, P5: 1, P6: 1, P7: 1, P8: 1 }, gold: [20, 20] };
  assert.equal(TRUCE_PLIES, 4);
  for (let ply = 0; ply < TRUCE_PLIES; ply++) {
    rejects(() => act({ ...front, ply }, "a", { t: "attack", code: "P5" }), "illegal-move");
    assert.ok(!legalActions({ ...front, ply }, ADJ, "a").some((x) => x.t === "attack"), `ply ${ply}`);
  }
  assert.ok(legalActions({ ...front, ply: TRUCE_PLIES }, ADJ, "a").some((x) => x.t === "attack"));
  assert.equal(act({ ...front, ply: TRUCE_PLIES }, "a", { t: "attack", code: "P5" }).owner.P5, 0);
});

test("FR-15.4: fortify your own for FORTIFY_COST; pass costs nothing", () => {
  const s = drafted();
  const f = act(s, "a", { t: "fortify", code: "P1" });
  assert.equal(f.fort.P1, 1);
  assert.equal(f.gold[0], 3 - FORTIFY_COST);
  rejects(() => act(s, "a", { t: "fortify", code: "P8" }), "illegal-move");
  rejects(() => act(s, "a", { t: "fortify", code: "P4" }), "illegal-move");
  const p = act(s, "a", { t: "pass" });
  assert.equal(p.gold[0], 3);
  assert.equal(p.turnUid, "b");
});

test("FR-15.4: only the player whose turn it is, only a player, only while the game is on", () => {
  const s = drafted();
  rejects(() => act(s, "b", { t: "pass" }), "not-your-turn");
  rejects(() => act(s, "z", { t: "pass" }), "permission-denied");
  assert.deepEqual(legalActions(s, ADJ, "b"), []);
  const over = resign(s, "a");
  rejects(() => act(over, "b", { t: "pass" }), "already-completed");
  rejects(() => applyTimeout(over, BOT_DEADLINE), "already-completed");
  rejects(() => resign(over, "b"), "already-completed");
  rejects(() => abort(over), "already-completed");
  assert.deepEqual(legalActions(over, ADJ, "a"), []);
});

// --- clock ---------------------------------------------------------------------

test("FR-15.6: a move spends its time and earns the increment; the deadline is the clock", () => {
  const s = drafted();
  const t = act(s, "a", { t: "pass" }, s.turnStartedAt + 10_000);
  assert.equal(t.clock.a, CLOCK_MS - 10_000 + INCREMENT_MS);
  assert.equal(t.clock.b, CLOCK_MS);
  assert.equal(t.turnStartedAt, s.turnStartedAt + 10_000);
  assert.equal(t.deadline, t.turnStartedAt + CLOCK_MS);
});

test("FR-15.6: at or after the deadline a move is refused, and the turn is settled by timeout", () => {
  const s = drafted();
  act(s, "a", { t: "pass" }, s.deadline - 1);
  rejects(() => act(s, "a", { t: "pass" }, s.deadline), "deadline-passed");
  rejects(() => act(s, "a", { t: "pass" }, s.deadline + 5), "deadline-passed");
  rejects(() => applyTimeout(s, s.deadline - 1), "invalid-argument");
  const flagged = applyTimeout(s, s.deadline);
  assert.deepEqual(flagged.result, { winner: "b", reason: "time" });
  assert.equal(flagged.clock.a, 0);
});

test("D-112: a draft pick that runs out aborts with no winner", () => {
  const s = act(fresh(), "a", { t: "pick", code: "P1" });
  rejects(() => act(s, "b", { t: "pick", code: "P8" }, s.deadline), "deadline-passed");
  assert.deepEqual(applyTimeout(s, s.deadline).result, { winner: null, reason: "abort" });
});

test("D-113: the bot has no clock, spends none, and can never be flagged", () => {
  let s = fresh(["a", BOT_UID]);
  assert.deepEqual(Object.keys(s.clock), ["a"]);
  s = act(s, "a", { t: "pick", code: "P1" });
  assert.equal(s.turnUid, BOT_UID);
  assert.equal(s.deadline, BOT_DEADLINE);
  rejects(() => applyTimeout(s, T0 + 10 * 86_400_000), "invalid-argument");
  const d = drafted(["a", BOT_UID]);
  const b = act(act(d, "a", { t: "pass" }), BOT_UID, { t: "pass" }, T0 + 86_400_000);
  assert.deepEqual(Object.keys(b.clock), ["a"]);
  assert.equal(b.turnUid, "a");
});

// --- ends ----------------------------------------------------------------------

function passOut(s: FronteirasState): FronteirasState {
  for (let i = 0; i < 2 * TURNS_EACH; i++) {
    assert.equal(s.result, null, `over early at ply ${i}`);
    s = act(s, s.turnUid!, { t: "pass" });
  }
  return s;
}

test("FR-15.5: after TURNS_EACH turns each, more value held wins; equal is a draw", () => {
  const draw = passOut(drafted());
  assert.equal(draw.ply, 2 * TURNS_EACH);
  assert.deepEqual(draw.result, { winner: null, reason: "turns" }, "6 against 6");
  const b = passOut({ ...drafted(), owner: { ...drafted().owner, X: 1 } });
  assert.deepEqual(b.result, { winner: "b", reason: "turns" });
  assert.equal(b.gold[0], 3 * TURNS_EACH, "income every turn, and passing spends nothing");
});

test("FR-15.5: resign in play loses; giving up in the draft or an abort has no winner", () => {
  assert.deepEqual(resign(drafted(), "b").result, { winner: "a", reason: "resign" });
  assert.deepEqual(resign(drafted(), "a").result, { winner: "b", reason: "resign" }, "on your own turn or not");
  assert.deepEqual(resign(fresh(), "a").result, { winner: null, reason: "abort" });
  rejects(() => resign(drafted(), "z"), "permission-denied");
  assert.deepEqual(abort(drafted()).result, { winner: null, reason: "abort" });
});

// --- the real boards -------------------------------------------------------------

const SIZES = { Europe: 45, Asia: 48, Americas: 35, Africa: 54 };

test("FR-15.2: each board is its continent, connected, symmetric, laid out", () => {
  for (const c of CONTINENTS) {
    const b = boardOf(c);
    assert.equal(b.codes.length, SIZES[c], c);
    for (const code of b.codes) {
      assert.ok(b.adj[code]!.length > 0, `${code} has no neighbour`);
      assert.ok(!b.adj[code]!.includes(code));
      for (const n of b.adj[code]!) assert.ok(b.adj[n]!.includes(code), `${code}–${n} one way`);
      assert.ok(b.labels[code], `${code} has no label`);
    }
    const seen = new Set([b.codes[0]!]);
    const todo = [b.codes[0]!];
    while (todo.length) for (const n of b.adj[todo.pop()!]!) if (!seen.has(n)) (seen.add(n), todo.push(n));
    assert.equal(seen.size, b.codes.length, `${c} is not connected`);
    assert.match(b.viewBox, /^-?\d+ -?\d+ \d+ \d+$/);
  }
  assert.ok(boardOf("Europe").adj.ES!.includes("PT"));
});

const totals = (gdpJson as unknown as { totals: { values: Record<string, number> } }).totals;

test("D-108: values are quintiles 1–5 of total GDP on every board", () => {
  for (const c of CONTINENTS) {
    const v = valuesOf(c, totals);
    const codes = boardOf(c).codes;
    assert.deepEqual(Object.keys(v).sort(), codes);
    const counts = [1, 2, 3, 4, 5].map((t) => Object.values(v).filter((x) => x === t).length);
    for (const n of counts) assert.ok(Math.abs(n - codes.length / 5) <= 1.5, `${c} tiers ${counts}`);
    // Monotone in the figure.
    for (const a of codes) for (const b of codes) if (totals.values[a]! < totals.values[b]!) assert.ok(v[a]! <= v[b]!);
  }
});

test("D-108, SEC-19: values come from the totals handed in, never from per-capita", () => {
  const codes = boardOf("Europe").codes;
  // Totals that run AGAINST per-capita: the tiers must follow the totals.
  const pc = (c: string) => gdpFor(c) ?? 0;
  const inverted = { values: Object.fromEntries(codes.map((c) => [c, -pc(c)])) };
  const v = valuesOf("Europe", inverted);
  for (const a of codes) for (const b of codes) if (pc(a) > pc(b)) assert.ok(v[a]! <= v[b]!, `${a} ${b}`);
  // Equal figures share a tier, whatever order they come in.
  const flat = valuesOf("Europe", { values: Object.fromEntries(codes.map((c) => [c, 7])) });
  assert.ok(Object.values(flat).every((x) => x === 1));
  assert.throws(() => valuesOf("Europe", { values: {} }));
  // And the file never reaches for the per-capita figure on its own.
  const src = readFileSync(join(__dirname, "../../src/lib/fronteiras.ts"), "utf8");
  assert.doesNotMatch(src, /import[^;]*gdp|gdpFor|gdpGrowthFor/);
});
