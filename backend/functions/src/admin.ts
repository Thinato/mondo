/**
 * Admin dashboard callables (FR-7.2). Every handler reads the caller's own
 * profile and passes requireAdmin BEFORE touching anyone else's data. Nothing
 * here ever returns an e-mail (FR-1.4); admin sees display names like everyone.
 *
 * D-29: admin is granted by tools/set-role.mjs only; setRole hands out
 * organizer/player. D-30: grantRetry resets today's attempt and keeps history.
 * D-31: today's guesses are hidden until the admin has finished their own round.
 */

import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { attemptRef, db, groupsCol, playRef, puzzleDays, roundRef, userRef } from "./db";
import { groupsOf, requireAdmin, roleOf } from "./lib/authz";
import { callable } from "./lib/callable";
import { cardIntervalsMs, totalGuesses, type CardPlay } from "./lib/card";
import { countryByCode } from "./lib/countries";
import { mondoError } from "./lib/errors";
import { todayState, type Group, type TodayState } from "./lib/groups";
import { intervalsMs, puzzleItems, resetAttempt, type Attempt, type Profile, type Puzzle, type Role } from "./lib/round";
import { windowDays } from "./lib/standings";
import { playId, type TournamentRound } from "./lib/tournament";
import { requireObject, requirePuzzleId, requireRole, requireUid } from "./lib/validate";

const PAGE = 50;
const REMOVED = "[removido]";

async function requireAdminCaller(uid: string): Promise<void> {
  const snap = await userRef(uid).get();
  requireAdmin(snap.exists ? (snap.data() as Profile) : null);
}

/** displayName per uid, "[removido]" when the profile is gone. */
async function namesFor(uids: readonly string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(uids)];
  if (distinct.length === 0) return new Map();
  const snaps = await db().getAll(...distinct.map(userRef));
  return new Map(snaps.map((s) => [s.id, s.exists ? (s.data() as Profile).displayName : REMOVED]));
}

const iso = (t: Timestamp | null) => (t ? t.toDate().toISOString() : null);

/** `<seconds>.<nanoseconds>|<uid>` — exact, and only what this API issues parses. */
const cursorOf = (t: Timestamp, uid: string) => `${t.seconds}.${t.nanoseconds}|${uid}`;

function parseCursor(v: unknown): [Timestamp, string] {
  const m = typeof v === "string" ? /^(\d{1,12})\.(\d{1,9})\|([A-Za-z0-9]{1,128})$/.exec(v) : null;
  if (!m) throw mondoError("invalid-argument", "cursor is not one this API issued.");
  return [new Timestamp(Number(m[1]), Number(m[2])), m[3]!];
}

// ---------------------------------------------------------------------------

export interface UserRow {
  uid: string; displayName: string; role: Role; createdAt: string;
  totalPlayed: number; totalSolved: number; currentStreak: number; groupCount: number;
}

/** listUsers({ cursor? }) → 50 profiles by createdAt; cursor = createdAt ISO of the last row. */
export const listUsers = callable<{ cursor?: unknown } | null | undefined, { users: UserRow[]; nextCursor: string | null }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = data == null ? {} : requireObject(data);
  // Ordered by createdAt AND document id, and the cursor carries the timestamp
  // to the nanosecond: millisecond ties are common (two sign-ins in one batch),
  // and an ISO round-trip would truncate and so repeat or skip a row.
  let q = db().collection("users").orderBy("createdAt", "asc").orderBy(FieldPath.documentId(), "asc").limit(PAGE);
  if (input.cursor !== undefined) {
    q = q.startAfter(...parseCursor(input.cursor));
  }
  const snaps = (await q.get()).docs;
  const users = snaps.map((s) => {
    const p = s.data() as Profile;
    return {
      uid: s.id, displayName: p.displayName, role: roleOf(p), createdAt: p.createdAt.toDate().toISOString(),
      totalPlayed: p.totalPlayed, totalSolved: p.totalSolved, currentStreak: p.currentStreak, groupCount: groupsOf(p).length,
    };
  });
  const last = snaps[snaps.length - 1];
  return { users, nextCursor: users.length === PAGE && last ? cursorOf(last.get("createdAt") as Timestamp, last.id) : null };
});

/** setRole({ uid, role }) — organizer or player, never an admin in either direction (FR-7.6, D-29), never yourself. */
export const setRole = callable<{ uid: unknown; role: unknown }, { ok: true }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = requireObject(data);
  const target = requireUid(input.uid);
  const role = requireRole(input.role);
  if (target === uid) throw mondoError("invalid-argument", "You cannot change your own role.");
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef(target));
    if (!snap.exists) throw mondoError("not-found", "No such user.");
    // FR-7.6: admin is granted and revoked out of band only (tools/set-role.mjs).
    // One admin must not be able to demote another through the dashboard.
    if (roleOf(snap.data() as Profile) === "admin") {
      throw mondoError("invalid-argument", "An admin's role can only be changed with tools/set-role.mjs.");
    }
    tx.update(userRef(target), { role });
  });
  return { ok: true };
});

