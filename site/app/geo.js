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

/**
 * Fill a <figure> with the person a `person` challenge asks about (D-78): the
 * photograph and its credit. The NAME is not set here — it is text and it goes
 * where every other text prompt goes.
 *
 * This is the only artwork in the game that comes from somewhere else, so it is
 * the only one that can fail to arrive. When it does, the figure goes away
 * entirely rather than leaving a broken-image box in the middle of the card:
 * the name is the question and the face is the help, so a challenge without the
 * photo is harder, not impossible. `alt` carries the name rather than "photo of
 * X" — a screen reader is reading the prompt out of the paragraph already.
 */
export function renderPerson(figure, img, credit, prompt) {
  figure.hidden = false;
  img.alt = prompt.name;
  credit.textContent = prompt.credit;
  img.onerror = () => { figure.hidden = true; };
  img.onload = () => { figure.hidden = false; };
  img.src = prompt.photo;
}

/**
 * The bio under a finished `person` challenge (D-81): a paragraph on who that
 * was, a link to the article it came from, and the licence it is shown under.
 *
 * Three reveal panels call this — the daily's, practice's and a tournament
 * card's — and it lives here for the reason D-79 taught the hard way: `person`
 * shipped to two of those three render paths and the third showed an error to
 * everyone at noon. One helper cannot ship to two of three.
 *
 * `about` only ever arrives inside an `answer`, which the server sends only for
 * a challenge that is over (SEC-1), so there is nothing to gate here. What IS
 * gated is the URL: it is the one string in the game that came from a third
 * party and ends up in an `href`, so it has to look like the article it claims
 * to be before it is one.
 */
export function renderAbout(el, answer) {
  const wiki = String(answer?.wiki ?? "");
  const show = Boolean(answer?.about) && wiki.startsWith("https://pt.wikipedia.org/wiki/");
  el.box.hidden = !show;
  if (!show) return;
  el.text.textContent = answer.about;
  el.link.href = wiki;
  el.link.textContent = t("revealWiki");
  // Not decoration: the text is CC BY-SA 4.0 and this line plus the link above
  // it are the terms it travels under, the same way the photo carries its
  // credit (D-78).
  el.credit.textContent = t("revealWikiCredit");
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

/** The kinds whose answer is picked rather than typed (FR-8.7, D-64, D-72). */
export const isPick = (kind) => kind === "flagPick" || kind === "shapePick";

/**
 * The options of a multiple-choice challenge, as a grid of buttons (FR-8.7,
 * D-64, D-72).
 *
 * The client is handed artwork and nothing else — no code, no name, no id — so
 * position is the only thing an option has, and an index is the whole guess.
 * That is also why a wrong pick is struck out rather than named: the server
 * could not name it without sending the mapping, and sending the mapping is
 * the one thing that would give the answer away.
 *
 * `guesses` are the picks already spent, `answer` is set only once the
 * challenge is over, and `onPick` is absent whenever the grid is a read-only
 * reveal. Rebuilt from scratch on every render, like every other list here.
 */
export function renderOptions(list, options, { guesses = [], answer = null, onPick = null } = {}) {
  const spent = new Set(guesses.filter((g) => g.kind === "choice").map((g) => g.pick));
  // Every option's name, but only once the challenge is over: the server sends
  // them on the reveal and nowhere else (D-76). While it is open this is
  // undefined and the board renders exactly as it always did.
  const names = answer?.names ?? null;
  list.replaceChildren(...options.map((option, i) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    // The label is the position, never the country — WHILE THE CHALLENGE IS
    // OPEN: a screen reader must not be told what the eyes are being asked to
    // work out. Once it is over the country is the whole point, and the label
    // says it, so the reveal teaches a screen reader what it teaches everyone
    // else (D-76).
    button.setAttribute("aria-label", t("optionLabel", { n: i + 1 }));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("role", "presentation");
    // Whichever artwork the kind deals in (D-72). A silhouette is a bare path
    // with no colour of its own, so it is marked for mondo.css to paint; a flag
    // paints itself and must not be touched.
    if (option.shape) {
      renderShape(svg, option.shape);
      svg.classList.add("shape");
    } else {
      renderFlag(svg, option.flag);
    }
    // Every option box is the same size, so the grid does not go ragged when a
    // 37:28 Dane sits beside a 2:1 Palauan. The artwork keeps its own shape and
    // is letterboxed inside the box by the SVG's own preserveAspectRatio, which
    // means dropping the aspect-ratio renderFlag sets for a lone flag.
    svg.style.aspectRatio = "";
    button.appendChild(svg);

    const struck = spent.has(i) && !(answer && answer.pick === i);
    const right = answer !== null && answer.pick === i;
    button.className = `option${struck ? " struck" : ""}${right ? " right" : ""}`;
    // Three states x named or not. The plain, un-named, un-struck case keeps the
    // `optionLabel` set above, which is the one a player sees while choosing.
    const country = names?.[i];
    const state = struck ? "Struck" : right ? "Right" : "";
    if (country !== undefined) button.setAttribute("aria-label", t(`option${state}Named`, { n: i + 1, country }));
    else if (state !== "") button.setAttribute("aria-label", t(`option${state}`, { n: i + 1 }));
    // A struck option is out, and once the answer is up the whole grid is.
    button.disabled = struck || answer !== null || onPick === null;
    if (!button.disabled) button.addEventListener("click", () => onPick(i));
    li.appendChild(button);
    // The caption is a SIBLING of the button, never inside it: `.option` is
    // `aspect-ratio: 3 / 2` and text within it would shrink the artwork, which
    // is the thing being learned.
    if (country !== undefined) {
      const name = document.createElement("p");
      name.className = `option-name${right ? " right" : ""}`;
      name.textContent = country;
      li.appendChild(name);
    }
    return li;
  }));
}
