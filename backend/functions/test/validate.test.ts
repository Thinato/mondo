import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsError } from "firebase-functions/v2/https";
import { requireCountryCode, requireDisplayName, requireLocale, requireObject, requirePuzzleId } from "../src/lib/validate";

const invalidArgument = (fn: () => unknown) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError);
    assert.equal(e.code, "invalid-argument");
    assert.deepEqual(e.details, { code: "invalid-argument" });
    return true;
  });

test("SEC-8: requireObject rejects everything that is not a plain object", () => {
  for (const bad of [null, undefined, "x", 1, true, [], () => {}]) invalidArgument(() => requireObject(bad));
  assert.deepEqual(requireObject({ a: 1 }), { a: 1 });
});

test("SEC-8: requirePuzzleId accepts real dates only", () => {
  assert.equal(requirePuzzleId("2026-09-15"), "2026-09-15");
  assert.equal(requirePuzzleId("2028-02-29"), "2028-02-29");
  for (const bad of ["2026-9-15", "2026-02-30", "2026-13-01", "20260915", "2026-09-15T00:00:00Z", 20260915, "", null]) {
    invalidArgument(() => requirePuzzleId(bad));
  }
});

test("SEC-8: requireCountryCode accepts only codes in the pool", () => {
  assert.equal(requireCountryCode("BR"), "BR");
  assert.equal(requireCountryCode("XK"), "XK");
  for (const bad of ["br", "BRA", "GL", "PR", "ZZ", "", 1, null, ["BR"]]) invalidArgument(() => requireCountryCode(bad));
});

test("FR-1.3: requireDisplayName mirrors the rules — length, alphabet, edges", () => {
  for (const ok of ["Ana", "Capivara Veloz_2", "pinguim-veloz-4821", "José Ângelo", "a".repeat(24), "日本語の名前"]) {
    assert.equal(requireDisplayName(ok), ok);
  }
  for (const bad of ["ab", "a".repeat(25), " capivara", "capivara ", "capi@vara", "a@b.com", "", 123, null, "tab\tname"]) {
    invalidArgument(() => requireDisplayName(bad));
  }
});

test("requireLocale accepts pt-BR and en only", () => {
  assert.equal(requireLocale("pt-BR"), "pt-BR");
  assert.equal(requireLocale("en"), "en");
  for (const bad of ["fr", "PT-BR", "", null, 1]) invalidArgument(() => requireLocale(bad));
});
