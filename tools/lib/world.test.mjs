import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWorld, insideViewBox, MIN_AREA_PX, piecesOf, WIDTH } from "./world.mjs";

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

test("D-89: Greenland is painted with Denmark, so the map can fill", () => {
  const w = read("backend/functions/src/data/world.json");
  const xs = [...w.paths.DK.matchAll(/[ML]([\d.]+) /g)].map((m) => Number(m[1]));
  // Denmark proper is east of Greenwich (x > 500); Greenland reaches past 70°W.
  assert.ok(Math.min(...xs) < 400, `DK's path starts at x=${Math.min(...xs)}: no Greenland`);
  assert.ok(Math.max(...xs) > 500, "and Denmark itself is still there");
});

test("D-109: piecesOf finds a board's connected pieces, an island on its own", () => {
  const edges = new Map([["A", new Set(["B"])], ["B", new Set(["A"])], ["C", new Set(["D"])], ["D", new Set(["C"])], ["I", new Set()]]);
  assert.deepEqual(piecesOf(["A", "B", "C", "D", "I"], edges), [["A", "B"], ["C", "D"], ["I"]]);
});

const BOARDS = ["Europe", "Asia", "Americas", "Africa"];

test("D-109: every board is one symmetric, connected piece, and only land is a land edge", () => {
  const { countries } = read("backend/functions/src/data/countries.json");
  const b = read("backend/functions/src/data/borders.json");
  const regionOf = new Map(countries.map((c) => [c.code, c.region]));
  const edges = new Map(Object.keys(b.land).map((c) => [c, new Set(b.land[c])]));
  for (const [a, ns] of Object.entries(b.land)) for (const n of ns) {
    assert.ok(b.land[n].includes(a), `${a}–${n} is not symmetric`);
    assert.equal(regionOf.get(n), regionOf.get(a), `${a}–${n} crosses continents`);
  }
  for (const [a, n] of b.links) {
    assert.equal(regionOf.get(n), regionOf.get(a), `link ${a}–${n} crosses continents`);
    edges.get(a).add(n);
    edges.get(n).add(a);
  }
  for (const region of BOARDS) {
    const members = countries.filter((c) => c.region === region).map((c) => c.code);
    for (const c of members) assert.ok(edges.get(c)?.size, `${c} is isolated`);
    const seen = new Set([members[0]]);
    const stack = [members[0]];
    while (stack.length) for (const n of edges.get(stack.pop())) if (!seen.has(n)) seen.add(n), stack.push(n);
    assert.equal(seen.size, members.length, `${region} is in pieces: ${members.filter((c) => !seen.has(c))}`);
  }
  assert.ok(b.land.ES.includes("PT"));
  assert.ok(b.land.DJ.includes("SO"), "DJ–SO, a real border the topology misses");
  const routes = new Set(b.links.map((l) => l.join("–")));
  for (const r of ["FR–GB", "DK–SE", "IT–MT", "JP–KR", "CU–US", "KM–MZ"]) assert.ok(routes.has(r), `sea route ${r}`);
  for (const r of ["BG–CY", "KM–MW", "AL–MT"]) assert.ok(!routes.has(r), `no route ${r}`);
  for (const n of ["BR", "NL"]) assert.ok(!edges.get("FR").has(n), `FR–${n}`);
  assert.ok(!Object.keys(b.land).some((c) => regionOf.get(c) === "Oceania"), "Oceania is out of v1");
});

test("D-109: every label and every dot of a board lies inside its viewBox", () => {
  const { countries } = read("backend/functions/src/data/countries.json");
  const b = read("backend/functions/src/data/borders.json");
  const w = read("backend/functions/src/data/world.json");
  for (const c of countries.filter((x) => BOARDS.includes(x.region))) {
    const box = b.viewBox[c.region];
    assert.ok(b.labels[c.code] && insideViewBox(box, b.labels[c.code]), `${c.code}'s label is outside ${c.region}`);
    if (w.dots[c.code]) assert.ok(insideViewBox(box, w.dots[c.code]), `${c.code}'s dot is outside ${c.region}`);
  }
});
