// The profile page (FR-13, D-97): anyone's last 30 days of the daily, and the
// owner's name and account (FR-1.3, FR-1.5), which used to be a dialog.
//
// Everything on screen is getProfile's. This file computes no stat and decides
// no visibility: a row comes with `recap: true` or it does not, and today's
// answers for another player are not something the server will send.

import { signOut } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { auth } from "./firebase.js";
import { showAccount, watchAuth } from "./auth-ui.js";
import "./theme.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";
import { guessRow } from "./geo.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"), status: $("status"),
  account: $("account"), adminLink: $("admin-link"),
  notFound: $("not-found"), profile: $("profile"), name: $("p-name"), meta: $("p-meta"),
  renameForm: $("rename-form"), renameName: $("rename-name"), renameHint: $("rename-hint"),
  chart: $("chart"), chartFrom: $("chart-from"), chartTo: $("chart-to"),
  kinds: $("kinds"), days: $("days"), noGames: $("no-games"),
  ownerFoot: $("owner-foot"), deleteBtn: $("delete-btn"),
  deleteDialog: $("delete-dialog"), deleteForm: $("delete-form"), deleteError: $("delete-error"),
};

const target = new URLSearchParams(location.search).get("u");
let view = null;

const setStatus = (text, cls = "") => { el.status.textContent = text; el.status.className = cls; };
const node = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, setStatus,
  onUser: (user) => {
    view = null;
    el.profile.hidden = el.notFound.hidden = true;
    if (user) load();
  },
});

async function load() {
  setStatus(t("loading"));
  try {
    view = await api.getProfile(target ? { uid: target } : {});
    setStatus("");
    render();
  } catch (err) {
    // An id that is not one is a profile that does not exist, as far as anyone can tell.
    if (err?.details?.code !== "invalid-argument") return setStatus(errorMessage(err), "err");
    setStatus("");
    el.notFound.hidden = false;
  }
}

function render() {
  // A new account has no profile document yet and is still its own owner:
  // rename and delete are exactly what it might want (AC 4).
  if (!view.found && !view.isOwner) return void (el.notFound.hidden = false);
  el.profile.hidden = false;

  const name = view.profile?.displayName ?? t("perfil.you");
  el.name.textContent = name;
  document.title = `Mondo — ${name}`;
  el.meta.textContent = view.profile
    ? t("perfil.streaks", { n: view.profile.currentStreak, max: view.profile.longestStreak })
    : "";

  el.renameForm.hidden = el.renameHint.hidden = el.ownerFoot.hidden = !view.isOwner;
  if (view.isOwner) el.renameName.value = view.profile?.displayName ?? "";

  renderChart();
  renderKinds();
  renderDays();
}

// ---------------------------------------------------------------------------
// The chart: one point per day played, as a share of that day's own maximum,
// so the days before a kind was added (D-75, D-79) do not read as a slump.

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

function renderChart() {
  const pts = view.chart;
  const x = (i) => (i * 300) / (pts.length - 1);
  const y = (pct) => 100 - pct;
  const kids = [0, 50, 100].map((p) => svg("line", { x1: 0, x2: 300, y1: y(p), y2: y(p), class: "grid" }));

  // A gap (a day not played, or voided) lifts the pen: the line never claims
  // a day that did not count.
  let d = "";
  let run = 0;
  pts.forEach((p, i) => {
    if (p === null) return void (run = 0);
    d += `${run++ === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p)}`;
  });
  if (d) kids.push(svg("path", { d, class: "line" }));
  pts.forEach((p, i) => { if (p !== null) kids.push(svg("circle", { cx: x(i).toFixed(1), cy: y(p), r: 2.6, class: "pt" })); });
  el.chart.replaceChildren(...kids);

  const played = pts.filter((p) => p !== null);
  const avg = played.length ? Math.round(played.reduce((a, b) => a + b, 0) / played.length) : 0;
  el.chart.setAttribute("aria-label", played.length ? t("perfil.chartLabel", { n: played.length, pct: avg }) : t("perfil.noGames"));

  el.chartFrom.textContent = formatDay(daysBefore(view.today, pts.length - 1));
  el.chartTo.textContent = formatDay(view.today);
}

const pct = new Intl.NumberFormat("pt-BR", { style: "percent" });
const one = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ARROW = { up: "↑", flat: "→", down: "↓" };

