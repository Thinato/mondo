#!/usr/bin/env node
// Flag build: a vendored public-domain SVG set → the one file the `flag` kind
// serves from. Offline, deterministic, committed. OQ-11; 06-tournaments.md §5.3.
//
// Outputs
//   backend/functions/src/data/flags.json   server: flat path list per country
//   tools/flags-preview.html                human review grid (gitignored)
//
// The client never receives this file. `getRound`-style inlining applies: one
// flag per challenge, with no code, name or filename beside it (SEC-1, SEC-2).
//
// Two rules drop a country from the flag pool, and both are printed:
//   1. The artwork needs something the wire format cannot carry (a gradient, a
//      clip under a transform). Refused by lib/flag.mjs.
//   2. It is over the byte budget, or it is on the SEC-1 exclusion list in
//      tools/flags.json because the artwork spells the country's own name.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildFlag, UnsupportedFlag } from "./lib/flag.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const write = (p, data) => {
  mkdirSync(dirname(join(ROOT, p)), { recursive: true });
  writeFileSync(join(ROOT, p), data);
};

// ---------------------------------------------------------------------------
// Budgets. A card is played one item at a time (card.ts), so the per-flag cap
// is the per-response cap. 40 KB sits in the gap the data itself leaves —
// Portugal's armillary sphere is the last flag under it at 36 KB and Oman's
// is the first over it at 47 KB — rather than at a round number that would cut
// through the middle of the distribution. The total is what a tournament
// function parses on a cold start; `flags.json` is imported by kinds.ts, which
// the daily does not touch (D-45), so the daily round pays none of it.
//
// The per-flag cap also does the SEC-1 work almost by itself: every flag whose
// artwork spells its own country's name — Bolivia, Costa Rica, the Dominican
// Republic, El Salvador, Guatemala, Nicaragua, Paraguay, Peru, Afghanistan —
// carries a coat of arms, and the emblem detail is exactly the weight. What is
// left over goes in tools/flags.json by hand.
// ---------------------------------------------------------------------------
const MAX_FLAG_BYTES = 40 * 1024;
const MAX_TOTAL_BYTES = 800 * 1024;
const MIN_POOL = 150; // below this something in the converter regressed; fail the build

const SET = "svg-country-flags";
const SVG_DIR = join(TOOLS, "node_modules", SET, "svg");

const pool = Object.keys(read("tools/include.json").countries);
const { exclude } = read("tools/flags.json");
const countries = read("backend/functions/src/data/countries.json").countries;
const nameOf = Object.fromEntries(countries.map((c) => [c.code, c.names["pt-BR"]]));

const flags = {};
const dropped = [];

for (const code of pool) {
  if (exclude[code]) {
    dropped.push({ code, why: `excluded: ${exclude[code]}` });
    continue;
  }
  let source;
  try {
    source = readFileSync(join(SVG_DIR, `${code.toLowerCase()}.svg`), "utf8");
  } catch {
    dropped.push({ code, why: `${SET} has no ${code.toLowerCase()}.svg` });
    continue;
  }
  let flag;
  try {
    flag = buildFlag(source);
  } catch (err) {
    if (!(err instanceof UnsupportedFlag)) throw err;
    dropped.push({ code, why: err.message });
    continue;
  }
  const bytes = Buffer.byteLength(JSON.stringify(flag));
  if (bytes > MAX_FLAG_BYTES) {
    dropped.push({ code, why: `${(bytes / 1024).toFixed(1)} KB over the ${MAX_FLAG_BYTES / 1024} KB budget` });
    continue;
  }
  flags[code] = flag;
}

const kept = Object.keys(flags).sort();
const out = {
  "//": `Flag artwork per country, flattened to filled paths by tools/build-flags.mjs from ${SET}. Server-only (SEC-1): one flag is inlined per challenge and the client never sees this file. Do not edit by hand.`,
  source: { set: SET, version: read(`tools/node_modules/${SET}/package.json`).version, license: "Public domain (Wikimedia-derived). See NOTICE." },
  flags: Object.fromEntries(kept.map((c) => [c, flags[c]])),
};
const json = JSON.stringify(out, null, 0);
const total = Buffer.byteLength(json);

