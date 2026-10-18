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
import { peopleFor } from "../src/lib/countries";
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

test("FR-14: the GDP hint places the figure — rank, the continent's median, growth when known", () => {
  const h = gdpHint("BR");
  assert.ok(h);
  assert.match(h.text, /^\d+º de \d+ em PIB per capita, (perto da|[\d,]+× a) mediana da América\. De 2013 a 2023, já descontada a inflação, /);
  assert.equal(gdpHint("KP"), null, "no figure, no hint");
});