function renderKinds() {
  el.kinds.replaceChildren(...view.kinds.map((k) => {
    const tr = node("tr");
    const none = k.played === 0;
    const trend = node("td", `trend ${k.trend ?? ""}`, k.trend ? ARROW[k.trend] : "");
    if (k.trend) {
      trend.title = t(`perfil.trend.${k.trend}`);
      trend.setAttribute("aria-label", trend.title);
    }
    tr.append(
      node("td", "kind", t(`kindName.${k.kind}`)),
      node("td", "", String(k.played)),
      node("td", "", none ? "—" : one.format(k.avgPoints)),
      node("td", "", none ? "—" : pct.format(k.solvedPct / 100)),
      node("td", "", none ? "—" : pct.format(k.firstGuessPct / 100)),
      trend,
    );
    return tr;
  }));
}

// ---------------------------------------------------------------------------
// Days: newest first, each its points and the share grid; a closed day opens
// into its recap, fetched the first time it is opened.

function renderDays() {
  el.noGames.hidden = view.days.length > 0;
  el.days.replaceChildren(...view.days.map((day) => {
    const li = node("li", day.cheated ? "voided" : "");
    const head = node(day.recap ? "summary" : "div", "day-row");
    const when = node("span", "when", formatDay(day.puzzleId));
    const score = node("span", "score", `${day.points}/${day.maxPoints}`);
    // One square per challenge, so a closed row still says how the day went;
    // a grid line with 🎉 in it is a challenge solved.
    const strip = node("span", "strip", day.grid.map((line) => (line.includes("🎉") ? "🟩" : "🟥")).join(""));
    strip.setAttribute("aria-hidden", "true");
    head.append(when, score, strip);
    if (day.cheated) head.append(node("span", "badge", t("perfil.voided")));
    const grid = node("pre", "grid", day.grid.join("\n"));
    grid.setAttribute("aria-hidden", "true");

    if (!day.recap) {
      li.append(head, grid, node("p", "fine", t("perfil.recapLater")));
      return li;
    }
    const details = node("details");
    const body = node("div", "recap-body");
    details.append(head, grid, body);
    details.addEventListener("toggle", () => { if (details.open && !body.dataset.loaded) loadRecap(day.puzzleId, body); });
    li.append(details);
    return li;
  }));
}

async function loadRecap(day, body) {
  body.dataset.loaded = "1";
  body.replaceChildren(node("p", "fine", t("loading")));
  try {
    const r = await api.getProfile({ ...(target ? { uid: target } : {}), day });
    const list = node("ul", "recap");
    list.append(...r.items.map(recapItem));
    body.replaceChildren(list);
  } catch (err) {
    delete body.dataset.loaded;
    body.replaceChildren(node("p", "err", errorMessage(err)));
  }
}

function recapItem(it) {
  const li = node("li", it.solved ? "solved" : "failed");
  const left = node("span");
  const answer = it.answer ? it.answer.name + (it.answer.bornIn ? ` · ${it.answer.bornIn}` : "") : "—";
  left.append(node("span", "kind", t(`kindName.${it.kind}`)), node("span", "answer", answer));
  li.append(left, node("span", "score", String(it.points)));
  if (it.guesses.length) {
    const ul = node("ul", "guesses");
    ul.append(...it.guesses.map((g) => (g.kind === "choice" ? pickRow(g, it.answer) : guessRow(g))));
    li.append(ul);
  }
  return li;
}

/** A pick names no country; the reveal's `names` says which one it was (D-76). */
function pickRow(g, answer) {
  const right = answer && g.pick === answer.pick;
  const li = node("li", `guess band-${right ? 4 : 0}`);
  li.append(node("span", "name", answer?.names?.[g.pick] ?? `#${g.pick + 1}`), node("span", "dist", right ? "🎉" : "✗"));
  return li;
}

// ---------------------------------------------------------------------------
// The owner's account (FR-1.3, FR-1.5).

el.renameForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    const saved = await api.updateProfile({ displayName: el.renameName.value });
    el.name.textContent = saved.displayName;
    document.title = `Mondo — ${saved.displayName}`;
    showAccount(el.account, auth.currentUser, saved.displayName);
    setStatus(t("saved"), "ok");
  } catch (err) {
    setStatus(errorMessage(err), "err");
  }
});

el.deleteBtn.addEventListener("click", () => {
  el.deleteError.textContent = "";
  el.deleteDialog.showModal();
});
el.deleteForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (ev.submitter?.value !== "ok") return el.deleteDialog.close();
  ev.submitter.disabled = true;
  try {
    await api.deleteAccount({});
    await signOut(auth);
    location.href = "./";
  } catch (err) {
    el.deleteError.textContent = errorMessage(err);
    ev.submitter.disabled = false;
  }
});

// ---------------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** "qua., 14 de out." from a puzzle id, YYYY-MM-DD. */
function formatDay(iso) { return dayFmt.format(new Date(`${iso}T12:00:00Z`)); }
const daysBefore = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
