// Vendored country artwork → one path in the game's viewBox (D-69). Pure, no I/O.
//
// This replaced `icon.mjs`, which did the same job for the four microstates
// mapsicon covered (D-59). The difference is what arrives: mapsicon shipped one
// potrace path per country, already a single landmass, small enough to keep its
// Béziers untouched. `tools/country-shapes/` ships whole countries — Russia
// arrives as 1295 subpaths and a megabyte — so this one has to do what
// `shape.mjs` does after projecting: pick the landmass (D-8), then simplify
// until the path fits the byte budget.
//
// It shares the back half of that pipeline rather than restating it:
// `simplifyRings` and `toPathData` are shape.mjs's, so an artwork silhouette
// and a projected one round, close and serialise identically.
//
// **It deliberately does NOT touch the centroid.** Distance and compass hints
// still come from Natural Earth, which is accurate about *where* a country is
// even when it is useless about *what shape* it is. Artwork must not reach the
// scoring path.

import { PADDING, SIZE, simplifyRings, toPathData } from "./shape.mjs";

/** Thrown when the artwork uses something this converter will not guess at. */
export class UnsupportedArtwork extends Error {}

/**
 * Every `d` in the file → closed rings of `{x, y}`.
 *
 * Only the commands these files actually use: M L H V C Z and their relative
 * twins. Anything else throws — a converter that silently skips an arc draws a
 * country with a bite out of it and nobody would know which.
 *
 * Curves are flattened here rather than carried. shape.mjs's simplifier needs
 * polylines, and at 500px a coastline's Béziers are a rounding error either way.
 */
export function toRings(d, { flatness = 8 } = {}) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const rings = [];
  let ring = null;
  let i = 0;
  let cmd = null;
  let cur = [0, 0];
  let start = [0, 0];
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || !/^-?\d*\.?\d+/.test(t)) throw new UnsupportedArtwork(`expected a number, got ${t}`);
    return Number(t);
  };
  const push = (x, y) => ring?.push({ x, y });
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === "M") cmd = "L"; // repeated pairs after M are implicit linetos
    else if (cmd === "m") cmd = "l";
    if (cmd == null) throw new UnsupportedArtwork("path data does not start with a command");
    const rel = cmd === cmd.toLowerCase();
    const bx = rel ? cur[0] : 0;
    const by = rel ? cur[1] : 0;
    switch (cmd.toUpperCase()) {
      case "M":
        cur = [bx + num(), by + num()];
        start = cur;
        ring = [{ x: cur[0], y: cur[1] }];
        rings.push(ring);
        break;
      case "L":
        cur = [bx + num(), by + num()];
        push(cur[0], cur[1]);
        break;
      case "H":
        cur = [bx + num(), cur[1]];
        push(cur[0], cur[1]);
        break;
      case "V":
        cur = [cur[0], by + num()];
        push(cur[0], cur[1]);
        break;
      case "C": {
        const c1 = [bx + num(), by + num()];
        const c2 = [bx + num(), by + num()];
        const end = [bx + num(), by + num()];
        const steps = Math.max(2, Math.min(32, Math.ceil(Math.hypot(end[0] - cur[0], end[1] - cur[1]) / flatness)));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const u = 1 - t;
          push(
            u * u * u * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
            u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
          );
        }
        cur = end;
        break;
      }
      case "Z":
        cur = start;
        break;
      default:
        throw new UnsupportedArtwork(`unsupported path command "${cmd}"`);
    }
  }
  // A ring needs 3 distinct points plus its close to enclose anything.
  return rings.filter((r) => r.length >= 3);
}

/** Every `d` attribute in an SVG file, in document order. */
export function pathData(svg) {
  const ds = [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length === 0) throw new UnsupportedArtwork("no <path> in the file");
  return ds;
}

