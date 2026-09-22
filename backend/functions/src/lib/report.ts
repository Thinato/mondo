/**
 * What the PAGE says happened while a challenge was open (D-77).
 *
 * Every number in here was measured by the client and sent by the client, which
 * makes it a **claim, never a measurement**. Nothing in this file may reach
 * scoring: invariant 3 is "server timestamps only", and the moment a self-report
 * touches points it becomes worth forging. It exists to be looked at by a human
 * on the admin timing surface, beside the intervals the SERVER timed, and to be
 * weighed with them rather than instead of them.
 *
 * **Why a forgeable signal is worth collecting.** Paulo, 2026-09-22: "if we are
 * never receiving this information from that user, it's even weirder — most
 * people will switch tabs at some point and they might not even be cheating".
 * That is the whole design. Stripping the field is easy, and that is the point:
 * a signal everybody emits makes SILENCE conspicuous, so the cheap forgery is
 * the one that stands out. It only works if the report is sent **unconditionally
 * and boringly**, including when nothing happened — see `EMPTY_REPORT`. A client that
 * only phoned home when it had something to say would make "no data" mean three
 * things at once (nothing happened / the field was stripped / the request died),
 * and that ambiguity is exactly the cell the argument depends on.
 *
 * **It is also bounded by a fact.** The window a report covers is the window
 * `cardIntervalsMs` times on the server, so `hiddenMs` cannot honestly exceed
 * that interval. Under-report and the zero-record rule catches it; over-report
 * and `reportExceedsInterval` catches it. The lie has nowhere comfortable to sit.
 *
 * What it can NEVER see, and nobody should forget: a second device. Someone
 * reading the answer off their phone produces a perfectly clean report. This is
 * evidence to weigh, not proof, and it is not a cheating test.
 */

import { mondoError } from "./errors";

/** A phone backgrounds itself constantly; a desktop tab may legitimately never
 *  hide. The base rate for "no hides at all" is completely different between
 *  them, so the platform travels with the claim or the claim cannot be read. */
export type ReportPlatform = "mobile" | "desktop";

export interface SelfReport {
  /** `visibilitychange` → hidden: tab switch, minimise, app switch, screen lock. */
  hides: number;
  /** Window blur while the page was still VISIBLE — a second window beside this
   *  one, or devtools taking focus. Invisible to `visibilitychange`. */
  blurs: number;
  /** Milliseconds hidden, by the client's own monotonic clock. A duration, not
   *  a timestamp, so wall-clock changes cannot move it. */
  hiddenMs: number;
  platform: ReportPlatform;
}

/** What a client with nothing to report must still send. */
export const EMPTY_REPORT: Readonly<SelfReport> = { hides: 0, blurs: 0, hiddenMs: 0, platform: "desktop" };

/** Nobody hides a tab ten thousand times inside one challenge, and no challenge
 *  is open for a day. These are not tolerances — they are the point past which
 *  the number is not a reading at all and storing it teaches nothing. */
const MAX_COUNT = 10_000;
const MAX_HIDDEN_MS = 24 * 60 * 60 * 1000;

/**
 * Client jitter allowed before `hiddenMs` is called impossible.
 *
 * The client's window opens when it receives the previous response and closes
 * when it sends this one, so it sits strictly INSIDE the server's interval —
 * the honest overhang is network latency, not clock skew, because `hiddenMs` is
 * a monotonic duration. A second is generous and still catches a client that
 * claims to have been away longer than the challenge was open.
 */
const JITTER_MS = 1_000;

/**
 * Parse what arrived on a callable, or refuse it. Absent is fine and means an
 * older page (`null`); present and malformed is not, because a shape nobody
 * validated is a shape nobody can read back later.
 */
export function parseSelfReport(raw: unknown): SelfReport | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw mondoError("invalid-argument", "Bad report.");
  const o = raw as Record<string, unknown>;

  // A closed shape: an unknown key means a client and a server that disagree
  // about what is being collected, which is the one thing this must not be
  // vague about.
  for (const key of Object.keys(o)) {
    if (!["hides", "blurs", "hiddenMs", "platform"].includes(key)) throw mondoError("invalid-argument", "Bad report.");
  }
  if (o.platform !== "mobile" && o.platform !== "desktop") throw mondoError("invalid-argument", "Bad report.");
  return {
    hides: count(o.hides, MAX_COUNT),
    blurs: count(o.blurs, MAX_COUNT),
    hiddenMs: count(o.hiddenMs, MAX_HIDDEN_MS),
    platform: o.platform,
  };
}

function count(v: unknown, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
    throw mondoError("invalid-argument", "Bad report.");
  }
  return v;
}

/**
 * Did the page claim to have been hidden for longer than the challenge was
 * open? Derived on read, never stored: the interval it is checked against is
 * the server's, and storing a verdict computed from two numbers that are both
 * still there is a fact with a shelf life.
 */
export function reportExceedsInterval(report: SelfReport | null | undefined, intervalMs: number): boolean {
  return report !== null && report !== undefined && report.hiddenMs > intervalMs + JITTER_MS;
}

/**
 * How many of a play's guesses made a claim the clock cannot support. The two
 * arrays are the same length and the same order by construction — `selfReports`
 * and `intervalsMs` are flattened the same way — and a short array simply ends
 * the count rather than throwing, because an admin panel is not the place to
 * discover that an old document is shaped differently.
 */
export function countImpossible(
  reports: readonly (SelfReport | null)[],
  intervals: readonly number[],
): number {
  return reports.reduce<number>((n, r, i) => {
    const interval = intervals[i];
    return interval === undefined ? n : n + (reportExceedsInterval(r, interval) ? 1 : 0);
  }, 0);
}
