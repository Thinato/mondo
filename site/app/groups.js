// Groups and boards (FR-4). Everything on screen comes from getLeaderboard;
// this file renders it and never computes a rank or a score itself.

import { ask, watchAuth } from "./auth-ui.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"), status: $("status"),
  list: $("list"), cards: $("cards"), noGroups: $("no-groups"), createForm: $("create-form"), createName: $("create-name"),
  board: $("board"), groupName: $("group-name"), groupMeta: $("group-meta"),
  ownerTools: $("owner-tools"), inviteBtn: $("invite-btn"), inviteResult: $("invite-result"), inviteHint: $("invite-hint"),
  inviteUrl: $("invite-url"), copyBtn: $("copy-btn"), renameBtn: $("rename-btn"), renameForm: $("rename-form"),
  renameName: $("rename-name"), renameCancel: $("rename-cancel"), pending: $("pending"),
  tabs: $("tabs"), rows: $("rows"), actionsHead: $("actions-head"), closedThrough: $("closed-through"),
  todayHint: $("today-hint"), todayFinished: $("today-finished"), todayPlaying: $("today-playing"), todayWaiting: $("today-waiting"),
  leaveBtn: $("leave-btn"), confirmDialog: $("confirm-dialog"), confirmText: $("confirm-text"),
};

const params = new URLSearchParams(location.search);
let gid = params.get("g");
let view = null;          // last getLeaderboard response
let window_ = "last30";   // FR-4.7
let user = null;

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut, setStatus,
  onUser: (u) => {
    user = u;
    el.list.hidden = el.board.hidden = true;
    if (!u) return;
    const token = params.get("convite");
    if (token) return accept(token);
    if (gid) return loadBoard();
    loadList();
  },
});

// ---------------------------------------------------------------------------
// Invite link (FR-4.3 as amended): ?convite=TOKEN
// ---------------------------------------------------------------------------

async function accept(token) {
  const ok = await ask(el.confirmDialog, el.confirmText, t("confirmJoin"));
  if (!ok) { history.replaceState(null, "", "./grupos.html"); return loadList(); }
  try {
    const res = await api.acceptInvite({ token });
    gid = res.groupId;
    history.replaceState(null, "", `./grupos.html?g=${gid}`);
    setStatus(t("invited", { name: res.name }), "ok");
    await loadBoard();
  } catch (err) {
    setStatus(errorMessage(err), "err");
    history.replaceState(null, "", "./grupos.html");
    loadList();
  }
}

// ---------------------------------------------------------------------------
// Group list
// ---------------------------------------------------------------------------

async function loadList() {
  el.board.hidden = true;
  el.list.hidden = false;
  try {
    const { groups, canCreate } = await api.listGroups({});
    el.createForm.hidden = !canCreate;
    el.cards.replaceChildren(...groups.map((g) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `./grupos.html?g=${g.groupId}`;
      const name = document.createElement("span"); name.textContent = g.name;
      const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = t("players", { n: g.memberCount });
      if (g.isOwner) { const b = document.createElement("span"); b.className = "badge"; b.textContent = t("owner"); meta.prepend(b, " "); }
      a.append(name, meta);
      li.append(a);
      return li;
    }));
    el.noGroups.hidden = groups.length > 0;
    el.noGroups.textContent = t("noGroups");
  } catch (err) {
    setStatus(errorMessage(err), "err");
  }
}

el.createForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const button = ev.submitter; button.disabled = true;
  try {
    const { groupId } = await api.createGroup({ name: el.createName.value.trim() });
    el.createName.value = "";
    gid = groupId;
    history.pushState(null, "", `./grupos.html?g=${gid}`);
    setStatus(t("created"), "ok");
    await loadBoard();
  } catch (err) {
    // FR-4.1 as amended: only organizers create groups; say so plainly.
    setStatus(err?.details?.code === "permission-denied" ? t("notOrganizer") : errorMessage(err), "err");
  } finally { button.disabled = false; }
});

// ---------------------------------------------------------------------------
// Board (FR-4.6, FR-4.7, FR-4.11)
// ---------------------------------------------------------------------------

async function loadBoard() {
  el.list.hidden = true;
  el.board.hidden = false;
  try {
    view = await api.getLeaderboard({ groupId: gid });
    render();
    if (view.group.isOwner) loadPending();
  } catch (err) {
    setStatus(errorMessage(err), "err");
    el.board.hidden = true;
  }
}

