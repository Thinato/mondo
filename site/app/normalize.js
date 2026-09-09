// Text normalisation for country matching (FR-6.3).
//
// One implementation, used in two places: the browser autocomplete and the
// build-time duplicate check in tools/build-geo.mjs. If they ever disagree, a
// name that the build thinks is unique could be ambiguous to the player, or
// vice versa. Node imports this file directly — keep it free of browser APIs.

/**
 * Lowercase, strip diacritics, collapse punctuation and whitespace to single
 * spaces. "São Tomé & Príncipe" → "sao tome principe"; "Timor-Leste" → "timor leste".
 */
export function normalize(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks left behind by NFD
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
