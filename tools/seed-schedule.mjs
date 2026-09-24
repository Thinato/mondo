#!/usr/bin/env node
// Upload a generated schedule into the `puzzles` collection (02-architecture.md §3.2).
//
//   node seed-schedule.mjs --file out/schedule-<seed>.json --emulator
//   node seed-schedule.mjs --file out/schedule-<seed>.json --project lisecki-dev
//
// Production runs use Application Default Credentials from
// `gcloud auth application-default login` — no key file, ever (SEC-10, D-20).
// Writes are idempotent: the document ID is the puzzleId, so re-running with the
// same schedule changes nothing and re-running with a regenerated one overwrites.
// `puzzles` has no client read access at any time (SEC-7); only the Admin SDK
// ever touches it.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const { values: args } = parseArgs({
  options: {
    file: { type: "string" },
    project: { type: "string" },
    emulator: { type: "boolean", default: false },
  },
});
if (!args.file || (!args.emulator && !args.project)) {
  console.error("usage: seed-schedule.mjs --file <schedule.json> (--emulator | --project <gcp-project>)");
  process.exit(2);
}

if (args.emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  // Refuse the ambiguous case: --project named, but the environment would send
  // the writes to an emulator. Say which one you mean.
  console.error(`FIRESTORE_EMULATOR_HOST is set (${process.env.FIRESTORE_EMULATOR_HOST}); pass --emulator or unset it`);
  process.exit(2);
}

const projectId = args.emulator ? (args.project ?? "demo-mondo") : args.project;
const { puzzles } = JSON.parse(readFileSync(args.file, "utf8"));

// ---------------------------------------------------------------------------
// Pre-flight: build every prompt this file would serve, against the SERVER's
// own kinds, before a single document is written.
//
// This is the last gate in front of production and it used to have none — the
// seeder copied `items` through and found out at noon. Two outages came out of
// that gap: D-66 nearly seeded a kind the deployed backend had never heard of,
// and on 2026-09-24 every `person` item went out with no person on it, because
// the generator was never taught D-78's `buildDetail`. Both are the same shape
// — an item that is well-formed JSON and unservable — and both are caught by
// asking the only question that matters: does this item make a prompt?
//
// It is deliberately not a schema check. A schema would have to be kept in step
// with `kinds.ts` by hand, which is the very thing that failed; `prompt()` IS
// the specification, so it is what runs here. It costs one pass over the file
// and needs the backend built, same as the generator.
const require = createRequire(import.meta.url);
const TOOLS = dirname(fileURLToPath(import.meta.url));
let KINDS_IMPL;
try {
  KINDS_IMPL = require(join(TOOLS, "../backend/functions/lib/lib/kinds.js")).KINDS;
} catch {
  console.error("build the backend first: npm --prefix backend/functions run build");
  process.exit(2);
}
const problems = [];
for (const p of puzzles) {
  for (const item of p.items ?? []) {
    const kind = KINDS_IMPL[item.kind];
    if (!kind) { problems.push(`${p.puzzleId}: the backend does not ship the kind "${item.kind}"`); continue; }
    try {
      kind.prompt(item);
    } catch (err) {
      problems.push(`${p.puzzleId}: ${item.kind}/${item.subject} builds no prompt — ${err.message}`);
    }
  }
}
if (problems.length > 0) {
  console.error(`refusing to seed: ${problems.length} item(s) the deployed server cannot serve\n`);
  for (const line of problems.slice(0, 10)) console.error(`  ${line}`);
  if (problems.length > 10) console.error(`  … and ${problems.length - 10} more`);
  process.exit(2);
}
console.log(`✓ pre-flight: ${puzzles.length} days, every item builds a prompt`);

initializeApp({ projectId });
const db = getFirestore();

const BATCH = 400; // Firestore caps a batch at 500 writes
let written = 0;
for (let i = 0; i < puzzles.length; i += BATCH) {
  const batch = db.batch();
  for (const p of puzzles.slice(i, i + BATCH)) {
    batch.set(db.collection("puzzles").doc(p.puzzleId), {
      puzzleId: p.puzzleId,
      // D-52: a day is a list of challenges. `countryCode` and `tier` are NOT
      // written any more; days seeded before the switch keep theirs and still
      // play, as one silhouette (lib/round.ts `puzzleItems`).
      items: p.items,
      opensAt: Timestamp.fromDate(new Date(p.opensAt)),
    });
  }
  await batch.commit();
  written += Math.min(BATCH, puzzles.length - i);
}

const target = args.emulator ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : `project ${projectId}`;
console.log(`✓ ${written} puzzles written to ${target}: ${puzzles[0].puzzleId} → ${puzzles.at(-1).puzzleId}`);
