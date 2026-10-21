/**
 * Fronteiras (FR-15, D-107–D-113): two players, one continent, no dice. Pure:
 * times are epoch milliseconds from the SERVER clock (invariant 3), passed in.
 *
 * A snake draft, A B B A A B, deals three territories each, and a player's
 * FIRST pick is their capital (see `draftable` for what a pick may be). Then
 * one action a turn: take a neutral territory next to one you hold, attack an
 * enemy one next to yours, fortify one of your own, or pass. Each costs gold,
 * and at the start of each of your turns you are paid one gold per territory
 * you hold — values set costs and the score, not income. Nobody attacks during
 * the first `TRUCE_PLIES` plies of play. Taking the enemy capital wins; so does
 * the other side's clock running out; after `TURNS_EACH` turns each, the more
 * value held wins and equal is a draw.
 *
 * The board carries nothing a kind asks for (SEC-19): a territory's value is
 * the per-continent quintile of TOTAL GDP (D-108), never of the per-capita
 * figure the `gdp` kind asks — `valuesOf` is handed `gdp.json.totals` and this
 * file never reads `gdp.json` at all. Everything here is public, perfect
 * information, and lives on the room.
 *
 * The bot (D-113) is `BOT_UID`: it has no clock entry and its deadline is
 * `BOT_DEADLINE`, so `applyTimeout` can never flag it — it moves inside the
 * transaction that hands it the turn and is never waited on.
 */

import bordersJson from "../data/borders.json";
import { COUNTRIES } from "./countries";
import { mondoError } from "./errors";

export const TURNS_EACH = 30;
export const CLOCK_MS = 300_000;
export const INCREMENT_MS = 3_000;
export const DRAFT_PICK_MS = 30_000;
export const FORTIFY_COST = 2;
/** Added to an attack on the enemy capital: a capital is not just another territory. Tunable (R-2). */
export const CAPITAL_DEFENCE = 12;
/** No attacks in each player's first two play turns: plies 0–3 of play. Tunable (R-2). */
export const TRUCE_PLIES = 4;
/** A capital must border at least this many board territories (land or link). */
export const CAPITAL_MIN_NEIGHBOURS = 2;
/** No Firebase uid holds a `~`, so the bot can never be a person (D-113). */
export const BOT_UID = "~bot";
/** The bot's deadline: never reached, so nothing ever flags it. */
export const BOT_DEADLINE = Number.MAX_SAFE_INTEGER;
/** Draft order by pick: A B B A A B. */
const SNAKE = [0, 1, 1, 0, 0, 1] as const;

export const CONTINENTS = ["Europe", "Asia", "Americas", "Africa"] as const;
export type Continent = (typeof CONTINENTS)[number];

export interface FronteirasResult {
  winner: string | null;
  reason: "capital" | "time" | "turns" | "resign" | "abort";
  ratings?: Record<string, { before: number; after: number }>;
}

export interface FronteirasState {
  continent: Continent;
  order: [string, string];
  rated: boolean;
  phase: "draft" | "play";
  draftIdx: number;
  /** Play turns taken, both players together; the game is over by `2 * TURNS_EACH`. */
  ply: number;
  turnUid: string | null;
  turnStartedAt: number;
  deadline: number;
  /** Ms left. The bot has no entry (D-113). */
  clock: Record<string, number>;
  /** 1–5 per board territory, PER MATCH; its keys are the board. */
  values: Record<string, number>;
  owner: Record<string, 0 | 1>;
  fort: Record<string, number>;
  gold: [number, number];
  capital: [string | null, string | null];
  result: FronteirasResult | null;
}

export type Action = { t: "pick" | "take" | "attack" | "fortify"; code: string } | { t: "pass" };

/** Land neighbours plus generated sea links, symmetric, within one board. */
export type Adjacency = Record<string, string[]>;

export interface Board {
  codes: string[];
  adj: Adjacency;
  viewBox: string;
  labels: Record<string, [number, number]>;
}

const borders = bordersJson as unknown as {
  land: Record<string, string[]>;
  links: [string, string][];
  viewBox: Record<Continent, string>;
  labels: Record<string, [number, number]>;
};

/** One continent's board: its members (by `countries.json` region), their adjacency and layout. */
export function boardOf(continent: Continent): Board {
  const codes = [...COUNTRIES.values()].filter((c) => c.region === continent).map((c) => c.code).sort();
  const on = new Set(codes);
  const sets = new Map(codes.map((c) => [c, new Set<string>()]));
  const link = (a: string, b: string) => {
    if (a === b || !on.has(a) || !on.has(b)) return;
    sets.get(a)!.add(b);
    sets.get(b)!.add(a);
  };
  for (const a of codes) for (const b of borders.land[a] ?? []) link(a, b);
  for (const [a, b] of borders.links) link(a, b);
  return {
    codes,
    adj: Object.fromEntries(codes.map((c) => [c, [...sets.get(c)!].sort()])),
    viewBox: borders.viewBox[continent],
    labels: Object.fromEntries(codes.filter((c) => borders.labels[c]).map((c) => [c, borders.labels[c]!])),
  };
}

