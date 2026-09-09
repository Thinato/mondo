// Country search (FR-6.3, FR-6.4, FR-2.6).
//
// Matches on English and pt-BR names, alpha-2/alpha-3 codes and the curated
// aliases from countries.min.json, diacritic- and case-insensitive through the
// same normalize() the build used for its uniqueness check. Prefix first, then
// substring, then Levenshtein ≤ 2 on whole names as a last resort.

import { normalize } from "./normalize.js";

export async function loadCountries(url = "./data/countries.min.json") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`countries: ${res.status}`);
  return res.json();
}

/** Build the search index once. Returns { search(query), byCode }. */
export function createIndex(countries) {
  const entries = countries.map((c) => ({
    code: c.code,
    label: c.pt,
    en: c.en,
    terms: [c.pt, c.en, c.code, c.code3, ...(c.aliases ?? [])].map(normalize).filter(Boolean),
  }));
  const byCode = new Map(entries.map((e) => [e.code, e]));

  function search(query, limit = 8) {
    const q = normalize(query);
    if (!q) return [];
    const exact = [], prefix = [], substring = [], fuzzy = [];
    for (const e of entries) {
      if (e.terms.includes(q)) exact.push(e);
      else if (e.terms.some((t) => t.startsWith(q))) prefix.push(e);
      else if (e.terms.some((t) => t.includes(q))) substring.push(e);
      else if (q.length >= 4 && [normalize(e.label), normalize(e.en)].some((t) => levenshtein(q, t) <= 2)) fuzzy.push(e);
    }
    const byLabel = (a, b) => a.label.localeCompare(b.label, "pt-BR");
    return [...exact, ...prefix.sort(byLabel), ...substring.sort(byLabel), ...fuzzy.sort(byLabel)].slice(0, limit);
  }

  /** The single country a query resolves to, or null (FR-2.6). */
  function resolve(query) {
    const q = normalize(query);
    if (!q) return null;
    const exact = entries.filter((e) => e.terms.includes(q));
    if (exact.length === 1) return exact[0];
    const all = search(query, 2);
    return all.length === 1 ? all[0] : null;
  }

  return { search, resolve, byCode };
}

/**
 * Wire an <input> + <ul role="listbox"> pair. `onPick(entry)` fires when the
 * player commits a country (click, Enter on a highlighted option, or Enter on
 * text that resolves to exactly one). Keyboard: ↓ ↑ Enter Esc.
 */
export function attach({ input, list, index, onPick, onMiss }) {
  let items = [];
  let active = -1;

  const close = () => { items = []; active = -1; list.hidden = true; list.replaceChildren(); input.removeAttribute("aria-activedescendant"); };
  const render = () => {
    list.replaceChildren(...items.map((e, i) => {
      const li = document.createElement("li");
      li.id = `opt-${e.code}`;
      li.role = "option";
      li.textContent = e.label;
      if (e.en !== e.label) {
        const small = document.createElement("small");
        small.textContent = ` ${e.en}`;
        li.appendChild(small);
      }
      li.setAttribute("aria-selected", String(i === active));
      li.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(e); });
      return li;
    }));
    list.hidden = items.length === 0;
    input.setAttribute("aria-expanded", String(items.length > 0));
    if (active >= 0) input.setAttribute("aria-activedescendant", `opt-${items[active].code}`);
    else input.removeAttribute("aria-activedescendant");
  };
  const pick = (e) => { input.value = e.label; close(); onPick(e); };

  input.addEventListener("input", () => { items = index.search(input.value); active = items.length ? 0 : -1; render(); });
  input.addEventListener("focus", () => { if (input.value) { items = index.search(input.value); active = items.length ? 0 : -1; render(); } });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" && items.length) { ev.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (ev.key === "ArrowUp" && items.length) { ev.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (ev.key === "Escape") { close(); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      if (active >= 0 && items[active]) return pick(items[active]);
      const one = index.resolve(input.value);
      if (one) return pick(one);
      onMiss?.(input.value);
    }
  });
  return { close, commit: () => { const one = active >= 0 ? items[active] : index.resolve(input.value); if (one) pick(one); else onMiss?.(input.value); } };
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3; // cheap exit: caller only cares about ≤ 2
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
