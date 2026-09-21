import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFlag, parseSvg, roundPath, toPathData, UnsupportedFlag } from "./flag.mjs";

const svg = (body, viewBox = "0 0 6 3") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
const refuses = (body, viewBox) => assert.throws(() => buildFlag(svg(body, viewBox)), UnsupportedFlag);

test("a plain two-bar flag flattens to two filled paths", () => {
  const { viewBox, paths } = buildFlag(svg(`<rect width="6" height="3" fill="#009b3a"/><rect width="6" height="1.5" fill="#fedf00"/>`));
  assert.equal(viewBox, "0 0 6 3");
  assert.deepEqual(paths, [
    { fill: "#009b3a", d: "M0 0h6v3h-6z" },
    { fill: "#fedf00", d: "M0 0h6v1.5h-6z" },
  ]);
});

test("presentation attributes inherit from the group, and the child wins", () => {
  const [a, b] = buildFlag(svg(`<g fill="#fff" stroke="#000"><path d="M0 0h6"/><path d="M0 3h6" fill="#f00"/></g>`)).paths;
  assert.deepEqual(a, { fill: "#fff", stroke: "#000", d: "M0 0h6" });
  assert.equal(b.fill, "#f00", "the child's own fill overrides the group's");
  assert.equal(b.stroke, "#000", "and what it does not set still inherits");
});

test("style= is the same declarations spelled the other way", () => {
  const [p] = buildFlag(svg(`<rect width="6" height="3" style="fill:#169b62;fill-opacity:1"/>`)).paths;
  assert.equal(p.fill, "#169b62");
  assert.equal(p.fillOpacity, "1");
});

test("a property outside the allowlist is refused, not silently dropped", () => {
  refuses(`<rect width="6" height="3" style="filter:blur(2px)"/>`);
});

// ---------------------------------------------------------------------------
// <use>
// ---------------------------------------------------------------------------

test("<use> copies the referenced path, with x/y after the use's own transform", () => {
  const { paths } = buildFlag(svg(`<defs><path id="s" d="M0 0h1v1z"/></defs><use xlink:href="#s" x="2" y="1" transform="scale(3)" fill="#fff"/>`));
  assert.deepEqual(paths, [{ fill: "#fff", d: "M0 0h1v1z", transform: "scale(3) translate(2 1)" }]);
});

test("<use> carries the target's own clip-path — the Georgia bug", () => {
  // Half a cross, clipped, drawn twice at right angles. Losing the clip on the
  // second copy drew a blob instead of an arm, and every test still passed.
  const body = `<defs>
      <clipPath id="c"><path d="M0 0h3v3z"/></clipPath>
      <path id="arm" d="M0 0h6v1z" clip-path="url(#c)"/>
    </defs>
    <use xlink:href="#arm"/><use xlink:href="#arm" transform="rotate(90)"/>`;
  const { paths } = buildFlag(svg(body));
  assert.equal(paths.length, 2);
  assert.equal(paths[0].clip, "M0 0h3v3z");
  assert.equal(paths[1].clip, "M0 0h3v3z", "the rotated copy keeps its clip too");
  assert.equal(paths[1].transform, "rotate(90)");
});

test("<use> pointing at itself is refused rather than hung on", () => {
  refuses(`<defs><g id="loop"><use xlink:href="#loop"/></g></defs><use xlink:href="#loop"/>`);
});

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

test("a clip covering the whole viewBox is dropped, in any of its spellings", () => {
  for (const d of ["M0 0h6v3H0z", "M0 0v3h6V0z", "M0 0h6v3h-6z"]) {
    const { paths } = buildFlag(svg(`<clipPath id="a"><path d="${d}"/></clipPath><g clip-path="url(#a)"><path d="M0 0h6" stroke="#fff"/></g>`));
    assert.equal(paths[0].clip, undefined, `${d} is the flag's own box`);
  }
});

test("a clip that is not the whole viewBox is kept", () => {
  const { paths } = buildFlag(svg(`<clipPath id="a"><path d="M3 0h3v3H3z"/></clipPath><path d="M0 0h6" stroke="#fff" clip-path="url(#a)"/>`));
  assert.equal(paths[0].clip, "M3 0h3v3H3z");
});

test("a clip and a transform on the SAME element are fine — Australia", () => {
  const { paths } = buildFlag(svg(`<clipPath id="a"><path d="M0 0h3v3H0z"/></clipPath><path d="M0 0l6 3" stroke="#fff" clip-path="url(#a)" transform="scale(840)"/>`));
  assert.equal(paths[0].clip, "M0 0h3v3H0z");
  assert.equal(paths[0].transform, "scale(840)");
});

test("a clip inherited ACROSS a transform is refused — it would be drawn moved", () => {
  refuses(`<clipPath id="a"><path d="M0 0h3v3H0z"/></clipPath><g clip-path="url(#a)"><path d="M0 0h6" transform="scale(2)"/></g>`);
});

test("two real clips on one path cannot be expressed, and are refused", () => {
  refuses(`<clipPath id="a"><path d="M0 0h3v3H0z"/></clipPath><clipPath id="b"><path d="M1 1h2v1H1z"/></clipPath>
    <g clip-path="url(#a)"><path d="M0 0h6" clip-path="url(#b)"/></g>`);
});

// ---------------------------------------------------------------------------
// Shapes, lengths, refusals
// ---------------------------------------------------------------------------

