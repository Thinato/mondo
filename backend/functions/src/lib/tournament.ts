/**
 * Tournaments: presets, stored shapes, round windows and standings
 * (docs/06-tournaments.md §4, §6). Pure (NFR-8); `src/tournaments.ts` is I/O.
 *
 * Two ideas carry the whole file:
 *
 * - **D-38** — everyone still in a round plays the identical card, so any two
 *   scores that get compared came from the same questions.
 * - **D-41** — standings are a fold over the round log, recomputed from
 *   scratch every time, never stored incrementally. At ≤ 20 rounds a full
 *   recompute is cheaper than a drift bug, and it makes closing a round
 *   idempotent (the same lesson as D-25).
 */

import type { Timestamp } from "firebase-admin/firestore";
import type { CardSpec } from "./card";
import { mondoError } from "./errors";
import { opensAt as puzzleOpensAt, puzzleIdAt } from "./puzzle-day";
import { nextDay, rankBy } from "./standings";
import {
  competitionRanks, DEFAULT_MATCH_POINTS, EMPTY_RECORD, matchRecords, MAX_PAIRED_PARTICIPANTS,
  type MatchPoints, type MatchRecord, type Pairing,
} from "./tournament-core";

export type Regime = "aggregate" | "match";
export type Format = "free_for_all" | "single_elim" | "double_elim" | "round_robin" | "swiss";
export type TournamentStatus = "draft" | "running" | "finished" | "cancelled";

/** FR-5.4 — free-for-all takes a whole group; the pairing formats are lunch-sized. */
export const MAX_PARTICIPANTS = 200;
export const MIN_PARTICIPANTS = 2;
/** FR-4.4's sibling: a group cannot be drowned in open tournaments. */
export const MAX_ACTIVE_PER_GROUP = 5;

export interface Tiebreak {
  /** Ordered comparators. Leaving "time" out is what lets sudden death fire (D-50). */
  chain: ("points" | "time")[];
  unresolved: "sudden_death" | "replay" | "seed" | "draw";
  suddenDeathMaxItems: number;
}

export interface TournamentConfig {
  cardSpec: CardSpec;
  /**
   * What the preset asked for. Round robin overrides it at start, because its
   * length is a function of the field (n−1, or n when odd) and the field is
   * not frozen until then — `roundCount` on the tournament is the real number.
   */
  rounds: number;
  /** Round length in puzzle days; a round always closes on a noon boundary (D-43). */
  roundDays: number;
  tiebreak: Tiebreak;
  consolation: boolean;
  entry: "open" | "managed";
  maxParticipants: number;
  /**
   * Both are absent on `aggregate` presets, and absent is the honest shape:
   * free-for-all pairs nobody, so it has no match points to award and no byes
   * to credit. Only the pairing formats read them (§6.2, §7).
   */
  matchPoints?: MatchPoints;
  byePolicy?: { credit: "win" | "draw"; play: boolean };
}

export interface Preset {
  id: string;
  /** pt-BR, shown on the create form. */
  label: string;
  description: string;
  format: Format;
  regime: Regime;
  config: TournamentConfig;
}

// ---------------------------------------------------------------------------
// Built-in presets (D-48)
// ---------------------------------------------------------------------------

/**
 * A tournament is created from a named preset, resolved here and then **copied
 * into the tournament document**, so editing a preset can never change a
 * running or finished tournament and user-defined presets later need no
 * migration (D-48).
 *
 * This also deletes the hardest validation problem in the phase: there is no
 * client-supplied settings lattice to reject incoherent corners of. Every
 * shipped combination is one of these, and each has a fixture.
 *
 * A preset for a format that does not exist yet would be a create form that
 * 500s, so this list only ever grows with the slice that implements it:
 * free-for-all under `aggregate` (slices 1–2) and round robin under `match`
 * (slice 3). Elimination and Swiss presets land with slices 4–6.
 */
