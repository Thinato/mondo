import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildArtwork, pointInRing, ringArea, selectRings, toRings, UnsupportedArtwork } from "./artwork.mjs";
import { PADDING, SIZE } from "./shape.mjs";

const svg = (d) => `<svg viewBox="0 0 1000 1000"><path d="${d}"/></svg>`;
const square = (x, y, w) => `M${x} ${y}L${x + w} ${y}L${x + w} ${y + w}L${x} ${y + w}Z`;

test("H and V are real commands, not decoration", () => {
  // Every file in tools/country-shapes/ uses them; icon.mjs did not accept them
  // and would have thrown on 196 countries.
  const [ring] = toRings("M10 10H50V50H10Z");
  assert.deepEqual(ring, [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }]);
});

test("relative commands and implicit linetos after M", () => {
  const [a] = toRings("m10 10 40 0 0 40 -40 0z");
  const [b] = toRings("M10 10L50 10L50 50L10 50Z");
  assert.deepEqual(a, b);
});

test("a curve is flattened, not dropped", () => {
  const [ring] = toRings("M0 0C0 100 100 100 100 0Z");
  assert.ok(ring.length > 4, `flattened to ${ring.length} points`);
  assert.ok(ring.some((p) => p.y > 40), "the bulge survives");
});

test("an unknown command is refused rather than guessed at", () => {
  // A converter that silently skips an arc draws a country with a bite out of
  // it and nobody would know which.
  assert.throws(() => toRings("M0 0A50 50 0 0 1 100 0Z"), UnsupportedArtwork);
});

test("D-8: selectRings keeps the largest landmass and the enclaves inside it", () => {
  const land = toRings(square(0, 0, 100))[0];
  const island = toRings(square(400, 400, 20))[0];
  const enclave = toRings(square(40, 40, 20))[0]; // 4% of land — Lesotho is 1.3%
  const r = selectRings([island, land, enclave]);
  assert.equal(r.keptPolygons, 1, "one landmass");
  assert.equal(r.rings.length, 2, "landmass + enclave");
  assert.equal(r.discardedPolygons, 1, "the island");
  assert.ok(r.discardedAreaShare > 0 && r.discardedAreaShare < 0.05);
});

test("D-8: minShare reads the same overrides the projected pipeline read", () => {
  const land = toRings(square(0, 0, 100))[0];
  const big = toRings(square(400, 0, 60))[0]; // 36%
  const small = toRings(square(400, 200, 20))[0]; // 4%
  assert.equal(selectRings([land, big, small]).keptPolygons, 1);
  assert.equal(selectRings([land, big, small], { minShare: 0.3 }).keptPolygons, 2);
  assert.equal(selectRings([land, big, small], { minShare: 0.03 }).keptPolygons, 3);
});

test("an island outside the landmass is not mistaken for a hole", () => {
  const land = toRings(square(0, 0, 100))[0];
  assert.ok(pointInRing({ x: 50, y: 50 }, land));
  assert.ok(!pointInRing({ x: 400, y: 400 }, land));
  assert.ok(Math.abs(ringArea(land)) === 10000);
});

test("FR-6.2: a country fills the padded box whatever size it was drawn", () => {
  for (const d of [square(0, 0, 900), square(480, 480, 4)]) {
    const { path } = buildArtwork(svg(d));
    const nums = path.match(/-?\d+(\.\d+)?/g).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    assert.ok(Math.min(...xs) >= PADDING - 0.5 && Math.max(...xs) <= SIZE - PADDING + 0.5, "x within padding");
    assert.ok(Math.min(...ys) >= PADDING - 0.5 && Math.max(...ys) <= SIZE - PADDING + 0.5, "y within padding");
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    assert.ok(span > SIZE - 2 * PADDING - 1, `fitted to the box, span ${span}`);
  }
});

test("the byte cap is met by escalating tolerance for that country alone", () => {
  let d = "M500 200";
  for (let i = 1; i < 400; i++) {
    const a = (i / 400) * 2 * Math.PI;
    const r = 300 + 15 * Math.sin(i * 7);
    d += `L${(500 + r * Math.cos(a)).toFixed(3)} ${(500 + r * Math.sin(a)).toFixed(3)}`;
  }
  const s = buildArtwork(svg(d + "Z"), { maxBytes: 400 });
  assert.ok(Buffer.byteLength(s.path) <= 400, `${Buffer.byteLength(s.path)} B`);
  assert.ok(s.tolerance > 1, "tolerance was escalated");
});

test("a file with no path is refused", () => {
  assert.throws(() => buildArtwork("<svg></svg>"), UnsupportedArtwork);
});

test("every vendored country in the pool converts, under budget", () => {
  // The build asserts this too, but the build is not what runs in CI.
  const root = new URL("../../", import.meta.url);
  const pool = Object.keys(JSON.parse(readFileSync(new URL("tools/include.json", root), "utf8")).countries);
  const keep = JSON.parse(readFileSync(new URL("tools/overrides.json", root), "utf8")).keep;
  const { noShape } = JSON.parse(readFileSync(new URL("tools/shape-overrides.json", root), "utf8"));
  let total = 0;
  for (const code of pool) {
    if (noShape[code]) continue;
    const file = new URL(`tools/country-shapes/${code.toLowerCase()}.svg`, root);
    const r = buildArtwork(readFileSync(file, "utf8"), { minShare: keep[code]?.minShare ?? null, maxBytes: 8192 });
    assert.ok(r.path.startsWith("M"), `${code} produced a path`);
    total += Buffer.byteLength(r.path);
  }
  assert.ok(total <= 640 * 1024, `${(total / 1024).toFixed(1)} KB total`);
});
