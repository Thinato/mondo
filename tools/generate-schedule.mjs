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
import { generate, poolsFrom, tierMix, minRepeatGap, minDayGap, DEFAULT_WEIGHTS, KINDS, KIND_WINDOW, DAY_WINDOW } from "./lib/schedule.mjs";

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
const pools = poolsFrom(data, flags);
const tierOf = new Map(data.countries.map((c) => [c.code, c.tier]));
const history = args.history ? JSON.parse(readFileSync(args.history, "utf8")).puzzles : [];

const seed = Number(args.seed);
const puzzles = generate({ pools, seed, start: args.start, days: Number(args.days), history });

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
      dayWindow: DAY_WINDOW,
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
console.log(`  shortest gap, any kind:  ${minDayGap(puzzles)} days (needs ≥ ${DAY_WINDOW})`);
console.log(`  written: ${outPath}  — do not commit, do not share`);
