#!/usr/bin/env node
// Shuffle the boards of every day that has not opened yet (D-86, FR-8.7).
//
//   node shuffle-boards.mjs --emulator                       # dry run
//   node shuffle-boards.mjs --project lisecki-dev            # dry run
//   node shuffle-boards.mjs --project lisecki-dev --apply    # write
//
// Until 2026-10-08 the generator seeded every flagPick and shapePick board with
// the answer at option 1. This repairs the days still to come IN PLACE: each
// board's eight options are put in a random order and nothing else on the day
// changes — not the subjects, not the distractors, not the play order — so no
// regeneration and no reseed, and the schedule's one rule (FR-2.3) is untouched.
//
// The open day and every day before it are left alone ON PURPOSE. A guess at a
// board is an index (D-64) and is graded against the options stored on the
// puzzle, so reordering a board someone already has on screen would score their
// click against a different flag. For the same reason this refuses to run within
// 15 minutes of noon, when the next day opens.
//
// Random from node:crypto, not a seed: a repair has nothing to reproduce, and an
// order nobody can recompute is the point. Re-running it only reshuffles days
// nobody has seen. Production uses Application Default Credentials (SEC-10).

import { randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { boardProblems } from "./lib/schedule.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let puzzleIdAt;
try {
  ({ puzzleIdAt } = require(join(TOOLS, "../backend/functions/lib/lib/puzzle-day.js")));
} catch {
  console.error("build the backend first: npm --prefix backend/functions run build");
  process.exit(2);
}

const { values: args } = parseArgs({
  options: {
    project: { type: "string" },
    emulator: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
  },
});
if (!args.emulator && !args.project) {
  console.error("usage: shuffle-boards.mjs (--emulator | --project <gcp-project>) [--apply]");
  process.exit(2);
}
if (args.emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(`FIRESTORE_EMULATOR_HOST is set (${process.env.FIRESTORE_EMULATOR_HOST}); pass --emulator or unset it`);
  process.exit(2);
}

// The day that is open now, by the server's own rule (noon, São Paulo).
const now = new Date();
const today = puzzleIdAt(now);
if (puzzleIdAt(new Date(now.getTime() + 15 * 60_000)) !== today) {
  console.error(`refusing: the next day opens within 15 minutes — run this after noon São Paulo time.`);
  process.exit(2);
}

const projectId = args.emulator ? (args.project ?? "demo-mondo") : args.project;
initializeApp({ projectId });
const db = getFirestore();

const days = (await db.collection("puzzles").where("puzzleId", ">", today).get()).docs;
const changed = [];
for (const snap of days) {
  const day = snap.data();
  let touched = false;
  const items = (day.items ?? []).map((item) => {
    if (!item.options) return item;
    touched = true;
    const options = [...item.options];
    for (let i = options.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { ...item, options };
  });
  if (touched) changed.push({ ref: snap.ref, puzzleId: day.puzzleId, before: day.items, items });
}

const at = (list) => {
  const h = new Array(8).fill(0);
  for (const c of list) for (const it of c) if (it.options) h[it.options.indexOf(it.subject)]++;
  return h.join(" ");
};
console.log(`open day: ${today} (left alone). Days after it with boards: ${changed.length}, ${changed[0]?.puzzleId ?? "-"} → ${changed.at(-1)?.puzzleId ?? "-"}`);
console.log(`answer at options 1..8, before: ${at(changed.map((c) => c.before))}`);
console.log(`answer at options 1..8, after:  ${at(changed.map((c) => c.items))}`);

// The same gate the generator and the seeder use, on what is about to be written.
const problems = boardProblems(changed.map((c) => ({ puzzleId: c.puzzleId, items: c.items })));
if (problems.length > 0) {
  console.error(`refusing: ${problems.join("; ")}`);
  process.exit(2);
}
if (!args.apply) {
  console.log("dry run — nothing written. Re-run with --apply to write.");
  process.exit(0);
}
for (let i = 0; i < changed.length; i += 400) {
  const batch = db.batch();
  for (const c of changed.slice(i, i + 400)) batch.update(c.ref, { items: c.items });
  await batch.commit();
}
console.log(`wrote ${changed.length} day(s).`);
