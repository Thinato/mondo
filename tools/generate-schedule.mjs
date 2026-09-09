#!/usr/bin/env node
// Generate the puzzle schedule. See 03-geo-data-pipeline.md §6.
//
//   node generate-schedule.mjs --seed 20260908 --start 2026-09-15 [--days 365] [--history out/schedule-<old>.json]
//
// Output: tools/out/schedule-<seed>.json — EVERY ANSWER FOR A YEAR. tools/out/ is
// gitignored (CLAUDE.md invariant 8). Never move this file anywhere public.
// Seed it into Firestore with seed-schedule.mjs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generate, tierMix, minRepeatGap, DEFAULT_WEIGHTS } from "./lib/schedule.mjs";

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
const countries = data.countries.map((c) => ({ code: c.code, tier: c.tier }));
const history = args.history ? JSON.parse(readFileSync(args.history, "utf8")).puzzles : [];

const seed = Number(args.seed);
const puzzles = generate({ countries, seed, start: args.start, days: Number(args.days), history });

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
      windowDays: 180,
      weights: DEFAULT_WEIGHTS,
      countriesSource: data.sources,
      generatedAt: new Date().toISOString(),
      puzzles,
    },
    null,
    1,
  ) + "\n",
);

const mix = tierMix(puzzles);
const pct = (t) => ((mix[t] ?? 0) * 100).toFixed(1).padStart(4);
console.log(`✓ ${puzzles.length} puzzles, ${args.start} → ${puzzles.at(-1).puzzleId}, seed ${seed}`);
console.log(`  tier mix 1/2/3: ${pct(1)}% / ${pct(2)}% / ${pct(3)}%   (target 50 / 35 / 15)`);
console.log(`  shortest repeat gap: ${minRepeatGap(puzzles)} days (FR-2.3 requires ≥ 180)`);
console.log(`  distinct countries: ${new Set(puzzles.map((p) => p.countryCode)).size} of ${countries.length}`);
console.log(`  written: ${outPath}  — do not commit, do not share`);
