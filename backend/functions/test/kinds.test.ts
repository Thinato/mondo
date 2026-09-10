/**
 * Challenge kinds (FR-8, docs/06-tournaments.md §5).
 *
 * The interesting tests here are the cross-kind ones: what makes a card of
 * mixed kinds summable (D-44) is that every kind agrees on the 0..6 scale, and
 * what makes any of it safe is that a prompt never carries the answer (FR-8.4).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { COUNTRIES, countryByCode, flagFor } from "../src/lib/countries";
import { GDP_CORRECT_WITHIN, KINDS, KIND_IDS, MAX_ITEM_POINTS, capitalNamesItsCountry, kindById, scoreItem } from "../src/lib/kinds";
import { GDP_YEAR, gdpFor } from "../src/lib/countries";
import { isNumberGuess, type StoredNumberGuess } from "../src/lib/round";
import { distanceKm } from "../src/lib/geo";
import type { StoredCountryGuess, StoredGuess } from "../src/lib/round";

/** Narrow where the test already knows the kind stores a country guess. */
const asCountry = (g: StoredGuess): StoredCountryGuess => g as StoredCountryGuess;

const T0 = Timestamp.fromMillis(Date.parse("2026-09-15T15:30:00Z"));

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

test("FR-8.2 / D-44: every kind scores a first-guess solve at exactly 6 and never rises", () => {
  for (const id of KIND_IDS) {
    const k = KINDS[id];
    assert.equal(k.pointsByGuess.length, k.maxGuesses, `${id}: one entry per allowed guess`);
    assert.equal(scoreItem(k, true, 1), MAX_ITEM_POINTS, `${id}: first guess is worth 6`);
    assert.equal(scoreItem(k, false, k.maxGuesses), 0, `${id}: an unsolved item is worth 0`);
    for (let n = 2; n <= k.maxGuesses; n++) {
      assert.ok(scoreItem(k, true, n) < scoreItem(k, true, n - 1), `${id}: guess ${n} must be worth less`);
      assert.ok(scoreItem(k, true, n) >= 1, `${id}: a solve is always worth at least 1`);
    }
  }
});

test("shape scores exactly like the daily (FR-3.1); capital and flag over three guesses", () => {
  assert.deepEqual([...KINDS.shape.pointsByGuess], [6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...KINDS.capital.pointsByGuess], [6, 4, 2]);
  assert.deepEqual([...KINDS.flag.pointsByGuess], [6, 4, 2]);
  assert.equal(KINDS.shape.maxGuesses, 6);
  assert.equal(KINDS.capital.maxGuesses, 3);
  assert.equal(KINDS.flag.maxGuesses, 3);
});

test("scoreItem refuses a guess count the kind cannot produce", () => {
  assert.throws(() => scoreItem(KINDS.capital, true, 4), RangeError);
  assert.throws(() => scoreItem(KINDS.shape, true, 0), RangeError);
});

// --- SEC-1 / FR-8.4: prompts ------------------------------------------------

test("FR-8.4: the shape prompt carries a path and nothing that names the country", () => {
  const p = KINDS.shape.prompt("PY");
  assert.equal(p.kind, "shape");
  const json = JSON.stringify(p);
  assert.ok(json.includes('"d"'), "expected SVG path data");
  const py = countryByCode("PY")!;
  for (const term of [py.code, py.code3, py.names.en, py.names["pt-BR"], py.capital["pt-BR"], String(py.centroid[0])]) {
    assert.ok(!json.includes(term), `prompt leaks ${term}`);
  }
});

test("FR-8.4: the capital prompt is the city in pt-BR, and never the country or its centroid", () => {
  const p = KINDS.capital.prompt("IT");
  assert.deepEqual(p, { kind: "capital", capital: "Roma" });
  const json = JSON.stringify(p);
  const it = countryByCode("IT")!;
  for (const term of [it.code, it.code3, it.names.en, it.names["pt-BR"], String(it.centroid[1])]) {
    assert.ok(!json.includes(term), `prompt leaks ${term}`);
  }
});

