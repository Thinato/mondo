import { test } from "node:test";
import assert from "node:assert/strict";
import { band, shareGrid, type ItemForShare } from "../src/lib/scoring";
import { KINDS } from "../src/lib/kinds";
import { COUNTRIES } from "../src/lib/countries";

/**
 * FR-3.1's ladder lives on the `shape` kind since D-52, so that a silhouette
 * scores identically whether it is the daily or one challenge of a tournament
 * card. This is the test that used to own `pointsFor`.
 */
test("FR-3.1: the points table, all seven cases", () => {
  assert.deepEqual([...KINDS.shape.pointsByGuess], [6, 5, 4, 3, 2, 1]);
  assert.equal(KINDS.shape.maxGuesses, 6);
});

test("band: one square for how close a guess landed", () => {
  assert.equal(band(0), "🟥");
  assert.equal(band(0.39), "🟥");
  assert.equal(band(0.4), "🟨");
  assert.equal(band(0.79), "🟨");
  assert.equal(band(0.8), "🟩");
  assert.equal(band(1), "🟩");
  assert.equal(band(-1), "🟥", "clamped");
  assert.equal(band(2), "🟩", "clamped");
});

const item = (kind: ItemForShare["kind"], maxGuesses: number, guesses: ItemForShare["guesses"], solved: boolean): ItemForShare =>
  ({ kind, maxGuesses, guesses, solved });

test("FR-2.11: one row per challenge, its icon, and the score out of the day's best", () => {
  const g = shareGrid(
    "2026-09-15",
    [
      item("shape", 6, [
        { correct: false, proximity: 0.5, compass: "NE" },
        { correct: true, proximity: 1, compass: "N" },
      ], true),
      item("flag", 3, [{ correct: true, proximity: 1, compass: "N" }], true),
      item("capital", 3, [
        { correct: false, proximity: 0.2, compass: "W" },
        { correct: false, proximity: 0.9, compass: "SE" },
        { correct: false, proximity: 0.1, compass: "S" },
      ], false),
    ],
    11,
    18,
  );
  assert.equal(
    g,
    [
      "Mondo 2026-09-15 11/18",
      "🗺️ 🟨↗️ 🟩🎉 ⬛ ⬛ ⬛ ⬛",
      "🏳️ 🟩🎉 ⬛ ⬛",
      "🏙️ 🟥⬅️ 🟩↘️ 🟥⬇️",
    ].join("\n"),
  );
});

test("FR-2.11: a challenge nobody reached is all blanks, and the day still shares", () => {
  const g = shareGrid("2026-09-15", [item("shape", 6, [{ correct: true, proximity: 1, compass: "N" }], true), item("flag", 3, [], false)], 6, 12);
  assert.equal(g.split("\n").length, 3);
  assert.equal(g.split("\n")[2], "🏳️ ⬛ ⬛ ⬛");
});

test("SEC-1: the share grid can never contain a country name or code", () => {
  const g = shareGrid(
    "2026-09-15",
    [item("shape", 6, [{ correct: true, proximity: 1, compass: "N" }], true), item("capital", 3, [{ correct: false, proximity: 0.5, compass: "SW" }], false)],
    6,
    18,
  ).toLowerCase();
  for (const c of COUNTRIES.values()) {
    for (const term of [c.names.en, c.names["pt-BR"]]) {
      assert.ok(!g.includes(term.toLowerCase()), `share grid leaks ${term}`);
    }
  }
  // Codes are two capital letters; the grid has none.
  assert.ok(!/[A-Z]{2}/.test(g.replace(/^Mondo/, "")));
});