/** listAllGroups({}) — every group, with the owner's display name. */
export const listAllGroups = callable<unknown, { groups: { groupId: string; name: string; ownerUid: string; ownerDisplayName: string; memberCount: number; createdAt: string }[] }>(async (uid) => {
  await requireAdminCaller(uid);
  const snaps = (await groupsCol().get()).docs;
  const names = await namesFor(snaps.map((s) => (s.data() as Group).ownerUid));
  return {
    groups: snaps.map((s) => {
      const g = s.data() as Group;
      return {
        groupId: s.id, name: g.name, ownerUid: g.ownerUid, ownerDisplayName: names.get(g.ownerUid) === REMOVED ? "" : (names.get(g.ownerUid) ?? ""),
        memberCount: g.memberCount, createdAt: g.createdAt.toDate().toISOString(),
      };
    }),
  };
});

export interface AttemptRow {
  uid: string; displayName: string; puzzleId: string; state: TodayState;
  guessCount: number; elapsedMs: number | null; retries: number;
  intervalsMs: number[]; startedAt: string; finishedAt: string | null;
  /** Null for today until the admin has finished their own round (D-31), like FR-4.11 on the board. */
  solved: boolean | null; points: number | null; suspicious: boolean | null;
  guesses?: { code: string; name: string; distanceKm: number; proximity: number }[];
}

export interface MatchRow {
  uid: string; displayName: string; tournamentId: string; roundId: string;
  state: "in_progress" | "finished";
  itemCount: number; guessCount: number;
  /** Null while the round is open and the admin has not finished it (D-31). */
  points: number | null; elapsedMs: number | null; suspicious: boolean | null;
  startedAt: string; finishedAt: string | null;
  /** Per item: served→first guess, then guess→guess. */
  intervalsMs: number[][];
}

/**
 * Which of these rounds the caller may see outcomes for: the closed ones, plus
 * any still-open round whose card the caller has already finished themselves.
 * Fails closed — a round document that is missing is not revealed.
 */
async function revealableRounds(uid: string, roundIds: readonly string[]): Promise<Set<string>> {
  const distinct = [...new Set(roundIds)];
  if (distinct.length === 0) return new Set();
  const parsed = distinct.flatMap((rid) => {
    const at = rid.lastIndexOf("_r");
    const n = Number(rid.slice(at + 2));
    return at > 0 && Number.isInteger(n) ? [{ rid, tid: rid.slice(0, at), n }] : [];
  });
  if (parsed.length === 0) return new Set();
  const [rounds, own] = await Promise.all([
    db().getAll(...parsed.map((x) => roundRef(x.tid, x.n))),
    db().getAll(...parsed.map((x) => playRef(playId(uid, x.tid, x.n)))),
  ]);
  const out = new Set<string>();
  parsed.forEach((x, i) => {
    const closed = rounds[i]?.exists === true && (rounds[i]!.data() as TournamentRound).closedAt !== null;
    const ownFinished = own[i]?.exists === true && (own[i]!.data() as { finishedAt: unknown }).finishedAt !== null;
    if (closed || ownFinished) out.add(x.rid);
  });
  return out;
}

/**
 * listAttempts({ puzzleId } | { uid }) — one day for everyone, or one player's
 * last 31 days. Guesses are included for closed days, and for today only once
 * the admin's own round is over (D-31).
 *
 * The `uid` path also returns that player's tournament cards (`matches`).
 * Neither of the daily paths can see them and neither should: the `puzzleId`
 * path filters on a field a card play does not have, and this path `getAll`s 31
 * deterministic daily ids (D-40 — that absence is what keeps tournaments out of
 * the daily boards). They are fetched with a third, equality-only query, which
 * Firestore serves by merging single-field indexes, so `firestore.indexes.json`
 * stays empty. Without this the admin timing surface would be blind to
 * tournaments — and SEC-13/SEC-14 name it as the *whole* mitigation there.
 *
 * That third query is capped at PAGE and **unordered**: two equality filters
 * plus an `orderBy` would need a composite index, and firestore.indexes.json is
 * deliberately empty. So a player with more than 50 card plays shows an
 * arbitrary 50, sorted by start time only after the cap. Fine while a
 * tournament is a handful of rounds; revisit with an index if it ever matters.
 */
