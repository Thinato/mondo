// Admin dashboard (FR-7.2). The server enforces the role; this page only asks
// and renders. A non-admin gets one sentence and nothing else.

import { ask, watchAuth } from "./auth-ui.js";
import "./theme.js";
import { mountProfile } from "./profile.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"), status: $("status"), panel: $("panel"), tabs: $("tabs"),
  account: $("account"), profileBtn: $("profile-btn"), adminLink: $("admin-link"),
  usersRows: $("users-rows"), usersMore: $("users-more"), userAttempts: $("user-attempts"), userAttemptsTitle: $("user-attempts-title"), userAttemptsRows: $("user-attempts-rows"),
  groupsRows: $("groups-rows"), dayInput: $("day-input"), dayRows: $("day-rows"), dayTitle: $("day-title"), dayCounts: $("day-counts"),
  confirmDialog: $("confirm-dialog"), confirmText: $("confirm-text"),
};

let cursor = null;
let currentDay = null;
const TODAY = puzzleToday();

el.usersMore.textContent = t("loadMore"); // the markup label is a fallback

const profile = mountProfile({ button: el.profileBtn, setStatus: (text, cls) => setStatus(text, cls) });

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, profile, setStatus,
  onUser: (u) => {
    el.panel.hidden = !u;
    if (u) loadUsers(true);
  },
});

/** Denied anywhere → the page is not for this person. */
function denied(err) {
  if (err?.details?.code !== "permission-denied") return false;
  el.panel.hidden = true;
  setStatus(t("adminOnly"), "warn");
  return true;
}
function fail(err) { if (!denied(err)) setStatus(errorMessage(err), "err"); }

// --- tabs -----------------------------------------------------------------------

el.tabs.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-tab]");
  if (!b) return;
  for (const x of el.tabs.querySelectorAll("button")) {
    x.setAttribute("aria-selected", String(x === b));
    $(`tab-${x.dataset.tab}`).hidden = x !== b;
  }
  if (b.dataset.tab === "groups") loadGroups();
  if (b.dataset.tab === "day" && !currentDay) { el.dayInput.value = TODAY; loadDay(TODAY); }
});

// --- Usuários --------------------------------------------------------------------

async function loadUsers(reset) {
  if (reset) { cursor = null; el.usersRows.replaceChildren(); }
  el.usersMore.disabled = true;
  try {
    const res = await api.listUsers(cursor ? { cursor } : {});
    cursor = res.nextCursor;
    el.usersMore.hidden = !cursor;
    el.usersRows.append(...res.users.map(userRow));
  } catch (err) { fail(err); }
  finally { el.usersMore.disabled = false; }
}
el.usersMore.addEventListener("click", () => loadUsers(false));

function userRow(u) {
  const tr = document.createElement("tr");
  const role = document.createElement("td");
  if (u.role === "admin") role.textContent = t("role.admin");
  else {
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `Papel de ${u.displayName}`);
    for (const r of ["player", "organizer"]) {
      const o = document.createElement("option"); o.value = r; o.textContent = t(`role.${r}`); o.selected = r === u.role; sel.append(o);
    }
    sel.addEventListener("change", async () => {
      sel.disabled = true;
      try { await api.setRole({ uid: u.uid, role: sel.value }); setStatus(t("roleSaved"), "ok"); }
      catch (err) { fail(err); sel.value = u.role; }
      finally { sel.disabled = false; }
    });
    role.append(sel);
  }
  const attempts = document.createElement("td");
  const b = document.createElement("button"); b.type = "button"; b.className = "link"; b.textContent = "tentativas";
  b.addEventListener("click", () => loadUserAttempts(u));
  attempts.append(b);
  tr.append(cell(u.displayName, "name"), role, cell(formatDay(u.createdAt)), cell(u.totalPlayed), cell(u.totalSolved), cell(u.currentStreak), cell(u.groupCount), attempts);
  return tr;
}

async function loadUserAttempts(u) {
  try {
    const { attempts } = await api.listAttempts({ uid: u.uid });
    el.userAttemptsTitle.textContent = `Tentativas de ${u.displayName} (31 dias)`;
    const quickest = quickestOf(attempts);
    // Same six columns as the day, one column short of it: here the subject of
    // a row is the day rather than the person, and there is nothing to do to it.
    el.userAttemptsRows.replaceChildren(...attempts.flatMap((a) => attemptRows(a, {
      subject: subjectCell(formatDay(a.puzzleId), a), cols: 6, quickest,
    })));
    el.userAttempts.hidden = false;
  } catch (err) { fail(err); }
}

// --- Grupos ----------------------------------------------------------------------

