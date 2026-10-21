/**
 * Glicko-2 (D-110). The paper's own worked example is the test: if these three
 * numbers come out, every step of the algorithm is right.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { glicko2, preRate, START } from "../src/lib/glicko";

const near = (actual: number, expected: number, tol: number) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} is not ${expected} ±${tol}`);

test("Glickman's example: 1500/200 vs a 1400 win, a 1550 loss and a 1700 loss", () => {
  const r = glicko2({ rating: 1500, rd: 200, vol: 0.06 }, [
    { rating: 1400, rd: 30, score: 1 },
    { rating: 1550, rd: 100, score: 0 },
    { rating: 1700, rd: 300, score: 0 },
  ]);
  near(r.rating, 1464.06, 0.1);
  near(r.rd, 151.52, 0.1);
  near(r.vol, 0.05999, 1e-5);
});

test("a period with no games only grows RD", () => {
  const p = { rating: 1500, rd: 200, vol: 0.06 };
  const r = glicko2(p, []);
  assert.equal(r.rating, 1500);
  assert.equal(r.vol, 0.06);
  near(r.rd, Math.sqrt(200 ** 2 + (0.06 * 173.7178) ** 2), 1e-9);
});

test("inflate: false skips step 6, so the same game ends at a smaller RD", () => {
  const p = { rating: 1500, rd: 200, vol: 0.06 };
  const res = [{ rating: 1500, rd: 200, score: 1 }];
  assert.ok(glicko2(p, res, 0.5, false).rd < glicko2(p, res).rd);
});

test("preRate grows RD by the idle days and caps it at 350", () => {
  const p = { rating: 1600, rd: 100, vol: 0.06 };
  assert.deepEqual(preRate(p, 0), p);
  near(preRate(p, 4).rd, Math.sqrt(100 ** 2 + 4 * (0.06 * 173.7178) ** 2), 1e-9);
  assert.equal(preRate(p, 100_000).rd, 350);
  assert.equal(preRate(START, 30).rd, 350);
  assert.equal(preRate(p, 4).rating, 1600);
});
