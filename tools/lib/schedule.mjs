// Pure schedule generation. No I/O. See 03-geo-data-pipeline.md §6.
//
// FR-2.1  one puzzle per day, puzzleId = the date it opens, day flips at noon São Paulo (OQ-2)
// FR-2.2  answers come from a pre-generated schedule, never chosen at request time
// FR-2.3  no country repeats within 180 days
// FR-2.4  tier mix targets 50 / 35 / 15
//
// Determinism: same inputs + same seed → byte-identical output, so the schedule
// can be regenerated from its seed rather than backed up (05-cost.md).

export const PUZZLE_TIMEZONE = "America/Sao_Paulo";
export const PUZZLE_ROLLOVER_HOUR = 12;
export const DEFAULT_WEIGHTS = { 1: 0.5, 2: 0.35, 3: 0.15 };

/** mulberry32 — small, seedable, good enough for shuffling countries. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} o
 * @param {{code:string,tier:1|2|3}[]} o.countries   the pool
 * @param {number} o.seed
 * @param {string} o.start        "YYYY-MM-DD", first puzzleId
 * @param {number} [o.days=365]
 * @param {number} [o.windowDays=180]                 FR-2.3
 * @param {Record<number,number>} [o.weights]         FR-2.4
 * @param {{puzzleId:string,countryCode:string}[]} [o.history]  earlier schedule, so an
 *        annual re-run still honours the window across the boundary
 * @returns {{puzzleId:string,countryCode:string,tier:number,opensAt:string}[]}
 */
export function generate({ countries, seed, start, days = 365, windowDays = 180, weights = DEFAULT_WEIGHTS, history = [] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error(`start must be YYYY-MM-DD, got ${start}`);
  if (countries.length <= windowDays * 0.5) {
    // Below this the window cannot be honoured for long; refuse rather than emit a
    // schedule that silently violates FR-2.3 halfway through.
    throw new Error(`pool of ${countries.length} is too small for a ${windowDays}-day no-repeat window`);
  }
  const byTier = new Map();
  for (const c of countries) {
    if (!byTier.has(c.tier)) byTier.set(c.tier, []);
    byTier.get(c.tier).push(c.code);
  }
  for (const t of Object.keys(weights)) if (!byTier.has(Number(t))) throw new Error(`no countries in tier ${t}`);
  const tierOf = new Map(countries.map((c) => [c.code, c.tier]));

  const rand = prng(seed);
  const lastUsed = new Map(); // code → day index of last use (negative for history)
  const startDay = dayIndex(start);
  for (const h of history) {
    const i = dayIndex(h.puzzleId) - startDay;
    if (i >= 0) throw new Error(`history entry ${h.puzzleId} is not before start ${start}`);
    lastUsed.set(h.countryCode, Math.max(lastUsed.get(h.countryCode) ?? -Infinity, i));
  }

  const out = [];
  for (let i = 0; i < days; i++) {
    const eligible = (t) => byTier.get(t).filter((code) => (lastUsed.get(code) ?? -Infinity) <= i - windowDays);
    // Weighted tier draw over the tiers that still have an eligible country
    // (R-1: tier 1 is 93 countries against ~90 picks per window, so an empty
    // tier is normal near the end of a window, not an error).
    const pools = Object.entries(weights)
      .map(([t, w]) => ({ tier: Number(t), w, codes: eligible(Number(t)) }))
      .filter((p) => p.codes.length > 0);
    if (pools.length === 0) throw new Error(`no eligible country on day ${i} — window too wide for the pool`);
    const total = pools.reduce((n, p) => n + p.w, 0);
    let r = rand() * total;
    let pick = pools[pools.length - 1];
    for (const p of pools) {
      r -= p.w;
      if (r < 0) { pick = p; break; }
    }
    const code = pick.codes[Math.floor(rand() * pick.codes.length)];
    lastUsed.set(code, i);
    const puzzleId = dateString(startDay + i);
    out.push({ puzzleId, countryCode: code, tier: tierOf.get(code), opensAt: opensAt(puzzleId).toISOString() });
  }
  return out;
}

/** The instant `puzzleId` opens: 12:00 in America/Sao_Paulo (OQ-2), as a Date. */
export function opensAt(puzzleId, tz = PUZZLE_TIMEZONE, hour = PUZZLE_ROLLOVER_HOUR) {
  const [y, m, d] = puzzleId.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour);
  // Subtract the zone's offset at that instant; iterate once more so a DST edge
  // on that very day resolves to the post-transition offset.
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - offsetMs(t, tz);
  return new Date(t);
}

/** Tier mix of a schedule as fractions, for the report and the tests. */
export function tierMix(schedule) {
  const n = schedule.length;
  const mix = {};
  for (const p of schedule) mix[p.tier] = (mix[p.tier] ?? 0) + 1 / n;
  return mix;
}

/** Smallest gap in days between two uses of the same country, or Infinity. */
export function minRepeatGap(schedule) {
  const last = new Map();
  let min = Infinity;
  for (const p of schedule) {
    const i = dayIndex(p.puzzleId);
    if (last.has(p.countryCode)) min = Math.min(min, i - last.get(p.countryCode));
    last.set(p.countryCode, i);
  }
  return min;
}

// ---------------------------------------------------------------------------
const DAY = 86_400_000;
function dayIndex(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}
function dateString(dayIdx) {
  return new Date(dayIdx * DAY).toISOString().slice(0, 10);
}
function offsetMs(t, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}
