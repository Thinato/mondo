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
import { COUNTRIES, countryByCode, flagFor, peopleFor, shapeFor } from "../src/lib/countries";
import peopleJson from "../src/data/people.json";
import { PICK_NEAR, PICK_OPTIONS, GDP_CORRECT_WITHIN, KINDS, KIND_IDS, MAX_ITEM_POINTS, capitalNamesItsCountry, kindById, scoreItem, type Challenge, type KindId, type Prompt } from "../src/lib/kinds";
import { GDP_YEAR, gdpFor } from "../src/lib/countries";
import { isNumberGuess, type StoredNumberGuess } from "../src/lib/round";
import { distanceKm } from "../src/lib/geo";
import type { StoredCountryGuess, StoredGuess } from "../src/lib/round";

/** Narrow where the test already knows the kind stores a country guess. */
const asCountry = (g: StoredGuess): StoredCountryGuess => g as StoredCountryGuess;

/** One challenge, as every Kind method takes it since D-64. */
const ch = (kind: KindId, subject: string, options?: string[]): Challenge =>
  options ? { kind, subject, options } : { kind, subject };

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
  const p = KINDS.shape.prompt(ch("shape", "PY"));
  assert.equal(p.kind, "shape");
  const json = JSON.stringify(p);
  assert.ok(json.includes('"d"'), "expected SVG path data");
  const py = countryByCode("PY")!;
  for (const term of [py.code, py.code3, py.names.en, py.names["pt-BR"], py.capital["pt-BR"], String(py.centroid[0])]) {
    assert.ok(!json.includes(term), `prompt leaks ${term}`);
  }
});

test("FR-8.4: the capital prompt is the city in pt-BR, and never the country or its centroid", () => {
  const p = KINDS.capital.prompt(ch("capital", "IT"));
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
  // D-59: every country has a silhouette except the two atoll nations whose
  // largest landmass is a speck. They keep flag, capital and gdp.
  assert.equal(KINDS.shape.pool().length, COUNTRIES.size - 2);
  for (const code of ["TV", "MH"]) {
    assert.ok(!KINDS.shape.pool().some((c) => c.code === code), `${code} must not be a silhouette`);
    assert.ok(KINDS.gdp.pool().some((c) => c.code === code), `${code} is still in the game`);
  }
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
  const p = KINDS.flag.prompt(ch("flag", "BR"));
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
  rejects(() => KINDS.flag.prompt(ch("flag", "MX")), "not-found");
});

test("flag grades identically to shape — the answer is a country either way", () => {
  assert.deepEqual(KINDS.flag.grade(ch("flag", "BR"), "AR", T0), KINDS.shape.grade(ch("shape", "BR"), "AR", T0));
});

// --- gdp (OQ-12, D-53) -----------------------------------------------------

const asNumber = (g: StoredGuess): StoredNumberGuess => g as StoredNumberGuess;

test("D-53: the gdp prompt names the country, because here the country is the question", () => {
  const p = KINDS.gdp.prompt(ch("gdp", "BR"));
  assert.deepEqual(p, { kind: "gdp", country: "Brasil", year: GDP_YEAR });
  // ...and the figure, which IS the answer, is nowhere in it (SEC-1).
  assert.ok(!JSON.stringify(p).includes(String(gdpFor("BR"))), "the prompt carries the figure");
});

test("D-53: a guess within 10 % counts, and one just outside does not", () => {
  const answer = gdpFor("BR")!;
  const grade = (v: number) => KINDS.gdp.grade(ch("gdp", "BR"), v, T0);
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
  const half = asNumber(KINDS.gdp.grade(ch("gdp", "BR"), Math.round(answer / 2), T0).guess);
  assert.ok(Math.abs(half.proximity - 0.5) < 0.01, `2x out should read ~50 %, got ${half.proximity}`);
  assert.equal(half.higher, true, "the answer is higher than half of it");

  const double = asNumber(KINDS.gdp.grade(ch("gdp", "BR"), answer * 2, T0).guess);
  assert.ok(Math.abs(double.proximity - 0.5) < 0.01);
  assert.equal(double.higher, false);
  assert.equal(isNumberGuess(double), true);
});

