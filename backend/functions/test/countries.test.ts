import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES, countryByCode, shapeFor } from "../src/lib/countries";

test("the bundled data covers the whole pool: 196 countries, one shape each", () => {
  assert.equal(COUNTRIES.size, 196);
  for (const c of COUNTRIES.values()) {
    const s = shapeFor(c.code);
    assert.ok(s, `${c.code} has no shape`);
    assert.equal(s.viewBox, "0 0 500 500");
    assert.equal(s.fillRule, "evenodd");
    assert.ok(Buffer.byteLength(s.d) <= 8192, `${c.code} path is ${Buffer.byteLength(s.d)} B`);
    assert.ok(/^M[\d. L-]+Z(M[\d. L-]+Z)*$/.test(s.d), `${c.code} path has unexpected commands`);
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
