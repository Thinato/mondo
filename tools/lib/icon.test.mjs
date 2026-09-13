import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boundsOf, buildIcon, fitToBox, mapPoints, parsePath, toPathData, UnsupportedIcon, PADDING, SIZE } from "./icon.mjs";

const svg = (code) => readFileSync(new URL(`../mapsicon/${code}.svg`, import.meta.url), "utf8");
const CODES = ["mc", "sm", "li", "nr"];

test("relative commands accumulate from the current point", () => {
  assert.deepEqual(parsePath("M10 10 l5 0 l0 5 z"), [
    { m: [10, 10] }, { l: [15, 10] }, { l: [15, 15] }, { z: true },
  ]);
});

test("a repeated pair after M is an implicit lineto, as SVG says", () => {
  assert.deepEqual(parsePath("M0 0 1 1 2 2"), [{ m: [0, 0] }, { l: [1, 1] }, { l: [2, 2] }]);
});

test("Z returns the current point to the subpath start", () => {
  // Without this a following relative command walks from the wrong place, which
  // is invisible in the numbers and obvious in the drawing.
  assert.deepEqual(parsePath("M10 10 l5 5 z l1 1"), [
    { m: [10, 10] }, { l: [15, 15] }, { z: true }, { l: [11, 11] },
  ]);
});

test("a cubic carries its control points, and they move with it", () => {
  const [seg] = parsePath("M0 0 c1 2 3 4 5 6").slice(1);
  assert.deepEqual(seg, { c: [1, 2, 3, 4, 5, 6] });
  const moved = mapPoints([seg], (x, y) => [x * 2, y + 1]);
  assert.deepEqual(moved, [{ c: [2, 3, 6, 5, 10, 7] }]);
});

test("anything this converter cannot read is refused, never guessed", () => {
  // An arc silently dropped is a country with a bite taken out of it and no
  // error anywhere. Four files, a human sees each one — refuse and say so.
  for (const d of ["M0 0 A10 10 0 0 1 5 5", "M0 0 S1 1 2 2", "M0 0 q1 1 2 2", "5 5 L1 1"]) {
    assert.throws(() => parsePath(d), UnsupportedIcon, `should refuse: ${d}`);
  }
});

test("the bounding box includes control points, not just anchors", () => {
  // A Bézier bulges past its anchors; a box drawn around the anchors alone
  // would clip the bulge off at the edge of the viewBox.
  const segs = parsePath("M0 0 C0 100 10 100 10 0");
  assert.deepEqual(boundsOf(segs), { minX: 0, minY: 0, maxX: 10, maxY: 100 });
});

test("fitting centres inside the padding and preserves aspect", () => {
  const wide = fitToBox(parsePath("M0 0 L100 0 L100 50 z"));
  const { minX, minY, maxX, maxY } = boundsOf(wide);
  assert.ok(minX >= PADDING - 1e-6 && maxX <= SIZE - PADDING + 1e-6, "inside the box horizontally");
  assert.ok(minY >= PADDING - 1e-6 && maxY <= SIZE - PADDING + 1e-6, "inside the box vertically");
  // 2:1 in, 2:1 out — a stretched country is a different country.
  assert.ok(Math.abs((maxX - minX) / (maxY - minY) - 2) < 1e-6);
  // The long axis fills the padded box; the short one is centred in it.
  assert.ok(Math.abs((maxX - minX) - (SIZE - 2 * PADDING)) < 1e-6);
  assert.ok(Math.abs((minY - PADDING) - (SIZE - PADDING - maxY)) < 1e-6);
});

test("one decimal place, and no trailing zeros", () => {
  assert.equal(toPathData([{ m: [1.04, 2.06] }, { l: [3, 4.0] }, { z: true }]), "M1 2.1L3 4Z");
});

test("every vendored mapsicon file converts, fits the box and the byte budget", () => {
  for (const code of CODES) {
    const { path, points, bytes } = buildIcon(svg(code));
    assert.ok(points > 90, `${code}: ${points} points — the whole reason for this is detail`);
    assert.ok(bytes <= 8192, `${code}: ${bytes} B over budget`);
    const { minX, minY, maxX, maxY } = boundsOf(parsePath(path));
    assert.ok(minX >= 0 && minY >= 0 && maxX <= SIZE && maxY <= SIZE, `${code} escapes the viewBox`);
    assert.match(path, /^M/, `${code} must start with a moveto`);
  }
});

test("the potrace y-flip is applied, so no country is upside down", () => {
  // mapsicon's group is `scale(0.1,-0.1) translate(0,1024)`: y grows upward in
  // the path and downward in SVG. Getting this wrong mirrors the country, which
  // still looks like a plausible silhouette — which is exactly why it is tested
  // rather than eyeballed. Monaco's coast runs along its SOUTH edge, so its
  // widest row must be in the bottom half of the box.
  const segs = parsePath(buildIcon(svg("mc")).path);
  const ys = segs.filter((s) => !s.z).map((s) => (s.c ? s.c[5] : (s.m ?? s.l)[1]));
  const mid = SIZE / 2;
  const below = ys.filter((y) => y > mid).length;
  assert.ok(below > ys.length * 0.5, `Monaco's mass should sit low in the box, got ${below}/${ys.length}`);
});

test("a file shaped unlike potrace output is refused rather than half-read", () => {
  assert.throws(() => buildIcon('<svg><path d="M0 0"/><path d="M1 1"/></svg>'), UnsupportedIcon);
  assert.throws(() => buildIcon('<svg><path d="M0 0 L1 1 z"/></svg>'), UnsupportedIcon, "no group transform");
  assert.throws(
    () => buildIcon('<svg><g transform="translate(0,1024) scale(0.1,-0.1)"><path d="M0 0 L0 0 z"/></g></svg>'),
    UnsupportedIcon,
    "a shape with no extent",
  );
});