/**
 * D-108: each board territory's quintile, 1–5, of `totals.values` within its
 * continent. Equal figures share a tier: a territory's rank is how many on the
 * board are strictly smaller, so the order of the input never matters.
 */
export function valuesOf(continent: Continent, totals: { values: Record<string, number> }): Record<string, number> {
  const codes = boardOf(continent).codes;
  const figure = (c: string) => {
    const v = totals.values[c];
    if (typeof v !== "number") throw new Error(`gdp.json totals have no figure for ${c}`);
    return v;
  };
  const all = codes.map(figure);
  return Object.fromEntries(codes.map((c) => {
    const below = all.filter((v) => v < figure(c)).length;
    return [c, Math.floor((below * 5) / codes.length) + 1];
  }));
}

export function newFronteiras(o: {
  order: [string, string]; continent: Continent; values: Record<string, number>; rated: boolean; now: number;
}): FronteirasState {
  if (o.order[0] === o.order[1]) throw mondoError("invalid-argument", "A game needs two players.");
  const s: FronteirasState = {
    continent: o.continent,
    order: [o.order[0], o.order[1]],
    rated: o.rated,
    phase: "draft",
    draftIdx: 0,
    ply: 0,
    turnUid: o.order[0],
    turnStartedAt: o.now,
    deadline: 0,
    clock: Object.fromEntries(o.order.filter((u) => u !== BOT_UID).map((u) => [u, CLOCK_MS])),
    values: { ...o.values },
    owner: {},
    fort: {},
    gold: [0, 0],
    capital: [null, null],
    result: null,
  };
  return { ...s, deadline: deadlineFor(s, o.order[0], o.now) };
}

function deadlineFor(s: FronteirasState, uid: string, now: number): number {
  if (uid === BOT_UID) return BOT_DEADLINE;
  return now + (s.phase === "draft" ? DRAFT_PICK_MS : s.clock[uid] ?? 0);
}

const seatOf = (s: FronteirasState, uid: string): 0 | 1 | -1 => (s.order[0] === uid ? 0 : s.order[1] === uid ? 1 : -1);

/** Total value a seat holds: the 30-turn count. */
function heldValue(s: FronteirasState, seat: 0 | 1): number {
  let n = 0;
  for (const [code, o] of Object.entries(s.owner)) if (o === seat) n += s.values[code] ?? 0;
  return n;
}

/** What a seat is paid at the start of each of its play turns: one gold per territory held. */
export function incomeOf(s: FronteirasState, seat: 0 | 1): number {
  return Object.values(s.owner).filter((o) => o === seat).length;
}

const touches = (s: FronteirasState, adj: Adjacency, seat: 0 | 1, code: string) =>
  (adj[code] ?? []).some((n) => s.owner[n] === seat);

/**
 * The free territories `seat` may pick now. Spacing: none that borders (land
 * or link) a territory the opponent holds. A capital — the first pick — must
 * also border `CAPITAL_MIN_NEIGHBOURS`. Fallbacks, in order: no spaced
 * territory with enough neighbours → any spaced one; no spaced one at all →
 * any free one. So a draft can never run out of legal picks.
 */
function draftable(s: FronteirasState, adj: Adjacency, seat: 0 | 1): Set<string> {
  const free = Object.keys(s.values).filter((c) => s.owner[c] === undefined);
  let ok = free.filter((c) => !touches(s, adj, (1 - seat) as 0 | 1, c));
  if (s.capital[seat] === null) {
    const roomy = ok.filter((c) => (adj[c] ?? []).length >= CAPITAL_MIN_NEIGHBOURS);
    if (roomy.length) ok = roomy;
  }
  return new Set(ok.length ? ok : free);
}

/** What `action` costs `seat` now, or null when it is not a move at all (whatever the gold). */
export function costOf(s: FronteirasState, adj: Adjacency, seat: 0 | 1, action: Action): number | null {
  if (action.t === "pass") return s.phase === "play" ? 0 : null;
  const { code } = action;
  const value = s.values[code];
  if (value === undefined) return null;
  const owner = s.owner[code];
  if (s.phase === "draft") return action.t === "pick" && owner === undefined && draftable(s, adj, seat).has(code) ? 0 : null;
  switch (action.t) {
    case "take":
      return owner === undefined && touches(s, adj, seat, code) ? value : null;
    case "attack":
      if (owner !== 1 - seat || !touches(s, adj, seat, code) || s.ply < TRUCE_PLIES) return null;
      return value + (s.fort[code] ?? 0) + (s.capital[owner] === code ? CAPITAL_DEFENCE : 0);
    case "fortify":
      return owner === seat ? FORTIFY_COST : null;
    default:
      return null;
  }
}

