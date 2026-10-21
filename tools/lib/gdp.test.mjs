import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quintiles, refuseChanges, spearman } from "./gdp.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));

test("D-108: quintiles bin a continent into five equal fifths, ascending", () => {
  const values = Object.fromEntries([..."ABCDEFGHIJ"].map((c, i) => [c, (i + 1) * 10]));
  assert.deepEqual(Object.values(quintiles(values)), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(spearman([1, 2, 3], [3, 2, 1]), -1);
});

test("D-108: adding totals refuses to change `values` or `growth`", () => {
  const before = { values: { BR: 20000 }, growth: { values: { BR: 5 } } };
  assert.doesNotThrow(() => refuseChanges(before, { ...before, totals: { values: { BR: 1 } } }));
  assert.throws(() => refuseChanges(before, { ...before, values: { BR: 20001 } }), /values changed/);
  assert.throws(() => refuseChanges(before, { ...before, growth: undefined }), /growth changed/);
});

test("D-108: every country on a board has a total", () => {
  const { countries } = read("backend/functions/src/data/countries.json");
  const { totals } = read("backend/functions/src/data/gdp.json");
  for (const c of countries.filter((x) => ["Europe", "Asia", "Americas", "Africa"].includes(x.region))) {
    assert.ok(totals.values[c.code] > 0, `${c.code} has no total`);
  }
});
