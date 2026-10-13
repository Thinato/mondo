// The Batata Quente board (FR-12.3, D-89): every country on ONE projected map.
//
// This is not a silhouette and does not touch D-69: silhouettes are traced
// from artwork, one country per box, and nothing here goes near them. This is
// Natural Earth, projected once, so the countries fit together into a world.
// It is server-only (backend/functions/src/data/world.json) and a room receives
// a country's path only once someone in it has named that country.

import { geoEqualEarth, geoPath } from "d3-geo";
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

/**
 * @param land      GeoJSON geometry of all land (the grey base)
 * @param features  Map code → GeoJSON geometry, for the countries that have one
 * @param centroids Map code → [lon, lat], for every country in the pool
 */
export function buildWorld({ land, features, centroids }) {
  const base = withoutAntarctica(land);
  const projection = geoEqualEarth().fitWidth(WIDTH, base);
  const path = geoPath(projection);
  const [[, y0], [, y1]] = path.bounds(base);
  projection.translate([projection.translate()[0], projection.translate()[1] - y0]);
  const height = Math.ceil(y1 - y0);

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
