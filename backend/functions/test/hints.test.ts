/**
 * Learning hints (FR-14, D-101). Pure.
 *
 * Two halves. The engine, against small fixture catalogues: order, the cap,
 * person patterns needing both the name and the country, and — the one that
 * matters — a hint naming a country still open on the card is withheld. Then
 * the real catalogue, which is hand-written and so is checked like input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { cardView, giveUpCard, newCardPlay, type CardItem } from "../src/lib/card";
import { COUNTRIES, peopleFor } from "../src/lib/countries";
import { KINDS, type Challenge, type KindId } from "../src/lib/kinds";
import { CATALOGUE, gdpHint, hintsFor, MAX_HINTS, mentionsOf, openSubjects, revealOf, TOPIC_OF, TOPICS, type Catalogue } from "../src/lib/hints";

const NONE = new Set<string>();
const ch = (kind: KindId, subject: string, extra: Partial<Challenge> = {}): Challenge => ({ kind, subject, ...extra });
const src = "https://pt.wikipedia.org/wiki/Exemplo";

const FIXTURE: Catalogue = {
  patterns: [
    { id: "pan", topic: "flag", title: "Cores pan-africanas", text: "Vermelho, amarelo e verde, as cores da bandeira da Etiópia.", countries: ["ET", "GH", "SN", "ML"], source: src },
    { id: "pair", topic: "flag", title: "Mônaco ou Indonésia?", text: "A da Indonésia é 2:3 e mais viva; a de Mônaco é 4:5.", countries: ["MC", "ID"], source: src },
    { id: "escu", topic: "person", match: "escu\\b", title: "Sobrenomes em -escu", text: "Um sobrenome terminado em -escu é quase sempre romeno ou moldávio.", countries: ["RO", "MD"], source: src },
  ],
  notes: { flag: { GH: { title: "A estrela negra", text: "A estrela negra no meio é a de Gana, símbolo da liberdade africana.", source: src } } },
};

test("FR-14: the note comes first, then the patterns, and 'também' lists the other members", () => {
  const h = hintsFor(ch("flag", "GH"), NONE, FIXTURE);
  assert.deepEqual(h.map((x) => x.title), ["A estrela negra", "Cores pan-africanas"]);
  // Etiópia is in the text, so it is not repeated; Gana is the answer.
  assert.deepEqual(h[1]!.also, ["Senegal", "Mali"]);
});

test("FR-14: a pick kind is taught what its typed twin is", () => {
  assert.deepEqual(hintsFor(ch("flagPick", "GH"), NONE, FIXTURE), hintsFor(ch("flag", "GH"), NONE, FIXTURE));
  for (const k of Object.keys(KINDS) as KindId[]) assert.ok(TOPICS.includes(TOPIC_OF[k]), k);
});

test("FR-14: nothing to say is no hints at all, and revealOf then adds no key", () => {
  assert.deepEqual(hintsFor(ch("shape", "BR"), NONE, FIXTURE), []);
  const r = revealOf(ch("capital", "BR"), NONE);
  assert.equal("hints" in r, CATALOGUE.notes.capital?.BR !== undefined || CATALOGUE.patterns.some((p) => p.topic === "capital" && p.countries.includes("BR")));
});

test("FR-14: never more than three", () => {
  const many: Catalogue = {
    patterns: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, topic: "flag" as const, title: `T${i}`, text: "Um texto de exemplo que não nomeia país nenhum aqui.", countries: ["GH"], source: src })),
    notes: {},
  };
  assert.equal(hintsFor(ch("flag", "GH"), NONE, many).length, MAX_HINTS);
});

test("D-101: mentions are read off the text, accents and case aside", () => {
  assert.ok(mentionsOf(FIXTURE.patterns[0]!).has("ET"));
  assert.deepEqual([...mentionsOf(FIXTURE.patterns[1]!)].sort(), ["ID", "MC"]);
  assert.equal(mentionsOf({ title: "x", text: "pan-africanas, nada de país", source: src }).size, 0);
});

test("D-101: a hint naming a country still open on the card waits; 'também' drops it instead", () => {
  // Monaco's flag is over, Indonesia's is next: the pair would answer it.
  assert.deepEqual(hintsFor(ch("flag", "MC"), new Set(["ID"]), FIXTURE), []);
  assert.equal(hintsFor(ch("flag", "MC"), NONE, FIXTURE).length, 1);
  // Senegal is still to come: the pattern stays, Senegal leaves the list.
  const h = hintsFor(ch("flag", "GH"), new Set(["SN"]), FIXTURE);
  assert.deepEqual(h[1]!.also, ["Mali"]);
  // The text itself names Etiópia: open, and the whole pattern waits.
  assert.deepEqual(hintsFor(ch("flag", "GH"), new Set(["ET"]), FIXTURE).map((x) => x.title), ["A estrela negra"]);
});

test("FR-14: a name pattern needs the name AND the country", () => {
  const md = peopleFor("MD").find((p) => /escu\b/.test(p.name));
  assert.ok(md, "fixture: a Moldovan -escu");
  assert.equal(hintsFor(ch("person", "MD", { person: md.wd }), NONE, FIXTURE).length, 1);
  const other = peopleFor("MD").find((p) => !/escu\b/.test(p.name));
  if (other) assert.equal(hintsFor(ch("person", "MD", { person: other.wd }), NONE, FIXTURE).length, 0);
  // Right name, wrong country: nothing.
  assert.equal(hintsFor(ch("person", "BR", { person: md.wd }), NONE, FIXTURE).length, 0);
});

test("FR-14: openSubjects is the unfinished items' subjects", () => {
  const card = [ch("flag", "MC"), ch("flag", "ID"), ch("shape", "BR")];
  assert.deepEqual([...openSubjects(card, [{ finishedAt: 1 }, { finishedAt: null }, { finishedAt: null }])], ["ID", "BR"]);
});

test("SEC-1 / D-101: on a card, Monaco's answer holds back what Indonesia's flag would give away", () => {
  const pair = CATALOGUE.patterns.find((p) => p.topic === "flag" && p.countries.includes("MC") && p.countries.includes("ID"));
  assert.ok(pair, "the catalogue carries the Monaco/Indonesia pair");
  const card: CardItem[] = [{ kind: "flag", subject: "MC" }, { kind: "flag", subject: "ID" }];
  const t0 = Timestamp.fromMillis(Date.parse("2026-10-18T15:00:00Z"));
  const after = (ms: number) => Timestamp.fromMillis(t0.toMillis() + ms);
  const fresh = newCardPlay("u1", "t1", "t1_r1", card, t0);
  const one = { ...fresh, ...giveUpCard(fresh, card, after(1000)) };
  const titles = (v: ReturnType<typeof cardView>, i: number) => (v.items[i]!.answer?.hints ?? []).map((h) => h.title);
  assert.ok(!titles(cardView(one, card, after(1000)), 0).includes(pair.title), "withheld while Indonesia is open");
  const both = { ...one, ...giveUpCard(one, card, after(2000)) };
  assert.ok(titles(cardView(both, card, after(2000)), 0).includes(pair.title), "shown once the card is over");
  // And no prompt ever carries one.
  assert.equal("hints" in (cardView(newCardPlay("u1", "t1", "t1_r1", card, t0), card, t0).prompt ?? {}), false);
});

test("FR-14: the GDP hint places the figure — rank, the continent's median, growth when known", () => {
  const h = gdpHint("BR");
  assert.ok(h);
  assert.match(h.text, /^\d+º de \d+ em PIB per capita, (perto da|[\d,]+× a) mediana da América\. De 2013 a 2023, já descontada a inflação, /);
  assert.equal(gdpHint("KP"), null, "no figure, no hint");
});

// ---------------------------------------------------------------------------
// The real catalogue
// ---------------------------------------------------------------------------

const entries = () => [
  ...CATALOGUE.patterns.map((p) => ({ where: p.id, e: p })),
  ...Object.entries(CATALOGUE.notes).flatMap(([topic, notes]) => Object.entries(notes ?? {}).map(([code, e]) => ({ where: `${topic}/${code}`, e }))),
];
const POOL: Record<string, Set<string>> = Object.fromEntries(
  TOPICS.map((t) => [t, new Set((Object.keys(KINDS) as KindId[]).filter((k) => TOPIC_OF[k] === t).flatMap((k) => KINDS[k].pool().map((c) => c.code)))]),
);

test("catalogue: every entry is short, sourced, and in our own plain text", () => {
  for (const { where, e } of entries()) {
    assert.ok(e.title.length > 0 && e.title.length <= 40, `${where}: title length ${e.title.length}`);
    assert.ok(e.text.length >= 40 && e.text.length <= 320, `${where}: text length ${e.text.length}`);
    assert.match(e.source, /^https:\/\//, `${where}: source`);
    assert.doesNotMatch(e.text, /[<>]/, `${where}: plain text only`);
  }
});

test("catalogue: every code is a country, and every pattern can actually be shown", () => {
  const ids = new Set<string>();
  for (const p of CATALOGUE.patterns) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(TOPICS.includes(p.topic), `${p.id}: topic`);
    assert.ok(p.countries.length > 0, `${p.id}: no countries`);
    for (const c of p.countries) assert.ok(COUNTRIES.has(c), `${p.id}: unknown code ${c}`);
    assert.ok(p.countries.some((c) => POOL[p.topic]!.has(c)), `${p.id}: no member is ever asked about`);
    assert.equal(p.match !== undefined, p.topic === "person", `${p.id}: match is for person patterns, and they need one`);
  }
  for (const [topic, notes] of Object.entries(CATALOGUE.notes)) {
    for (const code of Object.keys(notes ?? {})) assert.ok(POOL[topic]?.has(code), `note ${topic}/${code}: not in the pool`);
  }
});

test("catalogue: every name pattern fits somebody it would be shown for", () => {
  for (const p of CATALOGUE.patterns.filter((x) => x.match !== undefined)) {
    const re = new RegExp(p.match!, "u");
    const hits = p.countries.flatMap((c) => peopleFor(c).filter((x) => re.test(x.name)));
    assert.ok(hits.length > 0, `${p.id}: matches nobody in people.json`);
  }
});

test("catalogue: the look-alike pairs are there", () => {
  for (const pair of [["MC", "ID"], ["TD", "RO"], ["AU", "NZ"], ["NL", "LU"], ["IE", "CI"]]) {
    assert.ok(
      CATALOGUE.patterns.some((p) => p.topic === "flag" && pair.every((c) => p.countries.includes(c))),
      `no flag pattern for ${pair.join("/")}`,
    );
  }
});
