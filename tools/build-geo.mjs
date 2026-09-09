#!/usr/bin/env node
// Geo build: Natural Earth (via world-atlas) + world-countries → the data files
// the game runs on. Offline, deterministic, committed. See 03-geo-data-pipeline.md.
//
// Outputs
//   site/data/countries.min.json           client: codes, names, aliases. NOTHING ELSE.
//   backend/functions/src/data/countries.json   server: + centroids, tiers, stats
//   backend/functions/src/data/shapes.json      server: SVG path per country
//   tools/preview.html                     human review grid (gitignored). Shows the crawled
//                                          reference SVG from assets/ beside each shape when
//                                          that file exists locally (D-15, D-17). assets/ is
//                                          gitignored and is never a build input.
//
// The client never receives shapes or centroids. The server inlines one shape
// per round (SEC-1, SEC-2, D-13), so there is no public shape file to match a
// silhouette against.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { feature } from "topojson-client";
import wc from "world-countries";
import { buildShape, VIEW_BOX } from "./lib/shape.mjs";
import { normalize } from "../site/app/normalize.js";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const write = (p, data) => {
  mkdirSync(dirname(join(ROOT, p)), { recursive: true });
  writeFileSync(join(ROOT, p), data);
};

// ---------------------------------------------------------------------------
// Budgets (§3.3, §8). buildShape enforces MAX_SHAPE_BYTES per country by
// escalating tolerance for that country alone; the total is a sanity cap.
// ---------------------------------------------------------------------------
const MAX_SHAPE_BYTES = 8192;
const MAX_TOTAL_SHAPE_BYTES = 640 * 1024;
const TOLERANCE_PX = 1.0;
const REVIEW_DISCARDED_SHARE = 0.25; // §3.1: above this, a human should look

// world-atlas features carry only a numeric ISO id. A few have none; map by name.
const BY_NAME = { XK: "Kosovo" };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
const include = read("tools/include.json").countries;
const tiers = read("tools/tiers.json").tiers;
const { names: nameOverrides = {}, aliases: curatedAliases = {} } = read("tools/aliases.json");
const keepOverrides = read("tools/overrides.json").keep;
const capitalOverrides = read("tools/capitals.json").capitals;
const topo = read("tools/node_modules/world-atlas/countries-10m.json");
const sources = {
  "world-atlas": read("tools/node_modules/world-atlas/package.json").version,
  "world-countries": read("tools/node_modules/world-countries/package.json").version,
  dataset: "ne_10m_admin_0_countries",
};

const features = feature(topo, topo.objects.countries).features;
const featureByName = new Map(features.map((f) => [f.properties.name, f]));

// Natural Earth gives some dependencies their sovereign's ISO id — at 10m,
// "Ashmore and Cartier Is." shares 036 with Australia. A Map would keep the
// last one and the whole build would think Australia is a reef. Merge every
// same-id feature into one MultiPolygon; D-8 then drops the reef on its own.
const featureById = new Map();
for (const f of features) {
  if (f.id == null) continue;
  const id = String(f.id);
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const prev = featureById.get(id);
  if (!prev) {
    featureById.set(id, { ...f, geometry: { type: "MultiPolygon", coordinates: polys } });
  } else {
    prev.geometry.coordinates.push(...polys);
    prev.properties = { ...prev.properties, merged: [...(prev.properties.merged ?? []), f.properties.name] };
  }
}
const metaByCode = new Map(wc.map((c) => [c.cca2, c]));

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const errors = [];
const countries = [];
const shapes = {};
const codes = Object.keys(include).sort();

