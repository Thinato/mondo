// Flag artwork → the flat path list the game serves. Pure, no I/O.
// See 06-tournaments.md §5.3 (OQ-11).
//
// Why a converter at all, rather than shipping the vendored SVG as markup:
// the client must never parse markup that came off the wire. `renderShape`
// builds one <path> and sets attributes; `renderFlag` does the same thing N
// times. Keeping the wire format as data means the browser has no sanitiser
// to get wrong, at the price of this file and a smaller pool — every flag we
// cannot express as filled paths is dropped, with its reason printed.

/** Presentation attributes a flag path may carry. Anything else is dropped. */
const PAINT = ["fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-dasharray", "opacity"];

/** Elements that draw. Everything else is either a container or a refusal. */
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline"]);
/** Containers we walk into. */
const CONTAINERS = new Set(["svg", "g"]);
/** Ignored outright: metadata that draws nothing. `<title>` matters — it says
 *  "Flag of Brazil" in this dataset, which is the answer (SEC-1). */
const DROP = new Set(["title", "desc", "metadata", "sodipodi:namedview"]);

const COLOR = /^(?:#[0-9a-fA-F]{3,8}|none|currentColor|[a-zA-Z]+|rgb\([\d\s,.%]+\))$/;
// A length may carry a unit: this dataset writes stroke-width="1pt".
const NUMBER = /^-?[\d.]+(?:e-?\d+)?(?:px|pt|pc|mm|cm|in|em|ex|%)?$/;
const DASHES = /^(?:none|-?[\d.]+(?:[\s,]+-?[\d.]+)*)$/;
const TRANSFORM = /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([-\d\s,.eE+]*\)\s*)+$/;

export class UnsupportedFlag extends Error {}

const refuse = (why) => {
  throw new UnsupportedFlag(why);
};

// ---------------------------------------------------------------------------
// A small XML reader
// ---------------------------------------------------------------------------

/**
 * Parse well-formed SVG into `{ name, attrs, children }`. Text nodes are
 * discarded: nothing in a flag draws with text, and an element that needs one
 * (`<text>`, `<style>`) is refused by the walker anyway.
 *
 * This is deliberately not a general XML parser. It runs offline over a
 * vendored dataset, its output is checked against a byte budget, and every
 * flag it mangles shows up in the preview grid a human looks at.
 */
export function parseSvg(source) {
  const src = source.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "");
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tag = /<(\/)?([a-zA-Z][\w:.-]*)((?:\s+[a-zA-Z][\w:.-]*\s*=\s*("[^"]*"|'[^']*'))*)\s*(\/)?>/g;

  for (const m of src.matchAll(tag)) {
    const [, closing, name, attrText, , selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) refuse(`mismatched </${name}>`);
      continue;
    }
    const node = { name, attrs: attributes(attrText), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) refuse("unclosed element");
  const svg = root.children.find((c) => c.name === "svg") ?? refuse("no <svg> element");
  return svg;
}

function attributes(text) {
  const out = {};
  for (const m of (text ?? "").matchAll(/([a-zA-Z][\w:.-]*)\s*=\s*"([^"]*)"|([a-zA-Z][\w:.-]*)\s*=\s*'([^']*)'/g)) {
    out[m[1] ?? m[3]] = unescapeXml(m[2] ?? m[4]);
  }
  return out;
}

const unescapeXml = (s) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+);/g, (_, e) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCharCode(Number(e.slice(1))),
  );

// ---------------------------------------------------------------------------
// Geometry: every drawable becomes path data
// ---------------------------------------------------------------------------

/**
 * One length. Percentages resolve against the viewport, which is how this
 * dataset writes "the whole flag" (`x="-50%" width="100%"` on a viewBox that
 * is centred on the origin). `axis` picks which side of the box they are a
 * percentage of.
 */
const num = (attrs, key, box, axis, fallback = 0) => {
  const raw = attrs[key];
  if (raw === undefined || raw === "") return fallback;
  if (raw.endsWith("%")) {
    const pct = Number(raw.slice(0, -1));
    if (!Number.isFinite(pct)) refuse(`${key}="${raw}" is not a number`);
    return (pct / 100) * (axis === "y" ? box[3] : box[2]);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) refuse(`${key}="${raw}" is not a number`);
  return n;
};

