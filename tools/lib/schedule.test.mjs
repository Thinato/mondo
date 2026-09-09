import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate, opensAt, tierMix, minRepeatGap, prng } from "./schedule.mjs";

// The real pool, so the tests exercise the real tension of R-1 (93 tier-1
// countries against ~90 tier-1 picks per 180-day window).
const { countries } = JSON.parse(readFileSync(new URL("../../backend/functions/src/data/countries.json", import.meta.url)));
const pool = countries.map((c) => ({ code: c.code, tier: c.tier }));
const base = { countries: pool, seed: 20260908, start: "2026-09-15" };

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

test("FR-2.3: no country repeats within 180 days, over 3 years and 5 seeds", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = generate({ ...base, seed, days: 3 * 365 });
    assert.ok(minRepeatGap(s) >= 180, `seed ${seed}: min gap ${minRepeatGap(s)}`);
  }
});

test("FR-2.3 across runs: history from the previous year is honoured", () => {
  const y1 = generate({ ...base, days: 365 });
  const y2 = generate({ ...base, seed: 99, start: "2027-09-15", history: y1 });
  assert.ok(minRepeatGap([...y1, ...y2]) >= 180);
  assert.throws(() => generate({ ...base, start: "2027-01-01", history: y1 }), /not before start/);
});

test("FR-2.4: tier mix over a year is within 5 points of 50/35/15", () => {
  const mix = tierMix(generate({ ...base, days: 365 }));
  const pct = (t) => Math.round((mix[t] ?? 0) * 100);
  assert.ok(Math.abs(pct(1) - 50) <= 5, `tier 1 ${pct(1)}%`);
  assert.ok(Math.abs(pct(2) - 35) <= 5, `tier 2 ${pct(2)}%`);
  assert.ok(Math.abs(pct(3) - 15) <= 5, `tier 3 ${pct(3)}%`);
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

test("a pool too small for the window fails loudly instead of looping", () => {
  const tiny = pool.slice(0, 40);
  assert.throws(() => generate({ ...base, countries: tiny }), /too small/);
});

test("prng is deterministic and in [0, 1)", () => {
  const a = prng(42), b = prng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});
