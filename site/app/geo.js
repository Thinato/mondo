// Rendering helpers: silhouette, flag, arrow, distance and proximity formatting
// (FR-6.2, FR-6.7). A shape arrives as raw path data and a flag as a list of
// paths; both go into the DOM with no attribute that could identify them (SEC-2).

import { t } from "./i18n.js";

const ARROW = { N: "↑", NE: "↗", E: "→", SE: "↘", S: "↓", SW: "↙", W: "←", NW: "↖" };

/** Fill an <svg> with the round's path. Nothing else goes in. */
export function renderShape(svg, shape) {
  svg.setAttribute("viewBox", shape.viewBox);
  svg.replaceChildren();
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", shape.d);
  path.setAttribute("fill-rule", shape.fillRule);
  svg.appendChild(path);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Presentation attributes a flag path may carry, camelCase on the wire and
 * hyphenated in the DOM. The list is closed on purpose: the server sends data,
 * not markup, and this function is what keeps it that way — nothing here parses
 * a string as SVG source, so there is no sanitiser to get wrong.
 */
const PAINT = {
  fill: "fill", fillRule: "fill-rule", fillOpacity: "fill-opacity", opacity: "opacity",
  stroke: "stroke", strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin", strokeMiterlimit: "stroke-miterlimit",
  strokeOpacity: "stroke-opacity", strokeDasharray: "stroke-dasharray",
};

/**
 * Fill an <svg> with a flag: one <path> per entry, plus a clip around the whole
 * thing. The outer clip is not decoration — tools/build-flags.mjs drops any
 * clip that covers the flag's own box on the understanding that this exists,
 * and without it the Union Jack's stroked diagonals run past the corners.
 */
export function renderFlag(svg, flag) {
  svg.setAttribute("viewBox", flag.viewBox);
  svg.replaceChildren();
  const [x, y, w, h] = flag.viewBox.trim().split(/[\s,]+/).map(Number);
  // The box takes the flag's own proportions, so the border in mondo.css hugs
  // the artwork. Without it a flag with a black or white edge — Yemen, Poland,
  // Indonesia — has no visible end against the card, and a flag's proportions
  // are part of the question.
  svg.style.aspectRatio = `${w} / ${h}`;

  const defs = document.createElementNS(SVG_NS, "defs");
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("clip-path", `url(#${clip(defs, `M${x} ${y}h${w}v${h}h${-w}z`)})`);

  for (const p of flag.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", p.d);
    for (const [key, attr] of Object.entries(PAINT)) if (p[key] !== undefined) path.setAttribute(attr, p[key]);
    if (p.transform !== undefined) path.setAttribute("transform", p.transform);
    if (p.clip !== undefined) path.setAttribute("clip-path", `url(#${clip(defs, p.clip)})`);
    group.appendChild(path);
  }
  svg.append(defs, group);
}

/** Add one <clipPath> to `defs` and return its id. Ids are per-render and
 *  unique, because a page can hold more than one flag. */
let clipSeq = 0;
function clip(defs, d) {
  const id = `fc${++clipSeq}`;
  const clipPath = document.createElementNS(SVG_NS, "clipPath");
  clipPath.setAttribute("id", id);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  clipPath.appendChild(path);
  defs.appendChild(clipPath);
  return id;
}

export const arrow = (compass) => ARROW[compass] ?? "";

const km = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
export const formatKm = (n) => `${km.format(n)} km`;
export const formatPercent = (p) => `${Math.round(p * 100)}%`;

/** 0..4 band for styling the proximity bar; never the only channel (FR-6.7). */
export const band = (p) => (p >= 0.95 ? 4 : p >= 0.8 ? 3 : p >= 0.6 ? 2 : p >= 0.3 ? 1 : 0);

/**
 * One row of the guess list: what you guessed, how far off, which way, how close.
 *
 * Two shapes, because a `gdp` guess is a number (D-53): "how far" is a ratio
 * rather than kilometres and "which way" is higher/lower rather than a compass.
 * The proximity band is common, which is why the colour and the bar work for
 * both without asking what kind of challenge this is.
 *
 * Shared by the daily and by tournaments — it was copied into both before, and
 * a two-shape row is exactly the thing you do not want to fix twice.
 */
export function guessRow(g) {
  const li = document.createElement("li");
  li.className = `guess band-${band(g.proximity)}`;
  const span = (cls, text) => { const e = document.createElement("span"); e.className = cls; e.textContent = text; return e; };
  const correct = g.kind === "number" ? g.proximity >= 0.9 : g.distanceKm === 0;

  const name = span("name", g.kind === "number" ? formatUsd(g.value) : g.name);
  const dist = span("dist", correct ? "🎉" : g.kind === "number" ? "" : formatKm(g.distanceKm));
  const dir = span("dir", "");
  if (!correct) {
    const label = g.kind === "number" ? t(g.higher ? "higher" : "lower") : t(`compass.${g.compass}`);
    dir.textContent = g.kind === "number" ? (g.higher ? "↑" : "↓") : arrow(g.compass);
    dir.setAttribute("aria-label", label);
    dir.title = label;
  }
  li.append(name, dist, dir, span("pct", formatPercent(g.proximity)));
  return li;
}

const nf = new Intl.NumberFormat("pt-BR");
/**
 * A `gdp` figure, with its unit. D-54: the number was always in international
 * dollars and nothing outside regras.html said so, so the first players read it
 * as reais — which is off by roughly five times and makes the question
 * unanswerable rather than merely hard.
 */
export const formatUsd = (n) => `US$ ${nf.format(n)}`;