const AGGREGATE_TIEBREAK: Tiebreak = { chain: ["points", "time"], unresolved: "seed", suddenDeathMaxItems: 0 };

function freeForAll(id: string, label: string, description: string, cardSpec: CardSpec): Preset {
  return {
    id,
    label,
    description,
    format: "free_for_all",
    regime: "aggregate",
    config: {
      cardSpec,
      rounds: 1,
      roundDays: 1,
      tiebreak: AGGREGATE_TIEBREAK,
      consolation: true,
      entry: "open",
      maxParticipants: MAX_PARTICIPANTS,
    },
  };
}

export const PRESETS: readonly Preset[] = [
  freeForAll("quintal", "Quintal", "Cinco silhuetas, um dia, todo mundo joga. Fecha ao meio-dia.", {
    items: [{ kind: "shape", count: 5 }],
    order: "as_listed",
  }),
  freeForAll("capitais", "Capitais", "Cinco capitais para descobrir o país. Três tentativas cada.", {
    items: [{ kind: "capital", count: 5 }],
    order: "as_listed",
  }),
  freeForAll("mistura", "Mistura", "Três silhuetas e duas capitais, em ordem sorteada.", {
    items: [
      { kind: "shape", count: 3 },
      { kind: "capital", count: 2 },
    ],
    order: "shuffled",
  }),
  {
    id: "liga",
    label: "Liga",
    description: "Todo mundo joga contra todo mundo, uma rodada por dia. Vitória 3, empate 1.",
    format: "round_robin",
    regime: "match",
    config: {
      cardSpec: { items: [{ kind: "shape", count: 3 }], order: "as_listed" },
      // Overridden at start: a league's length is n−1, or n for an odd field.
      rounds: 1,
      roundDays: 1,
      // Time stays in the chain, so a drawn fixture needs identical points AND
      // identical milliseconds — rare, but legal here, which is why `draw` is
      // the policy rather than sudden death (§6.4). A table can hold a draw;
      // a knockout cannot, and that is slice 4's problem.
      tiebreak: { chain: ["points", "time"], unresolved: "draw", suddenDeathMaxItems: 0 },
      consolation: true,
      entry: "open",
      maxParticipants: MAX_PAIRED_PARTICIPANTS,
      matchPoints: DEFAULT_MATCH_POINTS,
      // The odd player out plays the card anyway: a free win, plus a score that
      // still counts for the card-points tiebreak (§7).
      byePolicy: { credit: "win", play: true },
    },
  },
];

export function presetById(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw mondoError("invalid-argument", "Unknown tournament preset.");
  return p;
}

/**
 * Deep-frozen so "the preset is resolved and then copied" (D-48) is a property
 * of the code and not just of Firestore happening to serialise on write. A
 * shared mutable config object would let one tournament's settings drift into
 * another's, and the bug would surface days later as a round of the wrong
 * length.
 */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") Object.values(o).forEach(deepFreeze);
  return Object.freeze(o);
}
deepFreeze(PRESETS);

// ---------------------------------------------------------------------------
// Stored documents (§4.1, §4.2)
// ---------------------------------------------------------------------------

export interface Participant {
  seed: number;
  /**
   * A snapshot taken when the tournament starts (D-46). A tournament is a
   * historical record, so unlike the live board (D-26) this does not follow a
   * rename — and `deleteAccount` scrubs it, because a bracket cannot simply
   * drop a player the way a daily board can (D-21).
   */
  displayName: string;
  joinedAt: Timestamp;
}

export interface Tournament {
  groupId: string;
  name: string;
  preset: string;
  format: Format;
  regime: Regime;
  /** The preset resolved (D-48). Frozen at creation. */
  config: TournamentConfig;
  status: TournamentStatus;
  createdBy: string;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
  /** Denormalised for the `array-contains` sweep in deleteAccount (§4.5). */
  participantUids: string[];
  participants: Record<string, Participant>;
  currentRound: number | null;
  roundCount: number | null;
}

