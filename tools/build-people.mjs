#!/usr/bin/env node
// People build: Pantheon + Wikidata + Wikimedia Commons → the one file the
// `person` kind serves from (FR-8.8, D-78).
//
//   node build-people.mjs [--depth 20000] [--per-country 8] [--min-hpi 30] [--width 400]
//   node build-people.mjs --only-about        # add D-81's bios to the file that exists
//
// Output: backend/functions/src/data/people.json — server-only, committed.
//
// Like the GDP build this one reads the network, and for the same reason: three
// APIs are the source and the vendored OUTPUT is what ships, so every person
// the game asks about is in git where a human can read the diff. Nothing here
// runs at request time. The PHOTOS are the exception to "vendored": they are
// hotlinked from Commons at play time (D-78), so what is committed is a URL.
//
// Four passes, because each API answers a different question:
//   1. Pantheon  — who is worth asking about, and where were they born
//   2. Wikidata  — which photo is theirs (P18), their name in pt, their article
//   3. Commons   — may we show that photo, and who gets the credit
//   4. Wikipedia — one paragraph on who they were, for the REVEAL only (D-81)
//
// **What is deliberately NOT copied into the output**: Pantheon's `description`
// ("Turkish actor and fashion model"), which is the answer written out, and the
// occupation, which buys nothing. See lib/people.mjs.
//
// Pass 4 is the exception that proves that rule, and the reason it is safe is
// the PATH and not the text. `about` opens "foi uma condessa húngara" — it is
// the answer, stated more plainly than the description ever did. It may only
// travel inside a `Reveal`, beside `bplace`, and `kinds.ts` is where that is
// enforced: the `person` prompt is pinned to exactly four keys by a test, so
// this field cannot reach an open challenge without that test going red.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { birthPlace, creditFrom, displayLicence, keepBest, leadParagraph, photoUrl, vet } from "./lib/people.mjs";

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
    "only-about": { type: "boolean", default: false },
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

const SOURCES = [
  { name: "Pantheon (MIT Media Lab)", url: "https://pantheon.world/data/api", license: "CC BY-SA 4.0. See NOTICE." },
  { name: "Wikidata (P18)", url: "https://www.wikidata.org", license: "CC0 1.0. See NOTICE." },
  { name: "Wikimedia Commons", url: "https://commons.wikimedia.org", license: "per file; each entry carries its own credit and licence." },
  { name: "Wikipédia (pt)", url: "https://pt.wikipedia.org", license: "CC BY-SA 4.0. See NOTICE — the reveal links the article and names the licence." },
];

/** How long a bio may be. Long enough for who someone was, short enough to sit
 *  under a photograph on a phone without becoming the screen. */
const ABOUT_MAX = 400;

// --- 4. Wikipedia: one paragraph on who they were (D-81) ---------------------

/** Wikidata again, for the pt article title. Same endpoint as pass 2, different
 *  property, and a separate call because pass 2 runs over CANDIDATES while this
 *  runs over the few who survived vetting. */
async function ptTitles(wdIds) {
  const titles = new Map();
  for (const batch of chunks([...new Set(wdIds)], 50)) {
    const url =
      "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&sitefilter=ptwiki" +
      `&ids=${batch.join("|")}`;
    const { entities = {} } = await getJson(url);
    for (const [qid, e] of Object.entries(entities)) {
      const title = e.sitelinks?.ptwiki?.title;
      if (title) titles.set(qid, title);
    }
  }
  return titles;
}

/**
 * One GET, with backoff. pt.wikipedia throttles a sustained run — the first
 * attempt at this pass got 211 bios and then nothing, because a 429 and "this
 * person has no article" both looked like `null` and the build wrote a file
 * that was 80 % empty without complaining. That is D-80's failure again, one
 * layer down, so the two cases are now different types: this throws, and only
 * the caller decides that a person legitimately has nothing to say.
 */
async function getWithRetry(url, tries = 5) {
  let wait = 500;
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok || res.status === 404) return res;
    if (i >= tries - 1 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    const after = Number(res.headers.get("retry-after")) * 1000;
    await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after : wait));
    wait *= 2;
  }
}

