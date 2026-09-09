#!/usr/bin/env node
// Set a player's role (FR-7.1). This is the ONLY way anyone becomes admin (D-29);
// the setRole callable hands out organizer/player from the dashboard.
//
//   node set-role.mjs --uid <uid> --role admin --emulator
//   node set-role.mjs --uid <uid> --role admin --project lisecki-dev
//
// Production runs use Application Default Credentials from
// `gcloud auth application-default login` — no key file, ever (SEC-10, D-20).
// The write is a merge, so the profile keeps everything else. The profile must
// already exist (one sign-in creates it): a role-only document would look like a
// profile to the functions but have no display name or counters.

import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const ROLES = ["admin", "organizer", "player"];

const { values: args } = parseArgs({
  options: {
    uid: { type: "string" },
    role: { type: "string" },
    project: { type: "string" },
    emulator: { type: "boolean", default: false },
  },
});
if (!args.uid || !ROLES.includes(args.role) || (!args.emulator && !args.project)) {
  console.error("usage: set-role.mjs --uid <uid> --role admin|organizer|player (--emulator | --project <gcp-project>)");
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
const ref = getFirestore().doc(`users/${args.uid}`);
const before = await ref.get();
if (!before.exists) {
  console.error(`users/${args.uid} does not exist in ${projectId}; sign in once first so the profile is created.`);
  process.exit(1);
}
await ref.set({ role: args.role }, { merge: true });
console.log(`updated users/${args.uid}: role ${before.data()?.role ?? "(none)"} → ${args.role} in ${projectId}`);