test("SEC-8: a gdp guess must be a plausible number, and nothing else", () => {
  for (const bad of ["22000", null, {}, [], true, NaN, Infinity]) {
    rejects(() => KINDS.gdp.grade(ch("gdp", "BR"), bad, T0), "invalid-argument");
  }
  rejects(() => KINDS.gdp.grade(ch("gdp", "BR"), 0, T0), "invalid-argument");
  rejects(() => KINDS.gdp.grade(ch("gdp", "BR"), -5, T0), "invalid-argument");
  rejects(() => KINDS.gdp.grade(ch("gdp", "BR"), 1e10, T0), "invalid-argument");
  // A country code is a guess for the other three kinds and gibberish for this one.
  rejects(() => KINDS.shape.grade(ch("shape", "PY"), 22000, T0), "invalid-argument");
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
  const r = KINDS.gdp.reveal(ch("gdp", "BR"));
  assert.equal(r.code, "BR");
  assert.ok(r.name.startsWith("Brasil: "));
  assert.ok(r.name.includes(gdpFor("BR")!.toLocaleString("pt-BR")));
});

test("wasCorrect reads a stored guess back without a clock", () => {
  const answer = gdpFor("BR")!;
  const near = KINDS.gdp.grade(ch("gdp", "BR"), Math.round(answer * 0.95), T0).guess;
  const far = KINDS.gdp.grade(ch("gdp", "BR"), Math.round(answer * 0.5), T0).guess;
  assert.equal(KINDS.gdp.wasCorrect(ch("gdp", "BR"), near), true);
  assert.equal(KINDS.gdp.wasCorrect(ch("gdp", "BR"), far), false);
  // And a country kind still answers on the code it stored.
  assert.equal(KINDS.shape.wasCorrect(ch("shape", "PY"), KINDS.shape.grade(ch("shape", "PY"), "PY", T0).guess), true);
  assert.equal(KINDS.shape.wasCorrect(ch("shape", "PY"), KINDS.shape.grade(ch("shape", "PY"), "AR", T0).guess), false);
  assert.equal(KINDS.shape.wasCorrect(ch("shape", "PY"), near), false, "a number is never a country");
});

// --- grading ---------------------------------------------------------------

test("a wrong guess grades to distance, bearing and proximity; a right one to zero distance", () => {
  const wrong = KINDS.shape.grade(ch("shape", "PY"), "AR", T0);
  assert.equal(wrong.correct, false);
  assert.equal(asCountry(wrong.guess).code, "AR");
  assert.equal(asCountry(wrong.guess).distanceKm, distanceKm(COUNTRIES.get("AR")!.centroid, COUNTRIES.get("PY")!.centroid));
  assert.ok(asCountry(wrong.guess).bearingDeg > 0);

  const right = KINDS.shape.grade(ch("shape", "PY"), "PY", T0);
  assert.equal(right.correct, true);
  assert.equal(asCountry(right.guess).distanceKm, 0);
  assert.equal(asCountry(right.guess).bearingDeg, 0);
  assert.equal(asCountry(right.guess).proximity, 1);
});

test("capital grades identically to shape — the answer is a country either way", () => {
  const a = KINDS.capital.grade(ch("capital", "IT"), "FR", T0);
  const b = KINDS.shape.grade(ch("shape", "IT"), "FR", T0);
  assert.deepEqual(a, b);
});

test("SEC-8: a guess that is not a known country code is rejected by the kind itself", () => {
  rejects(() => KINDS.shape.grade(ch("shape", "PY"), "ZZ", T0), "invalid-argument");
  rejects(() => KINDS.capital.grade(ch("capital", "PY"), 42, T0), "invalid-argument");
  rejects(() => KINDS.capital.grade(ch("capital", "PY"), null, T0), "invalid-argument");
  rejects(() => KINDS.shape.grade(ch("shape", "PY"), { code: "AR" }, T0), "invalid-argument");
});

test("kindById rejects anything not registered", () => {
  rejects(() => kindById("population"), "invalid-argument"); // every shipped kind is now in KIND_IDS
  rejects(() => kindById("constructor"), "invalid-argument");
  rejects(() => kindById("__proto__"), "invalid-argument");
});

