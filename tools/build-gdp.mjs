#!/usr/bin/env node
// GDP build: World Bank → the one file the `gdp` kind serves from (OQ-12, D-53).
// See 06-tournaments.md §5.4.
//
//   node build-gdp.mjs [--year 2023]
//   node build-gdp.mjs --only-growth [--from 2013]
//   node build-gdp.mjs --only-total [--indicator NY.GDP.MKTP.PP.CD] [--dry]
//
// Output: backend/functions/src/data/gdp.json — server-only, committed.
//
// Unlike the geo and flag builds this one reads the network, because the World
// Bank is an API rather than an npm package. That is why the OUTPUT is the
// vendored artefact and is committed: a rebuild needs connectivity, and every
// figure the game serves is in git where it can be diffed.
//
// **A rebuild can legitimately change numbers.** The World Bank revises past
// years for a long time after they close, which is exactly why D-53 pins a
// single year and puts it in the prompt. A diff here is a revision, not a bug —
// read it, then commit it.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { quintiles, refuseChanges, spearman } from "./lib/gdp.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const write = (p, data) => {
  mkdirSync(dirname(join(ROOT, p)), { recursive: true });
  writeFileSync(join(ROOT, p), data);
};

const { values: args } = parseArgs({
  options: {
    year: { type: "string", default: "2023" },
    "only-growth": { type: "boolean", default: false },
    from: { type: "string", default: "2013" },
    "only-total": { type: "boolean", default: false },
    indicator: { type: "string", default: "NY.GDP.MKTP.PP.CD" },
    dry: { type: "boolean", default: false },
  },
});
const YEAR = Number(args.year);

// D-53: GDP per capita, PPP, current international $. Chosen over the three
// alternatives because it is the only one a player can reason about without
// already knowing the answer — a 131x spread against 520 000x for total GDP,
// and it asks "how rich is this place" rather than "how many people live here".
const INDICATOR = "NY.GDP.PCAP.PP.CD";
const MIN_POOL = 170;

/** The World Bank spells Kosovo XKX; world-countries gives it UNK. */
const ISO3_OVERRIDES = { XK: "XKX" };

const countries = read("backend/functions/src/data/countries.json").countries;
const iso3 = (c) => ISO3_OVERRIDES[c.code] ?? c.code3;
const byIso3 = new Map(countries.map((c) => [iso3(c), c]));

async function fetchRows(indicator, date) {
  const url = `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&date=${date}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`World Bank returned ${res.status} for ${url}`);
  const [meta, rows] = await res.json();
  if (!Array.isArray(rows)) throw new Error(`unexpected response: ${JSON.stringify(meta)}`);
  if (meta.pages > 1) throw new Error(`${meta.pages} pages — raise per_page`);
  return rows;
}

// FR-14 / D-101: ten years of REAL growth, for the hint shown after a `gdp`
// challenge. The served figure is current international dollars, and that
// dollar inflates — every country would look like it grew half again. So the
// growth comes from the constant-price series of the same indicator family,
// and is added to the file without touching `values`: those are the answer of
// every seeded `gdp` day, and the World Bank revises them (D-80's
// `--only-about`, the same move).
if (args["only-growth"]) {
  const REAL = "NY.GDP.PCAP.PP.KD";
  const path = "backend/functions/src/data/gdp.json";
  const before = read(path);
  const from = Number(args.from);
  const to = before.year;
  const at = { [from]: {}, [to]: {} };
  for (const row of await fetchRows(REAL, `${from}:${to}`)) {
    const country = byIso3.get(row.countryiso3code);
    if (country && row.value !== null && at[row.date]) at[row.date][country.code] = row.value;
  }
  const growth = {};
  for (const code of Object.keys(before.values)) {
    const a = at[from][code], b = at[to][code];
    if (a > 0 && b > 0) growth[code] = Math.round((b / a - 1) * 100);
  }
  const after = { ...before, growth: { indicator: REAL, url: `https://data.worldbank.org/indicator/${REAL}`, from, to, values: growth } };
  if (JSON.stringify(after.values) !== JSON.stringify(before.values)) throw new Error("values changed — refusing");
  const n = Object.keys(growth).length, of = Object.keys(before.values).length;
  console.log(`growth: ${n} of ${of} countries, ${from}→${to}, ${REAL}`);
  console.log(`  none for: ${Object.keys(before.values).filter((c) => growth[c] === undefined).join(", ")}`);
  if (n < of * 0.95) throw new Error(`only ${n} of ${of} have growth; the floor is 95%`);
  write(path, JSON.stringify(after, null, 0) + "\n");
  console.log(`  written: ${path}`);
  process.exit(0);
}

