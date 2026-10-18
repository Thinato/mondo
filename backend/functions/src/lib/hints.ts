/**
 * "Como reconhecer" — how a finished challenge's answer could have been told
 * apart (FR-14, D-101). Pure.
 *
 * Three sources, in this order, at most three hints:
 * 1. a note on this one country for this topic ("a Gâmbia é uma faixa ao longo
 *    de um rio"), where one helps;
 * 2. every catalogue pattern the country belongs to (pan-African colours,
 *    "-escu" surnames, Monaco-or-Indonesia);
 * 3. for `gdp`, where the figure sits: rank, the continent's median, and ten
 *    years of real growth — computed, not written.
 *
 * The catalogue (`data/hints.json`) is hand-written in our own words, each
 * entry with the source a reviewer checks it against. `source` never leaves
 * the server.
 *
 * **A hint can answer another challenge.** D-67 lets one day ask Monaco's flag
 * and then Indonesia's, and "Monaco or Indonesia? Indonesia's is 2:3" read
 * after the first is the second's answer. So every hint knows which countries
 * its text names — computed from the text by `countriesNamedIn`, never declared
 * by hand, so it cannot drift — and is withheld while any of them is still open
 * on the card, or, in practice and Multijogador, is one of the daily's answers this
 * week (D-60, D-91). The "Também" list is trimmed the same way. Once the card
 * is over nothing on it is open and everything shows.
 *
 * This is why hints are added here, by the caller that holds the card, and not
 * by `Kind.reveal`, which sees one item and cannot know what else is open.
 */

import hintsJson from "../data/hints.json";
import { countryByCode, gdpFor, gdpGrowthFor, GDP_GROWTH, peopleFor, type Region } from "./countries";
import { KINDS, kindById, type Challenge, type Hint, type KindId, type Reveal } from "./kinds";
import { countriesNamedIn } from "./match";

export const TOPICS = ["flag", "shape", "capital", "gdp", "person"] as const;
export type Topic = (typeof TOPICS)[number];

/** A pick kind is taught what its typed twin is: the same flags, the same silhouettes (D-72). */
export const TOPIC_OF: Readonly<Record<KindId, Topic>> = {
  flag: "flag", flagPick: "flag", shape: "shape", shapePick: "shape", capital: "capital", gdp: "gdp", person: "person",
};

export interface Entry {
  title: string;
  text: string;
  /** For the reviewer; never sent. */
  source: string;
}
export interface Pattern extends Entry {
  id: string;
  topic: Topic;
  countries: string[];
  /** `person` only: a regex on the person's name. The pattern needs it to match AND the subject in `countries`. */
  match?: string;
}
export interface Catalogue {
  patterns: Pattern[];
  notes: Partial<Record<Topic, Record<string, Entry>>>;
}

export const CATALOGUE = hintsJson as unknown as Catalogue;
export const MAX_HINTS = 3;
const MAX_ALSO = 6;

const mentions = new WeakMap<Entry, Set<string>>();
/** The countries an entry's title or text names. */
export function mentionsOf(e: Entry): Set<string> {
  let m = mentions.get(e);
  if (!m) mentions.set(e, (m = countriesNamedIn(`${e.title} ${e.text}`)));
  return m;
}

const regexes = new Map<string, RegExp>();
const regexOf = (src: string) => regexes.get(src) ?? regexes.set(src, new RegExp(src, "u")).get(src)!;

const nameOf = (code: string) => countryByCode(code)?.names["pt-BR"] ?? code;

