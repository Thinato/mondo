#!/usr/bin/env node
// The Batata Quente world map (FR-12.3, D-89) → backend/functions/src/data/world.json.
//
// Also the Fronteiras boards (FR-15.2, D-109) → backend/functions/src/data/borders.json:
// which territories of a continent touch, the reviewed sea routes that make every
// continent one board, each continent's viewBox and where each name sits.
//
// Natural Earth 1:50m via world-atlas, projected with Equal Earth. Server-only:
// `multiplayer.ts` hands a room one country's path at a time, as it is named. Run
// after build-geo.mjs, which decides the pool and the centroids this reads.
//
// One topology draws everything (D-96): the grey land is the union of the same
// countries, and the simplification runs on the topology's shared arcs, so a
// border is one line for both neighbours and for the land beneath them. The
// map is zoomed up to 8× (D-95), where a ring simplified on its own showed.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { merge, neighbors } from "topojson-client";
import { presimplify, quantile, simplify, sphericalTriangleArea } from "topojson-simplify";
import wc from "world-countries";
import { buildWorld, labelOf, piecesOf, viewBoxOf, worldProjection } from "./lib/world.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const MAX_BYTES = 400 * 1024;
/**
 * The share of the topology's points kept, the least important dropped first
 * (Visvalingam, by spherical triangle area). 0.18 is sharp at 8× and fits the
 * budget; 0.3 is barely different at 8× and half as big again.
 */
const KEEP = 0.18;

// The same numeric-id mapping build-geo.mjs uses; Kosovo has no ISO id.
const BY_NAME = { XK: "Kosovo" };
// Territories outside the pool (D-20) that are painted with their country when
// it is named, by world-atlas name. Without this they sit grey on a map that
// can then never fill. Map only: the pool, the centroid and every hint are
// untouched, and "Groenlândia" is still not an answer.
const PAINTED_WITH = { DK: ["Greenland"] };
/**
 * The Fronteiras boards, [west, south, east, north] in degrees — reviewed by
 * hand, not fitted, so a far-flung ring cannot stretch a board. Europe stops at
 * the Urals and takes Iceland, Cyprus and Malta; the Azores, the Canaries,
 * Svalbard, Alaska's Aleutians, Hawaii and Rodrigues fall outside and are
 * clipped. Oceania is out of v1.
 */
const BOARDS = {
  Europe: [-25, 34, 60, 72],
  Asia: [25, -11, 150, 56],
  Americas: [-142, -56, -30, 74],
  Africa: [-26, -36, 60, 38],
};
/**
 * Label points, [lon, lat], set by hand where the clipped outline puts the name
 * somewhere wrong. DK: the sliver of Greenland inside Europe's box is a bigger
 * ring than Jutland.
 */
const LABELS = { DK: [9.2, 56.1] };
/**
 * Sea routes, reviewed by hand: real straits, causeways and ferry crossings, so a
 * move across water is one a player could name. A nearest-centroid rule linked
 * Cyprus to Bulgaria and the Comoros to landlocked Malawi while leaving the
 * Channel and the Øresund out. The build refuses a board that is not one piece.
 */
const SEA_ROUTES = {
  // The Channel, the Øresund, the Gulf of Finland, the Faroes route, the Norse route, Crete–Cyprus, Sicily–Malta.
  Europe: [["GB", "FR"], ["DK", "SE"], ["EE", "FI"], ["GB", "IS"], ["IS", "NO"], ["CY", "GR"], ["IT", "MT"]],
  // Tsushima, the Ryukyus, the Taiwan and Luzon straits, the Sulu Sea, the Palk Strait,
  // the Maldives' two neighbours, the King Fahd Causeway, Bahrain–Qatar, the Johor Causeway, Singapore–Batam.
  Asia: [["JP", "KR"], ["JP", "TW"], ["CN", "TW"], ["PH", "TW"], ["MY", "PH"], ["IN", "LK"], ["IN", "MV"], ["LK", "MV"],
    ["BH", "SA"], ["BH", "QA"], ["MY", "SG"], ["ID", "SG"]],
  // The Florida Straits, the Yucatán Channel, the Windward Passage, the Antilles island by island, Trinidad–Venezuela.
  Americas: [["CU", "US"], ["BS", "US"], ["CU", "MX"], ["BS", "CU"], ["CU", "JM"], ["CU", "HT"], ["DO", "KN"], ["AG", "KN"],
    ["AG", "DM"], ["DM", "LC"], ["LC", "VC"], ["GD", "VC"], ["GD", "TT"], ["TT", "VE"], ["BB", "LC"], ["BB", "VC"]],
  // Dakar and Nouakchott, the Gulf of Guinea, the Mozambique Channel, the Mascarenes, the Seychelles' two neighbours.
  Africa: [["CV", "SN"], ["CV", "MR"], ["GA", "ST"], ["GQ", "ST"], ["KM", "MZ"], ["KM", "TZ"], ["KM", "MG"], ["MG", "MZ"],
    ["MG", "MU"], ["MG", "SC"], ["KE", "SC"]],
};
/** Real land borders the 1:50m topology does not draw as one shared line. */
const LAND_FIXES = { Africa: [["DJ", "SO"]] };

const countries = read("backend/functions/src/data/countries.json").countries;
const raw = presimplify(read("tools/node_modules/world-atlas/countries-50m.json"), sphericalTriangleArea);
const topo = simplify(raw, quantile(raw, KEEP));