test("percentages resolve against the viewBox, not against zero", () => {
  const [p] = buildFlag(svg(`<rect x="-50%" y="-50%" width="100%" height="100%" fill="#009b3a"/>`, "-2100 -1470 4200 2940")).paths;
  assert.equal(p.d, "M-2100 -1470h4200v2940h-4200z");
});

test("a rounded rect becomes arcs rather than a refusal", () => {
  const d = toPathData({ name: "rect", attrs: { width: "10", height: "6", rx: "2", ry: "1" } });
  assert.match(d, /^M2 0h6a2 1 0 0 1 2 1v4a2 1 0 0 1 -2 1h-6a2 1 0 0 1 -2 -1v-4a2 1 0 0 1 2 -1z$/);
});

test("a circle is two arcs, because one arc of 360° is a point", () => {
  assert.equal(toPathData({ name: "circle", attrs: { cx: "5", cy: "5", r: "2" } }), "M3 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0z");
});

test("a gradient fill is refused: the wire format carries flat colours only", () => {
  refuses(`<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect width="6" height="3" fill="url(#g)"/>`);
});

test("<text> is refused — a flag that spells anything is not artwork we can flatten", () => {
  refuses(`<text x="1" y="1">Brasil</text>`);
});

test("<title> is dropped, because in this dataset it names the answer (SEC-1)", () => {
  const { paths } = buildFlag(svg(`<title>Flag of Brazil</title><rect width="6" height="3" fill="#009b3a"/>`));
  assert.equal(paths.length, 1);
  assert.equal(JSON.stringify(paths).includes("Brazil"), false);
});

test("a file with nothing to draw is refused rather than served blank", () => {
  refuses(`<defs><path id="a" d="M0 0h1"/></defs>`);
});

// ---------------------------------------------------------------------------
// A nested <svg> is a viewport, not a group
// ---------------------------------------------------------------------------

test("a nested <svg> maps its viewBox into its own width and height", () => {
  // Slovenia's shape: a coat of arms drawn in its own 240-wide space and
  // placed on the flag by a nested <svg>. Walked as a <g> it came out twenty
  // times too big and covered the whole flag.
  const { paths } = buildFlag(
    svg(`<svg x="1" y="1" width="2" height="1" viewBox="-120 -60 240 120"><path d="M-120 -60h240v120z" fill="#005da4"/></svg>`),
  );
  assert.deepEqual(paths, [{ fill: "#005da4", d: "M-120 -60h240v120z", transform: "translate(2 1.5) scale(0.008333 0.008333)" }]);

  // What that means on the page: the viewBox's top-left corner lands on the
  // viewport's, at (1, 1), and its bottom-right on (3, 2) — a 2 x 1 box where
  // the artwork was asked to go, not a 240 x 120 one over the whole flag.
  const [, tx, ty, s] = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)/.exec(paths[0].transform).map(Number);
  const at = (x, y) => [+(tx + x * s).toFixed(2), +(ty + y * s).toFixed(2)];
  assert.deepEqual(at(-120, -60), [1, 1]);
  assert.deepEqual(at(120, 60), [3, 2]);
});

test("preserveAspectRatio: the default letterboxes, none stretches, anything else is refused", () => {
  const nested = (attrs) => buildFlag(svg(`<svg width="6" height="3" viewBox="0 0 10 10" ${attrs}><path d="M0 0h10v10z"/></svg>`)).paths[0].transform;
  // meet (the default): one scale, min(6/10, 3/10), and the slack split evenly.
  assert.equal(nested(""), "translate(1.5 0) scale(0.3 0.3)");
  assert.equal(nested(`preserveAspectRatio="xMidYMid meet"`), "translate(1.5 0) scale(0.3 0.3)");
  // none: fill the viewport, aspect ratio be damned.
  assert.equal(nested(`preserveAspectRatio="none"`), "translate(0 0) scale(0.6 0.3)");
  // An alignment this does not implement would place artwork subtly wrong, so
  // the flag is dropped with a reason instead.
  refuses(`<svg width="6" height="3" viewBox="0 0 10 10" preserveAspectRatio="xMinYMax slice"><path d="M0 0h1"/></svg>`);
});

test("a nested <svg> without a viewBox is just its own origin", () => {
  const [p] = buildFlag(svg(`<svg x="2" y="1"><path d="M0 0h1v1z" fill="#fff"/></svg>`)).paths;
  assert.equal(p.transform, "translate(2 1)");
});

// ---------------------------------------------------------------------------
// Rounding and parsing
// ---------------------------------------------------------------------------

test("rounding keeps the shape and drops the noise", () => {
  assert.equal(roundPath("M0.123456 -1.999999h3.00001", 2), "M.12 -2h3");
  assert.equal(roundPath("M1 2h3", 2), "M1 2h3", "integers are left alone");
  assert.equal(roundPath("a2.5 2.5 0 1 0 5 0", 0), "a3 3 0 1 0 5 0", "arc flags stay flags");
});

test("the parser keeps attribute values whole and ignores comments", () => {
  const root = parseSvg(`<!-- a flag --><svg viewBox="0 0 6 3"><path d="M0 0h6v3z" fill="#fff"/></svg>`);
  assert.equal(root.attrs.viewBox, "0 0 6 3");
  assert.equal(root.children[0].attrs.d, "M0 0h6v3z");
});

test("a flag without a viewBox is refused: there is nothing to scale it into", () => {
  assert.throws(() => buildFlag(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="6" height="3"/></svg>`), UnsupportedFlag);
});
