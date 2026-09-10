/**
 * Tournaments (FR-5 as rewritten, FR-8; docs/06-tournaments.md §8, §9).
 *
 * Slices 1–3: free-for-all under `aggregate`, round robin under `match`, cards
 * of N challenges from the `shape` and `capital` kinds. Elimination, Swiss and
 * the tie policies arrive in slices 4–6; the primitives they will share
 * (`cardWinner`, match points, pairings) are already in lib/tournament-core.ts.
 *
 * Rules in lib/tournament.ts, lib/card.ts and lib/kinds.ts; this file is I/O.
 * Every mutation is one transaction that reads everything before it writes.
 */

import { Timestamp, type Transaction } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  cardRef, db, groupRef, memberRef, playRef, roundRef, roundsCol,
  runningTournaments, tournamentRef, tournamentsCol, tournamentsOf, userRef,
} from "./db";
import { isAdmin, requireCanPlay, requireOwner } from "./lib/authz";
import { callable } from "./lib/callable";
import {
  applyCardGuess, buildCard, cardView, newCardPlay, totalGuesses,
  type CardItem, type CardPlay, type CardView,
} from "./lib/card";
import { mondoError } from "./lib/errors";
import type { Group } from "./lib/groups";
import { puzzleIdAt } from "./lib/puzzle-day";
import { previousDay, type Profile, type Puzzle } from "./lib/round";
import { nextDay } from "./lib/standings";
import {
  MAX_ACTIVE_PER_GROUP, MIN_PARTICIPANTS, newTournament, playId, presetById,
  PRESETS, roundClosesAt, roundId, seedOrder, standings,
  type Format, type Regime, type StandingRow, type Tournament, type TournamentRound, type TournamentStatus,
} from "./lib/tournament";
import { assertPairableSize, pairingsFor, resolvePairings, roundCountFor, type Pairing } from "./lib/tournament-core";
import {
  requireBoolean, requireGroupId, requireGroupName, requireObject, requirePresetId, requireTournamentId, requireUid,
} from "./lib/validate";

/** FR-5.2 — how far either side of today a scheduled daily blocks a subject. */
const SUBJECT_EXCLUSION_DAYS = 60;