for (const code of codes) {
  const meta = metaByCode.get(code);
  if (!meta) {
    errors.push(`${code}: not in world-countries`);
    continue;
  }
  const feat = BY_NAME[code] ? featureByName.get(BY_NAME[code]) : featureById.get(meta.ccn3);
  if (!feat) {
    errors.push(`${code}: no geometry in ${sources.dataset} (ccn3=${meta.ccn3 || "none"})`);
    continue;
  }
  const tier = tiers[code]?.tier;
  if (![1, 2, 3].includes(tier)) {
    errors.push(`${code}: missing or invalid tier in tools/tiers.json`);
    continue;
  }

  let shape;
  try {
    shape = buildShape(feat.geometry, {
      tolerance: TOLERANCE_PX,
      maxBytes: MAX_SHAPE_BYTES,
      minShare: keepOverrides[code]?.minShare ?? null,
    });
  } catch (e) {
    errors.push(`${code}: ${e.message}`);
    continue;
  }
  const [lon, lat] = shape.centroid;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    errors.push(`${code}: centroid out of range [${lon}, ${lat}]`);
  }

  const en = nameOverrides[code]?.en ?? meta.name.common;
  const ptPT = meta.translations.por?.common;
  const pt = nameOverrides[code]?.["pt-BR"] ?? ptPT ?? en;

  // Aliases: curated first, then the pt-PT form we overrode (if it still
  // differs once normalised), then world-countries' Latin-script alt spellings.
  // Dedupe on the normalised form and drop anything equal to a display name or code.
  const taken = new Set([en, pt, code, meta.cca3].map(normalize));
  const aliases = [];
  const candidates = [...(curatedAliases[code] ?? []), ...(ptPT ? [ptPT] : []), ...meta.altSpellings.filter(isLatin)];
  for (const raw of candidates) {
    const key = normalize(raw);
    if (!key || key.length < 2 || taken.has(key)) continue;
    taken.add(key);
    aliases.push(raw);
  }

  // The capital city, for the `capital` challenge kind (docs/06-tournaments.md
  // §5.2). SERVER-ONLY, like the centroid: a client-reachable capital→country
  // map would turn that kind's prompt into a one-lookup answer (SEC-2), so this
  // field must never reach site/data/countries.min.json. world-countries gives
  // ZA three; the first is the executive capital and the conventional answer.
  const capitalEn = meta.capital?.[0];
  if (!capitalEn) errors.push(`${code}: no capital in world-countries`);

  countries.push({
    code,
    code3: meta.cca3,
    names: { en, "pt-BR": pt },
    capital: { en: capitalEn ?? "", "pt-BR": capitalOverrides[code] ?? capitalEn ?? "" },
    aliases,
    centroid: shape.centroid,
    tier,
    areaKm2: Math.round(meta.area),
    keptPolygons: shape.keptPolygons,
    discardedPolygons: shape.discardedPolygons,
    discardedAreaShare: shape.discardedAreaShare,
    points: shape.points,
    tolerance: shape.tolerance,
    bytes: Buffer.byteLength(shape.path),
  });
  shapes[code] = shape.path;
}

// ---------------------------------------------------------------------------
// Validation (§8)
// ---------------------------------------------------------------------------
const termOwners = new Map(); // normalised term → Set(code)
for (const c of countries) {
  for (const term of [c.code, c.code3, c.names.en, c.names["pt-BR"], ...c.aliases]) {
    const key = normalize(term);
    if (!termOwners.has(key)) termOwners.set(key, new Set());
    termOwners.get(key).add(c.code);
  }
}
for (const [term, owners] of termOwners) {
  if (owners.size > 1) errors.push(`ambiguous term "${term}" → ${[...owners].join(", ")}`);
}

// A pt-BR capital override for a code outside the pool is a typo that would
// otherwise do nothing at all, quietly.
for (const code of Object.keys(capitalOverrides)) {
  if (!codes.includes(code)) errors.push(`tools/capitals.json: ${code} is not in the country pool`);
}

const totalShapeBytes = Object.values(shapes).reduce((n, p) => n + Buffer.byteLength(p), 0);
if (totalShapeBytes > MAX_TOTAL_SHAPE_BYTES) {
  errors.push(`total shape bytes ${totalShapeBytes} exceed ${MAX_TOTAL_SHAPE_BYTES}`);
}