export function hintsFor(item: Challenge, open: ReadonlySet<string>, cat: Catalogue = CATALOGUE): Hint[] {
  const topic = TOPIC_OF[item.kind];
  const code = item.subject;
  const out: Hint[] = [];
  const add = (e: Entry, members: readonly string[] = []) => {
    const named = mentionsOf(e);
    for (const c of named) if (open.has(c)) return;
    // Not the subject, not anyone the text already names, not anyone still to be asked.
    const also = members.filter((c) => c !== code && !named.has(c) && !open.has(c)).slice(0, MAX_ALSO).map(nameOf);
    out.push({ title: e.title, text: e.text, ...(also.length > 0 ? { also } : {}) });
  };

  const note = cat.notes[topic]?.[code];
  if (note) add(note);
  const person = topic === "person" ? peopleFor(code).find((p) => p.wd === item.person)?.name ?? null : null;
  for (const p of cat.patterns) {
    if (p.topic !== topic || !p.countries.includes(code)) continue;
    if (p.match !== undefined && (person === null || !regexOf(p.match).test(person))) continue;
    add(p, p.countries);
  }
  if (topic === "gdp") {
    const g = gdpHint(code);
    if (g) out.push(g);
  }
  return out.slice(0, MAX_HINTS);
}

/** `kind.reveal`, plus the hints the card can afford to show. The one way a view builds an answer. */
export function revealOf(item: Challenge, open: ReadonlySet<string>): Reveal {
  const reveal = kindById(item.kind).reveal(item);
  const hints = hintsFor(item, open);
  return hints.length > 0 ? { ...reveal, hints } : reveal;
}

/** The subjects of a card's items that have not finished — what a hint must not name yet. */
export function openSubjects(card: readonly Challenge[], items: readonly { finishedAt: unknown }[]): Set<string> {
  return new Set(card.filter((_, i) => items[i]?.finishedAt === null).map((c) => c.subject));
}

// ---------------------------------------------------------------------------
// GDP, computed
// ---------------------------------------------------------------------------

const OF_REGION: Readonly<Record<Region, string>> = {
  Africa: "da África", Americas: "da América", Asia: "da Ásia", Europe: "da Europa", Oceania: "da Oceania",
};

/**
 * The pool's ranks, continental medians and growth distribution. Built on first
 * use rather than at load: `kinds` → `round` → `hints` is an import cycle, and
 * `KINDS` does not exist yet while this module is being evaluated.
 */
let table: { size: number; rank: Map<string, number>; median: Map<Region, number>; growths: number[] } | null = null;
function gdpTable() {
  if (table) return table;
  const pool = KINDS.gdp.pool().map((c) => ({ code: c.code, region: c.region, value: gdpFor(c.code)! }));
  return (table = {
    size: pool.length,
    rank: new Map([...pool].sort((a, b) => b.value - a.value).map((c, i) => [c.code, i + 1])),
    median: new Map((Object.keys(OF_REGION) as Region[]).map((r) => [r, median(pool.filter((c) => c.region === r).map((c) => c.value))])),
    growths: pool.map((c) => gdpGrowthFor(c.code)).filter((g): g is number => g !== undefined),
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const fmt = (x: number, digits = 1) => x.toLocaleString("pt-BR", { maximumFractionDigits: digits });

export function gdpHint(code: string): Hint | null {
  const value = gdpFor(code);
  const country = countryByCode(code);
  const t = gdpTable();
  if (value === undefined || !country || !t.rank.has(code)) return null;
  const ratio = value / t.median.get(country.region)!;
  const vsMedian = ratio >= 0.9 && ratio <= 1.1 ? "perto da mediana" : `${fmt(ratio)}× a mediana`;
  const parts = [`${t.rank.get(code)}º de ${t.size} em PIB per capita, ${vsMedian} ${OF_REGION[country.region]}.`];
  const g = gdpGrowthFor(code);
  if (g !== undefined && GDP_GROWTH) {
    // Where the decade sits among everyone's: the top and bottom fifths get said out loud.
    const below = t.growths.filter((x) => x < g).length / t.growths.length;
    const tail = below >= 0.8 ? ", entre as que mais cresceram" : below < 0.2 ? ", entre as piores da década" : "";
    const moved = Math.abs(g) < 1 ? "ficou praticamente igual" : `${g < 0 ? "encolheu" : "cresceu"} ${fmt(Math.abs(g), 0)}%`;
    parts.push(`De ${GDP_GROWTH.from} a ${GDP_GROWTH.to}, já descontada a inflação, ${moved}${tail}.`);
  }
  return { title: "Onde esse número fica", text: parts.join(" ") };
}
