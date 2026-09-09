// Admin dashboard (FR-7.2). The server enforces the role; this page only asks
// and renders. A non-admin gets one sentence and nothing else.

import { ask, watchAuth } from "./auth-ui.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"), status: $("status"), panel: $("panel"), tabs: $("tabs"),
  usersRows: $("users-rows"), usersMore: $("users-more"), userAttempts: $("user-attempts"), userAttemptsTitle: $("user-attempts-title"), userAttemptsRows: $("user-attempts-rows"),
  groupsRows: $("groups-rows"), dayInput: $("day-input"), dayRows: $("day-rows"),
  confirmDialog: $("confirm-dialog"), confirmText: $("confirm-text"),
};

let cursor = null;
let currentDay = null;
const TODAY = puzzleToday();

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut, setStatus,
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
    el.userAttemptsRows.replaceChildren(...attempts.map((a) => {
      const tr = document.createElement("tr");
      tr.append(cell(formatDay(a.puzzleId)), cell(t(`state.${a.state}`)), cell(a.guessCount), cell(a.points), cell(formatMs(a.elapsedMs)), intervalsCell(a), extrasCell(a));
      return tr;
    }));
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
    el.dayRows.replaceChildren(...attempts.map((a) => {
      const tr = document.createElement("tr");
      const retry = document.createElement("td");
      if (puzzleId === TODAY) {
        const b = document.createElement("button"); b.type = "button"; b.className = "link"; b.textContent = "Nova chance";
        b.addEventListener("click", async () => {
          if (!(await ask(el.confirmDialog, el.confirmText, t("confirmRetry", { name: a.displayName })))) return;
          try { await api.grantRetry({ uid: a.uid, puzzleId }); setStatus(t("retryGranted"), "ok"); loadDay(puzzleId); }
          catch (err) { fail(err); }
        });
        retry.append(b);
      }
      tr.append(cell(a.displayName, "name"), cell(t(`state.${a.state}`)), cell(a.guessCount), cell(a.points), cell(formatMs(a.elapsedMs)), intervalsCell(a), extrasCell(a), retry);
      return tr;
    }));
  } catch (err) { fail(err); }
}

// --- cells ----------------------------------------------------------------------

function cell(text, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  td.textContent = text === null || text === undefined ? "–" : String(text);
  return td;
}

/** ms gaps, shortest highlighted (cheating material, D-31). */
function intervalsCell(a) {
  const td = document.createElement("td");
  const min = Math.min(...a.intervalsMs);
  a.intervalsMs.forEach((ms, i) => {
    const s = document.createElement("span");
    if (ms === min && a.intervalsMs.length > 1) s.className = "fast";
    s.textContent = String(ms);
    td.append(i ? " · " : "", s);
  });
  if (a.intervalsMs.length === 0) td.textContent = "–";
  return td;
}

/** suspicious badge, retries, and the guesses when the server chose to send them. */
function extrasCell(a) {
  const td = document.createElement("td");
  if (a.suspicious) { const b = document.createElement("span"); b.className = "badge warn"; b.textContent = "suspeito"; td.append(b, " "); }
  if (a.retries > 0) { const b = document.createElement("span"); b.className = "badge"; b.textContent = `${a.retries}× nova chance`; td.append(b, " "); }
  if (a.guesses) {
    const d = document.createElement("details"); d.className = "guesses";
    const sum = document.createElement("summary"); sum.textContent = "chutes";
    const ul = document.createElement("ul");
    for (const g of a.guesses) { const li = document.createElement("li"); li.textContent = `${g.name} · ${Math.round(g.distanceKm)} km · ${Math.round(g.proximity * 100)}%`; ul.append(li); }
    d.append(sum, ul);
    td.append(d);
  }
  return td;
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
function formatMs(ms) {
  if (ms === null || ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = cls;
}