/** rect/circle/ellipse/polygon/polyline → the `d` of an equivalent path. */
export function toPathData(node, box = [0, 0, 100, 100]) {
  const a = node.attrs;
  const x = (key, fallback) => num(a, key, box, "x", fallback);
  const y = (key, fallback) => num(a, key, box, "y", fallback);
  switch (node.name) {
    case "path":
      return a.d ?? refuse("<path> without d");
    case "rect":
      return rectPath(x("x"), y("y"), x("width"), y("height"), x("rx", NaN), y("ry", NaN));
    case "circle": {
      const r = x("r");
      return ellipsePath(x("cx"), y("cy"), r, r);
    }
    case "ellipse":
      return ellipsePath(x("cx"), y("cy"), x("rx"), y("ry"));
    case "polygon":
    case "polyline": {
      const pts = (a.points ?? "").trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4 || pts.length % 2 !== 0 || pts.some((n) => !Number.isFinite(n))) refuse(`bad points on <${node.name}>`);
      const points = [];
      for (let i = 0; i < pts.length; i += 2) points.push(`${pts[i]} ${pts[i + 1]}`);
      const d = `M${points[0]}L${points.slice(1).join("L")}`;
      return node.name === "polygon" ? `${d}z` : d;
    }
    default:
      return refuse(`<${node.name}> cannot be drawn as a path`);
  }
}