/** Shoelace area, in artwork units. Sign is winding; callers want magnitude. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return a / 2;
}

/** Ray casting. Used to tell an enclave apart from an island. */
export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A hole below this share of the largest landmass is not visible at 500px and
 *  only costs bytes. Lesotho is 1.3% of South Africa; the Vatican is 0.0005%. */
const MIN_HOLE_SHARE = 0.002;

/**
 * D-8, in two dimensions: keep the largest ring, plus any ring at least
 * `minShare` of it (tools/overrides.json), plus the enclaves inside what was
 * kept. Same contract as `selectPolygons`, and it reads the same overrides — a
 * country needs both islands or it needs one, and that does not depend on
 * whether the outline was projected or drawn.
 */
export function selectRings(rings, { minShare = null } = {}) {
  const sorted = rings.map((ring) => ({ ring, area: Math.abs(ringArea(ring)) })).sort((a, b) => b.area - a.area);
  if (sorted.length === 0) throw new UnsupportedArtwork("artwork has no rings");
  const largest = sorted[0].area;
  if (largest <= 0) throw new UnsupportedArtwork("artwork has no extent");
  const total = sorted.reduce((n, r) => n + r.area, 0);

  const land = sorted.filter((r, i) => i === 0 || (minShare !== null && r.area >= minShare * largest));
  const holes = sorted.filter(
    (r) => !land.includes(r) && r.area >= MIN_HOLE_SHARE * largest && land.some((l) => pointInRing(r.ring[0], l.ring)),
  );
  // What was thrown away, as a share of everything drawn — kept enclaves are
  // not "discarded", they are part of the silhouette.
  const keptArea = [...land, ...holes].reduce((n, r) => n + r.area, 0);

  return {
    rings: [...land, ...holes].map((r) => r.ring),
    keptPolygons: land.length,
    discardedPolygons: sorted.length - land.length - holes.length,
    discardedAreaShare: Math.round(((total - keptArea) / total) * 1e4) / 1e4,
  };
}

/**
 * Scale and centre into the fixed box, preserving aspect — the same contract
 * `fitExtent` gives the projected shapes, so a drawn country sits at the same
 * visual size as a projected one and nothing about the silhouette betrays which
 * door it came through (SEC-2).
 */
export function fitRings(rings, { size = SIZE, padding = PADDING } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (!(span > 0)) throw new UnsupportedArtwork("artwork has no extent");
  const inner = size - 2 * padding;
  const k = inner / span;
  const dx = padding + (inner - (maxX - minX) * k) / 2;
  const dy = padding + (inner - (maxY - minY) * k) / 2;
  return rings.map((ring) => ring.map((p) => ({ x: (p.x - minX) * k + dx, y: (p.y - minY) * k + dy })));
}

/**
 * The whole per-country pipeline. `maxBytes` is enforced the way buildShape
 * enforces it — by escalating the tolerance for this one country alone, so a
 * fjord-heavy coastline does not force a coarser Italy.
 */
export function buildArtwork(svg, { tolerance = 1, maxBytes = 8192, step = 0.25, minShare = null, size = SIZE, padding = PADDING } = {}) {
  const rings = pathData(svg).flatMap((d) => toRings(d));
  const selected = selectRings(rings, { minShare });
  const fitted = fitRings(selected.rings, { size, padding });

  let t = tolerance;
  for (;;) {
    const simplified = simplifyRings(fitted, t);
    if (simplified.length === 0) throw new UnsupportedArtwork("artwork vanished under simplification");
    const path = toPathData(simplified);
    if (Buffer.byteLength(path) <= maxBytes) {
      return {
        path,
        points: simplified.reduce((n, r) => n + r.length, 0),
        tolerance: Math.round(t * 1e4) / 1e4,
        keptPolygons: selected.keptPolygons,
        discardedPolygons: selected.discardedPolygons,
        discardedAreaShare: selected.discardedAreaShare,
      };
    }
    t += step;
    if (t > 20) throw new UnsupportedArtwork(`could not fit under ${maxBytes} B`);
  }
}
