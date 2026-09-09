import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShape, selectPolygons, simplifyRings, toPathData, SIZE, PADDING } from "./shape.mjs";

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

test("FR-6.2: a country fills the padded box regardless of real size", () => {
  for (const rings of [big, small]) {
    const { path } = buildShape({ type: "Polygon", coordinates: rings });
    const nums = path.match(/-?\d+(\.\d+)?/g).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    const lo = PADDING - 0.5;
    const hi = SIZE - PADDING + 0.5;
    assert.ok(Math.min(...xs) >= lo && Math.max(...xs) <= hi, `x within padding: ${Math.min(...xs)}..${Math.max(...xs)}`);
    assert.ok(Math.min(...ys) >= lo && Math.max(...ys) <= hi, `y within padding: ${Math.min(...ys)}..${Math.max(...ys)}`);
    // Fills at least one axis edge to edge — otherwise fitExtent did nothing.
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    assert.ok(Math.max(spanX, spanY) > SIZE - 2 * PADDING - 1, "fitted to the box");
  }
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

test("buildShape enforces the byte cap by escalating tolerance", () => {
  // A jagged ring with many vertices that will not fit in 200 bytes at 1px.
  const ring = [];
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * 2 * Math.PI;
    const r = 1 + 0.05 * Math.sin(i * 7);
    ring.push([20 + r * Math.cos(a), 20 + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  const s = buildShape({ type: "Polygon", coordinates: [ring] }, { maxBytes: 200 });
  assert.ok(Buffer.byteLength(s.path) <= 200);
  assert.ok(s.tolerance > 1, "tolerance was escalated");
});

test("degenerate geometry (a line, as world-atlas gives the Vatican) is refused, not emitted empty", () => {
  const line = [[[12.4543, 41.9026], [12.4543, 41.9043], [12.4543, 41.9026], [12.4543, 41.9026]]];
  assert.throws(() => buildShape({ type: "Polygon", coordinates: line }), /degenerate/);
  const triangle = [[[10, 10], [11, 10], [10, 11], [10, 10]]];
  assert.ok(buildShape({ type: "Polygon", coordinates: triangle }).path.startsWith("M"));
});
