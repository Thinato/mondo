// The pure half of the `person` build (FR-8.8, D-78). No network, no files.
//
// Everything here exists to answer one question: is this person, with this
// photo, safe to ask "where were they born?" about. The dangerous direction is
// not the obvious one. A portrait cannot leak a country, but the TEXT that
// travels with it can, and Pantheon ships a `description` field that reads
// "Turkish actor and fashion model (born 1986)" — the answer, in the prompt, in
// plain Portuguese-adjacent English. So the rule is the one invariant 1 already
// states, applied to a new surface: nothing the client receives may name, imply
// or spell the answer.

/** Accents off, case down, punctuation to spaces. Comparing "Türkiye" against
 *  "turkiye" is the whole point, and a file title is punctuation soup. */
export function normalize(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Every word that would hand over this country, for the leak guard below.
 *
 * The birth CITY is in here beside the country: Königsberg is not Russia's
 * name, but a player reading it in a filename has the answer just the same, and
 * the reveal is where a birthplace belongs.
 */
export function avoidWords(country, { demonym = "", bplace = "", aliases = [] } = {}) {
  return [country.names["pt-BR"], country.names.en, demonym, bplace, country.code, country.code3, ...aliases]
    .map(normalize)
    .filter((w) => w.length >= 2);
}

/**
 * Does this text name the answer?
 *
 * Three rules, because one does not fit. A **short** token is matched whole:
 * `IT` sits inside "Whitman" and a substring test would reject Walt Whitman for
 * being born in the wrong country. A **long** one is matched as a word PREFIX,
 * because "Brasil" has to catch "brasileiro" and "Itália" has to catch
 * "italiano" — an adjective hands over the answer exactly as well as a noun,
 * and it is the form a caption is likeliest to use. A **phrase** is matched
 * whole, which falls out of normalising both sides to single-spaced words.
 *
 * The prefix rule will occasionally reject an innocent name that happens to
 * start like a country. That asymmetry is deliberate: a dropped candidate costs
 * one of eight, and a leak costs the challenge.
 */
export function leaksCountry(text, avoid) {
  const tokens = normalize(text).split(" ").filter(Boolean);
  const phrase = ` ${tokens.join(" ")} `;
  return avoid.some((word) => {
    if (word.includes(" ")) return phrase.includes(` ${word} `);
    if (word.length >= 5) return tokens.some((t) => t.startsWith(word));
    return tokens.includes(word);
  });
}

/**
 * Commons `extmetadata.License`, as a yes or no.
 *
 * We are hotlinking rather than redistributing, so this is not a copyright
 * gate — it is a stability one. A file that is on Commons under a free licence
 * stays there; a non-free file lives on a local wiki under a fair-use claim
 * that a reviewer can revoke tomorrow, and a challenge whose photo vanished is
 * worse than a challenge that never used it.
 *
 * `pd` covers the public-domain family including `pdm-owner`, which is an owner
 * releasing their own work. Everything unrecognised is a no — `gfdl` and `fal`
 * are free and are still refused here, because the set worth having is the one
 * that is both free and overwhelmingly common, and the build prints what it
 * dropped so widening this is a decision with a number attached.
 */
export function isFreeLicence(licence) {
  const l = normalize(licence).replace(/\s+/g, "-");
  if (!l) return false;
  return /^(pd|cc0)/.test(l) || /^cc-by(-sa)?(-\d|$)/.test(l);
}

/** Commons returns `Artist` as HTML — links, `<bdi>`, occasionally a table. The
 *  credit line wants a name, so take the text and stop at a sensible length. */
export function creditFrom(artistHtml) {
  const text = String(artistHtml ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;|&gt;/g, "")
    .replace(/\s+/g, " ")
    // Stripping `<b>Argentina</b>.` leaves a space before the full stop.
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  // Commons often carries the same author twice — a template and its own text
  // both resolving to "Unknown author" — and "Unknown author Unknown author"
  // under a photograph reads like a bug in the game rather than a gap in the
  // record. Only an exact doubling is collapsed; two different names stay.
  const halves = text.split(" ");
  if (halves.length % 2 === 0) {
    const [a, b] = [halves.slice(0, halves.length / 2).join(" "), halves.slice(halves.length / 2).join(" ")];
    if (a === b && a !== "") return a;
  }
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}

/**
 * The URL the client will hotlink.
 *
 * `Special:FilePath` rather than the direct `upload.wikimedia.org` thumbnail
 * path that the API hands back: the direct path encodes a hash of the CURRENT
 * file name, so it dies the day someone renames the file, while this one
 * redirects and survives it. `width` is what keeps a 40-megapixel scan of a
 * painting from being sent to a phone.
 */
export function photoUrl(file, width = 400) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/^File:/, ""))}?width=${width}`;
}

/**
 * The licence as it is SHOWN, with its jurisdiction port taken off.
 *
 * Commons labels a ported licence "CC BY 3.0 br", "CC BY-SA 3.0 de", "CC BY-SA
 * 3.0 igo" — and a Brazilian port turns up on photographs of Brazilians, which
 * is a faint correlation with the answer printed under the picture. It is a
 * weak signal and it is free to remove, which is the whole argument. The base
 * licence is what the credit line needs anyway, and the exact port stays one
 * click away on Commons for anyone who wants it.
 *
 * The "BY" in every CC licence is NOT treated this way: it is in all of them,
 * worldwide, so it says nothing about anybody — even though it is also
 * Belarus's country code, which is exactly the kind of coincidence a whole-pool
 * test finds and a spot check does not.
 */
export function displayLicence(label) {
  return String(label ?? "").replace(/^(CC[ -]BY(?:-SA)?(?:\s+\d[\d.]*)?)\s+[a-z]{2,3}$/i, "$1");
}

/**
 * The people a country keeps, best first.
 *
 * `hpi` is Pantheon's popularity index and it is the only ordering that makes
 * this kind fair: the question "where was this person born" is answerable only
 * if the player has heard of them, so a country's entries are its most famous
 * people and the tail is cut rather than padded. A country that cannot field
 * one leaves the pool entirely — see MIN_HPI in build-people.mjs.
 */
export function keepBest(people, max) {
  return [...people].sort((a, b) => b.hpi - a.hpi).slice(0, max);
}

/**
 * The whole filter for one candidate, so the tool is a loop and the rules are
 * here where they can be tested. Returns the entry to store, or a string saying
 * why not — the build prints those, because "we dropped 400 people" is only
 * useful if you can see what for.
 */
/**
 * The birth city, or nothing.
 *
 * Pantheon falls back to a polity when it has no settlement — Magellan's is
 * "Kingdom of Portugal" — and "nasceu em Kingdom of Portugal" is not a city,
 * is not in Portuguese, and says the answer back to the player instead of
 * teaching them where the place was. The reveal is better off with the country
 * alone than with that.
 */
export function birthPlace(bplace, country, aliases = []) {
  if (!bplace) return null;
  return leaksCountry(bplace, avoidWords(country, { aliases })) ? null : bplace;
}

export function vet(candidate, country, aliases = []) {
  const { name, wd, file, licence, credit, demonym, bplace } = candidate;
  if (!wd) return "no wikidata id";
  if (!file) return "no photo";
  if (!isFreeLicence(licence)) return `licence ${licence || "unknown"}`;
  const avoid = avoidWords(country, { demonym, bplace, aliases });
  if (leaksCountry(file, avoid)) return `filename names the answer: ${file}`;
  if (leaksCountry(name, avoid)) return `name names the answer: ${name}`;
  // The CREDIT is sent to the client too, and it is the least obvious of the
  // three: "Dubai Government Photographer" is who took the photograph and also
  // where the person was born. Dropping the person is the only option — the
  // credit is the condition we show the photo under, so it cannot be blanked.
  if (leaksCountry(credit, avoid)) return `credit names the answer: ${credit}`;
  return null;
}

/**
 * The bio shown at the REVEAL (D-81): the lead paragraph of a pt.wikipedia
 * article, trimmed to something that fits under a photograph.
 *
 * This text is the one thing about a person that is NOT vetted for naming the
 * country, and that is not an oversight — a Wikipedia lead opens "foi uma
 * condessa húngara", which is the answer in four words. It is why this may only
 * ever travel in a `Reveal`, next to `bplace`, and never in a `Prompt`. The
 * build cannot make it safe; only the path it takes can.
 *
 * Cutting happens on a sentence boundary where there is one, because half a
 * sentence with an ellipsis reads as a bug. A period only ends a sentence when
 * a space and a capital follow it, so "Dr. Martin" and "1452 a.C." survive; the
 * cost of getting that wrong is a slightly shorter bio, which is why the rule
 * is a cheap approximation rather than a parser.
 */
export function leadParagraph(text, max = 400) {
  const first = String(text ?? "").split("\n")[0].replace(/\s+/g, " ").trim();
  if (first.length <= max) return first || null;
  const head = first.slice(0, max + 1);
  const ends = [...head.matchAll(/\.(?=\s+\p{Lu})/gu)].map((m) => m.index + 1);
  if (ends.length > 0) return head.slice(0, ends.at(-1)).trim();
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head.slice(0, max)).trim() + "…";
}
