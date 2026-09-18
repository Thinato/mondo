// Groups and boards (FR-4), and the tournaments that live inside them (FR-5).
//
// Everything on screen comes from getLeaderboard and listTournaments; this file
// renders it and never computes a rank or a score itself.
//
// A group is one page with three sections rather than three pages. Tournaments
// used to be a page of their own that opened by asking which group you meant —
// a question that being on this page has already answered — and the members
// were an extra column bolted onto the ranking table, visible only to the owner.
// The card of a tournament round is still torneios.html: that is a game screen,
// not a group screen.

import { ask, watchAuth } from "./auth-ui.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";
import { fillBuckets } from "./people.js";
import { mountProfile } from "./profile.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"), status: $("status"),
  account: $("account"), profileBtn: $("profile-btn"), adminLink: $("admin-link"),
  list: $("list"), cards: $("cards"), noGroups: $("no-groups"), createForm: $("create-form"), createName: $("create-name"),
  board: $("board"), groupName: $("group-name"), groupMeta: $("group-meta"),
  ownerTools: $("owner-tools"), inviteBtn: $("invite-btn"), inviteResult: $("invite-result"), inviteHint: $("invite-hint"),
  inviteUrl: $("invite-url"), copyBtn: $("copy-btn"), renameBtn: $("rename-btn"), renameForm: $("rename-form"),
  renameName: $("rename-name"), renameCancel: $("rename-cancel"),
  sections: $("sections"), tabRanking: $("tab-ranking"), tabTorneios: $("tab-torneios"), tabMembros: $("tab-membros"),
  countTournaments: $("count-tournaments"), countMembers: $("count-members"),
  tabs: $("tabs"), rows: $("rows"), closedThrough: $("closed-through"),
  todayHint: $("today-hint"), todayFinished: $("today-finished"), todayPlaying: $("today-playing"), todayWaiting: $("today-waiting"),
  openRound: $("open-round"), openRoundName: $("open-round-name"), openRoundMeta: $("open-round-meta"),
  tCards: $("t-cards"), noTournaments: $("no-tournaments"),
  tCreateForm: $("t-create-form"), tCreateName: $("t-create-name"), presets: $("presets"),
  memberRows: $("member-rows"), memberActionsHead: $("member-actions-head"),
  pendingWrap: $("pending-wrap"), pending: $("pending"),
  leaveBtn: $("leave-btn"), confirmDialog: $("confirm-dialog"), confirmText: $("confirm-text"),
};

const params = new URLSearchParams(location.search);
let gid = params.get("g");
let view = null;          // last getLeaderboard response
let tournaments = null;   // last listTournaments response
let window_ = "last30";   // FR-4.7
let section = "ranking";

const profile = mountProfile({ button: el.profileBtn, setStatus: (text, cls) => setStatus(text, cls) });

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, profile, setStatus,
  onUser: (u) => {
    el.list.hidden = el.board.hidden = true;
    if (!u) { view = null; tournaments = null; return; }
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
// One group (FR-4.6, FR-4.7, FR-4.11)
// ---------------------------------------------------------------------------

async function loadBoard() {
  el.list.hidden = true;
  el.board.hidden = false;
  try {
    // Fired here, not awaited here: the ranking is what the page is for, and a
    // slow or failing listTournaments must not hold it up. The Torneios tab and
    // the round card fill themselves in when it lands.
    loadTournaments();
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
  el.countMembers.textContent = String(group.memberCount);

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
    return tr;
  }));
  el.closedThrough.textContent = t("closedThrough", { day: formatDay(closedThrough) });

  renderMembers();

  // FR-4.11: states always; scores only once the viewer has finished.
  el.todayHint.replaceChildren();
  if (!today.viewerFinished) {
    const a = document.createElement("a"); a.href = "./"; a.textContent = t("playFirst");
    el.todayHint.append(a);
  }
  fillBuckets({
    players: today.players, withScore: today.viewerFinished,
    finished: el.todayFinished, playing: el.todayPlaying, waiting: el.todayWaiting,
  });
}

/**
 * Which row is the owner. getLeaderboard sends `isOwner` (about the viewer) and
 * `ownerDisplayName`, but no owner uid — so when the viewer IS the owner their
 * own row is the answer exactly, and otherwise the name is all there is. Two
 * members may share a display name, nothing stops them, so an ambiguous match
 * labels nobody rather than labelling the wrong person.
 */
function ownerRow(rows, group) {
  if (group.isOwner) return rows.find((r) => r.isMe) ?? null;
  const named = rows.filter((r) => r.displayName === group.ownerDisplayName);
  return named.length === 1 ? named[0] : null;
}

/**
 * Who is in the group (FR-4.8). This was an extra column on the ranking table
 * that only the owner could see, which made the ranking's own columns shift
 * about depending on who was looking.
 */