/** Two arcs, because one arc of 360° degenerates to a point. */
const ellipsePath = (cx, cy, rx, ry) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0z`;

/** A rect, with the rounded corners the Eswatini shield is drawn from. */
function rectPath(x, y, w, h, rx, ry) {
  const [a, b] = [Number.isNaN(rx) ? (Number.isNaN(ry) ? 0 : ry) : rx, Number.isNaN(ry) ? (Number.isNaN(rx) ? 0 : rx) : ry];
  const [cx, cy] = [Math.min(a, w / 2), Math.min(b, h / 2)];
  if (cx <= 0 || cy <= 0) return `M${x} ${y}h${w}v${h}h${-w}z`;
  const arc = (dx, dy) => `a${cx} ${cy} 0 0 1 ${dx} ${dy}`;
  return `M${x + cx} ${y}h${w - cx * 2}${arc(cx, cy)}v${h - cy * 2}${arc(-cx, cy)}h${-(w - cx * 2)}${arc(-cx, -cy)}v${-(h - cy * 2)}${arc(cx, -cy)}z`;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Flatten one flag to `{ viewBox, paths }`, where every path is
 * `{ d, ...paint, transform?, clip? }` and nothing else. Throws
 * `UnsupportedFlag` when the artwork needs something the format cannot carry
 * — a gradient, a filter, text — so the caller can drop that country and say
 * why.
 */
export function buildFlag(source) {
  const svg = parseSvg(source);
  const viewBox = svg.attrs.viewBox ?? refuse("no viewBox");
  const box = viewBox.trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) refuse(`bad viewBox "${viewBox}"`);

  const byId = new Map();
  index(svg, byId);

  const paths = [];
  walk(svg, { transform: "", clip: null, paint: {} }, { byId, box, paths, seen: new Set() });
  if (paths.length === 0) refuse("nothing to draw");

  // Round coordinates to about one part in ten thousand of the flag's width —
  // finer than any screen it is drawn on, and a third off the file for the
  // ones drawn in Inkscape. The geo build rounds for the same reason (§3.2).
  const dp = Math.max(0, Math.ceil(Math.log10(10000 / Math.abs(box[2]))));
  return { viewBox, paths: paths.map((p) => ({ ...p, d: roundPath(p.d, dp), ...(p.clip ? { clip: roundPath(p.clip, dp) } : {}) })) };
}

function index(node, byId) {
  if (node.attrs.id) byId.set(node.attrs.id, node);
  for (const child of node.children) index(child, byId);
}

function walk(node, ctx, env) {
  for (const child of node.children) {
    if (DROP.has(child.name)) continue;
    // <defs> draws nothing itself; its contents are reached through <use>.
    if (child.name === "defs" || child.name === "clipPath") continue;

    const inherited = { ...ctx.paint, ...paintOf(child) };
    const transform = join(ctx.transform, transformOf(child));
    const clip = clipOf(child, ctx.clip, transform, env);

    if (CONTAINERS.has(child.name)) {
      walk(child, { transform, clip, paint: inherited }, env);
    } else if (child.name === "use") {
      resolveUse(child, { transform, clip, paint: inherited }, env);
    } else if (SHAPES.has(child.name)) {
      emit(toPathData(child, env.box), { transform, clip, paint: inherited }, env);
    } else {
      refuse(`<${child.name}>`);
    }
  }
}

/**
 * `<use href="#id">` is how this dataset draws fifty identical stars once. The
 * referenced node is walked again with the use's own transform, paint and the
 * x/y offset folded in; the result is duplicated path data, which is why the
 * byte budget is checked on the OUTPUT rather than on the vendored file.
 */
function resolveUse(node, ctx, env) {
  const href = node.attrs["xlink:href"] ?? node.attrs.href ?? refuse("<use> without href");
  if (!href.startsWith("#")) refuse(`<use> points outside the file: ${href}`);
  const target = env.byId.get(href.slice(1)) ?? refuse(`<use> points at a missing id: ${href}`);
  if (env.seen.has(target)) refuse("<use> recursion");

  // `<use transform="T" x y>` is `<g transform="T translate(x y)">`, in that
  // order. `ctx.transform` already carries T: the caller entered this node.
  const [dx, dy] = [num(node.attrs, "x", env.box, "x"), num(node.attrs, "y", env.box, "y")];
  const base = join(ctx.transform, dx || dy ? `translate(${dx} ${dy})` : "");

  // Enter the target the same way `walk` enters a child. Georgia's small
  // crosses are half a clipped shape used twice, so skipping the target's own
  // clip-path here drew four blobs instead of four crosses.
  const transform = join(base, transformOf(target));
  const entered = { transform, clip: clipOf(target, ctx.clip, transform, env), paint: { ...ctx.paint, ...paintOf(target) } };

  env.seen.add(target);
  if (CONTAINERS.has(target.name)) walk(target, entered, env);
  else if (target.name === "use") resolveUse(target, entered, env);
  else if (SHAPES.has(target.name)) emit(toPathData(target, env.box), entered, env);
  else refuse(`<use> points at <${target.name}>`);
  env.seen.delete(target);
}

function emit(d, ctx, env) {
  // A clip is expressed in the user space of the element that referenced it,
  // which is the space AFTER that element's own transform. Flattening keeps
  // that space only while nothing transforms in between — Australia clips and
  // scales on one path (fine), Bolivia clips a group and transforms inside it
  // (not fine, and refused rather than drawn wrong).
  if (ctx.clip && ctx.clip.at !== ctx.transform) refuse("a clip path under a transform");
  const path = { d };
  for (const key of PAINT) if (ctx.paint[key] !== undefined) path[camel(key)] = ctx.paint[key];
  if (ctx.transform) path.transform = ctx.transform;
  if (ctx.clip) path.clip = ctx.clip.d;
  env.paths.push(path);
}

function paintOf(node) {
  const declared = { ...styleOf(node.attrs.style), ...node.attrs };
  const out = {};
  for (const key of PAINT) {
    const v = declared[key];
    if (v === undefined) continue;
    if (v.includes("url(")) refuse(`${key}=url() (gradient or pattern)`);
    const ok =
      key === "fill" || key === "stroke"
        ? COLOR.test(v)
        : key === "fill-rule" || key.startsWith("stroke-line")
          ? /^[a-z]+$/.test(v)
          : key === "stroke-dasharray"
            ? DASHES.test(v)
            : NUMBER.test(v);
    if (!ok) refuse(`${key}="${v}"`);
    out[key] = v;
  }
  return out;
}

/** `style="fill:#169b62;stroke:none"` → the same names PAINT already knows. A
 *  property outside PAINT is refused, not ignored: silently dropping one is how
 *  a flag renders subtly wrong and nobody notices. */
function styleOf(style) {
  if (style === undefined) return {};
  const out = {};
  for (const decl of style.split(";")) {
    if (!decl.trim()) continue;
    const [prop, ...rest] = decl.split(":");
    const key = prop.trim();
    if (!PAINT.includes(key)) refuse(`style="${key}: ..."`);
    out[key] = rest.join(":").trim();
  }
  return out;
}

function transformOf(node) {
  const t = node.attrs.transform;
  if (t === undefined) return "";
  if (!TRANSFORM.test(t)) refuse(`transform="${t}"`);
  return t.trim();
}

/**
 * Resolve `clip-path="url(#id)"` to the clip's path data. A clip covering the
 * whole viewBox is dropped, because every renderer clips the flag to its own
 * viewBox anyway (`renderFlag`, and the preview grid). Keeping it would make
 * the Union Jack a nest of two clips and drop it from the pool; dropping it
 * WITHOUT the renderer's clip let its stroked diagonals bleed past the corners.
 */
function clipOf(node, inherited, transform, env) {
  const ref = node.attrs["clip-path"];
  if (ref === undefined) return inherited;
  const id = /^url\(#([^)]+)\)$/.exec(ref)?.[1] ?? refuse(`clip-path="${ref}"`);
  const def = env.byId.get(id) ?? refuse(`clip-path points at a missing id: #${id}`);
  if (def.name !== "clipPath") refuse("clip-path points at something that is not a <clipPath>");
  if (def.attrs.clipPathUnits === "objectBoundingBox") refuse("clipPathUnits=objectBoundingBox");

  const shapes = def.children.filter((c) => !DROP.has(c.name));
  if (shapes.length !== 1) refuse(`<clipPath> with ${shapes.length} shapes`);
  if (shapes[0].attrs.transform) refuse("<clipPath> with a transform");
  const d = toPathData(shapes[0], env.box);
  if (coversViewBox(d, env.box)) return inherited;
  if (inherited) refuse("nested clip paths");
  return { d, at: transform };
}