test("reveal names the country in pt-BR, and only once the caller asks for it", () => {
  assert.deepEqual(KINDS.capital.reveal(ch("capital", "BR")), { code: "BR", name: "Brasil" });
});

// --- FR-8.7 / D-64, D-72: the pick kinds ------------------------------------
//
// Two kinds, one set of rules, so these are written once and run twice. What
// differs between them is the artwork and the pool; everything the tests below
// assert — eight options, the answer among them, four neighbours, nothing in
// the payload that names a country — is the same question asked of both.

type PickKind = "flagPick" | "shapePick";
const PICKS: readonly PickKind[] = ["flagPick", "shapePick"];

/** What each pick kind deals in: the artwork lookup, the option field, and the
 *  ONLY keys that field may carry. The last one is the SEC-1 assertion. */
const ART: Record<PickKind, { has: (code: string) => unknown; field: string; keys: string[]; pool: KindId }> = {
  flagPick: { has: flagFor, field: "flag", keys: ["viewBox", "paths"], pool: "flag" },
  shapePick: { has: shapeFor, field: "shape", keys: ["viewBox", "d", "fillRule"], pool: "shape" },
};

/** A pick challenge with real options, built the way `buildCard` builds one. */
function pickItem(kind: PickKind, subject: string, exclude: ReadonlySet<string> = new Set(), rand = mulberry(7)): Challenge {
  const options = KINDS[kind].buildOptions!(subject, exclude, rand);
  return { kind, subject, options };
}

/** The union is discriminated by a literal, which a loop variable cannot narrow. */
const optionsOf = (p: Prompt): readonly Record<string, unknown>[] =>
  "options" in p ? (p.options as readonly Record<string, unknown>[]) : [];
const countryOf = (p: Prompt): string => ("country" in p ? p.country : "");