test("the capitals file is wired up and pt-BR wins over world-countries' form", () => {
  assert.equal(countryByCode("RU")!.capital.en, "Moscow");
  assert.equal(countryByCode("RU")!.capital["pt-BR"], "Moscou");
  // Not overridden: both forms are the same word.
  assert.equal(countryByCode("KE")!.capital["pt-BR"], "Nairobi");
  // ZA has three capitals upstream; the build keeps the executive one.
  assert.equal(countryByCode("ZA")!.capital.en, "Pretoria");
});

test("every country can be asked about by shape; capital drops the self-naming ones", () => {
  assert.equal(KINDS.shape.pool().length, COUNTRIES.size);
  assert.ok(KINDS.capital.pool().length < COUNTRIES.size);
  assert.ok(KINDS.capital.pool().length > 150, "the exclusion must be a trim, not a cull");
});

test("FR-8.4: no capital prompt contains its own answer's name", () => {
  const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const c of KINDS.capital.pool()) {
    const cap = fold(c.capital["pt-BR"]);
    const name = fold(c.names["pt-BR"]);
    assert.ok(!cap.includes(name) && !name.includes(cap), `${c.code}: "${c.capital["pt-BR"]}" names ${c.names["pt-BR"]}`);
  }
});

test("the countries whose capital gives the game away are the ones excluded", () => {
  const pool = new Set(KINDS.capital.pool().map((c) => c.code));
  assert.ok(capitalNamesItsCountry(countryByCode("BR")!), "Brasília names Brasil");
  assert.ok(!capitalNamesItsCountry(countryByCode("KE")!), "Nairobi does not name Quênia");
  // "A capital é Brasília" / "Singapura" / "Cidade do México" answer themselves;
  // for the city-states the prompt is byte-identical to an autocomplete entry.
  for (const code of ["BR", "SG", "MX", "MC", "LU", "DJ", "GT", "KW", "PA", "AD", "GW", "DZ", "TN", "ST", "SM"]) {
    assert.ok(!pool.has(code), `${code} must not be asked as a capital`);
  }
  // ...while the ordinary ones stay.
  for (const code of ["KE", "IT", "JP", "RU", "PY", "IS"]) assert.ok(pool.has(code), `${code} should still be askable`);
});

// --- flag (OQ-11) ----------------------------------------------------------

test("FR-8.4: the flag prompt is paths and colours, and nothing that names the country", () => {
  const p = KINDS.flag.prompt("BR");
  assert.equal(p.kind, "flag");
  assert.ok(p.kind === "flag" && p.flag.paths.length > 0, "expected at least one path");
  const json = JSON.stringify(p);
  const br = countryByCode("BR")!;
  for (const term of [br.code3, br.names.en, br.names["pt-BR"], br.capital["pt-BR"], String(br.centroid[0])]) {
    assert.ok(!json.includes(term), `prompt leaks ${term}`);
  }
  // The vendored files carry `<title>Flag of Brazil</title>` and Inkscape ids;
  // the build drops both, and this is what would catch it coming back.
  assert.ok(!/title|desc|Flag of/i.test(json), "prompt carries metadata from the source file");
});

test("SEC-2: a flag prompt carries only the drawing keys the renderer knows", () => {
  const allowed = new Set([
    "d", "clip", "transform", "fill", "fillRule", "fillOpacity", "stroke", "strokeWidth",
    "strokeLinecap", "strokeLinejoin", "strokeMiterlimit", "strokeOpacity", "strokeDasharray", "opacity",
  ]);
  for (const c of KINDS.flag.pool()) {
    const flag = flagFor(c.code)!;
    assert.match(flag.viewBox, /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/, `${c.code}: viewBox`);
    assert.ok(flag.paths.length > 0, `${c.code}: nothing to draw`);
    for (const path of flag.paths) {
      assert.ok(path.d.length > 0, `${c.code}: empty path`);
      for (const key of Object.keys(path)) assert.ok(allowed.has(key), `${c.code}: unknown key ${key}`);
    }
  }
});

test("the flag pool is a real pool, and smaller than every other kind's", () => {
  const pool = KINDS.flag.pool().length;
  assert.ok(pool > 150, `only ${pool} flags: the build dropped more than it should`);
  assert.ok(pool < COUNTRIES.size, "some countries have no flag, and that is the point of pool()");
  assert.ok(pool < KINDS.shape.pool().length);
});