/** A card is stored at cards/{tid}_r{n}. */
interface CardDoc {
  tournamentId: string;
  round: number;
  items: CardItem[];
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

/**
 * FR-5.2 — the countries the daily schedule uses within ±60 days, so a
 * tournament never asks what the group is about to be asked at lunch.
 *
 * Under D-38 everyone plays the same card and everyone plays the same daily,
 * so the old FR-5.2 ("nothing either participant has seen in 60 days") and this
 * one describe the same set — with none of the per-participant history reads.
 *
 * ~121 documents, read once per advance run and shared across every tournament
 * that run touches. Outside the transaction on purpose: it is advisory input to
 * generation, not a consistency boundary.
 */
async function scheduledSubjects(now: Timestamp): Promise<Set<string>> {
  const today = puzzleIdAt(now.toDate());
  let from = today;
  let to = today;
  for (let i = 0; i < SUBJECT_EXCLUSION_DAYS; i++) {
    from = previousDay(from);
    to = nextDay(to);
  }
  const snap = await db().collection("puzzles").where("puzzleId", ">=", from).where("puzzleId", "<=", to).get();
  return new Set(snap.docs.map((d) => (d.data() as Puzzle).countryCode));
}

/** Subjects this tournament has already used, so a card never repeats one (FR-5.2). */
async function usedSubjects(tx: Transaction, tid: string, upToRound: number): Promise<string[]> {
  if (upToRound < 1) return [];
  const ids = [];
  for (let n = 1; n <= upToRound; n++) ids.push(cardRef(roundId(tid, n)));
  const snaps = await tx.getAll(...ids);
  return snaps.flatMap((s) => (s.exists ? (s.data() as CardDoc).items.map((i) => i.subject) : []));
}

async function loadTournament(tx: Transaction, tid: string): Promise<Tournament> {
  const snap = await tx.get(tournamentRef(tid));
  if (!snap.exists) throw mondoError("not-found", "No such tournament.");
  return snap.data() as Tournament;
}

/**
 * FR-5.3 / FR-4.10 — a tournament is visible to members of its group, and to an
 * admin (FR-7.2).
 *
 * Unlike getLeaderboard, this cannot run before the tournament document is
 * read: the group id lives on that document, so there is nothing to check
 * membership against until it is loaded. The consequence is that a non-member
 * can tell `not-found` from `permission-denied` for a tournament id they
 * already hold — which leaks nothing, because ids are 20-character Firestore
 * auto-ids and a member's own group ids are the only ones they can enumerate.
 * No participant data is read before the check.
 */
async function requireGroupMember(uid: string, gid: string): Promise<{ group: Group | null; profile: Profile | null }> {
  const [memberSnap, profileSnap, groupSnap] = await Promise.all([
    memberRef(gid, uid).get(), userRef(uid).get(), groupRef(gid).get(),
  ]);
  const profile = profileSnap.exists ? (profileSnap.data() as Profile) : null;
  if (!memberSnap.exists && !isAdmin(profile)) throw mondoError("permission-denied", "Members of this group only.");
  return { group: groupSnap.exists ? (groupSnap.data() as Group) : null, profile };
}

/** Management follows ownership of the group, not the role (FR-7.5, D-23). */
async function requireGroupOwner(tx: Transaction, gid: string, uid: string): Promise<Group> {
  const snap = await tx.get(groupRef(gid));
  if (!snap.exists) throw mondoError("not-found", "No such group.");
  const group = snap.data() as Group;
  requireOwner(group, uid);
  return group;
}

/**
 * The same check outside a transaction, run BEFORE anything expensive.
 *
 * `scheduledSubjects` is ~121 document reads, and it used to run before the
 * permission check — so any signed-in account, including one FR-1.7 bars from
 * playing, could spend 121 reads per request against an id it had never seen
 * and never be told no. Two cheap document reads authorize first now; the
 * transaction still re-checks, because this one is advisory.
 */
async function preAuthorizeOwner(tid: string, uid: string): Promise<Tournament> {
  const tSnap = await tournamentRef(tid).get();
  if (!tSnap.exists) throw mondoError("not-found", "No such tournament.");
  const t = tSnap.data() as Tournament;
  const gSnap = await groupRef(t.groupId).get();
  if (!gSnap.exists) throw mondoError("not-found", "No such group.");
  requireOwner(gSnap.data() as Group, uid);
  return t;
}

// ---------------------------------------------------------------------------
// Opening and closing rounds
// ---------------------------------------------------------------------------

/** Participants in seed order — the wheel the circle method rotates (§7). */
function seededUids(t: Tournament): string[] {
  return [...t.participantUids].sort((a, b) => (t.participants[a]?.seed ?? 0) - (t.participants[b]?.seed ?? 0));
}

/**
 * Write round `n` and its card. The card and the round are created in the same
 * transaction, so a round can never point at a card that does not exist.
 */
function openRound(tx: Transaction, tid: string, t: Tournament, n: number, exclude: ReadonlySet<string>, now: Timestamp): void {
  const items = buildCard(t.config.cardSpec, exclude);
  const rid = roundId(tid, n);
  const round: TournamentRound = {
    n,
    opensAt: now,
    closesAt: Timestamp.fromDate(roundClosesAt(now, t.config.roundDays)),
    closedAt: null,
    cardId: rid,
    results: {},
    // Published with the round: the draw is public, the outcomes are not.
    pairings: pairingsFor(t.format, seededUids(t), n),
  };
  const card: CardDoc = { tournamentId: tid, round: n, items, createdAt: now };
  tx.create(cardRef(rid), card);
  tx.create(roundRef(tid, n), round);
}

/**
 * Close the open round and either open the next one or finish the tournament.
 *
 * Idempotent (D-41, D-43): a round with `closedAt` set is skipped, so a retry,
 * a double schedule fire, and the owner pressing the button at the same moment
 * as the nightly job all converge. A participant with no finished card scores
 * zero and is marked unplayed — a forfeit, not a bye (FR-5.7).
 */
async function closeRoundTx(tx: Transaction, tid: string, n: number, scheduled: ReadonlySet<string>, now: Timestamp): Promise<boolean> {
  const [tSnap, rSnap] = await Promise.all([tx.get(tournamentRef(tid)), tx.get(roundRef(tid, n))]);
  if (!tSnap.exists || !rSnap.exists) return false;
  const t = tSnap.data() as Tournament;
  const round = rSnap.data() as TournamentRound;
  if (t.status !== "running" || round.closedAt !== null) return false;

  const playSnaps = await tx.getAll(...t.participantUids.map((u) => playRef(playId(u, tid, n))));
  const wasLastRound = n >= (t.roundCount ?? t.config.rounds);
  const priorSubjects = wasLastRound ? [] : await usedSubjects(tx, tid, n);

  const results: TournamentRound["results"] = {};
  t.participantUids.forEach((u, i) => {
    const snap = playSnaps[i];
    const play = snap?.exists ? (snap.data() as CardPlay) : null;
    const finished = play !== null && play.finishedAt !== null;
    results[u] = {
      points: finished ? play.points : 0,
      elapsedMs: finished ? (play.elapsedMs ?? 0) : 0,
      guessCount: play ? totalGuesses(play) : 0,
      played: finished,
    };
  });

  // --- writes ---
  const pairings = resolvePairings(
    round.pairings ?? [],
    results,
    t.config.tiebreak.chain,
    t.config.byePolicy?.credit ?? "win",
  );
  tx.update(roundRef(tid, n), { results, pairings, closedAt: now });
  if (wasLastRound) {
    tx.update(tournamentRef(tid), { status: "finished" satisfies TournamentStatus, endedAt: now, currentRound: null });
  } else {
    openRound(tx, tid, t, n + 1, new Set([...scheduled, ...priorSubjects]), now);
    tx.update(tournamentRef(tid), { currentRound: n + 1 });
  }
  return true;
}

/**
 * Every running tournament whose open round is past its deadline (D-43). Called
 * by the 12:05 scheduled handler beside `rebuildStandings` — no third Cloud
 * Scheduler job, because the free tier is three per *billing account*
 * (docs/05-cost.md §3.4) and Mondo already owns two.
 */
export async function advanceOpenRoundsNow(now: Timestamp): Promise<{ tournaments: number; closed: number; failed: number }> {
  const running = await runningTournaments().get();
  if (running.empty) return { tournaments: 0, closed: 0, failed: 0 };
  const scheduled = await scheduledSubjects(now);

  let closed = 0;
  let failed = 0;
  for (const doc of running.docs) {
    // Per tournament, for the same reason the 12:05 handler wraps its two
    // halves: one tournament whose next card cannot be generated must not stop
    // every other tournament in the project from advancing that night — and it
    // would have done so again the following night, and the next.
    try {
      const t = doc.data() as Tournament;
      const n = t.currentRound;
      if (n === null) continue;
      const roundSnap = await roundRef(doc.id, n).get();
      if (!roundSnap.exists) continue;
      const round = roundSnap.data() as TournamentRound;
      if (round.closedAt !== null || now.toMillis() < round.closesAt.toMillis()) continue;
      if (await db().runTransaction((tx) => closeRoundTx(tx, doc.id, n, scheduled, now))) closed++;
    } catch (e) {
      failed++;
      logger.error("ADVANCE_TOURNAMENT_FAILED", { tournamentId: doc.id, error: String(e) });
    }
  }
  return { tournaments: running.size, closed, failed };
}

// ---------------------------------------------------------------------------
// Lifecycle callables
// ---------------------------------------------------------------------------

/** createTournament({ groupId, name, preset }) → { tournamentId }. Group owner only (FR-5.1, FR-7.5). */
export const createTournament = callable<{ groupId: unknown; name: unknown; preset: unknown }, { tournamentId: string }>(async (uid, data) => {
  const input = requireObject(data);
  const gid = requireGroupId(input.groupId);
  const name = requireGroupName(input.name); // FR-5.1 borrows FR-4.1's 3–40 chars
  const preset = presetById(requirePresetId(input.preset));
  const now = Timestamp.now();
  const tid = tournamentsCol().doc().id;

  // Ownership first: the cap query below reads every tournament of the group,
  // and running it before the check let a non-member tell "this group already
  // has 5 tournaments open" from "permission denied" — an activity oracle on a
  // private group (FR-4.10).
  const gSnap = await groupRef(gid).get();
  if (!gSnap.exists) throw mondoError("not-found", "No such group.");
  requireOwner(gSnap.data() as Group, uid);

  // Counted outside the transaction: the cap is a courtesy against clutter,
  // not a security boundary, and two owners racing to the sixth tournament is
  // not a problem worth a contended read for.
  const active = (await tournamentsOf(gid).get()).docs
    .filter((d) => ["draft", "running"].includes((d.data() as Tournament).status));
  if (active.length >= MAX_ACTIVE_PER_GROUP) {
    throw mondoError("invalid-argument", `This group already has ${MAX_ACTIVE_PER_GROUP} tournaments open. Finish or cancel one first.`);
  }

  await db().runTransaction(async (tx) => {
    const [, profileSnap] = await Promise.all([requireGroupOwner(tx, gid, uid), tx.get(userRef(uid))]);
    const displayName = profileSnap.exists ? (profileSnap.data() as Profile).displayName : "";
    tx.create(tournamentRef(tid), newTournament({ groupId: gid, name, preset, createdBy: uid, displayName, now }));
  });
  return { tournamentId: tid };
});

/** setParticipation({ tournamentId, join }) — join or drop out while it is still a draft. */
export const setParticipation = callable<{ tournamentId: unknown; join: unknown }, { participating: boolean }>(async (uid, data) => {
  const input = requireObject(data);
  const tid = requireTournamentId(input.tournamentId);
  const join = requireBoolean(input.join, "join");
  const now = Timestamp.now();

  return db().runTransaction(async (tx) => {
    const t = await loadTournament(tx, tid);
    if (t.status !== "draft") throw mondoError("tournament-not-open", "This tournament has already started.");
    const [memberSnap, profileSnap] = await Promise.all([tx.get(memberRef(t.groupId, uid)), tx.get(userRef(uid))]);
    if (!memberSnap.exists) throw mondoError("permission-denied", "Members of this group only.");
    // No preset sets `entry: "managed"` yet and no callable lets a manager add
    // someone else, so this only ever refuses a self-join on a hand-edited
    // tournament. Kept as the seam; the message does not promise a flow that
    // does not exist.
    if (t.config.entry !== "open" && uid !== t.createdBy) throw mondoError("permission-denied", "This tournament is not open to join.");

    // uid reaches a dotted field path below; a "." in it would write a nested
    // object instead of a key. Auth uids are alphanumeric for every provider
    // this project enables, and this makes that assumption enforced rather than
    // assumed (the same check validate.ts applies to a uid from a client).
    requireUid(uid);
    const inNow = t.participantUids.includes(uid);
    if (inNow === join) return { participating: join };

    if (join) {
      if (t.participantUids.length >= t.config.maxParticipants) throw mondoError("group-full", "This tournament is full.");
      tx.update(tournamentRef(tid), {
        participantUids: [...t.participantUids, uid],
        // Snapshotted now so a draft can show who is in; refreshed at start (D-46).
        // Seeds are recomputed by seedOrder at start, so this is only what a
        // draft displays — but max+1 keeps it from repeating a number after
        // someone drops out.
        [`participants.${uid}`]: {
          seed: Math.max(0, ...Object.values(t.participants).map((p) => p.seed)) + 1,
          displayName: profileSnap.exists ? (profileSnap.data() as Profile).displayName : "",
          joinedAt: now,
        },
      });
    } else {
      const { [uid]: _gone, ...rest } = t.participants;
      tx.update(tournamentRef(tid), {
        participantUids: t.participantUids.filter((u) => u !== uid),
        participants: rest,
      });
    }
    return { participating: join };
  });
});

/**
 * startTournament({ tournamentId }) — freeze the field, seed it, open round 1.
 *
 * Display names are snapshotted here (D-46): a tournament is a record, so it
 * does not follow a later rename the way the live board does (D-26).
 */
export const startTournament = callable<{ tournamentId: unknown }, { round: number; closesAt: string }>(async (uid, data) => {
  const tid = requireTournamentId(requireObject(data).tournamentId);
  const now = Timestamp.now();
  await preAuthorizeOwner(tid, uid);
  const scheduled = await scheduledSubjects(now);

  return db().runTransaction(async (tx) => {
    const t = await loadTournament(tx, tid);
    await requireGroupOwner(tx, t.groupId, uid);
    if (t.status !== "draft") throw mondoError("tournament-not-open", "This tournament has already started.");
    if (t.participantUids.length < MIN_PARTICIPANTS) throw mondoError("invalid-argument", `A tournament needs at least ${MIN_PARTICIPANTS} players.`);
    // Checked here rather than at create: the field is only frozen now, and a
    // league of 200 would schedule 199 rounds (one a day, most of a year).
    assertPairableSize(t.format, t.participantUids.length);

    // Every read before the first write.
    const profiles = await tx.getAll(...t.participantUids.map(userRef));
    const names = new Map(profiles.map((s) => [s.id, s.exists ? (s.data() as Profile).displayName : ""]));
    const order = seedOrder(t.participants);
    const participants: Tournament["participants"] = {};
    order.forEach((u, i) => {
      const p = t.participants[u]!;
      participants[u] = { seed: i + 1, displayName: names.get(u) ?? "", joinedAt: p.joinedAt };
    });

    // --- writes ---
    const roundCount = roundCountFor(t.format, t.config.rounds, order.length);
    const started: Tournament = { ...t, status: "running", startedAt: now, participants, currentRound: 1, roundCount };
    tx.set(tournamentRef(tid), started);
    openRound(tx, tid, started, 1, scheduled, now);
    return { round: 1, closesAt: roundClosesAt(now, t.config.roundDays).toISOString() };
  });
});

/**
 * advanceTournament({ tournamentId }) — close the open round now, without
 * waiting for its deadline. Owner only. Safe to repeat: closing is idempotent
 * (D-41), and once there is no open round left it answers
 * `tournament-not-open` rather than doing anything twice.
 *
 * Not a convenience: this is what lets a tournament run over one lunch instead
 * of one round per day, and what makes the engine testable without a cron.
 */
export const advanceTournament = callable<{ tournamentId: unknown }, { closed: boolean; status: TournamentStatus; round: number | null }>(async (uid, data) => {
  const tid = requireTournamentId(requireObject(data).tournamentId);
  const now = Timestamp.now();
  await preAuthorizeOwner(tid, uid);
  const scheduled = await scheduledSubjects(now);

  const closed = await db().runTransaction(async (tx) => {
    const t = await loadTournament(tx, tid);
    await requireGroupOwner(tx, t.groupId, uid);
    if (t.status !== "running" || t.currentRound === null) throw mondoError("tournament-not-open", "This tournament has no open round.");
    return closeRoundTx(tx, tid, t.currentRound, scheduled, now);
  });

  const after = (await tournamentRef(tid).get()).data() as Tournament | undefined;
  return { closed, status: after?.status ?? "cancelled", round: after?.currentRound ?? null };
});

/** cancelTournament({ tournamentId }) — owner only. Keeps the record (FR-5.10). */
export const cancelTournament = callable<{ tournamentId: unknown }, { ok: true }>(async (uid, data) => {
  const tid = requireTournamentId(requireObject(data).tournamentId);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const t = await loadTournament(tx, tid);
    await requireGroupOwner(tx, t.groupId, uid);
    if (t.status === "cancelled" || t.status === "finished") return;
    tx.update(tournamentRef(tid), { status: "cancelled" satisfies TournamentStatus, endedAt: now, currentRound: null });
  });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface TournamentSummary {
  tournamentId: string;
  name: string;
  preset: string;
  format: Format;
  regime: Regime;
  status: TournamentStatus;
  participantCount: number;
  isParticipant: boolean;
  currentRound: number | null;
  rounds: number;
}

/**
 * listTournaments({ groupId }) — the group's tournaments.
 *
 * A callable of its own rather than a field on `getLeaderboard`, which is what
 * docs/06-tournaments.md §9 first proposed: the board is the game's hottest
 * read and already carries an accepted read ceiling (plan R-12), and making
 * every daily board pay one more query for a page the reader may not open is
 * the wrong trade. The registry cost of one more function is cents (§11).
 */
export const listTournaments = callable<{ groupId: unknown }, { tournaments: TournamentSummary[]; presets: { id: string; label: string; description: string }[]; canManage: boolean }>(async (uid, data) => {
  const gid = requireGroupId(requireObject(data).groupId);
  const { group } = await requireGroupMember(uid, gid);
  const docs = (await tournamentsOf(gid).get()).docs;

  const tournaments = docs
    .map((d) => {
      const t = d.data() as Tournament;
      return {
        tournamentId: d.id,
        name: t.name,
        preset: t.preset,
        format: t.format,
        regime: t.regime,
        status: t.status,
        participantCount: t.participantUids.length,
        isParticipant: t.participantUids.includes(uid),
        currentRound: t.currentRound,
        rounds: t.roundCount ?? t.config.rounds,
      };
    })
    .sort((a, b) => rankStatus(a.status) - rankStatus(b.status) || a.name.localeCompare(b.name));

  return {
    tournaments,
    presets: PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
    canManage: group !== null && group.ownerUid === uid,
  };
});

const rankStatus = (s: TournamentStatus) => ["running", "draft", "finished", "cancelled"].indexOf(s);

export interface TournamentView extends TournamentSummary {
  groupId: string;
  itemCount: number;
  canManage: boolean;
  canJoin: boolean;
  closedRounds: number;
  standings: StandingRow[];
  participants: { uid: string; displayName: string; seed: number; isMe: boolean }[];
  /**
   * The draw, oldest round first; empty for a format that pairs nobody.
   *
   * Fixtures are public as soon as their round opens — a league's whole point
   * is knowing who you are up against. `outcome` is what FR-5.6 protects, and
   * it is null until the round closes because that is when the engine writes
   * it, not because anything here filters it out.
   */
  fixtures: { n: number; closed: boolean; pairings: Pairing[] }[];
  /** The open round. Scores stay hidden until it closes (FR-5.6). */
  current: null | {
    n: number;
    closesAt: string;
    itemCount: number;
    myState: "not_started" | "in_progress" | "finished";
    /** The viewer's own score, which is theirs to see immediately. */
    myPoints: number | null;
    players: { uid: string; displayName: string; state: "not_started" | "in_progress" | "finished" }[];
  };
  serverTime: string;
}

/**
 * getTournament({ tournamentId }) — the whole state a member may see.
 *
 * FR-5.6 is structural rather than a filter: `standings()` folds **closed**
 * rounds only (D-41), so an open round's scores are not in the data being
 * projected. The live panel carries states and nothing else — the same line
 * FR-4.11 draws on the daily board.
 *
 * Read cost is 3 + rounds + participants documents, the same shape and the same
 * accepted ceiling as `getLeaderboard` (plan R-12, docs/05-cost.md §2).
 */
export const getTournament = callable<{ tournamentId: unknown }, TournamentView>(async (uid, data) => {
  const tid = requireTournamentId(requireObject(data).tournamentId);
  const now = Timestamp.now();

  const tSnap = await tournamentRef(tid).get();
  if (!tSnap.exists) throw mondoError("not-found", "No such tournament.");
  const t = tSnap.data() as Tournament;
  const { group } = await requireGroupMember(uid, t.groupId);

  const rounds = (await roundsCol(tid).get()).docs.map((d) => d.data() as TournamentRound).sort((a, b) => a.n - b.n);
  const rows = standings(t, rounds, uid);

  let current: TournamentView["current"] = null;
  const open = t.currentRound === null ? undefined : rounds.find((r) => r.n === t.currentRound);
  if (open && open.closedAt === null) {
    const snaps = await db().getAll(...t.participantUids.map((u) => playRef(playId(u, tid, open.n))));
    const stateOf = (i: number) => {
      const s = snaps[i];
      if (!s?.exists) return "not_started" as const;
      return (s.data() as CardPlay).finishedAt === null ? ("in_progress" as const) : ("finished" as const);
    };
    const mineIndex = t.participantUids.indexOf(uid);
    const mine = mineIndex >= 0 ? snaps[mineIndex] : undefined;
    const minePlay = mine?.exists ? (mine.data() as CardPlay) : null;
    const card = (await cardRef(open.cardId).get()).data() as CardDoc | undefined;
    current = {
      n: open.n,
      closesAt: open.closesAt.toDate().toISOString(),
      itemCount: card?.items.length ?? 0,
      myState: mineIndex < 0 ? "not_started" : stateOf(mineIndex),
      myPoints: minePlay?.finishedAt ? minePlay.points : null,
      players: t.participantUids.map((u, i) => ({
        uid: u,
        displayName: t.participants[u]?.displayName || "",
        state: stateOf(i),
      })),
    };
  }

  const canManage = group !== null && group.ownerUid === uid;
  return {
    tournamentId: tid,
    groupId: t.groupId,
    name: t.name,
    preset: t.preset,
    format: t.format,
    regime: t.regime,
    status: t.status,
    participantCount: t.participantUids.length,
    isParticipant: t.participantUids.includes(uid),
    currentRound: t.currentRound,
    rounds: t.roundCount ?? t.config.rounds,
    itemCount: t.config.cardSpec.items.reduce((n, i) => n + i.count, 0),
    canManage,
    canJoin: t.status === "draft" && !t.participantUids.includes(uid) && t.config.entry === "open",
    closedRounds: rounds.filter((r) => r.closedAt !== null).length,
    standings: rows,
    fixtures: rounds
      .filter((r) => (r.pairings ?? []).length > 0)
      .map((r) => ({ n: r.n, closed: r.closedAt !== null, pairings: r.pairings ?? [] })),
    participants: t.participantUids.map((u) => ({
      uid: u,
      displayName: t.participants[u]?.displayName || "",
      seed: t.participants[u]?.seed ?? 0,
      isMe: u === uid,
    })),
    current,
    serverTime: now.toDate().toISOString(),
  };
});

// ---------------------------------------------------------------------------
// Play (the getRound / submitGuess analogues)
// ---------------------------------------------------------------------------

/** The open round plus its card, for a caller who is allowed to play it. */
async function loadPlayable(uid: string, tid: string, now: Timestamp): Promise<{ t: Tournament; round: TournamentRound; card: CardItem[] }> {
  const tSnap = await tournamentRef(tid).get();
  if (!tSnap.exists) throw mondoError("not-found", "No such tournament.");
  const t = tSnap.data() as Tournament;
  if (!t.participantUids.includes(uid)) throw mondoError("not-a-participant", "You are not in this tournament.");
  // Membership is re-checked on every play call, exactly as submitGuess
  // re-checks requireCanPlay ("losing your last group closes the round too").
  // The participant list is frozen at start and a departed player keeps their
  // slot so the standings fold keeps its shape (D-46) — but a slot is not a
  // licence to keep playing inside a group they have left or been removed from
  // (FR-5.3, FR-1.7). Without this, `getTournament` denied an ex-member while
  // `getCard` kept serving them prompts.
  const [memberSnap, profileSnap] = await Promise.all([memberRef(t.groupId, uid).get(), userRef(uid).get()]);
  if (!memberSnap.exists) throw mondoError("permission-denied", "Members of this group only.");
  requireCanPlay(profileSnap.exists ? (profileSnap.data() as Profile) : null);
  if (t.status !== "running" || t.currentRound === null) throw mondoError("tournament-not-open", "This tournament has no open round.");

  const [rSnap, cSnap] = await Promise.all([
    roundRef(tid, t.currentRound).get(),
    cardRef(roundId(tid, t.currentRound)).get(),
  ]);
  if (!rSnap.exists || !cSnap.exists) throw mondoError("not-found", "This round is not ready.");
  const round = rSnap.data() as TournamentRound;
  if (round.closedAt !== null) throw mondoError("tournament-not-open", "This round is closed.");
  // FR-5.7 — past the deadline the card is over whether or not the job has run.
  if (now.toMillis() >= round.closesAt.toMillis()) throw mondoError("tournament-not-open", "This round's deadline has passed.");
  return { t, round, card: (cSnap.data() as CardDoc).items };
}

/**
 * getCard({ tournamentId }) — the current challenge, creating the play document
 * with a server `startedAt` on first call. That is what makes the clock
 * un-spoofable (SEC-3), exactly as `getRound` does for the daily.
 */
export const getCard = callable<{ tournamentId: unknown }, CardView>(async (uid, data) => {
  const tid = requireTournamentId(requireObject(data).tournamentId);
  const now = Timestamp.now();
  const { t, card } = await loadPlayable(uid, tid, now);
  const id = playId(uid, tid, t.currentRound!);

  const play = await db().runTransaction(async (tx) => {
    const snap = await tx.get(playRef(id));
    if (snap.exists) return snap.data() as CardPlay;
    const fresh = newCardPlay(uid, tid, roundId(tid, t.currentRound!), card, now);
    tx.create(playRef(id), fresh);
    return fresh;
  });
  return cardView(play, card, now);
});

/**
 * submitCardGuess({ tournamentId, guess }) — one guess on the current item,
 * evaluated server-side (SEC-1). Read-modify-write in a transaction so
 * concurrent calls cannot exceed the item's guess budget (SEC-4); the 400 ms
 * floor is enforced against the previous guess's server timestamp (SEC-5).
 *
 * `guess` is deliberately untyped here: each kind validates its own shape
 * (SEC-8), because a numeric kind will not take a country code.
 */
export const submitCardGuess = callable<{ tournamentId: unknown; guess: unknown }, CardView>(async (uid, data) => {
  const input = requireObject(data);
  const tid = requireTournamentId(input.tournamentId);
  const now = Timestamp.now();
  const { t, card } = await loadPlayable(uid, tid, now);
  const n = t.currentRound!;
  const id = playId(uid, tid, n);

  const play = await db().runTransaction(async (tx) => {
    // The round is re-read inside the transaction so a guess cannot land on a
    // round the nightly job closed a moment ago.
    const [snap, rSnap] = await Promise.all([tx.get(playRef(id)), tx.get(roundRef(tid, n))]);
    if (!rSnap.exists || (rSnap.data() as TournamentRound).closedAt !== null) {
      throw mondoError("tournament-not-open", "This round is closed.");
    }
    if (!snap.exists) throw mondoError("not-found", "Call getCard before guessing.");
    const after = applyCardGuess(snap.data() as CardPlay, card, input.guess, now);
    tx.set(playRef(id), after);
    return after;
  });
  return cardView(play, card, now);
});
