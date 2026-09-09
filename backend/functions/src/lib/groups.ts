/**
 * Groups and their boards (FR-4), pure (NFR-8). Firestore I/O lives in
 * `src/groups.ts` and `src/leaderboard.ts`.
 *
 * One document per membership (D-22): `groups/{gid}/members/{uid}` carries the
 * role in the group, the join date and the precomputed windows.
 */

import type { Timestamp } from "firebase-admin/firestore";
import { statusOf, type Attempt, type Role } from "./round";
import {
  advanceAllTime, EMPTY_STATS, rankBy, statsFor, windowDays,
  type AllTime, type FinishedResult, type WindowStats,
} from "./standings";

export const MAX_GROUPS_PER_USER = 10; // FR-4.4
export const DEFAULT_MAX_MEMBERS = 200; // FR-4.5
export const WINDOW_30 = 30;
export const WINDOW_7 = 7;
export const DROP_WORST = 2; // FR-3.5

export interface Group {
  name: string;
  ownerUid: string;
  memberCount: number;
  maxMembers: number;
  createdAt: Timestamp;
}

export interface Member extends AllTime {
  uid: string;
  displayName: string;
  role: "owner" | "member";
  joinedAt: Timestamp;
  last7: WindowStats;
  last30: WindowStats;
  currentStreak: number;
  updatedAt: Timestamp;
}

export type MemberStats = Pick<Member, "allTime" | "allTimeThrough" | "last7" | "last30">;

/** A finished attempt, reduced to what the standings need. Unfinished → null. */
export function resultOf(attempt: Pick<Attempt, "puzzleId" | "finishedAt" | "points" | "guessCount" | "elapsedMs">): FinishedResult | null {
  if (attempt.finishedAt === null || attempt.elapsedMs === null) return null;
  return { puzzleId: attempt.puzzleId, points: attempt.points, guessCount: attempt.guessCount, elapsedMs: attempt.elapsedMs };
}

/** Stats for a member as of `closedDay` from their finished results (the nightly job, D-25). */
export function memberStats(prev: AllTime, results: readonly FinishedResult[], closedDay: string): MemberStats {
  const days30 = windowDays(closedDay, WINDOW_30);
  return {
    ...advanceAllTime(prev, results, closedDay),
    last30: statsFor(results, days30, DROP_WORST),
    last7: statsFor(results, days30.slice(-WINDOW_7), 0),
  };
}

/**
 * A joiner brings their last 30 closed days with them (§4 "backfill"), and the
 * group's all-time for them starts there.
 */
export function backfillStats(results: readonly FinishedResult[], closedDay: string): MemberStats {
  const days30 = windowDays(closedDay, WINDOW_30);
  const inWindow = results.filter((r) => days30.includes(r.puzzleId));
  return memberStats({ allTime: EMPTY_STATS, allTimeThrough: null }, inWindow, closedDay);
}

export function newMember(uid: string, displayName: string, role: Member["role"], now: Timestamp, stats: MemberStats, currentStreak: number): Member {
  return { uid, displayName, role, joinedAt: now, ...stats, currentStreak, updatedAt: now };
}

/**
 * FR-1.3 within a group, resolved at read time (D-26): earliest member keeps the
 * bare name; later ones get " 2", " 3"… The base is trimmed so the result
 * still fits the 24-char limit.
 */