async function loadGroups() {
  try {
    const { groups } = await api.listAllGroups({});
    el.groupsRows.replaceChildren(...groups.map((g) => {
      const tr = document.createElement("tr");
      const link = document.createElement("td");
      const a = document.createElement("a"); a.href = `./grupos.html?g=${g.groupId}`; a.textContent = "ver";
      link.append(a);
      tr.append(cell(g.name, "name"), cell(g.ownerDisplayName || "–"), cell(g.memberCount), cell(formatDay(g.createdAt)), link);
      return tr;
    }));
  } catch (err) { fail(err); }
}

// --- Dia -------------------------------------------------------------------------

el.dayInput.addEventListener("change", () => { if (el.dayInput.value) loadDay(el.dayInput.value); });

async function loadDay(puzzleId) {
  currentDay = puzzleId;
  try {
    const { attempts } = await api.listAttempts({ puzzleId });
    el.dayTitle.textContent = formatLongDay(puzzleId);
    el.dayCounts.textContent = dayCounts(attempts);
    const quickest = quickestOf(attempts);
    el.dayRows.replaceChildren(...attempts.flatMap((a) => attemptRows(a, {
      subject: subjectCell(a.displayName, a), cols: 7, quickest, actions: dayActions(a, puzzleId),
    })));
  } catch (err) { fail(err); }
}

/** What the day looks like before you read a single row. */
function dayCounts(attempts) {
  const bits = [
    t("adminDayPlayers", { n: attempts.length }),
    t("adminDayFinished", { n: attempts.filter((a) => a.state === "finished").length }),
  ];
  const voided = attempts.filter((a) => a.cheated).length;
  if (voided > 0) bits.push(t("adminDayVoided", { n: voided }));
  return bits.join(" · ");
}

/**
 * The two things you can do to a day, with something between them.
 *
 * Side by side, identical and touching, they read as one long sentence — which
 * is exactly what they were. The rule makes them two controls and the colour on
 * hover makes one of them the destructive one, so neither is told apart by
 * position alone.
 */
function dayActions(a, puzzleId) {
  const td = document.createElement("td");
  td.className = "div ctrl";
  const box = document.createElement("span");
  box.className = "acts";
  // "Nova chance" is today's only (D-30) and never on a voided day — the
  // server refuses that too, this just does not offer it.
  if (puzzleId === TODAY && !a.cheated) {
    box.append(action("Nova chance", t("confirmRetry", { name: a.displayName }), async () => {
      await api.grantRetry({ uid: a.uid, puzzleId });
      return t("retryGranted");
    }), separator());
  }
  // FR-7.7, D-82: any day, either direction.
  const undo = a.cheated;
  const b = action(
    t(undo ? "uncheat" : "cheat"),
    t(undo ? "confirmUncheat" : "confirmCheat", { name: a.displayName }),
    async () => {
      await api.setCheated({ uid: a.uid, puzzleId, cheated: !undo });
      return t(undo ? "cheatCleared" : "cheatSet");
    },
  );
  // Undoing is not destructive, so it does not get the colour that says so.
  if (!undo) b.classList.add("danger");
  box.append(b);
  td.append(box);
  return td;
}

function separator() {
  const s = document.createElement("span");
  s.className = "sep";
  s.setAttribute("aria-hidden", "true");
  s.textContent = "|";
  return s;
}

/**
 * A confirm-then-call button. Two of these sit in the Dia row and both want the
 * same five lines — confirm, call, say what happened, reload, and do not leave
 * the button live while the call is in flight.
 */
function action(label, confirm, run) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "link"; b.textContent = label;
  b.addEventListener("click", async () => {
    if (!(await ask(el.confirmDialog, el.confirmText, confirm))) return;
    b.disabled = true;
    try { setStatus(await run(), "ok"); loadDay(currentDay); }
    catch (err) { fail(err); b.disabled = false; }
  });
  return b;
}

// --- cells ----------------------------------------------------------------------

function cell(text, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  td.textContent = text === null || text === undefined ? "–" : String(text);
  return td;
}

/**
 * One attempt: the row itself, and the hidden row under it holding its
 * challenges.
 *
 * The challenges table used to live inside a cell of this row, which made the
 * widest thing on the page the narrowest column on it — four columns squeezed
 * into one column's width, with the headings wrapping to two lines to get
 * there, and the whole board pushed past the viewport for the trouble. A
 * `colspan` row gives it the width the row already has.
 */
function attemptRows(a, { subject, cols, quickest, actions = null }) {
  const tr = document.createElement("tr");
  // A voided day still shows every number it ever had; what it stops doing is
  // counting, and the row has to say so at a glance (D-82).
  if (a.cheated) tr.className = "voided";

  const fast = fastestMs(a);
  tr.append(
    subject,
    cell(a.points, "pts div"),
    cell(a.guessCount),
    cell(formatMs(a.elapsedMs)),
    cell(formatSecs(fast), fast !== null && fast === quickest ? "fast" : null),
  );

  const detail = a.items?.length ? detailRow(a, cols) : null;
  const disc = document.createElement("td");
  disc.className = "div ctrl";
  disc.append(detail ? disclosure(detail, a.items.length) : "–");
  tr.append(disc);
  if (actions) tr.append(actions);

  return detail ? [tr, detail] : [tr];
}

