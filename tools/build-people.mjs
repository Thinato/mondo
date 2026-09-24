#!/usr/bin/env node
// People build: Pantheon + Wikidata + Wikimedia Commons → the one file the
// `person` kind serves from (FR-8.8, D-78).
//
//   node build-people.mjs [--depth 20000] [--per-country 8] [--min-hpi 30] [--width 400]
//
// Output: backend/functions/src/data/people.json — server-only, committed.
//
// Like the GDP build this one reads the network, and for the same reason: three
// APIs are the source and the vendored OUTPUT is what ships, so every person
// the game asks about is in git where a human can read the diff. Nothing here
// runs at request time. The PHOTOS are the exception to "vendored": they are
// hotlinked from Commons at play time (D-78), so what is committed is a URL.
//
// Three passes, because each API answers a different question:
//   1. Pantheon  — who is worth asking about, and where were they born
//   2. Wikidata  — which photo is theirs (P18), and what is their name in pt
//   3. Commons   — may we show that photo, and who gets the credit
//
// **What is deliberately NOT copied into the output**: Pantheon's `description`
// ("Turkish actor and fashion model"), which is the answer written out, and the
// occupation, which buys nothing. See lib/people.mjs.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { birthPlace, creditFrom, displayLicence, keepBest, photoUrl, vet } from "./lib/people.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const write = (p, data) => {
  mkdirSync(dirname(join(ROOT, p)), { recursive: true });
  writeFileSync(join(ROOT, p), data);
};

const { values: args } = parseArgs({
  options: {
    depth: { type: "string", default: "20000" },
    "per-country": { type: "string", default: "8" },
    "min-hpi": { type: "string", default: "30" },
    width: { type: "string", default: "400" },
  },
});
const DEPTH = Number(args.depth);
const PER_COUNTRY = Number(args["per-country"]);
const MIN_HPI = Number(args["min-hpi"]);
const WIDTH = Number(args.width);

/** A country needs one usable person to be in the pool, and the pool needs to
 *  clear D-67's window. This floor is far above that, so a collapse in coverage
 *  fails the build instead of quietly shrinking the kind. */
const MIN_POOL = 120;
/** How many candidates to vet per country. Vetting is two API calls per 50
 *  people, so the slack is nearly free and every rejection has a replacement. */
const CANDIDATES = 16;
const UA = "mondo-build/0.1 (https://lisecki.dev/mondo; github.com/Thinato/mondo)";
const ISO3_OVERRIDES = { XK: "XKX" };

const countries = read("backend/functions/src/data/countries.json").countries;
/** Words that reveal a country without being its name — England for the United
 *  Kingdom, Persia for Iran. Keyed per country ON PURPOSE: the same word points
 *  AWAY from the answer for someone born elsewhere, and those are the questions
 *  worth asking. See tools/people-aliases.json. */
const aliases = read("tools/people-aliases.json");
const aliasesFor = (code) => aliases[code]?.words ?? [];
const byIso3 = new Map(countries.map((c) => [ISO3_OVERRIDES[c.code] ?? c.code3, c]));

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// --- 1. Pantheon: who, and where were they born ------------------------------

const pantheonCountries = await getJson("https://api.pantheon.world/country?select=id,country_code,demonym");
/** Pantheon names its countries ("Türkiye"); we key on ISO-3 like everything else. */
const iso3Of = new Map(pantheonCountries.map((c) => [c.id, (c.country_code ?? "").toUpperCase()]));
const demonymOf = new Map(pantheonCountries.map((c) => [c.id, c.demonym ?? ""]));

const ranked = await getJson(
  `https://api.pantheon.world/person_ranks?select=id,name,hpi,bplace_country,bplace_name,birthyear&rank=lte.${DEPTH}&order=hpi.desc`,
);
console.log(`pantheon: ${ranked.length} ranked people, depth ${DEPTH}`);

/** code → candidates, best first. Countries we do not ask about (territories,
 *  and the ones `include.json` drops) never enter the map at all. */
const byCountry = new Map();
const unmatched = new Set();
for (const p of ranked) {
  if (!p.bplace_country || p.hpi < MIN_HPI) continue;
  const iso3 = iso3Of.get(p.bplace_country);
  const country = iso3 ? byIso3.get(iso3) : undefined;
  if (!country) {
    if (!iso3) unmatched.add(p.bplace_country);
    continue;
  }
  const list = byCountry.get(country.code) ?? [];
  if (list.length < CANDIDATES) {
    list.push({
      id: p.id,
      name: p.name,
      hpi: Math.round(p.hpi * 10) / 10,
      bplace: p.bplace_name ?? null,
      birthyear: p.birthyear ?? null,
      demonym: demonymOf.get(p.bplace_country) ?? "",
    });
  }
  byCountry.set(country.code, list);
}
const candidates = [...byCountry.values()].flat();
console.log(`  ${byCountry.size} of our ${countries.length} countries have candidates (${candidates.length} people to vet)`);
if (unmatched.size > 0) console.log(`  birthplaces with no ISO-3 in Pantheon's country table: ${[...unmatched].join(", ")}`);

// Pantheon's rank view has no Wikidata id; the `person` table does, keyed the same.
const wdById = new Map();
for (const batch of chunks(candidates.map((c) => c.id), 200)) {
  const rows = await getJson(`https://api.pantheon.world/person?select=id,wd_id&id=in.(${batch.join(",")})`);
  for (const r of rows) wdById.set(r.id, r.wd_id);
}
for (const c of candidates) c.wd = wdById.get(c.id) ?? null;

