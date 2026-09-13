import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES, countryByCode, shapeFor } from "../src/lib/countries";

// D-59 — the two exceptions, pinned here so neither can grow quietly.
// `noShape`: an atoll nation whose largest landmass is a speck has no
// silhouette. `ICONS`: four microstates whose outline comes from vendored
// mapsicon art because ne_10m has nothing to project, and which are therefore
// the only paths in the file allowed to contain curves.
const NO_SHAPE = ["TV", "MH"];
const ICONS = ["MC", "SM", "LI", "NR"];

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
    const shaped = ICONS.includes(c.code)
      ? /^M[\d. -]+(?:[LC][\d. -]+)*Z$/           // one subpath, curves allowed
      : /^M[\d. L-]+Z(M[\d. L-]+Z)*$/;            // projected polygons, straight only
    assert.ok(shaped.test(s.d), `${c.code} path has unexpected commands`);
  }
  assert.equal([...COUNTRIES.values()].filter((c) => shapeFor(c.code)).length, 194);
});

test("D-59: only the four vendored microstates carry curves", () => {
  // A curve anywhere else means projected geometry took the icon path by
  // mistake, which would be invisible in the drawing and wrong in the pipeline.
  for (const c of COUNTRIES.values()) {
    const d = shapeFor(c.code)?.d;
    if (d && d.includes("C")) assert.ok(ICONS.includes(c.code), `${c.code} has curves but is not a vendored icon`);
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
