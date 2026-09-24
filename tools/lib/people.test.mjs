import { test } from "node:test";
import assert from "node:assert/strict";
import { avoidWords, birthPlace, creditFrom, displayLicence, isFreeLicence, keepBest, leadParagraph, leaksCountry, normalize, photoUrl, vet } from "./people.mjs";

const BR = { code: "BR", code3: "BRA", names: { en: "Brazil", "pt-BR": "Brasil" } };
const IT = { code: "IT", code3: "ITA", names: { en: "Italy", "pt-BR": "Itália" } };
const RU = { code: "RU", code3: "RUS", names: { en: "Russia", "pt-BR": "Rússia" } };

test("normalize makes 'Türkiye' and 'turkiye' the same word", () => {
  assert.equal(normalize("Türkiye"), "turkiye");
  assert.equal(normalize("Itália"), "italia");
  assert.equal(normalize("Pelé_em_1970_no_Brasil.jpg"), "pele em 1970 no brasil jpg");
});

test("the guard catches a filename that names the country", () => {
  const avoid = avoidWords(BR);
  assert.equal(leaksCountry("Pelé em 1970 no Brasil.jpg", avoid), true);
  assert.equal(leaksCountry("Pele 1970.jpg", avoid), false);
});

test("a demonym is the answer too", () => {
  const avoid = avoidWords(IT, { demonym: "Italian" });
  assert.equal(leaksCountry("Italian painter self portrait.jpg", avoid), true);
  assert.equal(leaksCountry("Self portrait 1512.jpg", avoid), false);
});

test("the birth city is a leak in a filename and a reveal everywhere else", () => {
  // Kant's Königsberg is not Russia's name and hands over Russia all the same.
  const avoid = avoidWords(RU, { bplace: "Königsberg" });
  assert.equal(leaksCountry("Immanuel Kant in Konigsberg.jpg", avoid), true);
  assert.equal(leaksCountry("Immanuel Kant portrait.jpg", avoid), false);
});

test("an adjective hands over the answer as well as a noun", () => {
  // The hole a whole-word rule leaves: "Brasil" does not match "brasileiro",
  // and a caption is likelier to use the adjective than the country's name.
  assert.equal(leaksCountry("Escritor brasileiro.jpg", avoidWords(BR)), true);
  assert.equal(leaksCountry("Pintor italiano em 1520.jpg", avoidWords(IT)), true);
  // And the price: an innocent name that starts like a country goes too.
  assert.equal(leaksCountry("Joseph Chinard.jpg", avoidWords({ code: "CN", code3: "CHN", names: { en: "China", "pt-BR": "China" } })), true);
});

test("whole words only for short tokens — a two-letter code inside a surname is not a leak", () => {
  // `IT` sits inside "Whitman" and `RU` inside "Brunelleschi". A substring test
  // here would reject real people for no reason at all.
  assert.equal(leaksCountry("Walt Whitman.jpg", avoidWords(IT)), false);
  assert.equal(leaksCountry("Filippo Brunelleschi.jpg", avoidWords(RU)), false);
  assert.equal(leaksCountry("Portrait, IT, 1890.jpg", avoidWords(IT)), true);
});

test("a multi-word country name is matched as a phrase", () => {
  const US = { code: "US", code3: "USA", names: { en: "United States", "pt-BR": "Estados Unidos" } };
  assert.equal(leaksCountry("Born in the United States.jpg", avoidWords(US)), true);
  assert.equal(leaksCountry("United Artists poster.jpg", avoidWords(US)), false);
});

test("free licences in, fair use out", () => {
  for (const ok of ["pd", "PD", "pdm-owner", "cc0", "cc-by-4.0", "cc-by-sa-3.0", "cc-by-sa-3.0-migrated", "CC BY 2.0"]) {
    assert.equal(isFreeLicence(ok), true, ok);
  }
  for (const no of ["", null, undefined, "fair use", "non-free", "copyrighted", "gfdl", "fal"]) {
    assert.equal(isFreeLicence(no), false, String(no));
  }
});