function renderMembers() {
  const { group, rows } = view;
  el.memberActionsHead.hidden = !group.isOwner;
  const byName = [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const owner = ownerRow(rows, group);
  el.memberRows.replaceChildren(...byName.map((r) => {
    const tr = document.createElement("tr");
    if (r.isMe) tr.className = "me";
    const name = document.createElement("td");
    name.className = "name";
    name.textContent = r.displayName;
    const role = document.createElement("td");
    role.textContent = r === owner ? t("owner") : "";
    tr.append(name, role);
    if (group.isOwner) {
      const td = document.createElement("td");
      if (!r.isMe) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "link"; b.textContent = "remover";
        b.addEventListener("click", () => remove(r));
        td.append(b);
      }
      tr.append(td);
    }
    return tr;
  }));
}

// --- the three sections ------------------------------------------------------

el.sections.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-tab]");
  if (!b) return;
  section = b.dataset.tab;
  for (const x of el.sections.querySelectorAll("button")) x.setAttribute("aria-selected", String(x === b));
  el.tabRanking.hidden = section !== "ranking";
  el.tabTorneios.hidden = section !== "torneios";
  el.tabMembros.hidden = section !== "membros";
});

el.tabs.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-window]");
  if (!b) return;
  window_ = b.dataset.window;
  for (const x of el.tabs.querySelectorAll("button")) x.setAttribute("aria-selected", String(x === b));
  if (view) render(); // no network: ranks for all three windows came with the response
});

// ---------------------------------------------------------------------------
// Tournaments, in the group they belong to (FR-5)
// ---------------------------------------------------------------------------

/** Never on the critical path: a group whose tournaments will not load is a
 *  group with an empty Torneios tab, not a group that failed to open. */
async function loadTournaments() {
  try {
    tournaments = await api.listTournaments({ groupId: gid });
  } catch { return; }
  renderTournaments();
}

function renderTournaments() {
  const { tournaments: list, presets, canManage } = tournaments;
  el.countTournaments.textContent = list.length > 0 ? String(list.length) : "";
  el.tCards.replaceChildren(...list.map(tournamentCard));
  el.noTournaments.hidden = list.length > 0;
  el.noTournaments.textContent = t("noTournaments");
  el.tCreateForm.hidden = !canManage;
  if (canManage) renderPresets(presets);

  // The one that is waiting on somebody, at the top of the panel beside the
  // board. If there are several running, the first is the one the server
  // listed first — picking a "most urgent" would need a round's closesAt, and
  // fetching every tournament to sort a card is not worth a round trip.
  const running = list.find((x) => x.status === "running");
  el.openRound.hidden = !running;
  if (running) {
    el.openRound.href = `./torneios.html?g=${gid}&t=${running.tournamentId}`;
    el.openRoundName.textContent = running.name;
    el.openRoundMeta.textContent = running.currentRound
      ? t("roundOf", { n: running.currentRound, max: running.rounds })
      : t("players", { n: running.participantCount });
  }
}

function tournamentCard(x) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = `./torneios.html?g=${gid}&t=${x.tournamentId}`;
  const name = document.createElement("span");
  name.textContent = x.name;
  const meta = document.createElement("span");
  meta.className = "meta";
  const bits = [t(`statusOf.${x.status}`), t("players", { n: x.participantCount })];
  if (x.status === "running" && x.currentRound) bits.push(t("roundOf", { n: x.currentRound, max: x.rounds }));
  meta.textContent = bits.join(" · ");
  if (x.isParticipant) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = "você";
    meta.prepend(b, " ");
  }
  a.append(name, meta);
  li.append(a);
  return li;
}

function renderPresets(presets) {
  if (el.presets.children.length > 1) return;
  const legend = document.createElement("legend");
  legend.className = "fine";
  legend.textContent = t("presetLabel");
  el.presets.replaceChildren(legend, ...presets.map((p, i) => {
    const label = document.createElement("label");
    label.className = "preset";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "preset";
    input.value = p.id;
    if (i === 0) input.checked = true;
    const strong = document.createElement("strong");
    strong.textContent = p.label;
    const desc = document.createElement("span");
    desc.className = "fine";
    desc.textContent = p.description;
    label.append(input, strong, desc);
    return label;
  }));
}

el.tCreateForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const preset = el.presets.querySelector("input[name=preset]:checked")?.value;
  if (!preset) return;
  const button = ev.submitter;
  button.disabled = true;
  try {
    const { tournamentId } = await api.createTournament({ groupId: gid, name: el.tCreateName.value.trim(), preset });
    location.href = `./torneios.html?g=${gid}&t=${tournamentId}`;
  } catch (err) {
    setStatus(errorMessage(err), "err");
    button.disabled = false;
  }
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
    el.pendingWrap.hidden = false;
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
  // FR-4.9 / D-23: the last member leaving dissolves the group and deletes its
  // pending invites, and now cancels its tournaments too. That is a much bigger
  // action than "you disappear from the ranking", so it gets its own warning.
  const name = view?.group.name ?? "";
  const lastOne = view?.group.isOwner && view?.group.memberCount === 1;
  if (!(await ask(el.confirmDialog, el.confirmText, t(lastOne ? "confirmLeaveLast" : "confirmLeave", { name })))) return;
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