/** The REST summary endpoint, which returns the lead already flattened to plain
 *  text — so nothing here parses wikitext or HTML, and there is no sanitiser to
 *  get wrong. `type` filters out disambiguation pages, which read as nonsense
 *  under a portrait. Returns null only where there is genuinely nothing to
 *  show; a request that FAILED throws, and never reads as an empty bio. */
async function summaryOf(title) {
  const url = `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const res = await getWithRetry(url);
  if (res.status === 404) return null;
  const d = await res.json();
  if (d.type !== "standard") return null;
  const about = leadParagraph(d.extract, ABOUT_MAX);
  const wiki = d.content_urls?.desktop?.page ?? null;
  // Both or neither: a paragraph with no article to link is a quote with no
  // attribution, which is not a licence we hold.
  return about && wiki ? { about, wiki } : null;
}

/** Adds `about` and `wiki` to the people given, in place. Returns how many got
 *  one; everyone else simply has no bio and the reveal hides the block. */
async function addAbout(people) {
  const all = Object.values(people).flat();
  const titles = await ptTitles(all.map((p) => p.wd));
  console.log(`wikipedia: ${titles.size} of ${all.length} people have a pt article`);
  let done = 0;
  let got = 0;
  const failed = [];
  // Four at a time with a breath between batches. The whole pass is a few
  // minutes and nothing here runs at request time, so there is nothing to
  // optimise for but staying under the throttle.
  for (const batch of chunks(all, 4)) {
    await Promise.all(batch.map(async (person) => {
      const title = titles.get(person.wd);
      if (!title) return;
      try {
        const s = await summaryOf(title);
        if (s) {
          person.about = s.about;
          person.wiki = s.wiki;
          got++;
        }
      } catch (err) {
        failed.push(`${person.name} (${title}): ${err.message}`);
      }
    }));
    done += batch.length;
    if (done % 200 < 4) console.log(`  …${done}/${all.length}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`wikipedia: ${got} of ${all.length} people have a lead paragraph`);
  // Loudly. A person with no article is fine and expected; a request that could
  // not be made is a build that must not write a file.
  if (failed.length > 0) {
    console.error(`  ${failed.length} request(s) failed after retries; first 5:`);
    for (const f of failed.slice(0, 5)) console.error(`    ${f}`);
    throw new Error(`${failed.length} wikipedia requests failed — not writing a short file`);
  }
  return got;
}

if (args["only-about"]) {
  // The set of people is FROZEN and this mode exists because of that. Every
  // seeded day in production names its person by `wd` (D-78), so a full rebuild
  // — which re-draws from Pantheon and re-vets — can drop somebody a scheduled
  // day depends on, and a day naming a person the server cannot find is the
  // 2026-09-24 outage from the other end (D-80). Adding two fields to the file
  // that is already committed cannot do that. A full rebuild is still the right
  // thing when the pool itself should change; it just has to be followed by a
  // regeneration and a reseed, and the seeder's pre-flight will say so.
  const existing = read("backend/functions/src/data/people.json");
  const people = existing.people;
  const before = Object.values(people).flat().length;
  const got = await addAbout(people);
  const after = Object.values(people).flat().length;
  if (before !== after) throw new Error(`the set changed: ${before} → ${after}`);
  existing.sources = SOURCES;
  existing.aboutRetrievedAt = new Date().toISOString().slice(0, 10);
  write("backend/functions/src/data/people.json", JSON.stringify(existing, null, 0) + "\n");
  console.log(`  ${before} people untouched, ${got} gained a bio`);
  console.log("  written: backend/functions/src/data/people.json");
  process.exit(0);
}

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

// Pass 4 last, and only over the survivors: `keepBest` has already cut each
// country to its best few, so this is ~1,000 requests instead of ~3,000.
await addAbout(people);

const pool = Object.keys(people).sort();
const out = {
  "//":
    "People and birthplaces from Pantheon, photos hotlinked from Wikimedia Commons. Generated by tools/build-people.mjs. " +
    "Server-only: the birthplace IS the answer, and so is `about` — both leave the server ONLY inside a Reveal. " +
    "Do not edit by hand, and never copy a description or an occupation in here.",
  sources: SOURCES,
  retrievedAt: new Date().toISOString().slice(0, 10),
  aboutRetrievedAt: new Date().toISOString().slice(0, 10),
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