export const listAttempts = callable<{ puzzleId?: unknown; uid?: unknown }, { attempts: AttemptRow[]; matches: MatchRow[] }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = requireObject(data);
  if ((input.puzzleId === undefined) === (input.uid === undefined)) {
    throw mondoError("invalid-argument", "Pass exactly one of puzzleId or uid.");
  }
  const { today } = puzzleDays(Timestamp.now());

  let attempts: Attempt[];
  let plays: CardPlay[] = [];
  if (input.puzzleId !== undefined) {
    const puzzleId = requirePuzzleId(input.puzzleId);
    attempts = (await db().collection("attempts").where("puzzleId", "==", puzzleId).get()).docs.map((d) => d.data() as Attempt);
  } else {
    const target = requireUid(input.uid);
    const [snaps, matchSnap] = await Promise.all([
      db().getAll(...windowDays(today, 31).map((d) => attemptRef(target, d))),
      db().collection("attempts").where("uid", "==", target).where("mode", "==", "match").limit(PAGE).get(),
    ]);
    attempts = snaps.flatMap((s) => (s.exists ? [s.data() as Attempt] : []));
    plays = matchSnap.docs.map((d) => d.data() as CardPlay);
  }

  let revealToday = false;
  if (attempts.some((a) => a.puzzleId === today)) {
    const mine = await attemptRef(uid, today).get();
    revealToday = mine.exists && todayState(mine.data() as Attempt) === "finished";
  }
  const names = await namesFor([...attempts.map((a) => a.uid), ...plays.map((p) => p.uid)]);
  const revealRound = await revealableRounds(uid, plays.map((p) => p.roundId));

  const matches: MatchRow[] = plays
    .sort((a, b) => b.startedAt.toMillis() - a.startedAt.toMillis())
    .map((p) => {
      // D-31, carried over to tournaments: an admin who is in the same round
      // must finish their own card before they can see anyone else's outcome.
      // FR-5.6 is absolute about an open round, and this path would otherwise
      // route straight around getTournament's careful states-only panel.
      const reveal = p.uid === uid || revealRound.has(p.roundId);
      return {
        uid: p.uid, displayName: names.get(p.uid) ?? REMOVED,
        tournamentId: p.tournamentId, roundId: p.roundId,
        state: p.finishedAt === null ? "in_progress" : "finished",
        itemCount: p.items.length, guessCount: totalGuesses(p),
        // Guess count and timings stay live — they are the cheating material
        // the panel exists for, and the daily draws the same line (D-31).
        points: reveal ? p.points : null, elapsedMs: reveal ? p.elapsedMs : null,
        suspicious: reveal ? p.suspicious : null,
        startedAt: p.startedAt.toDate().toISOString(), finishedAt: iso(p.finishedAt),
        intervalsMs: cardIntervalsMs(p),
      };
    });

  return {
    matches,
    attempts: attempts.map((a) => {
      // D-31: while the admin's own round is open, today's rows carry state and
      // timings but no outcome — the same line getLeaderboard draws (FR-4.11).
      const reveal = a.puzzleId !== today || revealToday;
      const row: AttemptRow = {
        uid: a.uid, displayName: names.get(a.uid) ?? REMOVED, puzzleId: a.puzzleId, state: todayState(a),
        guessCount: a.guessCount, elapsedMs: a.elapsedMs,
        retries: a.retries ?? 0, intervalsMs: intervalsMs(a), startedAt: a.startedAt.toDate().toISOString(), finishedAt: iso(a.finishedAt),
        // `suspicious` is only ever set on a solve, so it would announce an
        // unrevealed outcome by itself (D-31). Guess count and timings are the
        // cheating material the panel is for and stay live.
        solved: reveal ? a.solved : null, points: reveal ? a.points : null, suspicious: reveal ? a.suspicious : null,
      };
      if (reveal) {
        // D-52: the day's guesses live per challenge. Flattened for the table,
        // which shows one row of guesses per player either way; pre-D-52
        // attempts keep their single flat list.
        const guesses = a.items ? a.items.flatMap((it) => it.guesses) : (a.guesses ?? []);
        row.guesses = guesses.map((g) => ({
          code: g.code, name: countryByCode(g.code)?.names["pt-BR"] ?? g.code, distanceKm: g.distanceKm, proximity: g.proximity,
        }));
      }
      return row;
    }),
  };
});

/**
 * grantRetry({ uid, puzzleId }) — today only; the old try stays in history (D-30).
 *
 * Never for yourself: by the time your own round is over you have seen the
 * answer (roundView reveals it), so a self-granted retry is a free 6 points.
 * Same reasoning as D-31 and the same guard as setRole. If the admin genuinely
 * needs one, another admin or the console can do it, and it stays on the record.
 */
export const grantRetry = callable<{ uid: unknown; puzzleId: unknown }, { ok: true }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = requireObject(data);
  const target = requireUid(input.uid);
  const puzzleId = requirePuzzleId(input.puzzleId);
  const now = Timestamp.now();
  if (target === uid) throw mondoError("invalid-argument", "You cannot grant yourself a retry.");
  if (puzzleId !== puzzleDays(now).today) throw mondoError("puzzle-not-open", "Retries apply to today's puzzle only.");
  await db().runTransaction(async (tx) => {
    // D-52: starting over means a fresh set of items, so the day's card is read
    // inside the transaction — before any write, per the Firestore rule.
    const [snap, puzzleSnap] = await Promise.all([tx.get(attemptRef(target, puzzleId)), tx.get(db().doc(`puzzles/${puzzleId}`))]);
    if (!snap.exists) throw mondoError("not-found", "That player has not started today.");
    if (!puzzleSnap.exists) throw mondoError("not-found", `No puzzle scheduled for ${puzzleId}.`);
    const card = puzzleItems(puzzleSnap.data() as Puzzle);
    tx.set(attemptRef(target, puzzleId), resetAttempt(snap.data() as Attempt, card, now, uid));
  });
  return { ok: true };
});
