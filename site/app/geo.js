// Rendering helpers: silhouette, arrow, distance and proximity formatting
// (FR-6.2, FR-6.7). The shape arrives as raw path data and is put in the DOM
// with no attribute that could identify it (SEC-2).

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

export const arrow = (compass) => ARROW[compass] ?? "";

const km = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
export const formatKm = (n) => `${km.format(n)} km`;
export const formatPercent = (p) => `${Math.round(p * 100)}%`;

/** 0..4 band for styling the proximity bar; never the only channel (FR-6.7). */
export const band = (p) => (p >= 0.95 ? 4 : p >= 0.8 ? 3 : p >= 0.6 ? 2 : p >= 0.3 ? 1 : 0);
