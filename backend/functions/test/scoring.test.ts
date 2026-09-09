import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsFor, shareGrid, squares } from "../src/lib/scoring";
import { COUNTRIES } from "../src/lib/countries";

test("FR-3.1: the points table, all seven cases", () => {
  assert.equal(pointsFor(true, 1), 6);
  assert.equal(pointsFor(true, 2), 5);
  assert.equal(pointsFor(true, 3), 4);
  assert.equal(pointsFor(true, 4), 3);
  assert.equal(pointsFor(true, 5), 2);
  assert.equal(pointsFor(true, 6), 1);
  assert.equal(pointsFor(false, 6), 0);
});

test("pointsFor rejects impossible guess counts", () => {
  assert.throws(() => pointsFor(true, 0), RangeError);
  assert.throws(() => pointsFor(true, 7), RangeError);
});

test("squares: five per row, greens by fifths, one yellow for a half step", () => {
  assert.equal(squares(0), "⬜⬜⬜⬜⬜");
  assert.equal(squares(0.05), "⬜⬜⬜⬜⬜");
  assert.equal(squares(0.1), "🟨⬜⬜⬜⬜");
  assert.equal(squares(0.2), "🟩⬜⬜⬜⬜");
  assert.equal(squares(0.5), "🟩🟩🟨⬜⬜");
  assert.equal(squares(0.948), "🟩🟩🟩🟩🟨");
  assert.equal(squares(1), "🟩🟩🟩🟩🟩");
  assert.equal([...squares(0.37)].filter((c) => c !== "️").length, 5);
});

test("FR-2.11: share grid has a header, one row per guess, 🎉 on the solve, X when failed", () => {
  const g = shareGrid(
    "2026-09-15",
    [
      { correct: false, proximity: 0.5, compass: "NE" },
      { correct: false, proximity: 0.9, compass: "SE" },
      { correct: true, proximity: 1, compass: "N" },
    ],
    true,
  );
  assert.equal(g, "Mondo 2026-09-15 3/6\n🟩🟩🟨⬜⬜ ↗️\n🟩🟩🟩🟩🟨 ↘️\n🟩🟩🟩🟩🟩 🎉");

  const failed = shareGrid("2026-09-15", Array(6).fill({ correct: false, proximity: 0.2, compass: "W" }), false);
  assert.ok(failed.startsWith("Mondo 2026-09-15 X/6\n"));
  assert.equal(failed.split("\n").length, 7);
});

test("SEC-1: the share grid can never contain a country name or code", () => {
  const g = shareGrid("2026-09-15", [{ correct: true, proximity: 1, compass: "N" }], true).toLowerCase();
  for (const c of COUNTRIES.values()) {
    for (const term of [c.names.en, c.names["pt-BR"]]) {
      assert.ok(!g.includes(term.toLowerCase()), `share grid leaks ${term}`);
    }
  }
  // Codes are two capital letters; the grid has none.
  assert.ok(!/[A-Z]{2}/.test(g.replace(/^Mondo/, "")));
});
