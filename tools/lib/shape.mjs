// Pure geometry helpers for the geo build. No I/O. See 03-geo-data-pipeline.md §3.

import { geoArea, geoAzimuthalEqualArea, geoCentroid, geoMercator } from "d3-geo";
import simplify from "simplify-js";

/** Fixed viewBox every silhouette is fitted into (FR-6.2). */
export const SIZE = 500;
export const PADDING = 24;
export const VIEW_BOX = `0 0 ${SIZE} ${SIZE}`;

/**
 * D-8: keep only the polygon with the greatest area, discard the rest — unless
 * `minShare` is given, in which case every polygon whose area is at least that
 * fraction of the largest is kept too. The default fixes France and the USA;
 * the override exists for archipelago states where the largest island alone is
 * unrecognisable (tools/overrides.json). Returns what was thrown away so the
 * contentious cases can be eyeballed (§3.1).
 *
 * `geometry` is a GeoJSON Polygon or MultiPolygon.
 */
export function selectPolygons(geometry, { minShare = null } = {}) {
  const polygons = (
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates
  ).map(rewind);
  if (polygons.length === 0) throw new Error("geometry has no polygons");

  const withArea = polygons
    .map((rings) => ({ rings, area: geoArea({ type: "Polygon", coordinates: rings }) }))
    .sort((a, b) => b.area - a.area);
  const total = withArea.reduce((n, p) => n + p.area, 0);
  const largest = withArea[0].area;
  const kept = withArea.filter((p, i) => i === 0 || (minShare !== null && p.area >= minShare * largest));
  const keptArea = kept.reduce((n, p) => n + p.area, 0);

  return {
    polygons: kept.map((p) => p.rings),
    keptPolygons: kept.length,
    discardedPolygons: polygons.length - kept.length,
    discardedAreaShare: total > 0 ? round((total - keptArea) / total, 4) : 0,
  };
}

/** Spherical centroid of the retained polygons, [lon, lat] to 4 dp (§3.2). */
export function centroidOf(polygons) {
  const [lon, lat] = geoCentroid({ type: "MultiPolygon", coordinates: polygons });
  return [round(lon, 4), round(lat, 4)];
}

/**
 * Project one polygon with an azimuthal equal-area projection centred on its
 * own centroid, fitted into the fixed viewBox (§3.4). Every country ends up the
 * same visual size regardless of real area — that is the point.
 *
 * Returns rings as arrays of {x, y} in pixel space.
 */
export function projectRings(polygons, centroid, kind = "mercator") {
  const shape = { type: "MultiPolygon", coordinates: polygons };
  const base =
    kind === "azimuthal"
      ? geoAzimuthalEqualArea().rotate([-centroid[0], -centroid[1], 0])
      : geoMercator().rotate([-centroid[0], 0, 0]);
  const projection = base.fitExtent([[PADDING, PADDING], [SIZE - PADDING, SIZE - PADDING]], shape);

  // Flatten to rings: with evenodd fill, exterior rings and holes from every
  // polygon can share one path.
  return polygons.flat().map((ring) =>
    ring.map(([lon, lat]) => {
      const p = projection([lon, lat]);
      if (!p) throw new Error(`point [${lon}, ${lat}] did not project`);
      return { x: p[0], y: p[1] };
    }),
  );
}

/**
 * Simplify in pixel space to a tolerance (§3.3). Doing this *after* projection
 * means every silhouette gets the same visual fidelity whether it is Russia or
 * Nauru, which a percentage-of-vertices rule cannot give you.
 *
 * Rings that collapse below a triangle are dropped — they were sub-pixel holes.
 */
export function simplifyRings(rings, tolerance) {
  return rings
    .map((ring) => simplify(ring, tolerance, true))
    .filter((ring) => ring.length >= 4); // 3 distinct points + closing point
}

/**
 * SVG path data. Outer ring then holes as separate subpaths; render with
 * fill-rule="evenodd". One decimal place: 0.1px on a 500px box is invisible
 * and roughly halves the bytes versus full precision.
 */
export function toPathData(rings, decimals = 1) {
  const f = (n) => {
    const s = n.toFixed(decimals);
    return s.replace(/\.?0+$/, "") || "0"; // 12.0 → 12, 0.0 → 0
  };
  return rings
    .map((ring) => {
      // Drop the explicit closing point; Z closes the subpath.
      const pts = ring[0].x === ring.at(-1).x && ring[0].y === ring.at(-1).y ? ring.slice(0, -1) : ring;
      return "M" + pts.map((p) => `${f(p.x)} ${f(p.y)}`).join("L") + "Z";
    })
    .join("");
}

/**
 * The whole per-country pipeline. `maxBytes` is enforced by escalating the
 * tolerance for this one country only, so a fjord-heavy coastline does not
 * force a coarser Italy.
 */
export function buildShape(geometry, { tolerance = 1, maxBytes = 4096, step = 0.25, minShare = null, projection = "mercator" } = {}) {
  const { polygons, keptPolygons, discardedPolygons, discardedAreaShare } = selectPolygons(geometry, { minShare });
  // world-atlas quantisation can collapse a microstate to a line (the Vatican at
  // 10m is two distinct points). Nothing downstream can rescue that; refuse it
  // rather than emit an empty path the game would render as nothing.
  const distinct = new Set(polygons[0][0].map((p) => p.join(","))).size;
  if (distinct < 3) throw new Error(`degenerate geometry: largest polygon has ${distinct} distinct points`);
  const centroid = centroidOf(polygons);
  const projected = projectRings(polygons, centroid, projection);

  let t = tolerance;
  let path;
  let points;
  for (;;) {
    const simplified = simplifyRings(projected, t);
    path = toPathData(simplified);
    points = simplified.reduce((n, r) => n + r.length, 0);
    if (simplified.length === 0) throw new Error("geometry vanished under simplification");
    if (Buffer.byteLength(path) <= maxBytes) break;
    t = round(t + step, 4);
    if (t > 20) throw new Error("could not fit shape under maxBytes");
  }

  return { centroid, path, points, tolerance: t, keptPolygons, discardedPolygons, discardedAreaShare };
}

/**
 * d3-geo is spherical: an exterior ring wound the wrong way is read as
 * "everything except this shape" and has an area near 4π. World-atlas data is
 * wound correctly for d3, but a mis-wound ring would silently produce a fitted
 * silhouette of the *complement* — so normalise rather than trust.
 * Exterior rings must enclose < 2π sr standalone; holes must enclose > 2π.
 */
export function rewind(rings) {
  const HEMISPHERE = 2 * Math.PI;
  return rings.map((ring, i) => {
    const a = geoArea({ type: "Polygon", coordinates: [ring] });
    const isExterior = i === 0;
    const wrong = isExterior ? a > HEMISPHERE : a < HEMISPHERE;
    return wrong ? [...ring].reverse() : ring;
  });
}

function round(n, dp) {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
}