/** A deterministic PRNG, so "shuffled" is testable rather than hopeful. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("D-65: four of the eight are the answer's nearest, and the rest are strangers", () => {
  for (const kind of PICKS) {
    const rand = mulberry(5);
    const pool = KINDS[kind].pool();
    for (const c of pool) {
      const options = KINDS[kind].buildOptions!(c.code, new Set(), rand);
      // The nearest four by centroid — the same measure the compass hint uses.
      const nearest = pool
        .filter((o) => o.code !== c.code)
        .sort((a, b) => distanceKm(c.centroid, a.centroid) - distanceKm(c.centroid, b.centroid))
        .slice(0, PICK_NEAR - 1)
        .map((o) => o.code);
      for (const n of nearest) assert.ok(options.includes(n), `${kind} ${c.code}: ${n} is a neighbour and was left out`);
      // And the other three are NOT the next-nearest: they are drawn at random
      // from the rest, which is what keeps a card from being a geography lesson.
      assert.equal(options.length, PICK_OPTIONS);
      assert.equal(new Set(options).size, PICK_OPTIONS);
    }
  }
});

test("D-65: the neighbourhood is measurably closer than the strangers", () => {
  for (const kind of PICKS) {
    const rand = mulberry(9);
    const pool = KINDS[kind].pool();
    let nearTotal = 0;
    let farTotal = 0;
    for (const c of pool) {
      const options = KINDS[kind].buildOptions!(c.code, new Set(), rand);
      const km = options.filter((o) => o !== c.code).map((o) => distanceKm(c.centroid, countryByCode(o)!.centroid));
      km.sort((a, b) => a - b);
      nearTotal += km.slice(0, PICK_NEAR - 1).reduce((n, d) => n + d, 0) / (PICK_NEAR - 1);
      farTotal += km.slice(PICK_NEAR - 1).reduce((n, d) => n + d, 0) / (PICK_OPTIONS - PICK_NEAR);
    }
    const near = nearTotal / pool.length;
    const far = farTotal / pool.length;
    // Uniform distractors averaged about 9000 km from the answer. The point of
    // D-65 is that half the board is now regional, so the near four must be a
    // different order of magnitude, not merely a bit closer.
    assert.ok(near < far / 4, `${kind}: near ${Math.round(near)} km vs far ${Math.round(far)} km`);
  }
});

test("FR-8.7: eight options, the answer among them exactly once", () => {
  for (const kind of PICKS) {
    const rand = mulberry(1);
    for (const c of KINDS[kind].pool()) {
      const options = KINDS[kind].buildOptions!(c.code, new Set(), rand);
      assert.equal(options.length, PICK_OPTIONS, `${kind} ${c.code}: wrong option count`);
      assert.equal(options.filter((o) => o === c.code).length, 1, `${kind} ${c.code}: the answer must appear once`);
      assert.equal(new Set(options).size, PICK_OPTIONS, `${kind} ${c.code}: options must be distinct`);
      for (const o of options) assert.ok(ART[kind].has(o), `${o} has no ${ART[kind].field} and cannot be an option`);
    }
  }
});

test("FR-8.7: distractors avoid the exclusion window, and never drop below eight to do it", () => {
  for (const kind of PICKS) {
    const pool = KINDS[kind].pool().map((c) => c.code);
    const exclude = new Set(pool.filter((c) => c !== "BR").slice(0, 40));
    const options = KINDS[kind].buildOptions!("BR", exclude, mulberry(3));
    assert.equal(options.length, PICK_OPTIONS);
    for (const o of options) assert.ok(o === "BR" || !exclude.has(o), `${kind}: ${o} is excluded and was offered anyway`);

    // Exclude all but four: the window has to give way rather than deal a short
    // hand, because a card of eight options with five in it is a different game.
    const nearlyAll = new Set(pool.filter((c) => c !== "BR").slice(4));
    const squeezed = KINDS[kind].buildOptions!("BR", nearlyAll, mulberry(4));
    assert.equal(squeezed.length, PICK_OPTIONS, `${kind}: a tight window must not shrink the question`);
    assert.ok(squeezed.includes("BR"));
  }
});

test("SEC-1: a pick prompt names the country it ASKS about and nothing that identifies the answer", () => {
  for (const kind of PICKS) {
    const item = pickItem(kind, "BR");
    const p = KINDS[kind].prompt(item);
    assert.equal(p.kind, kind);
    assert.equal(countryOf(p), "Brasil");
    assert.equal(optionsOf(p).length, PICK_OPTIONS);

    // The options carry artwork and nothing else: no code, no name, no id, in
    // any locale. Position is the only handle, and the guess is an index.
    const json = JSON.stringify(optionsOf(p));
    for (const code of item.options!) {
      const c = countryByCode(code)!;
      for (const term of [`"${c.code}"`, c.code3, c.names.en, c.names["pt-BR"]]) {
        assert.ok(!json.includes(term), `${kind}: the options leak ${term}`);
      }
    }
  }
});

test("SEC-1: no option in the whole pool ever carries a country's name or code", () => {
  for (const kind of PICKS) {
    const rand = mulberry(11);
    for (const c of KINDS[kind].pool()) {
      const p = KINDS[kind].prompt(pickItem(kind, c.code, new Set(), rand));
      const options = JSON.parse(JSON.stringify(optionsOf(p))) as Record<string, Record<string, unknown>>[];
      for (const option of options) {
        // One field, and inside it only the keys the artwork is made of. A
        // silhouette is a path and a fill rule; a flag is paths and colours.
        assert.deepEqual(Object.keys(option), [ART[kind].field], `${kind} ${c.code}: unexpected option field`);
        for (const key of Object.keys(option[ART[kind].field]!)) {
          assert.ok(ART[kind].keys.includes(key), `${kind} ${c.code}: unexpected artwork field ${key}`);
        }
      }
    }
  }
});

test("D-76: the reveal names every option, in the board's own order", () => {
  for (const kind of PICKS) {
    const rand = mulberry(29);
    for (const c of KINDS[kind].pool()) {
      const item = pickItem(kind, c.code, new Set(), rand);
      const r = KINDS[kind].reveal(item);
      assert.equal(r.names?.length, PICK_OPTIONS, `${kind} ${c.code}: one name per option`);
      // Board order, not pool order and not sorted: the name under tile i has
      // to be the country whose artwork is on tile i, or the reveal teaches the
      // wrong flag to everyone who reads it.
      item.options!.forEach((code, i) => {
        assert.equal(r.names![i], countryByCode(code)!.names["pt-BR"], `${kind} ${c.code}: name ${i} is off by position`);
      });
      assert.equal(r.names![r.pick!], r.name, `${kind} ${c.code}: the named answer is the one at pick`);
      assert.equal(item.options![r.pick!], item.subject);
    }
  }
});

test("D-76: names belong to a pick kind and nothing else", () => {
  // `Reveal.names` is the option-to-country mapping. A kind with no options has
  // no mapping to leak, and must not grow a field that implies it has one.
  for (const id of KIND_IDS) {
    if ((PICKS as readonly KindId[]).includes(id)) continue;
    // `person` needs the one thing its card fixed for it (D-78); every other
    // kind's reveal follows from the subject alone.
    const chosen = id === "person" ? { person: peopleFor("BR")[0]!.wd } : {};
    const r = KINDS[id].reveal({ kind: id, subject: "BR", ...chosen });
    assert.equal(r.names, undefined, `${id} has no options and must have no names`);
    assert.equal(r.pick, undefined, `${id} has no options and must have no pick`);
  }
});

test("FR-8.7: a pick is graded by index, and only an index in range is a guess", () => {
  for (const kind of PICKS) {
    const item = pickItem(kind, "BR");
    const right = item.options!.indexOf("BR");
    const wrong = (right + 1) % PICK_OPTIONS;

    assert.equal(KINDS[kind].grade(item, right, T0).correct, true);
    assert.equal(KINDS[kind].grade(item, wrong, T0).correct, false);
    assert.deepEqual(KINDS[kind].grade(item, right, T0).guess, { pick: right, proximity: 1, at: T0 });
    assert.equal(KINDS[kind].grade(item, wrong, T0).guess.proximity, 0, "there is no nearly");

    for (const bad of ["0", null, {}, [], true, NaN, Infinity, 1.5, -1, PICK_OPTIONS, "BR"]) {
      rejects(() => KINDS[kind].grade(item, bad, T0), "invalid-argument");
    }
  }
});

test("FR-8.7: a choice item with no options is a broken challenge, not a crash", () => {
  for (const kind of PICKS) {
    const bare: Challenge = { kind, subject: "BR" };
    rejects(() => KINDS[kind].prompt(bare), "not-found");
    rejects(() => KINDS[kind].grade(bare, 0, T0), "not-found");
  }
});

test("FR-8.7: wasCorrect reads a stored pick back, for the share grid", () => {
  for (const kind of PICKS) {
    const item = pickItem(kind, "BR");
    const right = item.options!.indexOf("BR");
    assert.equal(KINDS[kind].wasCorrect(item, KINDS[kind].grade(item, right, T0).guess), true);
    assert.equal(
      KINDS[kind].wasCorrect(item, KINDS[kind].grade(item, (right + 3) % PICK_OPTIONS, T0).guess),
      false,
    );
    // A country guess belongs to another kind and is never this one's answer.
    assert.equal(KINDS[kind].wasCorrect(item, KINDS.shape.grade(ch("shape", "BR"), "BR", T0).guess), false);
  }
});

test("D-64: the reveal is WHICH option, because the prompt already named the country", () => {
  for (const kind of PICKS) {
    const item = pickItem(kind, "BR");
    const r = KINDS[kind].reveal(item);
    assert.equal(r.name, "Brasil");
    assert.equal(r.pick, item.options!.indexOf("BR"));
    assert.ok(r.pick! >= 0 && r.pick! < PICK_OPTIONS);
  }
  // Every other kind still reveals a name and no index.
  assert.equal(KINDS.shape.reveal(ch("shape", "BR")).pick, undefined);
});

test("D-64: two guesses at [6, 2] — a blind picker scores on a quarter of items, not two fifths", () => {
  for (const kind of PICKS) {
    assert.equal(KINDS[kind].maxGuesses, 2);
    assert.deepEqual([...KINDS[kind].pointsByGuess], [6, 2]);
  }
  // 1/8 + 7/8 × 1/7. At three guesses this would be 0.40, which is what the
  // budget is for: FR-8.2 asks a card of mixed kinds to be summable.
  const blind = 1 / 8 + (7 / 8) * (1 / 7);
  assert.ok(Math.abs(blind - 0.25) < 1e-9);
});

test("a pick kind asks about exactly what the kind it inverts asks about", () => {
  for (const kind of PICKS) {
    assert.deepEqual(
      KINDS[kind].pool().map((c) => c.code),
      KINDS[ART[kind].pool].pool().map((c) => c.code),
      `${kind} must ask about exactly what ${ART[kind].pool} asks about`,
    );
  }
});

test("D-64: eight flags is a bigger prompt than one, and bounded", () => {
  const rand = mulberry(13);
  const pool = KINDS.flagPick.pool();
  const sizes = pool
    .map((c) => JSON.stringify(KINDS.flag.prompt(ch("flag", c.code))).length)
    .sort((a, b) => b - a);

  // The real bound, not a sampled one: the eight largest flags in the pool, all
  // in one question. Median artwork is about 0.5 KB and the mean about 3.4 KB,
  // but the tail runs to 34 KB — Portugal, Brazil and Fiji carry whole coats of
  // arms — so a sampled worst case understates it by a factor of three.
  // 266 KB today. It was 220 KB until the converter stopped rounding fine
  // detail away: Fiji, Portugal and Sri Lanka all got heavier by getting
  // COMPLETE, and that is the honest weight of the question. The bound is here
  // to catch artwork ballooning, not to pin the current number.
  const worstPossible = sizes.slice(0, PICK_OPTIONS).reduce((n, b) => n + b, 0);
  assert.ok(worstPossible < 300_000, `eight of the largest flags would be ${worstPossible} bytes`);

  // What a question actually weighs, over the whole pool.
  let total = 0;
  for (const c of pool) total += JSON.stringify(KINDS.flagPick.prompt(pickItem("flagPick", c.code, new Set(), rand))).length;
  assert.ok(total / pool.length < 60_000, `the average flagPick prompt is ${Math.round(total / pool.length)} bytes`);

  // NOT a licence to pick small distractors. Choosing options by weight would
  // make a complex flag rarer as a distractor than as an answer, and a player
  // who noticed would take the busiest flag on the board every time. The size
  // is the cost of the question being fair.
});

test("D-72: eight silhouettes weigh less than eight flags, and are bounded too", () => {
  const rand = mulberry(17);
  const pool = KINDS.shapePick.pool();
  const sizes = pool
    .map((c) => JSON.stringify(KINDS.shape.prompt(ch("shape", c.code))).length)
    .sort((a, b) => b - a);

  // The silhouettes have no tail: the build simplifies every one of them to a
  // byte budget, so the eight largest in the pool are within a factor of three
  // of the mean rather than ten times it.
  const worstPossible = sizes.slice(0, PICK_OPTIONS).reduce((n, b) => n + b, 0);
  assert.ok(worstPossible < 96_000, `eight of the largest silhouettes would be ${worstPossible} bytes`);

  let total = 0;
  for (const c of pool) total += JSON.stringify(KINDS.shapePick.prompt(pickItem("shapePick", c.code, new Set(), rand))).length;
  const mean = total / pool.length;
  assert.ok(mean < 40_000, `the average shapePick prompt is ${Math.round(mean)} bytes`);

  // The same rule as above, and it bites harder here: every silhouette is drawn
  // into the same 500×500 box, so SIZE IS NOT A CUE on the board — Monaco fills
  // it exactly as Russia does. Do not choose distractors by path length either.
});

// --- D-78: person -----------------------------------------------------------

/** The tools' leak guard, restated for the data the SERVER actually serves.
 *  Long words match as a prefix so "Brasil" catches "brasileiro". */
