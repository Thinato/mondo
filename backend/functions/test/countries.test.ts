import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES, countryByCode, shapeFor } from "../src/lib/countries";

// D-59 — the one exception, pinned here so it cannot grow quietly. An atoll
// nation whose largest landmass is a speck has no silhouette at all. D-69
// retired the other exception: every outline now comes from the same drawn
// artwork, so no country's path is shaped differently from the rest.
const NO_SHAPE = ["TV", "MH"];

test("the bundled data covers the whole pool: 196 countries, 194 shapes", () => {
  assert.equal(COUNTRIES.size, 196);
  for (const c of COUNTRIES.values()) {
    const s = shapeFor(c.code);
    if (NO_SHAPE.includes(c.code)) {
      assert.equal(s, undefined, `${c.code} is on the noShape list and must have none`);
      continue;
    }
    assert.ok(s, `${c.code} has no shape`);
    assert.equal(s.viewBox, "0 0 500 500");
    assert.equal(s.fillRule, "evenodd");
    assert.ok(Buffer.byteLength(s.d) <= 8192, `${c.code} path is ${Buffer.byteLength(s.d)} B`);
    // D-69: closed straight-line subpaths, nothing else. The artwork's curves
    // are flattened in the build, so a `C` here means one reached the server.
    assert.ok(/^M[\d. L-]+Z(M[\d. L-]+Z)*$/.test(s.d), `${c.code} path has unexpected commands`);
  }
  assert.equal([...COUNTRIES.values()].filter((c) => shapeFor(c.code)).length, 194);
});

test("D-69: no silhouette carries a curve", () => {
  // The build flattens the artwork's Béziers before simplifying, so a curve
  // here means a path skipped that step — invisible in the drawing, and a path
  // simplify-js never saw is a path over no byte budget at all.
  for (const c of COUNTRIES.values()) {
    const d = shapeFor(c.code)?.d;
    assert.ok(!d?.includes("C"), `${c.code} has curves`);
  }
});

test("D-59: a country with no silhouette keeps its centroid and its other kinds", () => {
  // The silhouette is what was dropped, not the country. The centroid still
  // feeds the distance hint every country-answer kind gives.
  for (const code of NO_SHAPE) {
    const c = COUNTRIES.get(code);
    assert.ok(c, `${code} must still be in the pool`);
    const [lon, lat] = c.centroid;
    assert.ok(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90, `${code} centroid out of range`);
  }
});

test("SEC-2: a shape carries no identifying attribute — only viewBox, d and fillRule", () => {
  assert.deepEqual(Object.keys(shapeFor("BR")!).sort(), ["d", "fillRule", "viewBox"]);
});

test("centroids are within range and tiers are 1..3", () => {
  for (const c of COUNTRIES.values()) {
    const [lon, lat] = c.centroid;
    assert.ok(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90, `${c.code} centroid ${c.centroid}`);
    assert.ok([1, 2, 3].includes(c.tier), `${c.code} tier ${c.tier}`);
  }
});

test("lookups", () => {
  assert.equal(countryByCode("BR")?.names["pt-BR"], "Brasil");
  assert.equal(countryByCode("GL"), undefined, "territories are not in the pool");
  assert.equal(countryByCode("VA"), undefined, "no usable geometry; excluded in include.json");
  assert.equal(shapeFor("ZZ"), undefined);
});