test("a credit is a name, not a paragraph of HTML", () => {
  assert.equal(creditFrom('<bdi><a href="/wiki/x" class="extiw">Elias Gottlob Haussmann</a></bdi>'), "Elias Gottlob Haussmann");
  assert.equal(creditFrom("<b>Argentina</b>. Revista <i><b>Vea y Lea</b></i>"), "Argentina. Revista Vea y Lea");
  assert.equal(creditFrom(null), "");
  assert.ok(creditFrom("x".repeat(200)).length <= 80);
});

test("the photo URL survives a rename, and encodes what it must", () => {
  const url = photoUrl("File:Johann Sebastian Bach.png", 400);
  assert.match(url, /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//);
  assert.ok(url.includes("Johann%20Sebastian%20Bach.png"), url);
  assert.ok(url.endsWith("?width=400"));
  // A direct upload.wikimedia.org thumb path would carry a hash of the current
  // name and 404 the day the file is renamed. This one redirects.
  assert.equal(url.includes("upload.wikimedia.org"), false);
});

test("a country keeps its most famous, best first", () => {
  const people = [{ name: "c", hpi: 60 }, { name: "a", hpi: 90 }, { name: "b", hpi: 75 }];
  assert.deepEqual(keepBest(people, 2).map((p) => p.name), ["a", "b"]);
  assert.equal(keepBest(people, 10).length, 3);
  assert.deepEqual(people.map((p) => p.name), ["c", "a", "b"], "keepBest does not sort its argument");
});

test("vet says yes, or says why not", () => {
  const good = { name: "Machado de Assis", wd: "Q1276", file: "File:Machado de Assis 1890.jpg", licence: "pd", demonym: "Brazilian" };
  assert.equal(vet(good, BR), null);
  assert.match(vet({ ...good, wd: null }, BR), /wikidata/);
  assert.match(vet({ ...good, file: null }, BR), /no photo/);
  assert.match(vet({ ...good, licence: "fair use" }, BR), /licence fair use/);
  assert.match(vet({ ...good, file: "File:Escritor brasileiro.jpg" }, BR), /filename names the answer/);
  assert.match(vet({ ...good, name: "Brazilian writer" }, BR), /name names the answer/);
});

test("an alias is a leak for its own country and a fair question for everybody else", () => {
  // "Isabel I de Inglaterra" is "Reino Unido" written out; "Catarina I da
  // Rússia" was born in Estonia, and asking where she was born is the whole
  // point of the kind. Same shape of name, opposite verdicts — which is why the
  // list is keyed per country rather than global.
  const GB = { code: "GB", code3: "GBR", names: { en: "United Kingdom", "pt-BR": "Reino Unido" } };
  const EE = { code: "EE", code3: "EST", names: { en: "Estonia", "pt-BR": "Estônia" } };
  const gb = ["Inglaterra", "England", "Escócia", "Grã-Bretanha"];
  assert.equal(leaksCountry("Isabel I de Inglaterra", avoidWords(GB, { aliases: gb })), true);
  assert.equal(leaksCountry("Catarina I da Rússia", avoidWords(EE, { aliases: [] })), false);
  assert.equal(vet({ name: "Isabel I de Inglaterra", wd: "Q7207", file: "File:Elizabeth I.jpg", licence: "pd" }, GB, gb), 
    "name names the answer: Isabel I de Inglaterra");
});

test("the credit is sent to the client too, so it is vetted like the rest", () => {
  // Observed in the wild: the UAE's most famous man is photographed by the
  // "Dubai Government Photographer", and Dubai is where he was born.
  const AE = { code: "AE", code3: "ARE", names: { en: "United Arab Emirates", "pt-BR": "Emirados Árabes Unidos" } };
  const p = { name: "Maktoum bin Rashid Al Maktoum", wd: "Q57170", file: "File:Maktoum.jpg", licence: "pd", bplace: "Dubai" };
  assert.match(vet({ ...p, credit: "Dubai Government Photographer" }, AE), /credit names the answer/);
  assert.equal(vet({ ...p, credit: "Unknown author" }, AE), null);
});

test("a licence's jurisdiction port is taken off, because it correlates with the answer", () => {
  // "CC BY 3.0 br" is the Brazilian port, and it turns up on Brazilians.
  assert.equal(displayLicence("CC BY 3.0 br"), "CC BY 3.0");
  assert.equal(displayLicence("CC BY-SA 3.0 de"), "CC BY-SA 3.0");
  assert.equal(displayLicence("CC BY-SA 3.0 igo"), "CC BY-SA 3.0");
  // Everything else is left exactly as Commons wrote it.
  for (const same of ["Public domain", "CC0", "CC BY-SA 4.0", "CC BY-SA 3.0", "CC BY-SA 3.0-migrated"]) {
    assert.equal(displayLicence(same), same);
  }
});

test("a birth 'city' that is really the country is no city at all", () => {
  const PT = { code: "PT", code3: "PRT", names: { en: "Portugal", "pt-BR": "Portugal" } };
  // Pantheon's fallback when it has no settlement for someone born in 1480.
  assert.equal(birthPlace("Kingdom of Portugal", PT), null);
  assert.equal(birthPlace("Sabrosa", PT), "Sabrosa");
  assert.equal(birthPlace(null, PT), null);
});

test("an author repeated twice is one author", () => {
  assert.equal(creditFrom("Unknown author Unknown author"), "Unknown author");
  assert.equal(creditFrom("<b>Unknown artist</b> <i>Unknown artist</i>"), "Unknown artist");
  // Two different people stay two.
  assert.equal(creditFrom("Joseph Karl Stieler"), "Joseph Karl Stieler");
  assert.equal(creditFrom("Anna Bianchi Carlo Rossi"), "Anna Bianchi Carlo Rossi");
});

// --- D-81: the lead paragraph shown at the reveal ----------------------------

test("D-81: a short lead is kept whole, and only the first paragraph is taken", () => {
  assert.equal(leadParagraph("Foi uma condessa húngara."), "Foi uma condessa húngara.");
  assert.equal(leadParagraph("Primeiro parágrafo.\nSegundo parágrafo."), "Primeiro parágrafo.");
  assert.equal(leadParagraph("  espaços   colapsados  "), "espaços colapsados");
});

test("D-81: nothing to say is null, not an empty string", () => {
  // The reveal hides the whole block on null; "" would render an empty <p> and
  // a button to an article that may not exist.
  assert.equal(leadParagraph(""), null);
  assert.equal(leadParagraph(null), null);
  assert.equal(leadParagraph(undefined), null);
});

test("D-81: a long lead is cut on a sentence boundary, not mid-word", () => {
  const text = `${"a".repeat(60)}. ${"B".repeat(60)}. ${"c".repeat(400)}`;
  const cut = leadParagraph(text, 150);
  assert.ok(cut.endsWith("."), `expected a sentence end, got …${cut.slice(-20)}`);
  assert.ok(cut.length <= 151, `too long: ${cut.length}`);
  assert.equal(cut.includes("c".repeat(10)), false, "the third sentence should be gone");
});

test("D-81: an abbreviation does not end a sentence", () => {
  // A period ends a sentence only before a space and a capital. Getting this
  // wrong costs a truncated bio, which is why it is worth the lookahead.
  const text = `Nasceu em 100 a.C. e foi ${"x".repeat(200)}. Depois ${"y".repeat(200)}.`;
  const cut = leadParagraph(text, 260);
  assert.equal(cut.includes("a.C. e foi"), true, "cut at the abbreviation");
});

test("D-81: with no sentence boundary at all it cuts on a word and says so", () => {
  const cut = leadParagraph(`${"palavra ".repeat(100)}`, 50);
  assert.ok(cut.endsWith("…"), `expected an ellipsis, got …${cut.slice(-10)}`);
  assert.equal(cut.includes("palav…"), false, "must not cut mid-word");
});