/**
 * The row's subject, and under it everything that qualifies the row rather than
 * measures it.
 *
 * The state was a column of its own and the badges were a column with no
 * heading, which gave a number the same weight as the person a row is about.
 */
function subjectCell(text, a) {
  const td = document.createElement("td");
  td.className = "subject";
  const name = document.createElement("b");
  name.textContent = text;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.append(...badges(a));
  td.append(name, sub);
  return td;
}

/** The state, then anything unusual about the attempt. */
function badges(a) {
  const out = [t(`state.${a.state}`)];
  const add = (text, warn) => {
    const b = document.createElement("span");
    b.className = warn ? "badge warn" : "badge";
    b.textContent = text;
    out.push(" ", b);
  };
  if (a.cheated) add(t("badgeCheated"), true);
  // D-77: a phone backgrounds itself constantly and a desktop tab may honestly
  // never hide, so "no hides" means two different things and the device has to
  // travel with the claims for the column to be readable at all.
  if (a.reportPlatform) add(t(`platform.${a.reportPlatform}`));
  if (a.impossibleReports > 0) add(t("badgeImpossible", { n: a.impossibleReports }), true);
  if (a.suspicious) add("suspeito", true);
  if (a.retries > 0) add(`${a.retries}× nova chance`);
  return out;
}

/**
 * The shortest gap between two of this attempt's guesses (cheating material,
 * D-31).
 *
 * The column used to be every gap, in milliseconds — up to twenty numbers in
 * one cell on a seven-challenge day, and by far the widest thing on the board.
 * Only one of them was ever read down the page, which is why only one of them
 * was highlighted. The rest are in the challenges table, in seconds, beside the
 * guess they belong to.
 */
function fastestMs(a) {
  return a.intervalsMs.length > 0 ? Math.min(...a.intervalsMs) : null;
}

/**
 * The fastest gap on the whole table.
 *
 * The flat column highlighted the smallest gap within a row, which is the right
 * mark when the whole row is on show. One number per row is read DOWN the
 * column instead, so the mark moves with it. Both are orderings and neither is
 * a threshold: what counts as too fast is the server's rule (SEC-5's floor) and
 * a second copy of it here is the drift D-66 and D-80 already charged us for.
 */
function quickestOf(attempts) {
  const all = attempts.flatMap((a) => a.intervalsMs);
  return all.length > 1 ? Math.min(...all) : null;
}

/** The hidden row that holds one attempt's challenges, full width. */
function detailRow(a, cols) {
  const tr = document.createElement("tr");
  tr.className = "detail";
  tr.hidden = true;
  const td = document.createElement("td");
  td.colSpan = cols;
  const box = document.createElement("div");
  box.append(guessTable(a));
  td.append(box);
  tr.append(td);
  return tr;
}

let discId = 0;

/**
 * A disclosure that opens a sibling row.
 *
 * `<details>` cannot span table rows and spanning them is the whole point, so
 * the two states are written out. Nothing is lost by it: `aria-expanded` is
 * what a screen reader announces either way, and Enter and Space come free with
 * a real `<button>`.
 */
function disclosure(row, n) {
  row.id = `detail-${++discId}`;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "disc";
  b.setAttribute("aria-expanded", "false");
  b.setAttribute("aria-controls", row.id);
  b.append(chevron(), t("adminChallenges", { n }));
  b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") === "true";
    b.setAttribute("aria-expanded", String(!open));
    // `hidden` on a <tr> is an HTMLElement property and reflects to the
    // attribute, which `[hidden]` in mondo.css then wins with. (It would NOT
    // have worked on the <svg> beside it — see theme.js.)
    row.hidden = open;
  });
  return b;
}

function chevron() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M9 5l7 7-7 7");
  svg.append(path);
  return svg;
}

/**
 * One row per guess: which challenge it was, what was guessed, how long it took.
 * The flat "Intervalos" column is for scanning every player at once; this is for
 * reading one of them, which is why the kind repeats on every row rather than
 * spanning — a table you read top to bottom should not need you to look upwards
 * to know what a row is about.
 */
