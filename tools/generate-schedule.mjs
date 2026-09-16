#!/usr/bin/env node
// Generate the puzzle schedule. See 03-geo-data-pipeline.md §6.
//
//   node generate-schedule.mjs --seed 20260908 --start 2026-09-15 [--days 365] [--history out/schedule-<old>.json]
//
// Output: tools/out/schedule-<seed>.json — EVERY ANSWER FOR A YEAR. tools/out/ is
// gitignored (CLAUDE.md invariant 8). Never move this file anywhere public.
// Seed it into Firestore with seed-schedule.mjs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generate, poolsFrom, tierMix, minRepeatGap, minDayGap, DEFAULT_WEIGHTS, KINDS, KIND_WINDOW } from "./lib/schedule.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    seed: { type: "string" },
    start: { type: "string" },
    days: { type: "string", default: "365" },
    history: { type: "string" },
  },
});
if (!args.seed || !args.start) {
  console.error("usage: generate-schedule.mjs --seed <int> --start YYYY-MM-DD [--days 365] [--history <schedule.json>]");
  process.exit(2);
}

const data = JSON.parse(readFileSync(join(TOOLS, "../backend/functions/src/data/countries.json"), "utf8"));
const flags = JSON.parse(readFileSync(join(TOOLS, "../backend/functions/src/data/flags.json"), "utf8"));
const gdp = JSON.parse(readFileSync(join(TOOLS, "../backend/functions/src/data/gdp.json"), "utf8"));
const shapes = JSON.parse(readFileSync(join(TOOLS, "../backend/functions/src/data/shapes.json"), "utf8"));
const pools = poolsFrom(data, flags, gdp, shapes);
const tierOf = new Map(data.countries.map((c) => [c.code, c.tier]));
const history = args.history ? JSON.parse(readFileSync(args.history, "utf8")).puzzles : [];

/**
 * FR-8.7 — the options of a multiple-choice challenge, from the SERVER's own
 * `buildOptions` rather than a copy of it here.
 *
 * `poolsFrom` above restates the server's pool rules because a JSON generator
 * cannot import TypeScript, and that duplication is paid for by tests on both
 * sides. Restating the option rules too would be a much worse bargain: which
 * eight flags are on offer, and which four of them are the answer's neighbours
 * (D-65), is the entire difficulty of the kind. So this reaches into the
 * compiled backend, which means `npm --prefix backend/functions run build` has
 * to have been run — hence the message rather than a stack trace.
 *
 * The generator's own seeded stream is passed in, so the schedule stays
 * byte-reproducible from seed + start + history.
 */
const require = createRequire(import.meta.url);
let KINDS_IMPL;
try {
  KINDS_IMPL = require(join(TOOLS, "../backend/functions/lib/lib/kinds.js")).KINDS;
} catch {
  console.error("build the backend first: npm --prefix backend/functions run build");
  process.exit(2);
}
const buildOptions = (kind, subject, exclude, rand) => KINDS_IMPL[kind]?.buildOptions?.(subject, exclude, rand);

const seed = Number(args.seed);
const puzzles = generate({ pools, seed, start: args.start, days: Number(args.days), history, buildOptions });

const outPath = join(TOOLS, "out", `schedule-${seed}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      "//": "GENERATED puzzle schedule — every answer. Gitignored. Regenerable from seed+start+history.",
      seed,
      start: args.start,
      days: puzzles.length,
      kindWindow: KIND_WINDOW,
      kinds: KINDS,
      weights: DEFAULT_WEIGHTS,
      countriesSource: data.sources,
      generatedAt: new Date().toISOString(),
      puzzles,
    },
    null,
    1,
  ) + "\n",
);

console.log(`✓ ${puzzles.length} days × ${KINDS.length} challenges, ${args.start} → ${puzzles.at(-1).puzzleId}, seed ${seed}`);
for (const kind of KINDS) {
  const mix = tierMix(puzzles, tierOf, kind);
  const pct = (t) => ((mix[t] ?? 0) * 100).toFixed(1).padStart(4);
  const used = new Set(puzzles.flatMap((p) => p.items.filter((i) => i.kind === kind).map((i) => i.subject)));
  console.log(`  ${kind.padEnd(7)} tier mix ${pct(1)}% /${pct(2)}% /${pct(3)}%   ${used.size} of ${pools[kind].length} countries used`);
}
console.log(`  shortest gap, same kind: ${minRepeatGap(puzzles)} days (needs ≥ ${KIND_WINDOW})`);
// D-67: no rule governs this one any more. 0 means two kinds shared a country
// on one day, which is allowed and is the cost of the single rule — reported so
// it can be read rather than guessed at.
const sameDay = puzzles.filter((p) => new Set(p.items.map((i) => i.subject)).size < p.items.length).length;
console.log(`  shortest gap, any kind:  ${minDayGap(puzzles)} days (no rule; 0 is allowed since D-67)`);
console.log(`  days where two challenges share a country: ${sameDay} of ${puzzles.length}`);
console.log(`  written: ${outPath}  — do not commit, do not share`);