export interface RoundResultRow {
  points: number;
  elapsedMs: number;
  guessCount: number;
  /** False when the player never finished the card by the deadline: a forfeit (FR-5.7). */
  played: boolean;
}

export interface TournamentRound {
  n: number;
  opensAt: Timestamp;
  closesAt: Timestamp;
  closedAt: Timestamp | null;
  cardId: string;
  /** Written when the round closes. Empty while it is open — FR-5.6 has nothing to leak. */
  results: Record<string, RoundResultRow>;
  /**
   * The fixtures, written when the round OPENS — a league publishes its draw in
   * advance, and a fixture is not a result. Each `outcome` stays null until the
   * round closes, which is the only part FR-5.6 protects.
   *
   * Absent on a free-for-all round, and on every round written before slice 3.
   * Bracket bookkeeping and the tie sub-round (§4.2) arrive with slices 4–6.
   */
  pairings?: Pairing[];
}

export const NAME_REMOVED = "[removido]";

export function newTournament(input: {
  groupId: string;
  name: string;
  preset: Preset;
  createdBy: string;
  /** Snapshotted now so a draft can show who is in; refreshed at start (D-46). */
  displayName: string;
  now: Timestamp;
}): Tournament {
  const { groupId, name, preset, createdBy, displayName, now } = input;
  return {
    groupId,
    name,
    preset: preset.id,
    format: preset.format,
    regime: preset.regime,
    // A copy, so nothing this tournament stores can alias the shared preset.
    config: structuredClone(preset.config) as TournamentConfig,
    status: "draft",
    createdBy,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    // The creator is in by default; they can drop out while it is still a draft.
    participantUids: [createdBy],
    participants: { [createdBy]: { seed: 1, displayName, joinedAt: now } },
    currentRound: null,
    roundCount: null,
  };
}

export function roundId(tournamentId: string, n: number): string {
  return `${tournamentId}_r${n}`;
}

/** attempts/{uid}_{tid}_r{n} — uid first, so the rules' split('_')[0] still holds (§4.4). */
export function playId(uid: string, tournamentId: string, n: number): string {
  return `${uid}_${roundId(tournamentId, n)}`;
}

// ---------------------------------------------------------------------------
// Round windows (D-43)
// ---------------------------------------------------------------------------

/**
 * The shortest round we will ever hand out. A round that opens shortly before
 * noon must not close at that noon.
 */
export const MIN_ROUND_MS = 12 * 3_600_000;

/**
 * When a round that opened at `openedAt` closes: a noon boundary in the puzzle
 * zone, `roundDays` days out — the same clock the rest of the game runs on
 * (OQ-2), so "fecha ao meio-dia" stays one sentence for players.
 *
 * The floor is the point of this function. `puzzleIdAt` names the day a puzzle
 * OPENS, so before noon it still answers with yesterday, and "yesterday + 1
 * day" is *today's* noon — minutes away. A `quintal` started at 11:50 would
 * have closed at 12:00 and forfeited everybody, which is precisely the hour
 * that preset exists for. So: take the first noon strictly after `openedAt`,
 * and if that is less than MIN_ROUND_MS away, take the next one instead; then
 * add the remaining `roundDays − 1` days.
 */
export function roundClosesAt(openedAt: Timestamp, roundDays: number): Date {
  if (!Number.isInteger(roundDays) || roundDays < 1) throw new RangeError(`roundDays ${roundDays} out of range`);
  let day = nextDay(puzzleIdAt(openedAt.toDate()));
  if (puzzleOpensAt(day).getTime() - openedAt.toMillis() < MIN_ROUND_MS) day = nextDay(day);
  for (let i = 1; i < roundDays; i++) day = nextDay(day);
  return puzzleOpensAt(day);
}

// ---------------------------------------------------------------------------
// Standings — a fold over the closed rounds (D-41)
// ---------------------------------------------------------------------------