// --- 2. Wikidata: the photo, and the name in Portuguese ----------------------

const entities = new Map();
for (const batch of chunks(candidates.filter((c) => c.wd).map((c) => c.wd), 50)) {
  const url =
    "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|labels&languages=pt|pt-br" +
    `&ids=${batch.join("|")}`;
  const { entities: got = {} } = await getJson(url);
  for (const [qid, e] of Object.entries(got)) entities.set(qid, e);
}
for (const c of candidates) {
  const e = c.wd ? entities.get(c.wd) : undefined;
  c.file = e?.claims?.P18?.[0]?.mainsnak?.datavalue?.value ?? null;
  // The game is in pt-BR and Pantheon's names are English Wikipedia titles, so
  // "Pope John Paul II" would be asked of a Brazilian as "Papa João Paulo II"
  // only if Wikidata has the label. Where it does not, the English title is
  // what the player would meet on Wikipedia anyway.
  const labels = e?.labels ?? {};
  c.name = labels["pt-br"]?.value ?? labels.pt?.value ?? c.name;
}
console.log(`wikidata: ${candidates.filter((c) => c.file).length} of ${candidates.length} candidates have a P18 photo`);

// --- 3. Commons: may we show it, and who gets the credit ---------------------

const files = [...new Set(candidates.filter((c) => c.file).map((c) => `File:${c.file}`))];
const meta = new Map();
for (const batch of chunks(files, 50)) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=extmetadata" +
    `&titles=${batch.map((t) => encodeURIComponent(t)).join("|")}`;
  const { query } = await getJson(url);
  for (const page of Object.values(query?.pages ?? {})) {
    const em = page.imageinfo?.[0]?.extmetadata;
    // TWO licence fields, and they are not interchangeable. `License` is the
    // machine value ("pd", "cc-by-sa-4.0") and is what the filter must read;
    // `LicenseShortName` is the human one ("Public domain") and is what the
    // credit line shows. Reading them the wrong way round rejects every
    // public-domain photo in the set — which is most of the historical ones.
    if (em) {
      meta.set(page.title, {
        licence: em.License?.value ?? "",
        label: em.LicenseShortName?.value ?? em.License?.value ?? "",
        artist: em.Artist?.value ?? "",
      });
    }
  }
}

// --- vet, keep the best, write -----------------------------------------------

const people = {};
const rejected = [];
for (const [code, list] of byCountry) {
  const country = countries.find((c) => c.code === code);
  const kept = [];
  for (const c of list) {
    const m = c.file ? meta.get(`File:${c.file}`) : undefined;
    const credit = creditFrom(m?.artist);
    const why = vet({ ...c, licence: m?.licence ?? "", credit }, country, aliasesFor(code));
    if (why) {
      rejected.push(`${code} ${c.name}: ${why}`);
      continue;
    }
    kept.push({
      name: c.name,
      wd: c.wd,
      photo: photoUrl(c.file, WIDTH),
      credit,
      licence: displayLicence(m.label),
      bplace: birthPlace(c.bplace, country, aliasesFor(code)),
      birthyear: c.birthyear,
      hpi: c.hpi,
    });
  }
  if (kept.length > 0) people[code] = keepBest(kept, PER_COUNTRY);
}

const pool = Object.keys(people).sort();
const out = {
  "//":
    "People and birthplaces from Pantheon, photos hotlinked from Wikimedia Commons. Generated by tools/build-people.mjs. " +
    "Server-only: the birthplace IS the answer. Do not edit by hand, and never copy a description or an occupation in here.",
  sources: [
    { name: "Pantheon (MIT Media Lab)", url: "https://pantheon.world/data/api", license: "CC BY-SA 4.0. See NOTICE." },
    { name: "Wikidata (P18)", url: "https://www.wikidata.org", license: "CC0 1.0. See NOTICE." },
    { name: "Wikimedia Commons", url: "https://commons.wikimedia.org", license: "per file; each entry carries its own credit and licence." },
  ],
  retrievedAt: new Date().toISOString().slice(0, 10),
  params: { depth: DEPTH, perCountry: PER_COUNTRY, minHpi: MIN_HPI, width: WIDTH },
  people: Object.fromEntries(pool.map((c) => [c, people[c]])),
};

const total = pool.reduce((n, c) => n + people[c].length, 0);
const licences = {};
for (const c of pool) for (const p of people[c]) licences[p.licence] = (licences[p.licence] ?? 0) + 1;
const missing = countries.filter((c) => !people[c.code]);

console.log(`people: ${total} people across ${pool.length} of ${countries.length} countries`);
console.log(`  licences: ${Object.entries(licences).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(", ")}`);
console.log(`  rejected ${rejected.length}; first 10:`);
for (const r of rejected.slice(0, 10)) console.log(`    ${r}`);
console.log(`  no usable person for ${missing.length}: ${missing.map((c) => c.names["pt-BR"]).join(", ")}`);

if (pool.length < MIN_POOL) throw new Error(`only ${pool.length} countries have a person; the floor is ${MIN_POOL}`);

write("backend/functions/src/data/people.json", JSON.stringify(out, null, 0) + "\n");
console.log("  written: backend/functions/src/data/people.json");