/** Every action `uid` may take now, affordable ones only; empty when it is not their turn. */
export function legalActions(s: FronteirasState, adj: Adjacency, uid: string): Action[] {
  const seat = seatOf(s, uid);
  if (s.result || s.turnUid !== uid || seat === -1) return [];
  const out: Action[] = [];
  const kinds = s.phase === "draft" ? (["pick"] as const) : (["take", "attack", "fortify"] as const);
  for (const code of Object.keys(s.values).sort()) {
    for (const t of kinds) {
      const c = costOf(s, adj, seat, { t, code });
      if (c !== null && c <= s.gold[seat]) out.push({ t, code });
    }
  }
  if (s.phase === "play") out.push({ t: "pass" });
  return out;
}

function end(s: FronteirasState, winner: string | null, reason: FronteirasResult["reason"]): FronteirasState {
  return { ...s, turnUid: null, result: { winner, reason } };
}

/** Hand the turn to `seat`, paying it its income at the start of a play turn. */
function startTurn(s: FronteirasState, seat: 0 | 1, now: number): FronteirasState {
  const uid = s.order[seat];
  const gold: [number, number] = [...s.gold];
  if (s.phase === "play") gold[seat] += incomeOf(s, seat);
  const next = { ...s, gold, turnUid: uid, turnStartedAt: now };
  return { ...next, deadline: deadlineFor(next, uid, now) };
}

/**
 * One action by `uid`. Throws, changing nothing, when it is not theirs to take:
 * the game is over, it is not their turn, the deadline has passed (the caller
 * then settles with `applyTimeout`), or the move is illegal or unaffordable.
 */
export function applyAction(s: FronteirasState, adj: Adjacency, uid: string, action: Action, now: number): FronteirasState {
  if (s.result) throw mondoError("already-completed", "This game is over.");
  const seat = seatOf(s, uid);
  if (seat === -1) throw mondoError("permission-denied", "You are not in this game.");
  if (s.turnUid !== uid) throw mondoError("not-your-turn", "It is not your turn.");
  if (now >= s.deadline) throw mondoError("deadline-passed", "Time is up.");
  const cost = costOf(s, adj, seat, action);
  if (cost === null) throw mondoError("illegal-move", "That move is not allowed.");
  if (cost > s.gold[seat]) throw mondoError("illegal-move", "Not enough gold.");

  if (s.phase === "draft") {
    const code = (action as { code: string }).code;
    const capital: [string | null, string | null] = [...s.capital];
    if (capital[seat] === null) capital[seat] = code;
    const picked: FronteirasState = { ...s, owner: { ...s.owner, [code]: seat }, capital, draftIdx: s.draftIdx + 1 };
    if (picked.draftIdx < SNAKE.length) return startTurn(picked, SNAKE[picked.draftIdx]!, now);
    return startTurn({ ...picked, phase: "play" }, 0, now);
  }

  const gold: [number, number] = [...s.gold];
  gold[seat] -= cost;
  const clock = uid === BOT_UID ? s.clock : { ...s.clock, [uid]: (s.clock[uid] ?? 0) - Math.max(0, now - s.turnStartedAt) + INCREMENT_MS };
  let next: FronteirasState = { ...s, gold, clock, ply: s.ply + 1 };
  if (action.t !== "pass") {
    const { code } = action;
    if (action.t === "fortify") {
      next = { ...next, fort: { ...s.fort, [code]: (s.fort[code] ?? 0) + 1 } };
    } else {
      if (action.t === "attack" && s.capital[1 - seat] === code) return end({ ...next, owner: { ...s.owner, [code]: seat } }, uid, "capital");
      const fort = { ...s.fort };
      delete fort[code];
      next = { ...next, owner: { ...s.owner, [code]: seat }, fort };
    }
  }
  if (next.ply >= 2 * TURNS_EACH) {
    const a = heldValue(next, 0);
    const b = heldValue(next, 1);
    return end(next, a === b ? null : s.order[a > b ? 0 : 1], "turns");
  }
  return startTurn(next, (1 - seat) as 0 | 1, now);
}

/**
 * The turn's deadline passed. In the draft nobody has played a game yet, so
 * it is aborted with no result (D-112); in play the mover has flagged and the
 * other player wins on time. Never due for the bot (`BOT_DEADLINE`).
 */
export function applyTimeout(s: FronteirasState, now: number): FronteirasState {
  if (s.result) throw mondoError("already-completed", "This game is over.");
  if (now < s.deadline) throw mondoError("invalid-argument", "This turn has not run out.");
  if (s.phase === "draft") return abort(s);
  const uid = s.turnUid!;
  return end({ ...s, clock: { ...s.clock, [uid]: 0 } }, s.order[1 - seatOf(s, uid)]!, "time");
}

/** Giving up: in the draft that is an abort (no result), in play the other player wins. */
export function resign(s: FronteirasState, uid: string): FronteirasState {
  if (s.result) throw mondoError("already-completed", "This game is over.");
  const seat = seatOf(s, uid);
  if (seat === -1) throw mondoError("permission-denied", "You are not in this game.");
  if (s.phase === "draft") return abort(s);
  return end(s, s.order[1 - seat]!, "resign");
}

/** No result, no rating (D-112). */
export function abort(s: FronteirasState): FronteirasState {
  if (s.result) throw mondoError("already-completed", "This game is over.");
  return end(s, null, "abort");
}
