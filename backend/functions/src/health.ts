/**
 * scheduleHealthCheck — Mondays 09:00 America/Sao_Paulo (NFR-6). Counts the
 * puzzles still ahead of today and logs SCHEDULE_LOW when fewer than 30 remain.
 * Regenerate with tools/generate-schedule.mjs --history and re-seed.
 */

import { Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db } from "./db";
import { scheduled } from "./lib/callable";
import { puzzleIdAt } from "./lib/puzzle-day";

const MIN_DAYS_AHEAD = 30;

export async function healthCheckNow(now: Timestamp): Promise<number> {
  const today = puzzleIdAt(now.toDate());
  const count = (await db().collection("puzzles").where("puzzleId", ">=", today).count().get()).data().count;
  if (count < MIN_DAYS_AHEAD) logger.error("SCHEDULE_LOW", { remaining: count, today });
  else logger.info("scheduleHealthCheck", { remaining: count });
  return count;
}

export const scheduleHealthCheck = scheduled("0 9 * * 1", async () => {
  await healthCheckNow(Timestamp.now());
});
