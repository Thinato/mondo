/**
 * The Fronteiras bot (FR-15.10, D-113): greedy, one ply deep, unrated. Pure;
 * `rand` only breaks ties, so a seeded `rand` replays a game exactly.
 *
 * Draft, among the legal picks: the capital is the most valuable with the fewest
 * neighbours (fewest ways in), then the most valuable left. Play, first rule
 * that yields a move: take the enemy capital if it can; fortify its own
 * capital if the enemy could afford to take it next turn (its gold plus next
 * turn's income against value + walls + `CAPITAL_DEFENCE`, truce ignored); else the move with
 * the best gain in (own − enemy) value held per gold; else the cheapest legal
 * move; else pass.
 */

import { costOf, incomeOf, legalActions, CAPITAL_DEFENCE, type Action, type Adjacency, type FronteirasState } from "./fronteiras";

/** Highest `score`, ties broken by `rand`. */
function best<T>(xs: T[], score: (x: T) => number, rand: () => number): T | undefined {
  let top = -Infinity;
  let tied: T[] = [];
  for (const x of xs) {
    const v = score(x);
    if (v > top) [top, tied] = [v, [x]];
    else if (v === top) tied.push(x);
  }
  return tied[Math.floor(rand() * tied.length)];
}

export function botAction(s: FronteirasState, adj: Adjacency, rand: () => number): Action {
  const uid = s.turnUid;
  if (!uid) throw new Error("botAction: nobody's turn");
  const legal = legalActions(s, adj, uid);
  const seat = s.order[0] === uid ? 0 : 1;
  const enemy = (1 - seat) as 0 | 1;
  const coded = legal.filter((a): a is Exclude<Action, { t: "pass" }> => a.t !== "pass");

  if (s.phase === "draft") {
    const first = s.capital[seat] === null;
    const pick = best(coded, (a) => s.values[a.code]! * 1000 - (first ? (adj[a.code] ?? []).length : 0), rand);
    if (!pick) throw new Error("botAction: nothing left to pick");
    return pick;
  }

  const cap = s.capital[enemy];
  const strike = coded.find((a) => a.t === "attack" && a.code === cap);
  if (strike) return strike;

  const mine = s.capital[seat];
  if (mine) {
    const exposed = (adj[mine] ?? []).some((n) => s.owner[n] === enemy);
    const theirCost = s.values[mine]! + (s.fort[mine] ?? 0) + CAPITAL_DEFENCE;
    const fortify = coded.find((a) => a.t === "fortify" && a.code === mine);
    if (exposed && s.gold[enemy] + incomeOf(s, enemy) >= theirCost && fortify) return fortify;
  }

  const cost = (a: Action) => costOf(s, adj, seat, a)!;
  const gains = coded.filter((a) => a.t !== "fortify");
  const gain = best(gains, (a) => (a.t === "attack" ? 2 : 1) * s.values[a.code]! / cost(a), rand);
  if (gain) return gain;

  return best(coded, (a) => -cost(a), rand) ?? { t: "pass" };
}
