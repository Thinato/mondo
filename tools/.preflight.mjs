// Pre-flight before touching production. Reads only.
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { KINDS, KIND_WINDOW, DAY_WINDOW, itemsOf, minRepeatGap, minDayGap, poolsFrom } from "./lib/schedule.mjs";

const J = (p) => JSON.parse(readFileSync(p, "utf8"));
const sched = J("out/schedule-20260913.json").puzzles;
const countries = J("../backend/functions/src/data/countries.json");
const flags = J("../backend/functions/src/data/flags.json");
const gdp = J("../backend/functions/src/data/gdp.json");
const shapes = J("../backend/functions/src/data/shapes.json");
const pools = poolsFrom(countries, flags, gdp, shapes);
const inPool = Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, new Set(v.map((c) => c.code))]));

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fail = [];
const ok = (cond, msg) => (cond ? console.log(`  ok    ${msg}`) : (fail.push(msg), console.log(`  FAIL  ${msg}`)));

console.log(`schedule: ${sched.length} days, ${sched[0].puzzleId} → ${sched.at(-1).puzzleId}`);
ok(sched[0].puzzleId > today, `starts after today (${today}) — the open day is not touched`);
ok(sched.every((p) => p.items.length === 4), "every day has 4 challenges");
ok(sched.every((p) => new Set(p.items.map((i) => i.subject)).size === 4), "no country twice in one day");
ok(sched.every((p) => p.items.every((i) => KINDS.includes(i.kind))), "every kind is known");
ok(sched.every((p) => new Set(p.items.map((i) => i.kind)).size === 4), "one challenge of each kind per day");
for (const kind of KINDS) {
  const bad = sched.flatMap((p) => p.items.filter((i) => i.kind === kind && !inPool[kind].has(i.subject)).map((i) => `${p.puzzleId}:${i.subject}`));
  ok(bad.length === 0, `every ${kind} subject is in the ${kind} pool${bad.length ? ` — ${bad.slice(0, 5).join(" ")}` : ""}`);
}
ok(!sched.some((p) => p.items.some((i) => i.kind === "shape" && ["TV", "MH"].includes(i.subject))), "no TV/MH silhouette");

// Windows, measured across the history boundary.
initializeApp({ projectId: "lisecki-dev" });
const db = getFirestore();
const snap = await db.collection("puzzles").orderBy("puzzleId").get();
const past = snap.docs.map((d) => d.data()).filter((p) => p.puzzleId <= today)
  .map((p) => ({ puzzleId: p.puzzleId, items: itemsOf(p) }));
const joined = [...past, ...sched];
ok(minRepeatGap(joined) >= KIND_WINDOW, `same country, same kind: ${minRepeatGap(joined)} days (needs ≥ ${KIND_WINDOW})`);
ok(minDayGap(joined) >= DAY_WINDOW, `same country, any kind: ${minDayGap(joined)} days (needs ≥ ${DAY_WINDOW})`);

// Nothing seeded beyond the new schedule's reach would be orphaned.
const beyond = snap.docs.map((d) => d.id).filter((id) => id > sched.at(-1).puzzleId);
ok(beyond.length === 0, `no seeded day past the new range${beyond.length ? ` — ${beyond.join(" ")}` : ""}`);

console.log(fail.length ? `\n${fail.length} CHECK(S) FAILED — do not seed` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