function render() {
  const { group, rows, today, closedThrough } = view;
  el.groupName.textContent = group.name;
  el.groupMeta.textContent = `${t("players", { n: group.memberCount })} · ${t("owner")}: ${group.ownerDisplayName}`;
  el.ownerTools.hidden = !group.isOwner;
  el.actionsHead.hidden = !group.isOwner;

  const sorted = [...rows].sort((a, b) => a[window_].rank - b[window_].rank || a.displayName.localeCompare(b.displayName));
  el.rows.replaceChildren(...sorted.map((r) => {
    const tr = document.createElement("tr");
    if (r.isMe) tr.className = "me";
    const s = r[window_];
    const cells = [s.rank, r.displayName, s.points, s.played, s.avgGuesses ?? "–", r.currentStreak];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      if (i === 1) td.className = "name";
      td.textContent = String(v);
      tr.append(td);
    });
    if (group.isOwner) {
      const td = document.createElement("td");
      if (!r.isMe) {
        const b = document.createElement("button"); b.type = "button"; b.className = "link"; b.textContent = "remover";
        b.addEventListener("click", () => remove(r));
        td.append(b);
      }
      tr.append(td);
    }
    return tr;
  }));
  el.closedThrough.textContent = t("closedThrough", { day: formatDay(closedThrough) });

  // FR-4.11: states always; scores only once the viewer has finished.
  el.todayHint.replaceChildren();
  if (!today.viewerFinished) {
    const a = document.createElement("a"); a.href = "./"; a.textContent = t("playFirst");
    el.todayHint.append(a);
  }
  const by = (state) => today.players.filter((p) => p.state === state);
  el.todayFinished.replaceChildren(...by("finished").map((p) => todayItem(p, today.viewerFinished)));
  el.todayPlaying.replaceChildren(...by("in_progress").map((p) => todayItem(p, false)));
  el.todayWaiting.replaceChildren(...by("not_started").map((p) => todayItem(p, false)));
}

function todayItem(p, withScore) {
  const li = document.createElement("li");
  const name = document.createElement("span"); name.textContent = p.displayName;
  li.append(name);
  if (withScore && p.points !== null) {
    const score = document.createElement("span"); score.className = "score";
    score.textContent = t("todayScore", { points: p.points, n: p.guessCount });
    li.append(score);
  }
  return li;
}

el.tabs.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-window]");
  if (!b) return;
  window_ = b.dataset.window;
  for (const x of el.tabs.querySelectorAll("button")) x.setAttribute("aria-selected", String(x === b));
  if (view) render(); // no network: ranks for all three windows came with the response
});

// --- owner actions (FR-4.8) --------------------------------------------------

el.inviteBtn.addEventListener("click", async () => {
  el.inviteBtn.disabled = true;
  try {
    const inv = await api.createInvite({ groupId: gid });
    el.inviteUrl.textContent = inv.url;
    el.inviteHint.textContent = t("inviteCreated");
    el.inviteResult.hidden = false;
    el.copyBtn.textContent = "Copiar link";
    loadPending();
  } catch (err) { setStatus(errorMessage(err), "err"); }
  finally { el.inviteBtn.disabled = false; }
});

el.copyBtn.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(el.inviteUrl.textContent); el.copyBtn.textContent = t("copied"); }
  catch { setStatus(t("copyFailed"), "warn"); }
});

async function loadPending() {
  try {
    const { invites } = await api.listInvites({ groupId: gid });
    el.pending.replaceChildren(...invites.map((i) => {
      const li = document.createElement("li");
      const txt = document.createElement("span"); txt.textContent = `…${i.token.slice(-4)} · ${t("expires", { date: formatDay(i.expiresAt.slice(0, 10)) })}`;
      const b = document.createElement("button"); b.type = "button"; b.className = "link"; b.textContent = "Revogar";
      b.addEventListener("click", async () => {
        try { await api.revokeInvite({ token: i.token }); setStatus(t("inviteRevoked"), "ok"); loadPending(); }
        catch (err) { setStatus(errorMessage(err), "err"); }
      });
      li.append(txt, b);
      return li;
    }));
    if (invites.length === 0) { const li = document.createElement("li"); li.textContent = t("noPending"); el.pending.append(li); }
  } catch (err) { setStatus(errorMessage(err), "err"); }
}

el.renameBtn.addEventListener("click", () => { el.renameName.value = view?.group.name ?? ""; el.renameForm.hidden = false; el.renameName.select(); });
el.renameCancel.addEventListener("click", () => { el.renameForm.hidden = true; });
el.renameForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api.renameGroup({ groupId: gid, name: el.renameName.value.trim() });
    el.renameForm.hidden = true;
    setStatus(t("renamed"), "ok");
    await loadBoard();
  } catch (err) { setStatus(errorMessage(err), "err"); }
});

async function remove(row) {
  if (!(await ask(el.confirmDialog, el.confirmText, t("confirmRemove", { name: row.displayName })))) return;
  try { await api.removeMember({ groupId: gid, uid: row.uid }); setStatus(t("removed"), "ok"); await loadBoard(); }
  catch (err) { setStatus(errorMessage(err), "err"); }
}

el.leaveBtn.addEventListener("click", async () => {
  if (!(await ask(el.confirmDialog, el.confirmText, t("confirmLeave", { name: view?.group.name ?? "" })))) return;
  try {
    await api.leaveGroup({ groupId: gid });
    gid = null;
    history.replaceState(null, "", "./grupos.html");
    setStatus(t("left"), "ok");
    loadList();
  } catch (err) { setStatus(errorMessage(err), "err"); }
});

// ---------------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
function formatDay(iso) { return dayFmt.format(new Date(`${iso}T12:00:00Z`)); }

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = cls;
}
