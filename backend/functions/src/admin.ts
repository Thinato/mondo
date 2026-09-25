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
import { attemptRef, db, groupsCol, memberRef, playRef, puzzleDays, roundRef, userRef } from "./db";
import { groupsOf, requireAdmin, roleOf } from "./lib/authz";
import { callable } from "./lib/callable";
import { cardIntervalsMs, totalGuesses, type CardPlay } from "./lib/card";
import { countryByCode } from "./lib/countries";
import { mondoError } from "./lib/errors";
import { memberStats, resultOf, todayState, WINDOW_30, type Group, type Member, type TodayState } from "./lib/groups";
import type { KindId } from "./lib/kinds";
import { intervalsMs, isChoiceGuess, isNumberGuess, puzzleItems, resetAttempt, upgradeAttempt, type Attempt, type Profile, type Puzzle, type Role, type StoredGuess } from "./lib/round";
import { shiftAllTime, streakFrom, windowDays } from "./lib/standings";
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

/** One guess as the panel shows it. No country for a number or a pick — see `guessRow`. */
export interface GuessRow { code: string; name: string; distanceKm: number; proximity: number }

/**
 * One challenge of the day (D-52), for the panel's per-challenge table.
 *
 * The **kind and the timings go out whatever D-31 says**: neither names a
 * country, and they are the cheating material the panel exists for — the same
 * line the row's own `guessCount` and `intervalsMs` already draw. What waits for
 * the gate is the guess VALUES and the outcome.
 */
export interface AttemptItemRow {
  kind: KindId;
  /** Served→first guess, then guess→guess (SEC-3, server clock). One per guess. */
  intervalsMs: number[];
  /** Null while the challenge is still open; pure timing, so never gated. */
  elapsedMs: number | null;
  /** Null until the outcome is revealable (D-31). */
  solved: boolean | null; points: number | null;
  /** Null until revealable (D-31); otherwise one entry per interval above. */
  guesses: GuessRow[] | null;
}

export interface AttemptRow {
  uid: string; displayName: string; puzzleId: string; state: TodayState;
  guessCount: number; elapsedMs: number | null; retries: number;
  intervalsMs: number[]; startedAt: string; finishedAt: string | null;
  /** Null for today until the admin has finished their own round (D-31), like FR-4.11 on the board. */
  solved: boolean | null; points: number | null; suspicious: boolean | null;
  /** The day's challenges in play order. Always present; half of each row is gated. */
  items: AttemptItemRow[];
  /**
   * FR-7.7, D-82 — voided. Never gated: it is not a score, and it is the one
   * thing on this row you may need to act on before your own round is over.
   */
  cheated: boolean;
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
 * One stored guess, named for a human.
 *
 * D-53: a `gdp` guess is a number, so it has no code and no distance. D-64: a
 * pick has neither either, and is shown **by position** — resolving it to a
 * country would mean re-reading the card's stored `options`, and naming it is
 * not what the panel is for. What matters here — how close and how fast — is the
 * same for all three.
 */
const guessRow = (g: StoredGuess): GuessRow =>
  isChoiceGuess(g)
    ? { code: "", name: `opção ${g.pick + 1}`, distanceKm: 0, proximity: g.proximity }
    : isNumberGuess(g)
    ? { code: "", name: String(g.value), distanceKm: 0, proximity: g.proximity }
    : { code: g.code, name: countryByCode(g.code)?.names["pt-BR"] ?? g.code, distanceKm: g.distanceKm, proximity: g.proximity };

/**
 * The day's challenges, one row each — which challenge, how fast, and (once the
 * gate opens) what was guessed and what it scored.
 *
 * Read through `upgradeAttempt` so a pre-D-52 attempt — one flat `guesses`, no
 * `items` — comes through as the one-challenge `shape` day it was, which is
 * exactly what that function is for. One code path instead of a branch.
 */
function itemRows(attempt: Attempt, reveal: boolean): AttemptItemRow[] {
  const a = upgradeAttempt(attempt);
  const gaps = cardIntervalsMs(a);
  return a.items.map((it, i) => ({
    kind: it.kind,
    intervalsMs: gaps[i] ?? [],
    elapsedMs: it.elapsedMs,
    solved: reveal ? it.solved : null,
    points: reveal ? it.points : null,
    guesses: reveal ? it.guesses.map(guessRow) : null,
  }));
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
        // D-52: the day's guesses live per challenge, and the panel shows them
        // that way. The flat `intervalsMs` above stays because it is the column
        // you SCAN — across every player, and for rows whose outcome is still
        // hidden. Two shapes, two jobs.
        items: itemRows(a, reveal),
        cheated: Boolean(a.cheated),
      };
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
    const attempt = snap.data() as Attempt;
    // FR-7.7, D-82: a voided day is not a second chance. `resetAttempt` would
    // build a clean attempt and drop the marker with it, which is a retry with
    // extra steps — un-void it first if that is really what you meant.
    if (attempt.cheated) throw mondoError("invalid-argument", "A voided attempt cannot be retried. Undo the flag first.");
    const card = puzzleItems(puzzleSnap.data() as Puzzle);
    tx.set(attemptRef(target, puzzleId), resetAttempt(attempt, card, now, uid));
  });
  return { ok: true };
});