test("FR-8.4: the flags whose artwork spells their own country's name are not askable", () => {
  const pool = new Set(KINDS.flag.pool().map((c) => c.code));
  // Dropped by the byte budget, which is the same measure as "has a coat of
  // arms": REPÚBLICA DOMINICANA, REPUBLICA DE EL SALVADOR, BOLIVIA, and so on.
  for (const code of ["BO", "CR", "DO", "SV", "PE", "AF"]) {
    assert.ok(!pool.has(code), `${code}'s flag writes its own name`);
  }
  // Small enough to slip past the budget, so excluded by hand in tools/flags.json.
  for (const code of ["BN", "EG", "PY"]) {
    assert.ok(!pool.has(code), `${code} must be excluded by hand`);
  }
  // ...while the ordinary ones stay. Brazil's banner says ORDEM E PROGRESSO,
  // which is not its name.
  for (const code of ["BR", "AR", "PT", "US", "GB", "JP", "ZA", "AU"]) {
    assert.ok(pool.has(code), `${code} should still be askable`);
  }
});

test("a country the flag build dropped cannot be prompted, even if a card asks", () => {
  rejects(() => KINDS.flag.prompt("MX"), "not-found");
});

test("flag grades identically to shape — the answer is a country either way", () => {
  assert.deepEqual(KINDS.flag.grade("BR", "AR", T0), KINDS.shape.grade("BR", "AR", T0));
});

// --- gdp (OQ-12, D-53) -----------------------------------------------------

const asNumber = (g: StoredGuess): StoredNumberGuess => g as StoredNumberGuess;

test("D-53: the gdp prompt names the country, because here the country is the question", () => {
  const p = KINDS.gdp.prompt("BR");
  assert.deepEqual(p, { kind: "gdp", country: "Brasil", year: GDP_YEAR });
  // ...and the figure, which IS the answer, is nowhere in it (SEC-1).
  assert.ok(!JSON.stringify(p).includes(String(gdpFor("BR"))), "the prompt carries the figure");
});

test("D-53: a guess within 10 % counts, and one just outside does not", () => {
  const answer = gdpFor("BR")!;
  const grade = (v: number) => KINDS.gdp.grade("BR", v, T0);
  assert.equal(grade(answer).correct, true, "exact");
  assert.equal(grade(Math.round(answer * 0.91)).correct, true, "9 % under");
  assert.equal(grade(Math.round(answer / 0.91)).correct, true, "9 % over, symmetrically");
  assert.equal(grade(Math.round(answer * 0.89)).correct, false, "11 % under");
  assert.equal(grade(Math.round(answer / 0.89)).correct, false, "11 % over");
  // The rule is a ratio, so there is no "10 % of which number?" to argue about.
  assert.equal(GDP_CORRECT_WITHIN, 0.9);
});

test("D-53: the feedback is how close as a ratio, and which way to go", () => {
  const answer = gdpFor("BR")!;
  const half = asNumber(KINDS.gdp.grade("BR", Math.round(answer / 2), T0).guess);
  assert.ok(Math.abs(half.proximity - 0.5) < 0.01, `2x out should read ~50 %, got ${half.proximity}`);
  assert.equal(half.higher, true, "the answer is higher than half of it");

  const double = asNumber(KINDS.gdp.grade("BR", answer * 2, T0).guess);
  assert.ok(Math.abs(double.proximity - 0.5) < 0.01);
  assert.equal(double.higher, false);
  assert.equal(isNumberGuess(double), true);
});

test("SEC-8: a gdp guess must be a plausible number, and nothing else", () => {
  for (const bad of ["22000", null, {}, [], true, NaN, Infinity]) {
    rejects(() => KINDS.gdp.grade("BR", bad, T0), "invalid-argument");
  }
  rejects(() => KINDS.gdp.grade("BR", 0, T0), "invalid-argument");
  rejects(() => KINDS.gdp.grade("BR", -5, T0), "invalid-argument");
  rejects(() => KINDS.gdp.grade("BR", 1e10, T0), "invalid-argument");
  // A country code is a guess for the other three kinds and gibberish for this one.
  rejects(() => KINDS.shape.grade("PY", 22000, T0), "invalid-argument");
});