const ccn3 = new Map(wc.map((c) => [c.cca2, c.ccn3]));
const byId = new Map();
const byName = new Map();
for (const g of topo.objects.countries.geometries) {
  if (g.id != null) (byId.get(String(g.id)) ?? byId.set(String(g.id), []).get(String(g.id))).push(g);
  byName.set(g.properties.name, [g]);
}

// Same-id features (a sovereign and its dependency sharing an ISO id) merge into one shape.
const features = new Map();
const geomsOf = new Map();
for (const c of countries) {
  const geoms = [
    ...(BY_NAME[c.code] ? byName.get(BY_NAME[c.code]) : byId.get(ccn3.get(c.code)) ?? []),
    ...(PAINTED_WITH[c.code] ?? []).flatMap((name) => byName.get(name) ?? []),
  ];
  if (geoms.length) {
    features.set(c.code, merge(topo, geoms));
    geomsOf.set(c.code, geoms);
  }
}

const world = buildWorld({
  land: merge(topo, topo.objects.countries.geometries),
  features,
  centroids: new Map(countries.map((c) => [c.code, c.centroid])),
});

const out = JSON.stringify({
  "//": "GENERATED by tools/build-world.mjs — do not edit. Server-only (D-89): Natural Earth 1:50m (world-atlas), Equal Earth projection. A room receives a country's path only once it has been named there. `dots` are countries too small to see as a shape, at their projected centroid.",
  ...world,
}) + "\n";

const bytes = Buffer.byteLength(out);
if (bytes > MAX_BYTES) {
  console.error(`✗ world.json is ${(bytes / 1024).toFixed(0)} KB, over the ${MAX_BYTES / 1024} KB budget`);
  process.exit(1);
}
writeFileSync(join(ROOT, "backend/functions/src/data/world.json"), out);
console.log(`✓ world.json: ${Object.keys(world.paths).length} shapes + ${Object.keys(world.dots).length} dots, ${(bytes / 1024).toFixed(0)} KB, viewBox ${world.viewBox}`);

// ── borders.json ────────────────────────────────────────────────────────────
// Land adjacency is shared arcs of the SAME topology, so two territories touch
// on the board exactly where their drawn borders are one line. Only within a
// continent: France's Guiana touches Brazil, and that is not a Europe edge.
const { projection } = worldProjection(merge(topo, topo.objects.countries.geometries));
const codes = [...geomsOf.keys()];
const touching = neighbors(codes.map((c) => ({ type: "GeometryCollection", geometries: geomsOf.get(c) })));
const regionOf = new Map(countries.map((c) => [c.code, c.region]));

const land = {};
const links = [];
const viewBox = {};
const labels = {};
for (const [region, box] of Object.entries(BOARDS)) {
  const members = countries.filter((c) => c.region === region).map((c) => c.code).sort();
  const adj = new Map(members.map((c) => [c, new Set()]));
  codes.forEach((a, i) => {
    for (const j of touching[i]) if (regionOf.get(a) === region && regionOf.get(codes[j]) === region) adj.get(a).add(codes[j]);
  });
  for (const [a, b] of LAND_FIXES[region] ?? []) adj.get(a).add(b), adj.get(b).add(a);
  for (const c of members) land[c] = [...adj.get(c)].sort();
  const edges = new Map(members.map((c) => [c, new Set(adj.get(c))]));
  for (const [a, b] of SEA_ROUTES[region]) {
    if (!edges.has(a) || !edges.has(b)) throw new Error(`route ${a}–${b} is not on the ${region} board`);
    if (adj.get(a).has(b)) throw new Error(`route ${a}–${b} is already a land border`);
    edges.get(a).add(b);
    edges.get(b).add(a);
    links.push([a, b].sort());
  }
  const pieces = piecesOf(members, edges);
  if (pieces.length > 1) throw new Error(`${region} is in pieces: ${pieces.map((p) => p.join(" ")).join(" | ")}`);
  console.log(`${region}: ${members.length} territories, ${SEA_ROUTES[region].length} sea routes`);
  viewBox[region] = viewBoxOf(projection, box);
  for (const c of members) {
    const fixed = LABELS[c] && projection(LABELS[c]).map((n) => Math.round(n * 10) / 10);
    labels[c] = fixed ?? world.dots[c] ?? labelOf(projection, features.get(c), viewBox[region]);
    if (!labels[c]) throw new Error(`${c} has nothing inside the ${region} viewBox`);
  }
  console.log(`  viewBox ${viewBox[region]}`);
}

const borders = JSON.stringify({
  "//": "GENERATED by tools/build-world.mjs — do not edit. Server-only (D-109): the Fronteiras boards on world.json's map. `land` is shared borders of the same Natural Earth 1:50m topology, within one continent; `links` are reviewed sea routes (straits, causeways, ferries); `viewBox` is a reviewed lon/lat box per continent, Equal Earth; `labels` is the bbox centre of each territory's largest ring inside it, or its dot.",
  land,
  links,
  viewBox,
  labels,
}) + "\n";
writeFileSync(join(ROOT, "backend/functions/src/data/borders.json"), borders);
console.log(`✓ borders.json: ${Object.keys(labels).length} territories, ${links.length} links, ${(Buffer.byteLength(borders) / 1024).toFixed(1)} KB`);
