// What the page can see about the player leaving it, per guess (D-77).
//
// This is EVIDENCE, not enforcement, and the server treats it as a claim —
// `backend/functions/src/lib/report.ts` has the argument for collecting a
// signal that is trivial to strip. The short version: the report is sent with
// every guess, unconditionally, including when nothing happened. A signal that
// everyone emits is one whose ABSENCE is conspicuous, and the cheapest way to
// defeat it (delete this file's listeners) is the one that stands out most.
//
// So: no cleverness, no obfuscation, no attempt to detect tampering. Anything
// that made this harder to strip would also make it easier to strip QUIETLY,
// which is backwards.
//
// What it cannot see, which matters more than what it can: a second device.
// Someone reading the answer off their phone produces a perfectly clean
// report. Nothing here is a cheating test.

const monotonic = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * A phone backgrounds itself constantly — every notification, every screen
 * timeout — while a desktop tab may legitimately never hide at all. "Never
 * hid" means completely different things on the two, so the platform travels
 * with the claim. A coarse pointer is the honest test: it is about the device,
 * not the user agent string, which lies.
 */
const platform = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop";

let hides = 0;
let blurs = 0;
let hiddenMs = 0;
/** When the current hidden stretch began, or null if the page is visible. */
let hiddenSince = null;

function onHidden() {
  if (hiddenSince !== null) return;
  hides += 1;
  hiddenSince = monotonic();
}

function onVisible() {
  if (hiddenSince === null) return;
  hiddenMs += Math.round(monotonic() - hiddenSince);
  hiddenSince = null;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onHidden();
    else onVisible();
  });
  // A window can lose focus while staying perfectly visible — another window
  // beside this one, or devtools. `visibilitychange` never fires for that, so
  // it is counted separately rather than folded into `hides`: they are
  // different claims and a reader should be able to tell them apart.
  addEventListener("blur", () => {
    if (document.visibilityState === "visible") blurs += 1;
  });
  // `pagehide` rather than `beforeunload`: the latter is unreliable on mobile
  // and disqualifies the page from the back/forward cache. Nothing is sent
  // here — there is no guess to attach it to — but closing the open stretch
  // keeps the count honest if the page is restored from bfcache and played on.
  addEventListener("pagehide", onHidden);
  addEventListener("pageshow", onVisible);
}

/**
 * The claim for the window that just ended, and the start of the next one.
 *
 * Called once per guess, at the moment of sending, so the window it describes
 * is the one `cardIntervalsMs` times on the server. Two known gaps, both
 * accepted: a guess that FAILS to send loses its window (the counters have
 * already rolled over), and a page reload resets them mid-challenge, so both
 * under-report. Neither is worth defending against — `retries` already records
 * the reload, and this is a statistical signal, not a forensic one.
 */
export function takeReport() {
  // A guess submitted while the page is hidden is possible with a keyboard, so
  // close the open stretch before reading rather than losing it.
  if (hiddenSince !== null) {
    const now = monotonic();
    hiddenMs += Math.round(now - hiddenSince);
    hiddenSince = now;
  }
  const report = { hides, blurs, hiddenMs, platform: platform() };
  hides = 0;
  blurs = 0;
  hiddenMs = 0;
  return report;
}