const namesCountry = (text: string, words: readonly string[]): boolean => {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = norm(text).split(" ").filter(Boolean);
  return words.map(norm).filter((w) => w.length >= 2).some((w) =>
    w.includes(" ") ? ` ${tokens.join(" ")} `.includes(` ${w} `) : w.length >= 5 ? tokens.some((t) => t.startsWith(w)) : tokens.includes(w),
  );
};

const personCh = (subject: string, wd = peopleFor(subject)[0]!.wd): Challenge => ({ kind: "person", subject, person: wd });

test("FR-8.4 / D-78: the person prompt is a name, a photo and a credit, and nothing else", () => {
  const subject = KINDS.person.pool()[0]!.code;
  const p = KINDS.person.prompt(personCh(subject)) as Extract<Prompt, { kind: "person" }>;
  assert.deepEqual(Object.keys(p).sort(), ["credit", "kind", "name", "photo"]);
  assert.match(p.photo, /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//);
});

test("D-78: no prompt in the whole pool names its own answer — not the country, not the birth city", () => {
  // The two fields that would give it away are the ones the record carries and
  // the prompt must not: `bplace` (a city names its country) and Pantheon's
  // `description` ("Turkish actor"), which the build never copies. This walks
  // every person of every country rather than sampling, because a single bad
  // caption is a broken challenge for whoever draws it.
  let checked = 0;
  for (const country of KINDS.person.pool()) {
    const c = countryByCode(country.code)!;
    for (const person of peopleFor(c.code)) {
      const p = KINDS.person.prompt(personCh(c.code, person.wd)) as Extract<Prompt, { kind: "person" }>;
      // The three strings a player can actually read. The FILENAME is checked
      // decoded, because that is the form it is read in and the encoded form
      // is a trap: Rumi's photo is titled in Arabic, and percent-encoding it
      // produces the byte "%D8%AF" — whose hex pair is the token "AF", which
      // is Afghanistan, which is where he was born. A scan of the raw URL
      // calls that a leak and it is not one.
      const file = decodeURIComponent(p.photo.split("/Special:FilePath/")[1]!.split("?")[0]!);
      const words = [c.names["pt-BR"], c.names.en, c.code, c.code3];
      // The author, not the licence that follows it. Every CC licence contains
      // "BY" — which is Belarus — and that says nothing about anyone, because
      // it says the same thing about everyone. What the build DOES strip is the
      // licence's jurisdiction port ("CC BY 3.0 br"), which really does turn up
      // on Brazilians; `displayLicence` in tools/lib/people.mjs has the case.
      for (const text of [p.name, person.credit, file]) {
        assert.ok(!namesCountry(text, words), `prompt for ${c.code} leaks the country: ${text}`);
        if (person.bplace) assert.ok(!namesCountry(text, [person.bplace]), `prompt for ${c.code} leaks the birth city: ${text}`);
      }
      const json = JSON.stringify(p);
      assert.ok(!json.includes("centroid") && !json.includes(String(c.centroid[0])), `prompt for ${c.code} leaks a centroid`);
      checked++;
    }
  }
  assert.ok(checked > 300, `only ${checked} prompts checked — the pool looks empty`);
});

test("D-78: six guesses on shape's ladder, not capital's three", () => {
  // Raised from three on the day it shipped (Paulo, 2026-09-24). Recognising
  // the face is the first half of the question; the rest is geography, and
  // that is what the long ladder pays for. A silent revert to [6, 4, 2] would
  // cost four guesses without changing a single test that does not say so.
  assert.equal(KINDS.person.maxGuesses, 6);
  assert.deepEqual(KINDS.person.pointsByGuess, [6, 5, 4, 3, 2, 1]);
  assert.deepEqual(KINDS.person.pointsByGuess, KINDS.shape.pointsByGuess, "the same ladder, on purpose");
});

test("D-78: the pool is every country with somebody, and it clears the 30-day window", () => {
  const pool = KINDS.person.pool();
  assert.ok(pool.length > 30, `pool of ${pool.length} cannot honour a 30-day window`);
  for (const c of pool) assert.ok(peopleFor(c.code).length > 0);
  for (const c of COUNTRIES.values()) {
    if (peopleFor(c.code).length === 0) assert.ok(!pool.some((p) => p.code === c.code), `${c.code} is in the pool with nobody in it`);
  }
});

test("D-78: the person is chosen when the card is built and read back by id", () => {
  const subject = KINDS.person.pool()[0]!.code;
  const wds = peopleFor(subject).map((p) => p.wd);
  // Whatever `buildDetail` returns must be one of this country's people, for
  // every draw of the stream — a person from another country would be the
  // answer to a different question.
  for (let i = 0; i < 50; i++) {
    const chosen = KINDS.person.buildDetail!(subject, () => i / 50);
    assert.ok(wds.includes(chosen!), `${chosen} is not one of ${subject}'s people`);
  }
  // And an id nobody has is a missing challenge, not a silent fallback to
  // somebody else: the player would come back to a different face.
  rejects(() => KINDS.person.prompt({ kind: "person", subject, person: "Q0" }), "not-found");
  rejects(() => KINDS.person.prompt({ kind: "person", subject }), "not-found");
});

test("D-78: the reveal names the country and, where we know it, the city", () => {
  const subject = KINDS.person.pool().find((c) => peopleFor(c.code).some((p) => p.bplace))!.code;
  const person = peopleFor(subject).find((p) => p.bplace)!;
  const r = KINDS.person.reveal(personCh(subject, person.wd));
  assert.equal(r.code, subject);
  assert.equal(r.name, countryByCode(subject)!.names["pt-BR"]);
  assert.equal(r.bornIn, person.bplace);
});

test("D-81: the reveal carries the bio and its link, together or not at all", () => {
  const withBio = KINDS.person.pool()
    .flatMap((c) => peopleFor(c.code).map((p) => ({ code: c.code, p })))
    .find(({ p }) => p.about)!;
  const r = KINDS.person.reveal(personCh(withBio.code, withBio.p.wd));
  assert.equal(r.about, withBio.p.about);
  assert.equal(r.wiki, withBio.p.wiki);
  assert.match(r.wiki!, /^https:\/\/pt\.wikipedia\.org\/wiki\//);

  // 24 of the 1,013 have no pt article. Their reveal is the country and the
  // city, exactly as it was before D-81 — not an empty paragraph.
  const without = KINDS.person.pool()
    .flatMap((c) => peopleFor(c.code).map((p) => ({ code: c.code, p })))
    .find(({ p }) => !p.about);
  if (without) {
    const bare = KINDS.person.reveal(personCh(without.code, without.p.wd));
    assert.equal(bare.about, undefined);
    assert.equal(bare.wiki, undefined);
  }
});

test("D-81: no bio is ever half a bio, anywhere in the pool", () => {
  // The text is CC BY-SA and the link is the attribution, so one without the
  // other is not something we are licensed to render. Cheaper to pin here than
  // to remember it in three view layers.
  for (const country of KINDS.person.pool()) {
    for (const person of peopleFor(country.code)) {
      assert.equal(
        Boolean(person.about), Boolean(person.wiki),
        `${country.code} ${person.name}: about and wiki must travel together`,
      );
    }
  }
});

test("SEC-17 / D-81: the bio cannot reach an open challenge, for ANY person", () => {
  // The single-person version of this test has existed since D-78. D-81 added a
  // field to the record that names the country in its FIRST LINE — "foi uma
  // condessa húngara" — so the guard is now walked over the whole pool: every
  // prompt the game can build, pinned to the same four keys.
  let checked = 0;
  for (const country of KINDS.person.pool()) {
    for (const person of peopleFor(country.code)) {
      const prompt = KINDS.person.prompt(personCh(country.code, person.wd));
      assert.deepEqual(
        Object.keys(prompt).sort(), ["credit", "kind", "name", "photo"],
        `${country.code} ${person.name}: the prompt grew a key`,
      );
      checked++;
    }
  }
  assert.ok(checked > 900, `expected the whole pool, walked ${checked}`);
});

test("D-78: people.json carries no description and no occupation", () => {
  // Pantheon's description is "Turkish actor and fashion model (born 1986)".
  // The build does not copy it; this is the test that says so out loud, because
  // the next person to widen the build will read it before adding a field.
  const json = JSON.stringify(peopleJson);
  assert.equal(json.includes('"description"'), false);
  assert.equal(json.includes('"occupation"'), false);
});