test("D-53: the ten countries the World Bank has no figure for cannot be asked", () => {
  const pool = new Set(KINDS.gdp.pool().map((c) => c.code));
  for (const code of ["CU", "ER", "KP", "LI", "MC", "SS", "SY", "TW", "VE", "YE"]) {
    assert.ok(!pool.has(code), `${code} has no figure and must not be asked`);
  }
  for (const code of ["BR", "PT", "US", "VN", "NG", "QA"]) assert.ok(pool.has(code), `${code} should be askable`);
  assert.equal(pool.size, 186);
  for (const c of KINDS.gdp.pool()) assert.ok(gdpFor(c.code)! > 0, `${c.code}: implausible figure`);
});

test("D-53: reveal is the figure, since the country was never the secret", () => {
  const r = KINDS.gdp.reveal("BR");
  assert.equal(r.code, "BR");
  assert.ok(r.name.startsWith("Brasil: "));
  assert.ok(r.name.includes(gdpFor("BR")!.toLocaleString("pt-BR")));
});

test("wasCorrect reads a stored guess back without a clock", () => {
  const answer = gdpFor("BR")!;
  const near = KINDS.gdp.grade("BR", Math.round(answer * 0.95), T0).guess;
  const far = KINDS.gdp.grade("BR", Math.round(answer * 0.5), T0).guess;
  assert.equal(KINDS.gdp.wasCorrect("BR", near), true);
  assert.equal(KINDS.gdp.wasCorrect("BR", far), false);
  // And a country kind still answers on the code it stored.
  assert.equal(KINDS.shape.wasCorrect("PY", KINDS.shape.grade("PY", "PY", T0).guess), true);
  assert.equal(KINDS.shape.wasCorrect("PY", KINDS.shape.grade("PY", "AR", T0).guess), false);
  assert.equal(KINDS.shape.wasCorrect("PY", near), false, "a number is never a country");
});

// --- grading ---------------------------------------------------------------

test("a wrong guess grades to distance, bearing and proximity; a right one to zero distance", () => {
  const wrong = KINDS.shape.grade("PY", "AR", T0);
  assert.equal(wrong.correct, false);
  assert.equal(asCountry(wrong.guess).code, "AR");
  assert.equal(asCountry(wrong.guess).distanceKm, distanceKm(COUNTRIES.get("AR")!.centroid, COUNTRIES.get("PY")!.centroid));
  assert.ok(asCountry(wrong.guess).bearingDeg > 0);

  const right = KINDS.shape.grade("PY", "PY", T0);
  assert.equal(right.correct, true);
  assert.equal(asCountry(right.guess).distanceKm, 0);
  assert.equal(asCountry(right.guess).bearingDeg, 0);
  assert.equal(asCountry(right.guess).proximity, 1);
});

test("capital grades identically to shape — the answer is a country either way", () => {
  const a = KINDS.capital.grade("IT", "FR", T0);
  const b = KINDS.shape.grade("IT", "FR", T0);
  assert.deepEqual(a, b);
});

test("SEC-8: a guess that is not a known country code is rejected by the kind itself", () => {
  rejects(() => KINDS.shape.grade("PY", "ZZ", T0), "invalid-argument");
  rejects(() => KINDS.capital.grade("PY", 42, T0), "invalid-argument");
  rejects(() => KINDS.capital.grade("PY", null, T0), "invalid-argument");
  rejects(() => KINDS.shape.grade("PY", { code: "AR" }, T0), "invalid-argument");
});

test("kindById rejects anything not registered", () => {
  rejects(() => kindById("population"), "invalid-argument"); // every shipped kind is now in KIND_IDS
  rejects(() => kindById("constructor"), "invalid-argument");
  rejects(() => kindById("__proto__"), "invalid-argument");
});

test("reveal names the country in pt-BR, and only once the caller asks for it", () => {
  assert.deepEqual(KINDS.capital.reveal("BR"), { code: "BR", name: "Brasil" });
});
