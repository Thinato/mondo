// The Batata Quente board (FR-12.3, D-89): every country on ONE projected map.
//
// This is not a silhouette and does not touch D-69: silhouettes are traced
// from artwork, one country per box, and nothing here goes near them. This is
// Natural Earth, projected once, so the countries fit together into a world.
// It is server-only (backend/functions/src/data/world.json) and a room receives
// a country's path only once someone in it has named that country.

import { geoDistance, geoEqualEarth, geoPath } from "d3-geo";
import { toPathData } from "./shape.mjs";

export const WIDTH = 1000;
/** Below this many square pixels a country is drawn as a dot: it would not be seen as a shape. */
export const MIN_AREA_PX = 4;
/** Antarctica is land but nobody's country; dropping it buys a third of the height. */
const SOUTH_LIMIT = -58;

/**
 * Drop polygons that lie wholly south of SOUTH_LIMIT. Applied to the land base
 * only: no country in the pool has territory down there.
 */
function withoutAntarctica(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return { type: "MultiPolygon", coordinates: polys.filter((p) => p[0].some(([, lat]) => lat > SOUTH_LIMIT)) };
}

/** Rings in pixel space, as d3 clips and projects them (the antimeridian cut is d3's, not ours). */
function projectedRings(path, geometry) {
  const rings = [];
  let ring = null;
  path.context({
    moveTo(x, y) { ring = [{ x, y }]; rings.push(ring); },
    lineTo(x, y) { ring.push({ x, y }); },
    closePath() { if (ring?.length) ring.push({ ...ring[0] }); },
    arc() {},
  })(geometry);
  return rings;
}

/** The map's projection: Equal Earth, WIDTH wide, its top at y = 0. borders.json is drawn in the same space. */
export function worldProjection(land) {
  const base = withoutAntarctica(land);
  const projection = geoEqualEarth().fitWidth(WIDTH, base);
  const [[, y0], [, y1]] = geoPath(projection).bounds(base);
  projection.translate([projection.translate()[0], projection.translate()[1] - y0]);
  return { base, projection, height: Math.ceil(y1 - y0) };
}

/**
 * @param land      GeoJSON geometry of all land (the grey base)
 * @param features  Map code → GeoJSON geometry, for the countries that have one
 * @param centroids Map code → [lon, lat], for every country in the pool
 */
export function buildWorld({ land, features, centroids }) {
  const { base, projection, height } = worldProjection(land);
  const path = geoPath(projection);

  // No simplification here: the caller simplified the TOPOLOGY, so a border
  // shared by two countries (and by the land under them) is the same line in
  // all three. Simplifying each ring on its own is what used to pull them apart.
  const draw = (geometry) => toPathData(projectedRings(path, geometry).filter((ring) => ring.length >= 4));

  const paths = {};
  const dots = {};
  for (const [code, lonlat] of [...centroids].sort(([a], [b]) => a.localeCompare(b))) {
    const geometry = features.get(code);
    const d = geometry && path.area(geometry) >= MIN_AREA_PX ? draw(geometry) : "";
    if (d) paths[code] = d;
    else dots[code] = projection(lonlat).map((n) => Math.round(n * 10) / 10);
  }
  return { viewBox: `0 0 ${WIDTH} ${height}`, land: draw(base), paths, dots };
}

// Fronteiras (FR-15.2, D-109): one continent of the same map is a board. What a
// board adds to world.json is which territories touch, where its window is, and
// where each name sits — borders.json, built by build-world.mjs from these.

/**
 * The extra edges a continent needs to be one board: a territory with no land
 * neighbour (an island) links to its `near` nearest members, then whatever is
 * still in pieces is joined by the closest pair across pieces, one pair at a
 * time, until it is one piece. Great-circle on the NE centroids, build-time only.
 *
 * @param members   codes of one continent
 * @param land      Map code → Set of land neighbours (within the continent)
 * @param centroids Map code → [lon, lat]
 * @returns [{ a, b, km, why }], a < b, in the order they were added
 */
