// A vendored SVG icon → one path in the game's viewBox (D-59). Pure, no I/O.
//
// This is the second door into `shapes.json`. The first — `shape.mjs` — starts
// from lon/lat polygons and projects them; it is the right thing for 192 of the
// 196 countries and cannot help the other four, because Natural Earth simply
// has no detail to project. This one starts from artwork that is already 2D and
// only has to move it into our box.
//
// **It deliberately does NOT touch the centroid.** Distance and compass hints
// still come from Natural Earth's geometry, which is accurate about *where*
// Monaco is even when it is useless about *what shape* Monaco is. Mapsicon is
// hand-drawn art; letting it decide a distance would put a drawing in the
// scoring path.
//
// Curves survive. `simplify-js` needs polylines, so reusing shape.mjs would mean
// flattening a smooth coastline into segments and then approximating it back.
// An affine transform maps Béziers to Béziers — control points included — so
// the honest move is to transform and re-emit, which is also smaller.

/** Thrown when the artwork uses something this converter will not guess at. */
export class UnsupportedIcon extends Error {}

/** Fixed viewBox every silhouette is fitted into — the same one shape.mjs uses. */
export const SIZE = 500;
export const PADDING = 24;

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/**
 * Parse `d` into absolute segments: `{ m: [x,y] }`, `{ l: [x,y] }`,
 * `{ c: [x1,y1,x2,y2,x,y] }`, `{ z: true }`.
 *
 * Only the commands mapsicon's potrace output actually emits, plus their
 * absolute twins. Anything else throws: a converter that silently ignores an
 * arc draws a country with a bite out of it, and nobody would know which.
 */
export function parsePath(d) {
  const out = [];
  let i = 0;
  let cur = [0, 0];
  let start = [0, 0];
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let cmd = null;
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || !/^-?\d*\.?\d+/.test(t)) throw new UnsupportedIcon(`expected a number, got ${t}`);
    return Number(t);
  };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === "M") cmd = "L";       // repeated pairs after M are implicit linetos
    else if (cmd === "m") cmd = "l";
    if (cmd === undefined || cmd === null) throw new UnsupportedIcon("path data does not start with a command");
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : [0, 0];
    switch (cmd.toUpperCase()) {
      case "M": {
        cur = [base[0] + num(), base[1] + num()];
        start = cur;
        out.push({ m: cur });
        break;
      }
      case "L": {
        cur = [base[0] + num(), base[1] + num()];
        out.push({ l: cur });
        break;
      }
      case "C": {
        const p = [base[0] + num(), base[1] + num(), base[0] + num(), base[1] + num(), base[0] + num(), base[1] + num()];
        cur = [p[4], p[5]];
        out.push({ c: p });
        break;
      }
      case "Z": {
        cur = start;
        out.push({ z: true });
        break;
      }
      default:
        throw new UnsupportedIcon(`unsupported path command "${cmd}"`);
    }
  }
  return out;
}

/** Map every point of every segment. Affine-safe: control points move too. */
export function mapPoints(segs, fn) {
  return segs.map((s) => {
    if (s.z) return s;
    if (s.m) return { m: fn(s.m[0], s.m[1]) };
    if (s.l) return { l: fn(s.l[0], s.l[1]) };
    const [x1, y1, x2, y2, x, y] = s.c;
    return { c: [...fn(x1, y1), ...fn(x2, y2), ...fn(x, y)] };
  });
}

/** Bounding box over anchor AND control points — a Bézier can bulge past its
 *  anchors, and a shape clipped by its own box is worse than one slightly inset. */
export function boundsOf(segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    const pts = s.z ? [] : s.c ? [[s.c[0], s.c[1]], [s.c[2], s.c[3]], [s.c[4], s.c[5]]] : [s.m ?? s.l];
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) throw new UnsupportedIcon("path has no points");
  return { minX, minY, maxX, maxY };
}

/**
 * Scale and centre into the fixed box, preserving aspect — the same contract
 * `fitExtent` gives the projected shapes, so a mapsicon country sits at the
 * same visual size as a Natural Earth one and nothing about the silhouette
 * betrays which door it came through (SEC-2).
 */
export function fitToBox(segs, { size = SIZE, padding = PADDING } = {}) {
  const { minX, minY, maxX, maxY } = boundsOf(segs);
  const span = Math.max(maxX - minX, maxY - minY);
  if (span <= 0) throw new UnsupportedIcon("path has no extent");
  const inner = size - 2 * padding;
  const k = inner / span;
  const dx = padding + (inner - (maxX - minX) * k) / 2;
  const dy = padding + (inner - (maxY - minY) * k) / 2;
  return mapPoints(segs, (x, y) => [(x - minX) * k + dx, (y - minY) * k + dy]);
}

/** One decimal place, same as toPathData — 0.1px on a 500px box is invisible. */
export function toPathData(segs, decimals = 1) {
  const f = (n) => {
    const s = n.toFixed(decimals);
    return s.replace(/\.?0+$/, "") || "0";
  };
  const pair = (x, y) => `${f(x)} ${f(y)}`;
  return segs
    .map((s) => {
      if (s.z) return "Z";
      if (s.m) return `M${pair(s.m[0], s.m[1])}`;
      if (s.l) return `L${pair(s.l[0], s.l[1])}`;
      const [x1, y1, x2, y2, x, y] = s.c;
      return `C${pair(x1, y1)} ${pair(x2, y2)} ${pair(x, y)}`;
    })
    .join("");
}

/**
 * The whole per-icon pipeline: pull the one path out of the file, apply the
 * group transform, fit, emit.
 *
 * Potrace writes `<g transform="translate(0,H) scale(s,-s)">` around a single
 * `<path>`, and that is the only arrangement accepted. A file shaped any other
 * way is refused rather than guessed at — there are four of these, a human sees
 * every one, and a wrong guess is a wrong country.
 */
export function buildIcon(svg, { size = SIZE, padding = PADDING, maxBytes = 8192 } = {}) {
  const paths = [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 1) throw new UnsupportedIcon(`expected exactly one <path>, found ${paths.length}`);

  const g = svg.match(/<g\b[^>]*\stransform="translate\(([^,]+),([^)]+)\)\s*scale\(([^,]+),([^)]+)\)"/);
  if (!g) throw new UnsupportedIcon("expected a single potrace translate+scale group");
  const [tx, ty, sx, sy] = g.slice(1, 5).map(Number);
  if (![tx, ty, sx, sy].every(Number.isFinite)) throw new UnsupportedIcon("unreadable group transform");

  let segs = parsePath(paths[0]);
  segs = mapPoints(segs, (x, y) => [x * sx + tx, y * sy + ty]);
  segs = fitToBox(segs, { size, padding });
  const path = toPathData(segs);
  const bytes = Buffer.byteLength(path);
  if (bytes > maxBytes) throw new UnsupportedIcon(`path is ${bytes} B, over the ${maxBytes} B budget`);
  return { path, points: segs.filter((s) => !s.z).length, bytes };
}
