#!/usr/bin/env node
// Rewrite every pre-D-84 role to its tier, once (FR-10.1, D-84).
//
//   node migrate-tiers.mjs --emulator                       # dry run
//   node migrate-tiers.mjs --project lisecki-dev            # dry run
//   node migrate-tiers.mjs --project lisecki-dev --apply    # write
//
//   organizer                 → invited
//   player in ≥ 1 group       → invited   (somebody let them in)
//   player in no group        → user      (signed in, never let in)
//   no role (Phase 1 profile) → as player
//
// This is what makes Invited a closed list. Until it runs, the server reads the
// legacy values with that same mapping, so a `player` who joins a group in the
// meantime would read as invited; once it runs, nothing legacy is left and a
// user who joins stays a user. So: deploy, then run this straight away.
//
// The mapping is not restated here. It is `roleOf` from the compiled backend —
// the very function the server reads profiles with — so the script and the
// live fallback cannot disagree (the same bargain D-66 struck for the
// schedule). That needs `npm --prefix backend/functions run build` first.
//
// Production uses Application Default Credentials (`gcloud auth
// application-default login`), never a key file (SEC-10). Idempotent: a second
// run finds nothing to change. Prints uids and display names, never e-mails.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let roleOf;
try {
  ({ roleOf } = require(join(TOOLS, "../backend/functions/lib/lib/authz.js")));
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
  console.error("usage: migrate-tiers.mjs (--emulator | --project <gcp-project>) [--apply]");
  process.exit(2);
}
if (args.emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(`FIRESTORE_EMULATOR_HOST is set (${process.env.FIRESTORE_EMULATOR_HOST}); pass --emulator or unset it`);
  process.exit(2);
}

const projectId = args.emulator ? (args.project ?? "demo-mondo") : args.project;
initializeApp({ projectId });
const db = getFirestore();

const changes = [];
const counts = {};
for (const snap of (await db.collection("users").get()).docs) {
  const p = snap.data();
  const to = roleOf(p);
  const from = p.role ?? "(none)";
  if (from === to) continue;
  changes.push({ ref: snap.ref, uid: snap.id, name: p.displayName, from, to, groups: (p.groups ?? []).length });
  counts[`${from} → ${to}`] = (counts[`${from} → ${to}`] ?? 0) + 1;
}

for (const c of changes) console.log(`${c.uid}  ${String(c.name).padEnd(24)}  groups=${c.groups}  ${c.from} → ${c.to}`);
console.log(`\n${changes.length} profile(s) to change in ${projectId}:`, counts);

if (!args.apply) {
  console.log("dry run — nothing written. Re-run with --apply to write.");
  process.exit(0);
}
for (let i = 0; i < changes.length; i += 400) {
  const batch = db.batch();
  for (const c of changes.slice(i, i + 400)) batch.update(c.ref, { role: c.to });
  await batch.commit();
}
console.log(`wrote ${changes.length} profile(s).`);