// ---------------------------------------------------------------------------
// Report and gates
// ---------------------------------------------------------------------------
console.log(`flags: kept ${kept.length} of ${pool.length}, ${(total / 1024).toFixed(0)} KB total`);
const widest = kept.map((c) => [c, Buffer.byteLength(JSON.stringify(flags[c]))]).sort((a, b) => b[1] - a[1]);
console.log(`heaviest: ${widest.slice(0, 5).map(([c, n]) => `${c} ${(n / 1024).toFixed(1)}KB`).join(", ")}`);
console.log(`dropped ${dropped.length}:`);
for (const { code, why } of dropped.sort((a, b) => a.code.localeCompare(b.code))) {
  console.log(`  ${code} ${(nameOf[code] ?? "?").padEnd(24)} ${why}`);
}

if (total > MAX_TOTAL_BYTES) throw new Error(`flags.json is ${(total / 1024).toFixed(0)} KB, over the ${MAX_TOTAL_BYTES / 1024} KB cap`);
if (kept.length < MIN_POOL) throw new Error(`only ${kept.length} flags survived; the pool floor is ${MIN_POOL}`);

write("backend/functions/src/data/flags.json", json + "\n");

// ---------------------------------------------------------------------------
// Preview grid: gitignored, for a human to eyeball (D-17's precedent). It is
// the only place a flag appears next to its country's name.
// ---------------------------------------------------------------------------
const svgOf = (flag, code) =>
  `<svg viewBox="${flag.viewBox}" preserveAspectRatio="xMidYMid meet"><clipPath id="box${code}"><path d="M${flag.viewBox.split(/[\s,]+/)[0]} ${flag.viewBox.split(/[\s,]+/)[1]}h${flag.viewBox.split(/[\s,]+/)[2]}v${flag.viewBox.split(/[\s,]+/)[3]}h-${flag.viewBox.split(/[\s,]+/)[2]}z"/></clipPath><g clip-path="url(#box${code})">${flag.paths
    .map((p, i) => {
      const clip = p.clip ? `<clipPath id="c${code}${i}"><path d="${p.clip}"/></clipPath>` : "";
      const attrs = Object.entries(p)
        .filter(([k]) => k !== "clip")
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}="${escapeAttr(v)}"`)
        .join(" ");
      return `${clip}<path ${attrs}${p.clip ? ` clip-path="url(#c${code}${i})"` : ""}/>`;
    })
    .join("")}</g></svg>`;

const escapeText = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const escapeAttr = (v) => escapeText(v).replace(/"/g, "&quot;");

write(
  "tools/flags-preview.html",
  `<!doctype html><meta charset="utf-8"><title>Mondo — flag build review</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}
h1{font-size:16px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
figure{margin:0}svg{width:100%;height:120px;background:#222;border:1px solid #333}
figcaption{font-size:12px;padding-top:4px;color:#aaa}
.dropped{margin-top:32px;font-size:12px;color:#f8a}.dropped li{margin:2px 0}</style>
<h1>${kept.length} flags kept — check for a coat of arms that spells the country's name (SEC-1), and for artwork the converter mangled</h1>
<div class="grid">${kept.map((c) => `<figure>${svgOf(flags[c], c)}<figcaption>${c} · ${nameOf[c] ?? "?"}</figcaption></figure>`).join("")}</div>
<ul class="dropped"><li><b>dropped ${dropped.length}</b></li>${dropped.map(({ code, why }) => `<li>${code} ${nameOf[code] ?? "?"} — ${escapeText(why)}</li>`).join("")}</ul>
`,
);
console.log("preview: tools/flags-preview.html");
