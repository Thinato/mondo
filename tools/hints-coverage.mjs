#!/usr/bin/env node
// How much of the pool the learning hints reach (FR-14, D-101).
//
//   cd backend/functions && npm run build && cd ../../tools && node hints-coverage.mjs
//
// Reads the server's own engine from backend/functions/lib/ (as generate-schedule
// does), so "covered" means exactly what a player would see after a challenge.
// Prints, per topic, how many countries get at least one WRITTEN hint and the
// ones that do not — the to-do list for the catalogue. A `person` country counts
// as covered when at least one of its people would get a hint; `gdp`'s computed
// line reaches everyone and is not counted.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lib = (name) => require(join(TOOLS, "../backend/functions/lib/lib", `${name}.js`));
const { KINDS } = lib("kinds");
const { hintsFor, gdpHint } = lib("hints");
const { peopleFor } = lib("countries");

const NONE = new Set();
const written = (item) => {
  const computed = item.kind === "gdp" ? gdpHint(item.subject)?.title : undefined;
  return hintsFor(item, NONE).filter((h) => h.title !== computed).length;
};

for (const kind of ["flag", "shape", "capital", "gdp", "person"]) {
  const pool = KINDS[kind].pool();
  const missing = pool.filter((c) =>
    kind === "person"
      ? !peopleFor(c.code).some((p) => written({ kind, subject: c.code, person: p.wd }) > 0)
      : written({ kind, subject: c.code }) === 0,
  );
  const covered = pool.length - missing.length;
  console.log(`${kind.padEnd(8)} ${String(covered).padStart(3)} of ${pool.length} (${Math.round((100 * covered) / pool.length)}%)`);
  console.log(`         missing: ${missing.map((c) => c.code).join(" ")}`);
}
