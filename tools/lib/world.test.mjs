import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWorld, MIN_AREA_PX, WIDTH } from "./world.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));

// Two squares of land; a big country on one, a speck on the other.
const square = (lon, lat, size) => [[[lon, lat], [lon, lat + size], [lon + size, lat + size], [lon + size, lat], [lon, lat]]];
const land = { type: "MultiPolygon", coordinates: [square(-60, -30, 40), square(100, 0, 2)] };

test("D-89: a country big enough is a path; a speck, or one with no geometry, is a dot at its centroid", () => {
  const w = buildWorld({
    land,
    features: new Map([
      ["BIG", { type: "Polygon", coordinates: square(-50, -20, 20) }],
      ["SPECK", { type: "Polygon", coordinates: square(100.5, 0.5, 0.01) }],
    ]),
    centroids: new Map([["BIG", [-40, -10]], ["SPECK", [100.5, 0.5]], ["NONE", [101, 1]]]),
  });
  assert.match(w.viewBox, new RegExp(`^0 0 ${WIDTH} \\d+$`));
  assert.ok(w.land.startsWith("M"));
  assert.deepEqual(Object.keys(w.paths), ["BIG"]);
  assert.deepEqual(Object.keys(w.dots).sort(), ["NONE", "SPECK"]);
  assert.ok(MIN_AREA_PX > 0);
});

test("D-89: the committed world.json draws every country in the pool, within budget", () => {
  const { countries } = read("backend/functions/src/data/countries.json");
  const w = read("backend/functions/src/data/world.json");
  for (const c of countries) assert.ok(w.paths[c.code] || w.dots[c.code], `${c.code} has neither a path nor a dot`);
  assert.equal(Object.keys(w.paths).length + Object.keys(w.dots).length, countries.length);
  assert.ok(readFileSync(new URL("../../backend/functions/src/data/world.json", import.meta.url)).length < 400 * 1024);
});
