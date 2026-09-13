import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
initializeApp({ projectId: "lisecki-dev" });
const db = getFirestore();
const want = JSON.parse(readFileSync("out/schedule-20260913.json", "utf8")).puzzles;
const snap = await db.collection("puzzles").orderBy("puzzleId").get();
const got = new Map(snap.docs.map((d) => [d.id, d.data()]));
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

let mismatched = 0;
for (const p of want) {
  const g = got.get(p.puzzleId);
  if (!g || JSON.stringify(g.items) !== JSON.stringify(p.items)) mismatched++;
}
const badShapes = snap.docs.flatMap((d) =>
  (d.data().items ?? []).filter((i) => i.kind === "shape" && ["TV", "MH"].includes(i.subject)).map(() => d.id));
const todayDoc = got.get(today);

console.log(`read back ${snap.size} days in production`);
console.log(`  written days matching the generated file: ${want.length - mismatched}/${want.length}`);
console.log(`  TV/MH silhouettes anywhere: ${badShapes.length ? badShapes.join(" ") : "none"}`);
console.log(`  today (${today}) still: ${todayDoc ? todayDoc.items.map((i) => `${i.kind}=${i.subject}`).join(" ") : "MISSING"}`);
const next = want[0];
console.log(`  tomorrow (${next.puzzleId}): ${got.get(next.puzzleId).items.map((i) => `${i.kind}=${i.subject}`).join(" ")}`);
console.log(`  2026-10-08 (was MH silhouette): ${got.get("2026-10-08").items.map((i) => `${i.kind}=${i.subject}`).join(" ")}`);
