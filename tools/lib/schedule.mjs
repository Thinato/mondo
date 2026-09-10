// Pure schedule generation. No I/O. See 03-geo-data-pipeline.md §6.
//
// FR-2.1  one puzzle per day, puzzleId = the date it opens, day flips at noon São Paulo (OQ-2)
// FR-2.2  answers come from a pre-generated schedule, never chosen at request time
// FR-2.3  no country repeats: see the two windows below (D-52)
// FR-2.4  tier mix targets 50 / 35 / 15
//
// D-52 — a day is one challenge of every kind, so a day spends THREE countries.
// The old "no repeat within 180 days" is arithmetically impossible at that rate:
// 180 days × 3 = 540 draws from a pool of 196. It is replaced by two windows,
// which together say what the old one meant:
//
//   KIND_WINDOW (120 days)  the same country is not asked BY THE SAME KIND again.
//                           Bounded by the smallest pool: 172 flags, so 120 days
//                           leaves 52 spare rather than forcing every flag in.
//   DAY_WINDOW   (30 days)  the same country is not asked AT ALL again, by any
//                           kind. Without it Paraguay could be the silhouette on
//                           Monday and the flag on Thursday, which reads as a
//                           bug even though it is two different questions.
//
// And a country is never used twice on the same day.
//
// Determinism: same inputs + same seed → byte-identical output, so the schedule
// can be regenerated from its seed rather than backed up (05-cost.md).

export const PUZZLE_TIMEZONE = "America/Sao_Paulo";
export const PUZZLE_ROLLOVER_HOUR = 12;
export const DEFAULT_WEIGHTS = { 1: 0.5, 2: 0.35, 3: 0.15 };
export const KIND_WINDOW = 120;
export const DAY_WINDOW = 30;
/** The order challenges are drawn in. The order they are PLAYED in is shuffled. */
export const KINDS = ["shape", "flag", "capital"];

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
 * Pool membership per kind, derived from the same two data files the server
 * reads.
 *
 * **This duplicates the rules in backend/functions/src/lib/kinds.ts**, which is
 * the authority — a generator that cannot import the server's TypeScript is the
 * price of keeping the schedule an offline artefact (FR-2.2). The guard against
 * drift is that both sides pin their pool sizes in tests, so a change to either
 * rule fails one of them loudly.
 */
export function poolsFrom(countriesJson, flagsJson) {
  const fold = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const namesItsCapital = (c) => {
    const cap = fold(c.capital?.["pt-BR"] ?? "");
    const name = fold(c.names["pt-BR"]);
    return cap.length > 0 && (cap.includes(name) || name.includes(cap));
  };
  const withTier = (list) => list.map((c) => ({ code: c.code, tier: c.tier }));
  const hasFlag = new Set(Object.keys(flagsJson.flags));
  return {
    shape: withTier(countriesJson.countries),
    capital: withTier(countriesJson.countries.filter((c) => c.capital?.["pt-BR"] && !namesItsCapital(c))),
    flag: withTier(countriesJson.countries.filter((c) => hasFlag.has(c.code))),
  };
}

/**
 * @param {object} o
 * @param {Record<string,{code:string,tier:1|2|3}[]>} o.pools  one pool per kind (poolsFrom)
 * @param {number} o.seed
 * @param {string} o.start        "YYYY-MM-DD", first puzzleId
 * @param {number} [o.days=365]
 * @param {number} [o.kindWindow=120]                 FR-2.3, per kind
 * @param {number} [o.dayWindow=30]                   FR-2.3, any kind
 * @param {Record<number,number>} [o.weights]         FR-2.4
 * @param {{puzzleId:string,items:{kind:string,subject:string}[]}[]} [o.history]  earlier
 *        schedule, so an annual re-run still honours the windows across the boundary
 * @returns {{puzzleId:string,items:{kind:string,subject:string}[],opensAt:string}[]}
 */