export interface StandingRow {
  uid: string;
  displayName: string;
  isMe: boolean;
  rank: number;
  points: number;
  /** Rounds actually finished, out of the closed ones. */
  played: number;
  totalGuesses: number;
  totalElapsedMs: number;
  /**
   * The match record, present only under the `match` regime. `points` above
   * stays the card total in both regimes: under `match` it is shown and used
   * as the first tiebreak, but it never decides the table — that is what
   * "points off" means (D-49), and keeping it in one field rather than two is
   * what lets one table component render both regimes.
   */
  record?: MatchRecord;
}

/**
 * The table, computed from **closed rounds only** — an open round contributes
 * nothing, which is how FR-5.6 is honoured without a special case: there is no
 * "hide this" branch, the data simply is not in the fold yet.
 *
 * Ranks come from `rankBy` in lib/standings.ts, unchanged: it already ranks by
 * points then total elapsed time and already produces competition ranks
 * (1, 2, 2, 4) as D-24 wants. When the tiebreak chain omits "time" (a knockout
 * preset that wants sudden death, D-50), every row is handed the same zero, so
 * genuinely tied players come out genuinely tied instead of being separated by
 * a stopwatch nobody agreed to.
 */
export function standings(
  t: Pick<Tournament, "participants" | "participantUids" | "regime" | "config">,
  rounds: readonly TournamentRound[],
  viewerUid: string,
): StandingRow[] {
  const closed = rounds.filter((r) => r.closedAt !== null);
  const useTime = t.config.tiebreak.chain.includes("time");

  const rows = t.participantUids.map((uid) => {
    const mine = closed.map((r) => r.results[uid]).filter((x): x is RoundResultRow => x !== undefined);
    return {
      uid,
      displayName: t.participants[uid]?.displayName || NAME_REMOVED,
      isMe: uid === viewerUid,
      rank: 0,
      points: mine.reduce((n, r) => n + r.points, 0),
      played: mine.filter((r) => r.played).length,
      totalGuesses: mine.reduce((n, r) => n + r.guessCount, 0),
      totalElapsedMs: mine.reduce((n, r) => n + r.elapsedMs, 0),
    };
  });

  if (t.regime === "aggregate") {
    const ranks = rankBy(rows, (r) => ({ points: r.points, totalElapsedMs: useTime ? r.totalElapsedMs : 0 }));
    return finish(rows.map((r, i) => ({ ...r, rank: ranks[i]! })));
  }

  // `match` (D-49): the table is decided by match points. Card points are the
  // first tiebreak and are still shown, but they do not carry — a player can
  // out-score the field all tournament and finish second on fixtures.
  const records = matchRecords(
    t.participantUids,
    closed.map((r) => r.pairings ?? []),
    t.config.matchPoints ?? DEFAULT_MATCH_POINTS,
  );
  const withRecord = rows.map((r) => ({ ...r, record: records.get(r.uid) ?? { ...EMPTY_RECORD } }));
  const ranks = competitionRanks(withRecord, (r) => [
    r.record?.matchPoints ?? 0,
    r.points,
    // Negated: less time is better, and `competitionRanks` sorts descending.
    useTime ? -r.totalElapsedMs : 0,
  ]);
  return finish(withRecord.map((r, i) => ({ ...r, rank: ranks[i]! })));
}

/** Rank ascending, then alphabetically so a genuine tie renders in a stable order. */
function finish(rows: StandingRow[]): StandingRow[] {
  return rows.sort((a, b) => a.rank - b.rank || a.displayName.localeCompare(b.displayName));
}

/** Seeds by join order, stable and reproducible; ties broken by uid. */
export function seedOrder(participants: Record<string, Participant>): string[] {
  return Object.entries(participants)
    .sort(([ua, a], [ub, b]) => a.joinedAt.toMillis() - b.joinedAt.toMillis() || ua.localeCompare(ub))
    .map(([uid]) => uid);
}
