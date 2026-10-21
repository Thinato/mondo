// Pure helpers for build-gdp.mjs. No I/O.
//
// The R-1 measurement (D-108): a Fronteiras territory is worth the quintile of a
// figure within its continent, and that figure must not be the `gdp` answer in
// disguise. `quintiles` is the binning the board would use and `spearman` says
// how far it ranks countries the way the per-capita answer does.

/** code → 1..5 by ascending value: the bottom fifth is 1, the top fifth 5. */
export function quintiles(values) {
  const sorted = Object.entries(values).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return Object.fromEntries(sorted.map(([code], i) => [code, 1 + Math.floor((5 * i) / sorted.length)]));
}

/** Average ranks, so tied tiers share one — what makes this Spearman rather than Pearson on tiers. */
function ranks(xs) {
  const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

/** Spearman's ρ of two equal-length series. */
export function spearman(xs, ys) {
  const a = ranks(xs), b = ranks(ys);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/**
 * `values` is the answer of every seeded `gdp` day and `growth` is its hint
 * (D-101): a build that only ADDS a section must leave both byte-identical.
 */
export function refuseChanges(before, after) {
  for (const k of ["values", "growth"]) {
    if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) throw new Error(`${k} changed — refusing`);
  }
  return after;
}
