/**
 * scheduleHealthCheck — Mondays 09:00 America/Sao_Paulo (NFR-6). Counts the
 * puzzles still ahead of today and logs SCHEDULE_LOW when fewer than 30 remain.
 * Regenerate with tools/generate-schedule.mjs --history and re-seed.
 *
 * It also sweeps expired invites, so `invites` cannot grow without bound. A
 * Firestore TTL policy would be the obvious tool and is one of the features with
 * no free allowance at all (docs/05-cost.md §3.3); a weekly query plus a handful
 * of deletes costs nothing worth measuring.
 */

import { Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db, invitesCol } from "./db";
import { scheduled } from "./lib/callable";
import { puzzleIdAt } from "./lib/puzzle-day";

const MIN_DAYS_AHEAD = 30;
const SWEEP_BATCH = 400;

export async function healthCheckNow(now: Timestamp): Promise<number> {
  const today = puzzleIdAt(now.toDate());
  const count = (await db().collection("puzzles").where("puzzleId", ">=", today).count().get()).data().count;
  if (count < MIN_DAYS_AHEAD) logger.error("SCHEDULE_LOW", { remaining: count, today });
  else logger.info("scheduleHealthCheck", { remaining: count });
  return count;
}

/** Deletes invites past their expiry, spent or not. Returns how many went. */
export async function sweepExpiredInvites(now: Timestamp): Promise<number> {
  let removed = 0;
  for (;;) {
    const snap = await invitesCol().where("expiresAt", "<", now).limit(SWEEP_BATCH).get();
    if (snap.empty) break;
    const batch = db().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
    if (snap.size < SWEEP_BATCH) break;
  }
  if (removed > 0) logger.info("sweepExpiredInvites", { removed });
  return removed;
}

export const scheduleHealthCheck = scheduled("0 9 * * 1", async () => {
  const now = Timestamp.now();
  await healthCheckNow(now);
  await sweepExpiredInvites(now);
});
