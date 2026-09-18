import { test } from "node:test";
import assert from "node:assert/strict";
import { centroidOf, selectPolygons, simplifyRings, toPathData } from "./shape.mjs";

// A ~2°×2° square near the equator, and a much smaller one far away.
const big = [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]];
const small = [[[50, 50], [50.1, 50], [50.1, 50.1], [50, 50.1], [50, 50]]];

test("D-8: selectPolygons keeps the biggest and reports what it dropped", () => {
  const r = selectPolygons({ type: "MultiPolygon", coordinates: [small, big] });
  // Rings may be rewound, so compare as point sets rather than sequences.
  const key = (ring) => ring.map((p) => p.join(",")).sort().join(";");
  assert.equal(r.polygons.length, 1);
  assert.equal(key(r.polygons[0][0]), key(big[0]));
  assert.equal(r.discardedPolygons, 1);
  assert.ok(r.discardedAreaShare > 0 && r.discardedAreaShare < 0.01, "tiny island is a tiny share");
});

test("D-8: a plain Polygon discards nothing", () => {
  const r = selectPolygons({ type: "Polygon", coordinates: big });
  assert.equal(r.keptPolygons, 1);
  assert.equal(r.discardedPolygons, 0);
  assert.equal(r.discardedAreaShare, 0);
});

test("overrides: minShare keeps islands above the threshold and drops the rest", () => {
  const medium = [[[30, 30], [31, 30], [31, 31], [30, 31], [30, 30]]]; // ~1/4 of big
  const geo = { type: "MultiPolygon", coordinates: [small, medium, big] };
  assert.equal(selectPolygons(geo, { minShare: 0.2 }).keptPolygons, 2, "medium kept, speck dropped");
  assert.equal(selectPolygons(geo, { minShare: 0.5 }).keptPolygons, 1, "only the largest");
  assert.equal(selectPolygons(geo, { minShare: 0 }).keptPolygons, 3, "everything");
});

test("simplifyRings drops sub-pixel holes and keeps real rings", () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }];
  const speck = [{ x: 5, y: 5 }, { x: 5.1, y: 5 }, { x: 5.1, y: 5.1 }, { x: 5, y: 5 }];
  const out = simplifyRings([square, speck], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 5);
});

test("toPathData: compact, closed subpaths, no trailing zeros", () => {
  const ring = [{ x: 1, y: 2.5 }, { x: 10.04, y: 2 }, { x: 10, y: 12 }, { x: 1, y: 2.5 }];
  assert.equal(toPathData([ring]), "M1 2.5L10 2L10 12Z");
});

test("D-69: the centroid is still Natural Earth's, over the polygons D-8 kept", () => {
  // The whole point of the split: artwork decides what a country looks like,
  // never where it is. An island 40° away must not drag the centroid off the
  // mainland once D-8 has dropped it.
  const geo = { type: "MultiPolygon", coordinates: [big, [[[50, 50], [51, 50], [51, 51], [50, 51], [50, 50]]]] };
  const [lon, lat] = centroidOf(selectPolygons(geo).polygons);
  assert.ok(Math.abs(lon - 11) < 0.1 && Math.abs(lat - 11) < 0.1, `centroid on the mainland, got ${lon},${lat}`);
});
