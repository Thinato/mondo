/**
 * Typed country names → a code, for Batata Quente (FR-12.3, D-90). Pure.
 *
 * Every other kind takes a country CODE from the client, because the client's
 * autocomplete has already turned what was typed into one (FR-6.3). Batata
 * Quente has no autocomplete on purpose — suggestions would make "one wrong
 * character" meaningless — so this is the only place the server reads text.
 *
 * The rules, in the order they are tried:
 * 1. The pt-BR name or any alias, compared after `normalize` (accents, case and
 *    punctuation do not count: "Japao" IS "Japão").
 * 2. Otherwise, any of those within ONE edit — but only for terms of at least
 *    four characters, the same floor the client autocomplete uses before it
 *    fuzzes, because one edit away from "Irã" is half the Middle East.
 * 3. A one-edit guess that fits two countries is refused as ambiguous rather
 *    than guessed: the player meant one of them and we cannot know which.
 *
 * Terms of two characters or fewer are not terms at all. world-countries ships
 * ISO codes among its alternate spellings, and "BR" is not naming a country in
 * a game that is about naming them.
 */

import { COUNTRIES } from "./countries";

/**
 * Lowercase, strip diacritics, collapse punctuation and whitespace to single
 * spaces. A copy of site/app/normalize.js — the server cannot import from
 * site/, and `match.test.ts` pins the two to the same outputs.
 */
export function normalize(text: string): string {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Edit distance, but only ever asked "is it 0, 1, or more?": anything past 1 returns 2. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(prev[b.length]!, 2);
}

export const MIN_TERM = 3;
export const MIN_FUZZY = 4;

/** normalised term → the one country it names. tools/build-geo.mjs refuses a term two countries share. */
const TERMS: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const c of COUNTRIES.values()) {
    for (const raw of [c.names["pt-BR"], ...c.aliases]) {
      const key = normalize(raw);
      if (key.length >= MIN_TERM) out.set(key, c.code);
    }
  }
  return out;
})();

export type MatchResult = { code: string } | { error: "unknown" | "ambiguous" };

export function matchCountry(text: string): MatchResult {
  const key = normalize(text);
  if (key.length < MIN_TERM) return { error: "unknown" };
  const exact = TERMS.get(key);
  if (exact) return { code: exact };
  if (key.length < MIN_FUZZY) return { error: "unknown" };

  const near = new Set<string>();
  for (const [term, code] of TERMS) {
    if (term.length >= MIN_FUZZY && editDistance(key, term) <= 1) near.add(code);
  }
  if (near.size === 1) return { code: [...near][0]! };
  return { error: near.size === 0 ? "unknown" : "ambiguous" };
}
