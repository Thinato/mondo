/**
 * rebuildStandings — nightly at 12:05 America/Sao_Paulo (D-11), five minutes
 * after the puzzle day flips, so yesterday's rounds are final (D-25).
 *
 * Reads every attempt in the last 30 closed days once, then rewrites the
 * stats on every member document (D-21, D-22). Arithmetic in lib/standings.ts
 * and lib/groups.ts; this file is I/O.
 */

import { Timestamp, type WriteBatch } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db, groupsCol, membersCol, puzzleDays, userRef } from "./db";
import { scheduled } from "./lib/callable";
import { memberStats, resultOf, WINDOW_30, type Member } from "./lib/groups";
import type { Attempt, Profile } from "./lib/round";
import { effectiveStreak, nextDay, windowDays, type FinishedResult } from "./lib/standings";

const BATCH = 400; // Firestore caps a batch at 500 writes

/**
 * How far back a single run will reach to catch up. All-time is advanced from
 * `allTimeThrough` (D-25), so a run that read only the last 30 days would
 * silently skip — and permanently lose — everything in between if the job had
 * been down longer than that. It reads from the oldest member's watermark
 * instead, bounded so one corrupt watermark cannot scan the whole collection.
 */
const MAX_CATCHUP_DAYS = 400;

export async function rebuildStandingsNow(now: Timestamp): Promise<{ groups: number; members: number }> {
  const { today, closedDay } = puzzleDays(now);
  const days30 = windowDays(closedDay, WINDOW_30);

  const groups = await groupsCol().get();
  const memberDocs = await Promise.all(groups.docs.map((g) => membersCol(g.id).get()));
  const uids = [...new Set(memberDocs.flatMap((m) => m.docs.map((d) => d.id)))];
  const profiles = new Map<string, Profile>();
  if (uids.length > 0) {
    for (const snap of await db().getAll(...uids.map(userRef))) {
      if (snap.exists) profiles.set(snap.id, snap.data() as Profile);
    }
  }

  // The window the windows need is 30 days; all-time may need more after an
  // outage, so read from the oldest watermark among the members.
  const floor = windowDays(closedDay, MAX_CATCHUP_DAYS)[0]!;
  let from = days30[0]!;   // the 30-day window is always read, whatever the watermarks say
  let clamped = false;
  for (const snapshot of memberDocs) {
    for (const doc of snapshot.docs) {
      const through = (doc.data() as Member).allTimeThrough;
      if (through === null || through >= closedDay) continue;
      const wanted = nextDay(through);
      if (wanted < floor) clamped = true;
      from = min(from, max(wanted, floor));
    }
  }
  if (clamped) logger.error("STANDINGS_CATCHUP_CLAMPED", { from, floor, closedDay });

  // ponytail: one range query over all players' attempts; switch to per-member getAll of only group members past ~1 000 players.
  const attempts = await db().collection("attempts").where("puzzleId", ">=", from).where("puzzleId", "<=", closedDay).get();
  const resultsByUid = new Map<string, FinishedResult[]>();
  for (const doc of attempts.docs) {
    const a = doc.data() as Attempt;
    const r = resultOf(a);
    if (!r) continue;
    const list = resultsByUid.get(a.uid) ?? [];
    list.push(r);
    resultsByUid.set(a.uid, list);
  }

  let batch: WriteBatch = db().batch();
  let pending = 0;
  let members = 0;
  const flush = async () => { if (pending > 0) { await batch.commit(); batch = db().batch(); pending = 0; } };
  for (const snapshot of memberDocs) {
    for (const doc of snapshot.docs) {
      const m = doc.data() as Member;
      const profile = profiles.get(doc.id);
      const stats = memberStats({ allTime: m.allTime, allTimeThrough: m.allTimeThrough }, resultsByUid.get(doc.id) ?? [], closedDay);
      batch.update(doc.ref, {
        ...stats,
        currentStreak: effectiveStreak(profile ?? { lastPlayedOn: null, currentStreak: 0 }, closedDay, today),
        displayName: profile?.displayName ?? m.displayName,
        updatedAt: now,
      });
      members++;
      if (++pending >= BATCH) await flush();
    }
  }
  await flush();

  logger.info("rebuildStandings", { closedDay, from, groups: groups.size, members, attemptsRead: attempts.size });
  return { groups: groups.size, members };
}

const min = (a: string, b: string) => (a < b ? a : b);
const max = (a: string, b: string) => (a > b ? a : b);

export const rebuildStandings = scheduled("5 12 * * *", async () => {
  await rebuildStandingsNow(Timestamp.now());
});