/**
 * setCheated({ uid, puzzleId, cheated }) — void a day, or un-void it (FR-7.7, D-82).
 *
 * **Nothing is deleted.** The attempt keeps every guess, its points and its
 * clock, because the panel exists to look at them and an admin needs to see what
 * actually happened. What the marker does is make `resultOf` return null, and
 * that one line is what drops the day out of both windows, out of all-time going
 * forward, and out of the 30 days a player carries into a new group. Un-voiding
 * therefore restores the score by itself — there is no saved copy to put back,
 * which is why this is reversible at no cost.
 *
 * Three numbers are stored snapshots rather than projections, so they are moved
 * here and moved back on the way out:
 *   - **`allTime`** on each member document is watermarked at `allTimeThrough`
 *     and folded exactly once (D-25), so a day the nightly job has already eaten
 *     would otherwise sit in it forever. Only that case needs the hand
 *     correction; a day not yet folded is simply never picked up.
 *   - **`last7`/`last30`**, which would heal at 12:05 tonight — too late to be
 *     the answer to "someone cheated today".
 *   - **`profile.currentStreak`** and `lastPlayedOn`, which reach a board through
 *     `effectiveStreak`, recomputed by walking the days back (`streakFrom`).
 *
 * Deliberately NOT corrected: `profile.totalPlayed` and `totalSolved`, which
 * reach a client through `listUsers` and nowhere else — they are the admin's own
 * record of what really happened, and Paulo asked to keep seeing it. Nor
 * `longestStreak`: it is a high-water mark over a history this cannot bound, and
 * it is on no board.
 *
 * Unlike `grantRetry` this accepts **any** day, because the corrections above are
 * what earn it. Never your own attempt, for D-35's reason.
 */
export const setCheated = callable<{ uid: unknown; puzzleId: unknown; cheated: unknown }, { ok: true }>(async (uid, data) => {
  await requireAdminCaller(uid);
  const input = requireObject(data);
  const target = requireUid(input.uid);
  const puzzleId = requirePuzzleId(input.puzzleId);
  if (typeof input.cheated !== "boolean") throw mondoError("invalid-argument", "cheated must be true or false.");
  const cheated = input.cheated;
  if (target === uid) throw mondoError("invalid-argument", "You cannot flag your own attempt.");

  const now = Timestamp.now();
  const { today, closedDay } = puzzleDays(now);

  await db().runTransaction(async (tx) => {
    const [attemptSnap, profileSnap] = await tx.getAll(attemptRef(target, puzzleId), userRef(target));
    if (!attemptSnap?.exists) throw mondoError("not-found", "That player has no attempt on that day.");
    const attempt = attemptSnap.data() as Attempt;
    // Idempotent, and that is load-bearing: the all-time arithmetic below MOVES
    // numbers, so applying it twice would move them twice. A second click is a
    // no-op rather than a second subtraction.
    if (Boolean(attempt.cheated) === cheated) return;
    const profile = profileSnap?.exists ? (profileSnap.data() as Profile) : null;

    // One read serves both corrections. It ends at TODAY, not `closedDay`: a
    // player who has already finished today has `lastPlayedOn === today`, and a
    // window that stopped yesterday would walk straight past it and break a
    // streak that is fine. WINDOW_30 + 1 because `windowDays(closedDay, 30)`
    // reaches one day further back than `windowDays(today, 30)` does.
    const span = Math.max(WINDOW_30 + 1, (profile?.currentStreak ?? 0) + 2);
    const days = windowDays(today, span);
    const daySnaps = await tx.getAll(...days.map((d) => attemptRef(target, d)));
    const groups = profile ? groupsOf(profile) : [];
    const memberSnaps = groups.length > 0 ? await tx.getAll(...groups.map((g) => memberRef(g, target))) : [];

    // The window as it will read once this commits — the flagged day included
    // with its new marker, because nothing is written yet.
    const byDay = new Map<string, Attempt>();
    daySnaps.forEach((s, i) => { if (s.exists) byDay.set(days[i]!, s.data() as Attempt); });
    const after: Attempt = { ...attempt, cheated: cheated ? { by: uid, at: now } : null };
    if (byDay.has(puzzleId)) byDay.set(puzzleId, after);

    const results = [...byDay.values()].flatMap((a) => resultOf(a) ?? []);
    // What the day is worth with the marker set aside — which is the amount to
    // move in EITHER direction. Reading it off the stored attempt would work
    // when voiding and return null when un-voiding, because by then the marker
    // is on the document and `resultOf` is doing its job.
    const worth = resultOf({ ...attempt, cheated: null });

    for (const snap of memberSnaps) {
      if (!snap?.exists) continue;
      const m = snap.data() as Member;
      const stats = memberStats({ allTime: m.allTime, allTimeThrough: m.allTimeThrough }, results, closedDay);
      // Already folded into the running total, which `advanceAllTime` will never
      // revisit — so this is the only chance to move it.
      const folded = worth !== null && m.allTimeThrough !== null && puzzleId <= m.allTimeThrough;
      tx.update(snap.ref, {
        ...stats,
        allTime: folded ? shiftAllTime(stats.allTime, worth, cheated ? -1 : 1) : stats.allTime,
        updatedAt: now,
      });
    }

    if (profile) {
      const walk = streakFrom(days, (d) => {
        const a = byDay.get(d);
        return a !== undefined && a.finishedAt !== null && !a.cheated;
      });
      if (walk.currentStreak !== profile.currentStreak || walk.lastPlayedOn !== profile.lastPlayedOn) {
        tx.update(userRef(target), walk);
      }
    }

    tx.update(attemptSnap.ref, { cheated: after.cheated });
  });
  return { ok: true };
});