export function generate({ pools, seed, start, days = 365, kindWindow = KIND_WINDOW, dayWindow = DAY_WINDOW, weights = DEFAULT_WEIGHTS, history = [] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error(`start must be YYYY-MM-DD, got ${start}`);
  for (const kind of KINDS) {
    const pool = pools[kind];
    if (!pool || pool.length === 0) throw new Error(`no pool for kind ${kind}`);
    // A kind must have more countries than its window has days, or the window
    // cannot be honoured and the generator would loop or repeat silently.
    if (pool.length <= kindWindow) {
      throw new Error(`${kind}: pool of ${pool.length} is too small for a ${kindWindow}-day window`);
    }
  }

  const byTier = {};
  const tierOf = new Map();
  for (const kind of KINDS) {
    byTier[kind] = new Map();
    for (const c of pools[kind]) {
      if (!byTier[kind].has(c.tier)) byTier[kind].set(c.tier, []);
      byTier[kind].get(c.tier).push(c.code);
      tierOf.set(c.code, c.tier);
    }
  }

  const rand = prng(seed);
  const startDay = dayIndex(start);
  /** code → last day index it was used at all; and `${kind}:${code}` → last day for that kind. */
  const lastUsed = new Map();
  const bump = (key, i) => lastUsed.set(key, Math.max(lastUsed.get(key) ?? -Infinity, i));
  for (const h of history) {
    const i = dayIndex(h.puzzleId) - startDay;
    if (i >= 0) throw new Error(`history entry ${h.puzzleId} is not before start ${start}`);
    for (const it of itemsOf(h)) {
      bump(it.subject, i);
      bump(`${it.kind}:${it.subject}`, i);
    }
  }

  const out = [];
  for (let i = 0; i < days; i++) {
    const today = new Set();
    const items = KINDS.map((kind) => {
      const free = (code) =>
        !today.has(code) &&
        (lastUsed.get(code) ?? -Infinity) <= i - dayWindow &&
        (lastUsed.get(`${kind}:${code}`) ?? -Infinity) <= i - kindWindow;

      // Weighted tier draw over the tiers that still have an eligible country
      // (R-1: an empty tier is normal near the end of a window, not an error).
      const tiers = Object.entries(weights)
        .map(([t, w]) => ({ w, codes: (byTier[kind].get(Number(t)) ?? []).filter(free) }))
        .filter((p) => p.codes.length > 0);
      if (tiers.length === 0) throw new Error(`no eligible country for ${kind} on day ${i} — windows too wide for the pool`);
      const total = tiers.reduce((n, p) => n + p.w, 0);
      let r = rand() * total;
      let pick = tiers[tiers.length - 1];
      for (const p of tiers) {
        r -= p.w;
        if (r < 0) { pick = p; break; }
      }
      const subject = pick.codes[Math.floor(rand() * pick.codes.length)];
      today.add(subject);
      bump(subject, i);
      bump(`${kind}:${subject}`, i);
      return { kind, subject };
    });

    // Drawing order is fixed so the tier weighting is reproducible; PLAY order
    // is shuffled, so nobody learns "the silhouette is always first".
    shuffle(items, rand);
    const puzzleId = dateString(startDay + i);
    out.push({ puzzleId, items, opensAt: opensAt(puzzleId).toISOString() });
  }
  return out;
}

/** Fisher-Yates against the same seeded stream, so the whole file stays reproducible. */
function shuffle(xs, rand) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
}

/** A day's challenges, reading a pre-D-52 entry as a one-silhouette day. */
export function itemsOf(day) {
  if (day.items?.length) return day.items;
  if (day.countryCode) return [{ kind: "shape", subject: day.countryCode }];
  return [];
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

/**
 * Tier mix of one kind's picks, as fractions, for the report and the tests.
 * The tiers rate how recognisable a SHAPE is, so this is the real difficulty
 * curve for `shape` and a borrowed approximation for the other two — the same
 * caveat lib/card.ts carries.
 */
export function tierMix(schedule, tierOf, kind = "shape") {
  const picks = schedule.flatMap((d) => itemsOf(d).filter((it) => it.kind === kind));
  const mix = {};
  for (const it of picks) mix[tierOf.get(it.subject)] = (mix[tierOf.get(it.subject)] ?? 0) + 1 / picks.length;
  return mix;
}

/** Smallest gap in days between two uses of one country by the SAME kind. */
export function minRepeatGap(schedule) {
  const last = new Map();
  let min = Infinity;
  for (const d of schedule) {
    const i = dayIndex(d.puzzleId);
    for (const it of itemsOf(d)) {
      const key = `${it.kind}:${it.subject}`;
      if (last.has(key)) min = Math.min(min, i - last.get(key));
      last.set(key, i);
    }
  }
  return min;
}

/** Smallest gap in days between two uses of one country by ANY kind. */
export function minDayGap(schedule) {
  const last = new Map();
  let min = Infinity;
  for (const d of schedule) {
    const i = dayIndex(d.puzzleId);
    for (const it of itemsOf(d)) {
      if (last.has(it.subject)) min = Math.min(min, i - last.get(it.subject));
      last.set(it.subject, i);
    }
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