function guessTable(a) {
  // Its own class, because `table.board`'s padding, borders and mono font are
  // written as descendant selectors and a table inside one of its cells inherits
  // the lot. Cheaper to name this table than to out-specify each rule.
  const table = document.createElement("table"); table.className = "detail";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const k of ["adminColChallenge", "adminColGuess", "adminColSeconds", "adminColAway"]) {
    const th = document.createElement("th"); th.textContent = t(k); hr.append(th);
  }
  // A fifth, empty column takes the slack. Four columns given a whole row to
  // themselves spread across it, and a guess a hand away from its own time is
  // worse than the cramped version this replaced.
  hr.append(document.createElement("th"));
  thead.append(hr);
  const tbody = document.createElement("tbody");
  // Highlighted across the whole day, not per challenge, so this column and the
  // flat one agree about which gap was the fast one.
  const all = a.items.flatMap((it) => it.intervalsMs);
  const min = all.length > 1 ? Math.min(...all) : null;
  for (const it of a.items) {
    const kind = t(`kindName.${it.kind}`);
    // A challenge someone gave up on has no guesses (FR-2.13, D-61) and a blank
    // row would read as a bug, so it says so and shows the clock it still has.
    if (it.intervalsMs.length === 0) {
      tbody.append(guessRow(kind, t("adminGaveUp"), it.elapsedMs, null, undefined, true));
      continue;
    }
    it.intervalsMs.forEach((ms, i) => {
      // `guesses` is null until the D-31 gate opens; the timings never wait.
      const g = it.guesses?.[i];
      // D-77: the claim sits in the column beside the interval it claims about,
      // which is the comparison the whole signal rests on.
      tbody.append(guessRow(kind, g ? guessLabel(g) : "–", ms, ms === min ? "fast" : null, it.selfReports?.[i] ?? null, i === 0));
    });
  }
  table.append(thead, tbody);
  return table;
}

function guessRow(kind, guess, ms, cls, report, first) {
  const tr = document.createElement("tr");
  // A rule where each challenge starts. The kind still repeats on every row —
  // a table you read top to bottom should not need you to look upwards to know
  // what a row is about — but the seven blocks are visible without counting.
  if (first) tr.className = "start";
  tr.append(cell(kind, "kind"), cell(guess, "said"), cell(formatSecs(ms), cls ? `secs ${cls}` : "secs"), awayCell(report), cell(""));
  return tr;
}

/**
 * D-77 — what the page claimed for this guess.
 *
 * The **empty cell is the one to read**: a guess that carried no claim at all
 * means the page never reported, and a player whose every row is empty while
 * everyone else's are noisy is the whole reason the field exists. A row of
 * zeros is not suspicious — most people finish a challenge without leaving the
 * page — so that case is a quiet dash rather than a badge.
 *
 * Never a verdict. `impossible` is the server's own comparison against the
 * interval it timed (`reportExceedsInterval`), not a re-derivation here: the
 * jitter allowance is a server rule and a second copy of it on the client is
 * the drift D-66 and D-80 already charged us for.
 */
function awayCell(report) {
  const td = document.createElement("td");
  // Two different absences, and conflating them would put the loud one on the
  // wrong row. `undefined` is a row with NO GUESS on it — a challenge given up
  // on (D-61) — which claims nothing and was never going to. `null` is a guess
  // that carried no claim, and that is the absence this column exists to show.
  if (report === undefined) { td.textContent = "–"; return td; }
  if (report === null) {
    td.className = "claim-none";
    td.textContent = t("awayNoReport");
    return td;
  }
  if (report.hides === 0 && report.blurs === 0) { td.textContent = "–"; return td; }
  const bits = [];
  if (report.hides > 0) bits.push(t("awayHides", { n: report.hides, secs: formatSecs(report.hiddenMs) }));
  if (report.blurs > 0) bits.push(t("awayBlurs", { n: report.blurs }));
  td.textContent = bits.join(" · ");
  if (report.impossible) td.className = "claim-off";
  return td;
}

/** A country guess carries how close it was; a number and a pick do not (D-53, D-64). */
function guessLabel(g) {
  return g.code ? `${g.name} · ${Math.round(g.distanceKm)} km · ${Math.round(g.proximity * 100)}%` : g.name;
}

// ---------------------------------------------------------------------------

/** The puzzle day open right now: noon rollover in São Paulo (OQ-2), same rule as the server. */
function puzzleToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric",
  }).formatToParts(new Date()).map((p) => [p.type, Number(p.value)]));
  let day = Date.UTC(parts.year, parts.month - 1, parts.day);
  if (parts.hour < 12) day -= 86_400_000;
  return new Date(day).toISOString().slice(0, 10);
}

const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
function formatDay(iso) { return dayFmt.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)); }

/** The day is the heading of its tab, and a heading is not a form field. */
const longDayFmt = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long" });
function formatLongDay(iso) { return longDayFmt.format(new Date(`${iso}T12:00:00Z`)); }
function formatMs(ms) {
  if (ms === null || ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One decimal, pt-BR comma: at this scale the tenths are the tell (SEC-5's floor is 0,4). */
const secsFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function formatSecs(ms) { return ms === null || ms === undefined ? "–" : secsFmt.format(ms / 1000); }

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = cls;
}
