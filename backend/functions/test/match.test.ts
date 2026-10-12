/**
 * Batata Quente's text matching (FR-12.3, D-90). "One wrong character, not two"
 * is the rule Paulo set, and the ambiguity refusal is what keeps one wrong
 * character from silently naming the wrong country.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES } from "../src/lib/countries";
import { editDistance, matchCountry, normalize, MIN_FUZZY } from "../src/lib/match";

const code = (text: string) => {
  const r = matchCountry(text);
  return "code" in r ? r.code : r.error;
};

test("accents, case and punctuation do not count", () => {
  assert.equal(code("Japão"), "JP");
  assert.equal(code("japao"), "JP");
  assert.equal(code("  JAPÃO! "), "JP");
  assert.equal(code("sao tome e principe"), code("São Tomé e Príncipe"));
});

test("an alias names its country", () => {
  assert.equal(code("EUA"), "US");
});

test("one edit is forgiven, two are not", () => {
  assert.equal(code("Japãp"), "JP"); // substitution
  assert.equal(code("Japã"), "JP"); // deletion
  assert.equal(code("Jappão"), "JP"); // insertion
  assert.equal(code("Jpãp"), "unknown"); // two
  assert.equal(code("Argentian"), "unknown"); // a transposition is two edits
});

test("a one-edit guess that fits two countries is refused, not guessed", () => {
  // "nigera" is one edit from both Níger and Nigéria.
  assert.equal(code("Nigera"), "ambiguous");
  // ...while the exact name of either is still exact.
  assert.equal(code("Níger"), "NE");
  assert.equal(code("Nigéria"), "NG");
});

test("an exact match beats every one-edit neighbour", () => {
  for (const c of COUNTRIES.values()) assert.equal(code(c.names["pt-BR"]), c.code, c.names["pt-BR"]);
});

test("short input is never fuzzed, and two-letter codes are not names", () => {
  assert.equal(code("BR"), "unknown");
  assert.equal(code("UK"), "unknown");
  assert.ok(MIN_FUZZY >= 4);
  assert.equal(code("Ira"), code("Irã")); // exact after folding, not a fuzzy hit
});

test("nonsense is unknown", () => {
  assert.equal(code(""), "unknown");
  assert.equal(code("xyzzy"), "unknown");
  assert.equal(code("Atlântida"), "unknown");
});

test("the server folds text exactly as site/app/normalize.js documents", () => {
  assert.equal(normalize("São Tomé & Príncipe"), "sao tome principe");
  assert.equal(normalize("Timor-Leste"), "timor leste");
  assert.equal(normalize("  Ilhas   Marshall "), "ilhas marshall");
});

test("editDistance only distinguishes 0, 1 and more", () => {
  assert.equal(editDistance("brasil", "brasil"), 0);
  assert.equal(editDistance("brasil", "brazil"), 1);
  assert.equal(editDistance("brasil", "bras"), 2);
  assert.equal(editDistance("brasil", "xxxxxx"), 2);
});