export function uniqueNames(members: readonly { uid: string; displayName: string; joinedAt: Timestamp }[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const ordered = [...members].sort((a, b) => a.joinedAt.toMillis() - b.joinedAt.toMillis() || a.uid.localeCompare(b.uid));
  for (const m of ordered) {
    let name = m.displayName;
    for (let n = 2; taken.has(name); n++) {
      const suffix = ` ${n}`;
      name = m.displayName.slice(0, 24 - suffix.length).trimEnd() + suffix;
    }
    taken.add(name);
    out.set(m.uid, name);
  }
  return out;
}

/**
 * D-23: who takes over when the owner goes. Earliest-joined admin/organizer if
 * any; otherwise the earliest-joined member, who must then be promoted so they
 * can actually manage. Null when nobody is left (the group is deleted).
 */
export function nextOwner(
  others: readonly { uid: string; joinedAt: Timestamp; userRole: Role }[],
): { uid: string; promote: boolean } | null {
  if (others.length === 0) return null;
  const byJoin = [...others].sort((a, b) => a.joinedAt.toMillis() - b.joinedAt.toMillis() || a.uid.localeCompare(b.uid));
  const manager = byJoin.find((m) => m.userRole !== "player");
  return manager ? { uid: manager.uid, promote: false } : { uid: byJoin[0]!.uid, promote: true };
}

// ---------------------------------------------------------------------------
// What a member sees (FR-4.6, FR-4.7, FR-4.11). Nothing here can name a country.
// ---------------------------------------------------------------------------

export type TodayState = "not_started" | "in_progress" | "finished";

export function todayState(attempt: Pick<Attempt, "finishedAt" | "solved"> | null | undefined): TodayState {
  if (!attempt) return "not_started";
  return statusOf(attempt as Attempt) === "in_progress" ? "in_progress" : "finished";
}

export interface RankedStats extends WindowStats { rank: number }

export interface LeaderboardRow {
  uid: string;
  displayName: string;
  isMe: boolean;
  currentStreak: number;
  allTime: RankedStats;
  last7: RankedStats;
  last30: RankedStats;
}

export interface TodayPlayer {
  uid: string;
  displayName: string;
  state: TodayState;
  /** Only once the viewer has finished today (FR-4.11); null otherwise. */
  points: number | null;
  guessCount: number | null;
}

export interface LeaderboardView {
  group: { groupId: string; name: string; memberCount: number; maxMembers: number; isOwner: boolean; ownerDisplayName: string };
  closedThrough: string;
  rows: LeaderboardRow[];
  today: { puzzleId: string; viewerFinished: boolean; players: TodayPlayer[] };
}

export function leaderboardView(input: {
  groupId: string;
  group: Group;
  members: readonly Member[];
  /** Today's attempt per uid; missing or null = not started. */
  todayAttempts: ReadonlyMap<string, Attempt | null>;
  viewerUid: string;
  today: string;
  closedDay: string;
}): LeaderboardView {
  const { groupId, group, members, todayAttempts, viewerUid, today, closedDay } = input;
  const names = uniqueNames(members);
  const ranks = {
    allTime: rankBy(members, (m) => m.allTime),
    last7: rankBy(members, (m) => m.last7),
    last30: rankBy(members, (m) => m.last30),
  };
  const rows = members.map((m, i) => ({
    uid: m.uid,
    displayName: names.get(m.uid) ?? m.displayName,
    isMe: m.uid === viewerUid,
    currentStreak: m.currentStreak,
    allTime: { ...m.allTime, rank: ranks.allTime[i]! },
    last7: { ...m.last7, rank: ranks.last7[i]! },
    last30: { ...m.last30, rank: ranks.last30[i]! },
  }));

  const viewerFinished = todayState(todayAttempts.get(viewerUid)) === "finished";
  const players = members.map((m) => {
    const a = todayAttempts.get(m.uid) ?? null;
    const state = todayState(a);
    const reveal = viewerFinished && state === "finished" && a !== null;
    return {
      uid: m.uid,
      displayName: names.get(m.uid) ?? m.displayName,
      state,
      points: reveal ? a.points : null,
      guessCount: reveal ? a.guessCount : null,
    };
  });

  return {
    group: {
      groupId, name: group.name, memberCount: group.memberCount, maxMembers: group.maxMembers,
      isOwner: group.ownerUid === viewerUid,
      ownerDisplayName: names.get(group.ownerUid) ?? "",
    },
    closedThrough: closedDay,
    rows,
    today: { puzzleId: today, viewerFinished, players },
  };
}
