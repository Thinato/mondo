/**
 * R-2: bot against bot, seeded, with ε = 0.1 of random legal moves, on all four
 * real boards. CI asserts only that every game is legal throughout and ends in
 * time. With `SIM_GAMES=N` it plays N games per continent and prints the
 * balance table recorded in docs/08-multiplayer.md §5 — never asserted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { botAction } from "../src/lib/bot";
import {
  applyAction, boardOf, legalActions, newFronteiras, valuesOf, CONTINENTS, TURNS_EACH, type Continent,
} from "../src/lib/fronteiras";
import gdpJson from "../src/data/gdp.json";

const T0 = 1_800_000_000_000;
const EPSILON = 0.1;
const DRAFT_PICKS = 6;
const GAMES = Number(process.env.SIM_GAMES) || 25;

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const totals = (gdpJson as unknown as { totals: { values: Record<string, number> } }).totals;

function play(continent: Continent, rand: () => number) {
  const { adj } = boardOf(continent);
  let s = newFronteiras({ order: ["a", "b"], continent, values: valuesOf(continent, totals), rated: false, now: T0 });
  let now = T0;
  let steps = 0;
  while (!s.result) {
    assert.ok(steps < DRAFT_PICKS + 2 * TURNS_EACH, `${continent}: no end after ${steps} actions`);
    const uid = s.turnUid!;
    const legal = legalActions(s, adj, uid);
    const a = rand() < EPSILON ? legal[Math.floor(rand() * legal.length)]! : botAction(s, adj, rand);
    assert.ok(legal.some((x) => JSON.stringify(x) === JSON.stringify(a)), `${continent}: illegal ${JSON.stringify(a)}`);
    now += 1000;
    s = applyAction(s, adj, uid, a, now);
    steps++;
  }
  return s;
}

test("R-2: seeded bot-vs-bot games are legal throughout and end in time", () => {
  const rows: string[] = [];
  for (const [ci, continent] of CONTINENTS.entries()) {
    const rand = mulberry32(2026 + ci);
    const plies: number[] = [];
    let first = 0, draws = 0, capital = 0, turns = 0, earlyCapture = 0;
    for (let g = 0; g < GAMES; g++) {
      const s = play(continent, rand);
      plies.push(s.ply);
      const r = s.result!;
      if (r.winner === "a") first++;
      if (r.winner === null) draws++;
      if (r.reason === "capital") capital++;
      if (r.reason === "turns") turns++;
      if (r.reason === "capital" && s.ply < 8) earlyCapture++;
    }
    plies.sort((x, y) => x - y);
    const pct = (n: number) => `${((100 * n) / GAMES).toFixed(1)}%`.padStart(7);
    rows.push([
      continent.padEnd(9), String(GAMES).padStart(6), pct(first), pct(draws),
      String(plies[Math.floor(GAMES / 2)]).padStart(7), String(plies[Math.floor(GAMES / 10)]).padStart(5),
      pct(capital), pct(turns), pct(earlyCapture),
    ].join(" "));
  }
  if (process.env.SIM_GAMES) {
    console.log([
      "fronteiras sim",
      "continent  games  1st-win   draws  median   p10 capital   turns cap<p8",
      ...rows,
    ].join("\n"));
  }
});
