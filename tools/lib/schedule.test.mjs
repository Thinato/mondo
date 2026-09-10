import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate, itemsOf, minDayGap, minRepeatGap, opensAt, poolsFrom, prng, tierMix, DAY_WINDOW, KINDS, KIND_WINDOW } from "./schedule.mjs";

// The real pools, so the tests exercise the real tension: the flag pool is the
// tight one at 172 countries against a 120-day window.
const countriesJson = JSON.parse(readFileSync(new URL("../../backend/functions/src/data/countries.json", import.meta.url)));
const flagsJson = JSON.parse(readFileSync(new URL("../../backend/functions/src/data/flags.json", import.meta.url)));
const pools = poolsFrom(countriesJson, flagsJson);
const tierOf = new Map(countriesJson.countries.map((c) => [c.code, c.tier]));
const base = { pools, seed: 20260908, start: "2026-09-15" };

test("the pools match what the server's kinds allow (kinds.ts is the authority)", () => {
  // Duplicated rules, pinned on both sides: backend test/kinds.test.ts asserts
  // the same three numbers, so a change to either rule fails one of them.
  assert.equal(pools.shape.length, 196);
  assert.equal(pools.capital.length, 181);
  assert.equal(pools.flag.length, 172);
  for (const code of ["BR", "SG", "MX", "MC"]) {
    assert.ok(!pools.capital.some((c) => c.code === code), `${code} names itself in its capital`);
  }
  for (const code of ["MX", "PY", "EG"]) {
    assert.ok(!pools.flag.some((c) => c.code === code), `${code} has no flag in the pool`);
  }
});

test("D-52: every day is one challenge of every kind, in a shuffled order", () => {
  const s = generate({ ...base, days: 365 });
  const orders = new Set();
  for (const d of s) {
    assert.deepEqual([...d.items.map((i) => i.kind)].sort(), [...KINDS].sort(), d.puzzleId);
    assert.equal(new Set(d.items.map((i) => i.subject)).size, 3, `${d.puzzleId} asks the same country twice`);
    orders.add(d.items.map((i) => i.kind).join(">"));
  }
  assert.equal(orders.size, 6, "all six orderings should turn up over a year");
});

test("D-52: every subject is in its own kind's pool", () => {
  const inPool = Object.fromEntries(KINDS.map((k) => [k, new Set(pools[k].map((c) => c.code))]));
  for (const d of generate({ ...base, days: 365 })) {
    for (const it of d.items) assert.ok(inPool[it.kind].has(it.subject), `${d.puzzleId}: ${it.subject} is not askable as ${it.kind}`);
  }
});

test("determinism: same seed → identical schedule; different seed → different", () => {
  const a = JSON.stringify(generate(base));
  assert.equal(a, JSON.stringify(generate(base)));
  assert.notEqual(a, JSON.stringify(generate({ ...base, seed: 1 })));
});

test("FR-2.1: 365 consecutive puzzleIds starting at start", () => {
  const s = generate(base);
  assert.equal(s.length, 365);
  assert.equal(s[0].puzzleId, "2026-09-15");
  assert.equal(s[364].puzzleId, "2027-09-14");
  for (let i = 1; i < s.length; i++) {
    assert.equal((Date.parse(s[i].puzzleId) - Date.parse(s[i - 1].puzzleId)) / 86_400_000, 1);
  }
});

test("FR-2.3: the two windows hold over 3 years and 5 seeds", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = generate({ ...base, seed, days: 3 * 365 });
    assert.ok(minRepeatGap(s) >= KIND_WINDOW, `seed ${seed}: same kind again after ${minRepeatGap(s)} days`);
    assert.ok(minDayGap(s) >= DAY_WINDOW, `seed ${seed}: asked again after ${minDayGap(s)} days`);
  }
});

test("FR-2.3 across runs: history from the previous year is honoured", () => {
  const y1 = generate({ ...base, days: 365 });
  const y2 = generate({ ...base, seed: 99, start: "2027-09-15", history: y1 });
  assert.ok(minRepeatGap([...y1, ...y2]) >= KIND_WINDOW);
  assert.ok(minDayGap([...y1, ...y2]) >= DAY_WINDOW);
  assert.throws(() => generate({ ...base, start: "2027-01-01", history: y1 }), /not before start/);
});

test("D-52: a pre-D-52 schedule is readable as history, one silhouette a day", () => {
  const legacy = [{ puzzleId: "2026-09-14", countryCode: "PY" }];
  assert.deepEqual(itemsOf(legacy[0]), [{ kind: "shape", subject: "PY" }]);
  const s = generate({ ...base, days: 30, history: legacy });
  const firstShape = s.find((d) => d.items.some((i) => i.kind === "shape" && i.subject === "PY"));
  assert.equal(firstShape, undefined, "PY was the silhouette yesterday, so not again inside the window");
});

test("FR-2.4: every kind's tier mix over a year is within 8 points of 50/35/15", () => {
  const s = generate({ ...base, days: 365 });
  for (const kind of KINDS) {
    const mix = tierMix(s, tierOf, kind);
    const pct = (t) => Math.round((mix[t] ?? 0) * 100);
    // Wider than the old ±5: a kind's pool is not the whole world (172 flags),
    // so its tier proportions cannot match the full pool's exactly.
    assert.ok(Math.abs(pct(1) - 50) <= 8, `${kind} tier 1 ${pct(1)}%`);
    assert.ok(Math.abs(pct(2) - 35) <= 8, `${kind} tier 2 ${pct(2)}%`);
    assert.ok(Math.abs(pct(3) - 15) <= 8, `${kind} tier 3 ${pct(3)}%`);
  }
});

test("OQ-2: every puzzle opens at 12:00 São Paulo, i.e. 15:00Z (no DST in Brazil since 2019)", () => {
  for (const p of generate({ ...base, days: 400 })) {
    assert.equal(p.opensAt, `${p.puzzleId}T15:00:00.000Z`);
  }
});

test("opensAt handles a zone with DST on both sides of the change", () => {
  // New York: EDT (-4) in July, EST (-5) in January.
  assert.equal(opensAt("2026-07-01", "America/New_York").toISOString(), "2026-07-01T16:00:00.000Z");
  assert.equal(opensAt("2026-01-15", "America/New_York").toISOString(), "2026-01-15T17:00:00.000Z");
});

test("a pool too small for its window fails loudly instead of looping", () => {
  assert.throws(() => generate({ ...base, pools: { ...pools, flag: pools.flag.slice(0, 40) } }), /too small/);
  assert.throws(() => generate({ ...base, pools: { ...pools, capital: [] } }), /no pool for kind/);
});

test("prng is deterministic and in [0, 1)", () => {
  const a = prng(42), b = prng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});