export function linkRegion(members, land, centroids, near = 2) {
  const km = (a, b) => Math.round(geoDistance(centroids.get(a), centroids.get(b)) * 6371);
  const adj = new Map(members.map((c) => [c, new Set(land.get(c) ?? [])]));
  const links = [];
  const add = (a, b, why) => {
    if (adj.get(a).has(b)) return;
    adj.get(a).add(b);
    adj.get(b).add(a);
    links.push({ ...(a < b ? { a, b } : { a: b, b: a }), km: km(a, b), why });
  };
  for (const c of members.filter((m) => !land.get(m)?.size)) {
    const nearest = members.filter((m) => m !== c).sort((x, y) => km(c, x) - km(c, y) || x.localeCompare(y));
    for (const m of nearest.slice(0, near)) add(c, m, "island");
  }
  // ponytail: O(n²) per join over ≤ 54 members; fine at build time.
  for (;;) {
    const piece = new Map();
    for (const start of members) {
      if (piece.has(start)) continue;
      const stack = [start];
      piece.set(start, start);
      while (stack.length) for (const n of adj.get(stack.pop())) if (!piece.has(n)) piece.set(n, start), stack.push(n);
    }
    let best = null;
    for (const a of members) for (const b of members) {
      if (a < b && piece.get(a) !== piece.get(b) && (!best || km(a, b) < best.d)) best = { a, b, d: km(a, b) };
    }
    if (!best) return links;
    add(best.a, best.b, "join");
  }
}

/** A lon/lat box [west, south, east, north] as the integer viewBox that contains its projection. */
export function viewBoxOf(projection, [w, s, e, n]) {
  const pts = [];
  for (let lon = w; lon <= e; lon += 0.5) pts.push([lon, s], [lon, n]);
  for (let lat = s; lat <= n; lat += 0.5) pts.push([w, lat], [e, lat]);
  const xy = pts.map((p) => projection(p));
  const x0 = Math.floor(Math.min(...xy.map((p) => p[0]))), y0 = Math.floor(Math.min(...xy.map((p) => p[1])));
  const x1 = Math.ceil(Math.max(...xy.map((p) => p[0]))), y1 = Math.ceil(Math.max(...xy.map((p) => p[1])));
  return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
}

/** Whether [x, y] lies inside a "x y w h" viewBox. */
export function insideViewBox(viewBox, [x, y]) {
  const [x0, y0, w, h] = viewBox.split(" ").map(Number);
  return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h;
}

/**
 * Where a territory's name goes: the bbox centre of its largest ring once the
 * outline is clipped to the board's viewBox — so Russia is labelled in Europe,
 * not in Siberia, and Denmark in Jutland rather than Greenland. Null when
 * nothing of it is inside.
 */
export function labelOf(projection, geometry, viewBox) {
  const [x0, y0, w, h] = viewBox.split(" ").map(Number);
  projection.clipExtent([[x0, y0], [x0 + w, y0 + h]]);
  const rings = projectedRings(geoPath(projection), geometry);
  projection.clipExtent(null);
  const area = (r) => Math.abs(r.reduce((s, p, i) => s + (i ? r[i - 1].x * p.y - p.x * r[i - 1].y : 0), 0)) / 2;
  const ring = rings.filter((r) => r.length >= 4).sort((a, b) => area(b) - area(a))[0];
  if (!ring) return null;
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  const r1 = (n) => Math.round(n * 10) / 10;
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
  // A bent country's bbox centre is often its neighbour's (Norway's is in
  // Sweden, Vietnam's in Laos): then take the middle of the widest stretch of
  // the ring on that same horizontal line, which is inside it by construction.
  const cuts = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    if ((a.y > y) !== (b.y > y)) cuts.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  cuts.sort((p, q) => p - q);
  let best = null;
  for (let i = 0; i + 1 < cuts.length; i += 2) {
    if (cuts[i] <= x && x <= cuts[i + 1]) return [r1(x), r1(y)];
    if (!best || cuts[i + 1] - cuts[i] > best[1] - best[0]) best = [cuts[i], cuts[i + 1]];
  }
  return [r1(best ? (best[0] + best[1]) / 2 : x), r1(y)];
}