/**
 * True when `d` traces the flag's own box — `M0 0h9v6H0z` and the four other
 * spellings this dataset uses. Written as a walk rather than a set of regexes
 * because the spellings differ per file (`v h V` in one, `h v H` in the next)
 * and a regex that misses one turns a no-op clip into a real constraint.
 */
function coversViewBox(d, [x, y, w, h]) {
  const corners = straightPolygon(d);
  if (!corners) return false;
  const want = new Set([`${x},${y}`, `${x + w},${y}`, `${x + w},${y + h}`, `${x},${y + h}`]);
  const got = new Set(corners.map(([px, py]) => `${px},${py}`));
  return got.size === 4 && want.size === 4 && [...want].every((p) => got.has(p));
}

/** Point list of a path made only of M/L/H/V/Z, or null if it curves. */
function straightPolygon(d) {
  const points = [];
  let [px, py] = [0, 0];
  const tokens = d.matchAll(/([A-Za-z])|(-?[\d.]+(?:e-?\d+)?)/g);
  let cmd = null;
  const pending = [];
  const flush = () => {
    while (pending.length) {
      if (cmd === "M" || cmd === "L") [px, py] = [pending.shift(), pending.shift()];
      else if (cmd === "m" || cmd === "l") [px, py] = [px + pending.shift(), py + pending.shift()];
      else if (cmd === "H") px = pending.shift();
      else if (cmd === "h") px += pending.shift();
      else if (cmd === "V") py = pending.shift();
      else if (cmd === "v") py += pending.shift();
      else return false;
      points.push([px, py]);
    }
    return true;
  };
  for (const [, letter, number] of tokens) {
    if (number !== undefined) {
      pending.push(Number(number));
      continue;
    }
    if (!flush()) return null;
    if (letter === "Z" || letter === "z") continue;
    if (!"MmLlHhVv".includes(letter)) return null; // a curve is not a box
    cmd = letter;
  }
  if (!flush()) return null;
  return points.length ? points : null;
}

/** Every decimal in path data, rounded and stripped of trailing zeros. */
export function roundPath(d, dp) {
  return d.replace(/-?\d*\.\d+(?:e-?\d+)?/g, (m) => {
    const r = Number(m).toFixed(dp).replace(/\.?0+$/, "").replace(/^(-?)0\./, "$1.");
    return r === "" || r === "-" ? "0" : r;
  });
}

const join = (a, b) => (a && b ? `${a} ${b}` : a || b);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
