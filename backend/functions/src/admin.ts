/**
 * Admin dashboard callables (FR-7.2). Every handler reads the caller's own
 * profile and passes requireAdmin BEFORE touching anyone else's data. Nothing
 * here ever returns an e-mail (FR-1.4); admin sees display names like everyone.
 *
 * D-29: admin is granted by tools/set-role.mjs only; setRole hands out
 * organizer/player. D-30: grantRetry resets today's attempt and keeps history.
 * D-31: today's guesses are hidden until the admin has finished their own round.
 */

import { Timestamp } from "firebase-admin/firestore";
import { attemptRef, db, groupsCol, puzzleDays, userRef } from "./db";
import { groupsOf, requireAdmin, roleOf } from "./lib/authz";
import { callable } from "./lib/callable";
import { countryByCode } from "./lib/countries";
import { mondoError } from "./lib/errors";
import { todayState, type Group, type TodayState } from "./lib/groups";
import { intervalsMs, resetAttempt, type Attempt, type Profile, type Role } from "./lib/round";
import { windowDays } from "./lib/standings";
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

// ---------------------------------------------------------------------------

export interface UserRow {
  uid: string; displayName: string; role: Role; createdAt: string;
  totalPlayed: number; totalSolved: number; currentStreak: number; groupCount: number;
}

/** listUsers({ cursor? }) → 50 profiles by createdAt; cursor = createdAt ISO of the last row. */
export const listUsers = callable<{ cursor?: unknown } | null | undefined, { users: UserRow[]; nextCursor: string | null }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = data == null ? {} : requireObject(data);
  let q = db().collection("users").orderBy("createdAt", "asc").limit(PAGE);
  if (input.cursor !== undefined) {
    const t = typeof input.cursor === "string" ? Date.parse(input.cursor) : NaN;
    if (Number.isNaN(t)) throw mondoError("invalid-argument", "cursor must be an ISO timestamp.");
    q = q.startAfter(Timestamp.fromDate(new Date(t)));
  }
  const snaps = (await q.get()).docs;
  const users = snaps.map((s) => {
    const p = s.data() as Profile;
    return {
      uid: s.id, displayName: p.displayName, role: roleOf(p), createdAt: p.createdAt.toDate().toISOString(),
      totalPlayed: p.totalPlayed, totalSolved: p.totalSolved, currentStreak: p.currentStreak, groupCount: groupsOf(p).length,
    };
  });
  return { users, nextCursor: users.length === PAGE ? users[users.length - 1]!.createdAt : null };
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
  guessCount: number; elapsedMs: number | null; suspicious: boolean; retries: number;
  intervalsMs: number[]; startedAt: string; finishedAt: string | null;
  /** Null for today until the admin has finished their own round (D-31), like FR-4.11 on the board. */
  solved: boolean | null; points: number | null;
  guesses?: { code: string; name: string; distanceKm: number; proximity: number }[];
}

/**
 * listAttempts({ puzzleId } | { uid }) — one day for everyone, or one player's
 * last 31 days. Guesses are included for closed days, and for today only once
 * the admin's own round is over (D-31).
 */
export const listAttempts = callable<{ puzzleId?: unknown; uid?: unknown }, { attempts: AttemptRow[] }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = requireObject(data);
  if ((input.puzzleId === undefined) === (input.uid === undefined)) {
    throw mondoError("invalid-argument", "Pass exactly one of puzzleId or uid.");
  }
  const { today } = puzzleDays(Timestamp.now());

  let attempts: Attempt[];
  if (input.puzzleId !== undefined) {
    const puzzleId = requirePuzzleId(input.puzzleId);
    attempts = (await db().collection("attempts").where("puzzleId", "==", puzzleId).get()).docs.map((d) => d.data() as Attempt);
  } else {
    const target = requireUid(input.uid);
    const snaps = await db().getAll(...windowDays(today, 31).map((d) => attemptRef(target, d)));
    attempts = snaps.flatMap((s) => (s.exists ? [s.data() as Attempt] : []));
  }

  let revealToday = false;
  if (attempts.some((a) => a.puzzleId === today)) {
    const mine = await attemptRef(uid, today).get();
    revealToday = mine.exists && todayState(mine.data() as Attempt) === "finished";
  }
  const names = await namesFor(attempts.map((a) => a.uid));

  return {
    attempts: attempts.map((a) => {
      // D-31: while the admin's own round is open, today's rows carry state and
      // timings but no outcome — the same line getLeaderboard draws (FR-4.11).
      const reveal = a.puzzleId !== today || revealToday;
      const row: AttemptRow = {
        uid: a.uid, displayName: names.get(a.uid) ?? REMOVED, puzzleId: a.puzzleId, state: todayState(a),
        guessCount: a.guessCount, elapsedMs: a.elapsedMs, suspicious: a.suspicious,
        retries: a.retries ?? 0, intervalsMs: intervalsMs(a), startedAt: a.startedAt.toDate().toISOString(), finishedAt: iso(a.finishedAt),
        solved: reveal ? a.solved : null, points: reveal ? a.points : null,
      };
      if (reveal) {
        row.guesses = a.guesses.map((g) => ({
          code: g.code, name: countryByCode(g.code)?.names["pt-BR"] ?? g.code, distanceKm: g.distanceKm, proximity: g.proximity,
        }));
      }
      return row;
    }),
  };
});

/** grantRetry({ uid, puzzleId }) — today only; the old try stays in history (D-30). */
export const grantRetry = callable<{ uid: unknown; puzzleId: unknown }, { ok: true }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = requireObject(data);
  const target = requireUid(input.uid);
  const puzzleId = requirePuzzleId(input.puzzleId);
  const now = Timestamp.now();
  if (puzzleId !== puzzleDays(now).today) throw mondoError("puzzle-not-open", "Retries apply to today's puzzle only.");
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(attemptRef(target, puzzleId));
    if (!snap.exists) throw mondoError("not-found", "That player has not started today.");
    tx.set(attemptRef(target, puzzleId), resetAttempt(snap.data() as Attempt, now, uid));
  });
  return { ok: true };
});