if (errors.length) {
  console.error(`\n✗ geo build failed with ${errors.length} error(s):\n`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
write(
  "site/data/countries.min.json",
  JSON.stringify(
    countries.map((c) => ({ code: c.code, code3: c.code3, en: c.names.en, pt: c.names["pt-BR"], aliases: c.aliases })),
  ) + "\n",
);

write(
  "backend/functions/src/data/countries.json",
  JSON.stringify(
    {
      "//": "GENERATED by tools/build-geo.mjs — do not edit. Server-only: centroids feed distance/bearing (§7), tiers feed the schedule, capitals are the `capital` challenge kind's prompt. The client copy is site/data/countries.min.json and deliberately lacks all of this — a capital→country map on the client would name the answer in one lookup (SEC-2).",
      sources,
      countries: countries.map(({ points, tolerance, bytes, aliases, ...c }) => c),
    },
    null,
    1,
  ) + "\n",
);

write(
  "backend/functions/src/data/shapes.json",
  JSON.stringify(
    {
      "//": "GENERATED by tools/build-geo.mjs — do not edit. Server-only (D-13). One SVG path per country, largest landmass only (D-8), azimuthal equal-area centred on the country, fitted to the viewBox. Render with fill-rule=evenodd.",
      viewBox: VIEW_BOX,
      fillRule: "evenodd",
      shapes,
    },
    null,
    0,
  ) + "\n",
);

write("tools/preview.html", renderPreview(countries, shapes));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const review = countries.filter((c) => c.discardedAreaShare >= REVIEW_DISCARDED_SHARE);
const overridden = countries.filter((c) => keepOverrides[c.code]);
const escalated = countries.filter((c) => c.tolerance > TOLERANCE_PX);
const tierCounts = [1, 2, 3].map((t) => countries.filter((c) => c.tier === t).length);
const kb = (n) => (n / 1024).toFixed(1) + " KB";

console.log(`✓ ${countries.length} countries from ${sources.dataset} (world-atlas ${sources["world-atlas"]}, world-countries ${sources["world-countries"]})`);
console.log(`  tiers 1/2/3: ${tierCounts.join(" / ")}`);
console.log(`  shapes: ${kb(totalShapeBytes)} total, largest ${Math.max(...countries.map((c) => c.bytes))} B, ${countries.reduce((n, c) => n + c.points, 0)} points`);
console.log(`  client countries.min.json: ${kb(Buffer.byteLength(readFileSync(join(ROOT, "site/data/countries.min.json"))))}`);
console.log(`  tolerance escalated above ${TOLERANCE_PX}px for ${escalated.length}: ${escalated.map((c) => `${c.code}@${c.tolerance}`).join(" ") || "none"}`);
const merged = [...featureById.values()].filter((f) => f.properties.merged).map((f) => `${f.id}=${f.properties.name}+${f.properties.merged.join("+")}`);
console.log(`  same-id features merged: ${merged.join(" ") || "none"}`);
console.log(`  D-8 overrides (tools/overrides.json): ${overridden.map((c) => `${c.code}×${c.keptPolygons}`).join(" ") || "none"}`);
console.log(`  discarded ≥ ${REVIEW_DISCARDED_SHARE * 100}% of area (review these): ${review.length}`);
for (const c of review.sort((a, b) => b.discardedAreaShare - a.discardedAreaShare)) {
  console.log(`    ${c.code} ${c.names.en.padEnd(22)} ${(c.discardedAreaShare * 100).toFixed(1).padStart(5)}%  ${c.discardedPolygons} polygons dropped`);
}
console.log(`  preview: tools/preview.html — look at it.`);

// ---------------------------------------------------------------------------
function isLatin(s) {
  return /^[\p{Script=Latin}\p{P}\p{Zs}\d]+$/u.test(s);
}

function renderPreview(list, shapeByCode) {
  const card = (c) => `
    <figure class="${c.discardedAreaShare >= REVIEW_DISCARDED_SHARE ? "review" : ""}">
      <svg viewBox="${VIEW_BOX}"><path d="${shapeByCode[c.code]}" fill-rule="evenodd"/></svg>${reference(c.code)}
      <figcaption>
        <b>${esc(c.names.en)}</b> <span class="code">${c.code}</span><br>
        <small>${esc(c.names["pt-BR"])} · tier ${c.tier} · ${c.points} pts · ${c.bytes} B${c.tolerance > TOLERANCE_PX ? ` · tol ${c.tolerance}` : ""}${c.keptPolygons > 1 ? ` · kept ${c.keptPolygons}` : ""}${c.discardedPolygons ? ` · dropped ${c.discardedPolygons} (${(c.discardedAreaShare * 100).toFixed(1)}%)` : ""}</small>
      </figcaption>
    </figure>`;
  const review = list.filter((c) => c.discardedAreaShare >= REVIEW_DISCARDED_SHARE).sort((a, b) => b.discardedAreaShare - a.discardedAreaShare);
  const rest = list.filter((c) => c.discardedAreaShare < REVIEW_DISCARDED_SHARE).sort((a, b) => a.names.en.localeCompare(b.names.en));
  return `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light only"><meta name="darkreader-lock"><title>Mondo — silhouette preview (${list.length})</title>
<style>
  body{font:14px system-ui;margin:1.5rem;background:#fafaf8;color:#222}
  h1,h2{font-weight:600} h2{margin-top:2.5rem;border-top:1px solid #ddd;padding-top:1rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem}
  figure{margin:0;padding:.5rem;background:#fff;border:1px solid #e5e5e0;border-radius:6px}
  figure.review{border-color:#d33;background:#fff7f7}
  svg,img{width:100%;aspect-ratio:1;display:block;background:#f2f2ee;border-radius:4px} img{margin-top:.25rem;opacity:.8}
  path{fill:#222} .code{color:#888;font-family:ui-monospace,monospace} small{color:#666}
</style>
<h1>Mondo — ${list.length} silhouettes</h1>
<p>Generated by <code>tools/build-geo.mjs</code>. Not published. Largest landmass only (D-8), azimuthal equal-area centred per country, fitted to ${VIEW_BOX.split(" ")[2]}px, simplified to ${TOLERANCE_PX}px.</p>
<h2>Needs a human look — ≥ ${REVIEW_DISCARDED_SHARE * 100}% of area discarded (${review.length})</h2>
<div class="grid">${review.map(card).join("")}</div>
<h2>Everything else (${rest.length})</h2>
<div class="grid">${rest.map(card).join("")}</div>
`;
}

// D-17: a second opinion for the eye, never an input. Relative path from tools/.
function reference(code) {
  const rel = `../assets/countries/shapes/${code.toLowerCase()}.svg`;
  return existsSync(join(TOOLS, rel)) ? `<img src="${rel}" alt="" title="referência (local)">` : "";
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}
