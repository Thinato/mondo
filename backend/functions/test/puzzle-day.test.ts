import { test } from "node:test";
import assert from "node:assert/strict";
import { opensAt, puzzleIdAt } from "../src/lib/puzzle-day";

// São Paulo is UTC−3 all year (no DST since 2019), so noon local is 15:00Z.

test("OQ-2: the day flips at exactly 15:00Z", () => {
  assert.equal(puzzleIdAt(new Date("2026-09-15T14:59:59Z")), "2026-09-14");
  assert.equal(puzzleIdAt(new Date("2026-09-15T15:00:00Z")), "2026-09-15");
});

test("OQ-2: UTC midnight is still the previous day's puzzle (21:00 local)", () => {
  assert.equal(puzzleIdAt(new Date("2026-09-16T00:00:00Z")), "2026-09-15");
  assert.equal(puzzleIdAt(new Date("2026-09-16T02:59:59Z")), "2026-09-15");
  // 00:00 local is 03:00Z; still before noon, so still the 15th's puzzle.
  assert.equal(puzzleIdAt(new Date("2026-09-16T03:00:00Z")), "2026-09-15");
});

test("month and year boundaries", () => {
  assert.equal(puzzleIdAt(new Date("2026-10-01T14:00:00Z")), "2026-09-30");
  assert.equal(puzzleIdAt(new Date("2027-01-01T14:00:00Z")), "2026-12-31");
  assert.equal(puzzleIdAt(new Date("2027-01-01T15:00:00Z")), "2027-01-01");
});

test("opensAt is the inverse of puzzleIdAt at the boundary", () => {
  const open = opensAt("2026-09-15");
  assert.equal(open.toISOString(), "2026-09-15T15:00:00.000Z");
  assert.equal(puzzleIdAt(open), "2026-09-15");
  assert.equal(puzzleIdAt(new Date(open.getTime() - 1)), "2026-09-14");
});

test("a DST zone resolves both offsets (algorithm is not São Paulo-specific)", () => {
  assert.equal(opensAt("2026-07-01", "America/New_York").toISOString(), "2026-07-01T16:00:00.000Z");
  assert.equal(opensAt("2026-01-15", "America/New_York").toISOString(), "2026-01-15T17:00:00.000Z");
  assert.equal(puzzleIdAt(new Date("2026-07-01T15:59:59Z"), "America/New_York"), "2026-06-30");
});