// FR-15.2 / D-108: what a Fronteiras territory is worth. Total GDP, PPP, by
// default — a figure no kind asks for — binned into quintiles per continent at
// match start. It is correlated with per-capita, so this also PRINTS how much:
// Spearman's ρ between the two quintiles and how often they agree exactly
// (20 % is chance), per continent. `--indicator SP.POP.TOTL --dry` prints the
// same table for population, the fallback, without writing it.
//
// Each country takes its most recent figure from 2013 to 2023; the few the
// World Bank never covers come from tools/gdp-totals-fill.json, with a source
// each. Like `--only-growth` it adds a section and never touches `values`.
if (args["only-total"]) {
  const TOTAL = "NY.GDP.MKTP.PP.CD";
  const BOARDS = ["Europe", "Asia", "Americas", "Africa"];
  const path = "backend/functions/src/data/gdp.json";
  const before = read(path);
  const indicator = args.indicator;
  const from = 2013, to = before.year;
  const best = {};
  for (const row of await fetchRows(indicator, `${from}:${to}`)) {
    const country = byIso3.get(row.countryiso3code);
    if (!country || row.value === null || best[country.code]?.year > Number(row.date)) continue;
    best[country.code] = { value: row.value, year: Number(row.date) };
  }
  const filled = {};
  for (const [code, year] of Object.entries(best)) if (year.year !== to) filled[code] = { year: year.year, source: "World Bank" };
  const fill = indicator === TOTAL ? read("tools/gdp-totals-fill.json") : {};
  for (const [code, f] of Object.entries(fill)) {
    if (code === "//") continue;
    if (best[code]) throw new Error(`${code} is in gdp-totals-fill.json but the World Bank has it — drop the fill`);
    best[code] = f;
    filled[code] = { year: f.year, source: f.source };
  }
  const values = Object.fromEntries(Object.keys(best).sort().map((c) => [c, Math.round(best[c].value)]));
  const lacking = countries.filter((c) => BOARDS.includes(c.region) && values[c.code] === undefined).map((c) => c.code);

  console.log(`${indicator}: ${Object.keys(values).length} of ${countries.length}, most recent ${from}–${to}, ${Object.keys(filled).length} not from the World Bank in ${to}`);
  for (const [c, f] of Object.entries(filled)) console.log(`  ${c}: ${f.year}, ${f.source}`);
  console.log(`\n  R-1 (D-108): ${indicator} quintile vs per-capita quintile, per continent`);
  console.log("  continent   n   Spearman ρ   exact tier (chance 20 %)");
  for (const region of BOARDS) {
    const members = countries.filter((c) => c.region === region).map((c) => c.code);
    const pick = (src) => Object.fromEntries(members.filter((c) => src[c] !== undefined).map((c) => [c, src[c]]));
    const a = quintiles(pick(values)), b = quintiles(pick(before.values));
    const both = members.filter((c) => a[c] && b[c]);
    const rho = spearman(both.map((c) => a[c]), both.map((c) => b[c]));
    const same = both.filter((c) => a[c] === b[c]).length / both.length;
    console.log(`  ${region.padEnd(9)} ${String(both.length).padStart(3)}   ${rho.toFixed(2).padStart(10)}   ${(same * 100).toFixed(0).padStart(5)} %`);
  }

  if (lacking.length) {
    console.error(`\n✗ no ${indicator} for ${lacking.join(", ")} — add them to tools/gdp-totals-fill.json with a source`);
    if (!args.dry) process.exit(1);
  }
  if (args.dry) process.exit(0);
  const after = refuseChanges(before, { ...before, totals: { indicator, year: to, values, filled } });
  write(path, JSON.stringify(after, null, 0) + "\n");
  console.log(`\n  written: ${path}`);
  process.exit(0);
}

const rows = await fetchRows(INDICATOR, YEAR);

const values = {};
for (const row of rows) {
  const country = byIso3.get(row.countryiso3code);
  if (!country || row.value === null) continue;
  const v = Math.round(row.value);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${country.code}: implausible value ${row.value}`);
  values[country.code] = v;
}

const kept = Object.keys(values).sort();
const missing = countries.filter((c) => values[c.code] === undefined);

const out = {
  "//": `GDP per capita, PPP (current international $), ${YEAR}, from the World Bank indicator ${INDICATOR}. Generated by tools/build-gdp.mjs. Server-only: the figure is the answer. Do not edit by hand.`,
  source: {
    name: "World Bank, World Development Indicators",
    indicator: INDICATOR,
    url: `https://data.worldbank.org/indicator/${INDICATOR}`,
    license: "CC BY 4.0. See NOTICE.",
    retrievedAt: new Date().toISOString().slice(0, 10),
  },
  year: YEAR,
  values: Object.fromEntries(kept.map((c) => [c, values[c]])),
};
// The other sections came from their own flags; a full rebuild keeps them
// rather than dropping them (re-run those flags to refresh them).
let previous = {};
try { previous = read("backend/functions/src/data/gdp.json"); } catch { /* first build */ }
for (const k of ["growth", "totals"]) if (previous[k]) out[k] = previous[k];

console.log(`gdp: ${kept.length} of ${countries.length} countries, ${YEAR}, ${INDICATOR}`);
const sorted = kept.map((c) => [c, values[c]]).sort((a, b) => a[1] - b[1]);
console.log(`  range: ${sorted[0][1].toLocaleString("en")} (${sorted[0][0]}) … ${sorted.at(-1)[1].toLocaleString("en")} (${sorted.at(-1)[0]})  — ${(sorted.at(-1)[1] / sorted[0][1]).toFixed(0)}x`);
console.log(`  no figure for ${missing.length}: ${missing.map((c) => c.names["pt-BR"]).join(", ")}`);

if (kept.length < MIN_POOL) throw new Error(`only ${kept.length} countries have a figure; the floor is ${MIN_POOL}`);

write("backend/functions/src/data/gdp.json", JSON.stringify(out, null, 0) + "\n");
console.log("  written: backend/functions/src/data/gdp.json");
