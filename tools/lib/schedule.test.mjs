import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate, itemsOf, minDayGap, minRepeatGap, opensAt, poolsFrom, prng, tierMix, DAY_WINDOW, KINDS, KIND_WINDOW } from "./schedule.mjs";

// The real pools, so the tests exercise the real tension: the flag pool is the
// tight one at 172 countries against a 120-day window.
const countriesJson = JSON.parse(readFileSync(new URL("../../backend/functions/src/data/countries.json", import.meta.url)));
const flagsJson = JSON.parse(readFileSync(new URL("../../backend/functions/src/data/flags.json", import.meta.url)));
const gdpJson = JSON.parse(readFileSync(new URL("../../backend/functions/src/data/gdp.json", import.meta.url)));
const shapesJson = JSON.parse(readFileSync(new URL("../../backend/functions/src/data/shapes.json", import.meta.url)));
const pools = poolsFrom(countriesJson, flagsJson, gdpJson, shapesJson);
const tierOf = new Map(countriesJson.countries.map((c) => [c.code, c.tier]));
const base = { pools, seed: 20260908, start: "2026-09-15" };

test("the pools match what the server's kinds allow (kinds.ts is the authority)", () => {
  // Duplicated rules, pinned on both sides: backend test/kinds.test.ts asserts
  // the same three numbers, so a change to either rule fails one of them.
  // D-59: 196 countries, 194 silhouettes. Tuvalu and the Marshall Islands are
  // atoll nations whose largest landmass is a speck; they keep every other kind.
  assert.equal(pools.shape.length, 194);
  for (const code of ["TV", "MH"]) {
    assert.ok(!pools.shape.some((c) => c.code === code), `${code} has no silhouette worth asking about`);
    assert.ok(pools.gdp.some((c) => c.code === code), `${code} is still in the game`);
  }
  assert.equal(pools.capital.length, 181);
  assert.equal(pools.flag.length, 172);
  assert.equal(pools.gdp.length, 186);
  for (const code of ["BR", "SG", "MX", "MC"]) {
    assert.ok(!pools.capital.some((c) => c.code === code), `${code} names itself in its capital`);
  }
  for (const code of ["MX", "PY", "EG"]) {
    assert.ok(!pools.flag.some((c) => c.code === code), `${code} has no flag in the pool`);
  }
  for (const code of ["CU", "KP", "TW", "VE"]) {
    assert.ok(!pools.gdp.some((c) => c.code === code), `${code} has no World Bank figure`);
  }
});

test("D-52: every day is one challenge of every kind, in a shuffled order", () => {
  const s = generate({ ...base, days: 365 });
  const orders = new Set();
  for (const d of s) {
    assert.deepEqual([...d.items.map((i) => i.kind)].sort(), [...KINDS].sort(), d.puzzleId);
    assert.equal(new Set(d.items.map((i) => i.subject)).size, KINDS.length, `${d.puzzleId} asks the same country twice`);
    orders.add(d.items.map((i) => i.kind).join(">"));
  }
  // 4! = 24 orderings; over 365 days most should turn up.
  assert.ok(orders.size >= 20, `only ${orders.size} of 24 orderings appeared`);
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

// --- FR-8.7 / D-66: the daily's fifth challenge -----------------------------

test("D-66: a day is five challenges and flagPick is one of them", () => {
  assert.deepEqual(KINDS, ["shape", "flag", "capital", "gdp", "flagPick"]);
  assert.deepEqual(pools.flagPick, pools.flag, "flagPick asks about exactly what flag asks about");
});

test("D-66: the generator fills a choice kind's options, and only that kind's", () => {
  // A stand-in for the server's buildOptions: the real one is injected by the
  // CLI, so what this pins is the CONTRACT — called once per choice item, with
  // every subject of the day already in `exclude`.
  const seen = [];
  const buildOptions = (kind, subject, exclude) => {
    if (kind !== "flagPick") return undefined;
    seen.push({ subject, exclude: [...exclude] });
    return ["A", "B", subject];
  };
  const days = generate({ pools, seed: 3, start: "2026-01-01", days: 5, buildOptions });
  for (const day of days) {
    const subjects = day.items.map((i) => i.subject);
    for (const it of day.items) {
      if (it.kind === "flagPick") {
        assert.deepEqual(it.options, ["A", "B", it.subject]);
      } else {
        assert.equal(it.options, undefined, `${it.kind} must carry no options`);
      }
    }
    // Every subject of the day was already excluded when the options were
    // chosen — including the ones drawn after it (FR-8.7).
    const call = seen.find((c) => subjects.includes(c.subject) && day.items.some((i) => i.kind === "flagPick" && i.subject === c.subject));
    for (const s of subjects) assert.ok(call.exclude.includes(s), `${s} was not excluded`);
  }
});

test("D-66: a sixth kind would be arithmetically impossible, and says so", () => {
  // The day window locks KINDS.length countries per day for its whole length,
  // so the smallest pool has to outlast that. Five kinds × 30 days is 150
  // against 172 flags. Simulated here by widening the window rather than by
  // inventing a kind, which is the same arithmetic from the other side.
  assert.throws(
    () => generate({ pools, seed: 1, start: "2026-01-01", days: 10, dayWindow: 40 }),
    /cannot survive 5 kinds/,
  );
});
