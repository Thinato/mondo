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

initializeApp({ projectId });
const db = getFirestore();

const BATCH = 400; // Firestore caps a batch at 500 writes
let written = 0;
for (let i = 0; i < puzzles.length; i += BATCH) {
  const batch = db.batch();
  for (const p of puzzles.slice(i, i + BATCH)) {
    batch.set(db.collection("puzzles").doc(p.puzzleId), {
      puzzleId: p.puzzleId,
      countryCode: p.countryCode,
      tier: p.tier,
      opensAt: Timestamp.fromDate(new Date(p.opensAt)),
    });
  }
  await batch.commit();
  written += Math.min(BATCH, puzzles.length - i);
}

const target = args.emulator ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : `project ${projectId}`;
console.log(`✓ ${written} puzzles written to ${target}: ${puzzles[0].puzzleId} → ${puzzles.at(-1).puzzleId}`);
