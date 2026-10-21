/**
 * Glicko-2, as in Glickman's "Example of the Glicko-2 system" (D-110). Pure.
 *
 * One rating period is one DAY, but a Fronteiras game is rated the moment it
 * ends. So the period's RD inflation is done once, up front, by `preRate` over
 * the whole days since the player's last game, and the per-game update is then
 * run with `inflate: false` — inflating again inside it would charge a player
 * a day's uncertainty for every game they play in an afternoon.
 */

/** Glicko-2's scale between the Glicko and Glicko-2 rating units. */
const SCALE = 173.7178;
/** Convergence tolerance of the volatility iteration (Illinois algorithm). */
const EPSILON = 1e-6;
/** The RD a new player has, and the most anyone's RD can grow back to. */
const MAX_RD = 350;

/** System constant: how much volatility may move. Glickman suggests 0.3–1.2. */
export const TAU = 0.5;
/** A player is provisional — off the leaderboard — while RD is above this. */
export const PROVISIONAL_RD = 110;
export const START: Rating = { rating: 1500, rd: MAX_RD, vol: 0.06 };

export interface Rating {
  rating: number;
  rd: number;
  vol: number;
}

/** One game in the period: the opponent's rating and RD, and 1 win, 0.5 draw, 0 loss. */
export interface Result {
  rating: number;
  rd: number;
  score: number;
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

/**
 * The paper's steps 2–8. With no results only step 6 happens (RD grows by σ).
 * `inflate: false` drops step 6's σ'² from φ*, for a φ `preRate` already grew.
 */
export function glicko2(p: Rating, results: Result[], tau = TAU, inflate = true): Rating {
  const mu = (p.rating - 1500) / SCALE;
  const phi = p.rd / SCALE;
  if (results.length === 0) {
    const rd = inflate ? Math.sqrt(phi * phi + p.vol * p.vol) * SCALE : p.rd;
    return { rating: p.rating, rd, vol: p.vol };
  }

  let vInv = 0;
  let sum = 0;
  for (const r of results) {
    const gj = g(r.rd / SCALE);
    const e = 1 / (1 + Math.exp(-gj * (mu - (r.rating - 1500) / SCALE)));
    vInv += gj * gj * e * (1 - e);
    sum += gj * (r.score - e);
  }
  const v = 1 / vInv;
  const delta = v * sum;

  // Step 5: the new volatility, by the Illinois algorithm.
  const a = Math.log(p.vol * p.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);

  // Steps 6–8.
  const phiStar = inflate ? Math.sqrt(phi * phi + vol * vol) : phi;
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return { rating: muNew * SCALE + 1500, rd: phiNew * SCALE, vol };
}

/**
 * Step 6 for `days` idle rating periods at once — φ* = √(φ² + days·σ²), capped
 * at a new player's 350 — applied ONCE before a game is rated.
 */
export function preRate(p: Rating, days: number): Rating {
  // In rating units (σ scaled up) rather than φ, so 0 days returns rd exactly.
  const sigma = p.vol * SCALE;
  return { rating: p.rating, rd: Math.min(Math.sqrt(p.rd * p.rd + days * sigma * sigma), MAX_RD), vol: p.vol };
}
