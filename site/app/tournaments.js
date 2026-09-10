// Tournaments (FR-5 as rewritten, FR-8; docs/06-tournaments.md §9).
//
// Three views on one page, chosen by the query string: a group's tournaments
// (?g=), one tournament (?t=), and playing its card (?t=…&jogar=1).
//
// Like groups.js, this file renders what the server sent and computes nothing.
// It cannot know an answer: the card's prompt is one SVG path or one city name,
// and an item's answer arrives only once that item is over (SEC-1).

import { ask, watchAuth } from "./auth-ui.js";
import * as api from "./api.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { arrow, band, formatKm, formatPercent, renderShape } from "./geo.js";
import { errorMessage, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"), status: $("status"),
  pick: $("pick"), pickCards: $("pick-cards"), pickEmpty: $("pick-empty"),
  list: $("list"), cards: $("cards"), noTournaments: $("no-tournaments"),
  backToGroup: $("back-to-group"), createForm: $("create-form"), createName: $("create-name"), presets: $("presets"),
  detail: $("detail"), backToList: $("back-to-list"), tName: $("t-name"), tMeta: $("t-meta"), tActions: $("t-actions"),
  round: $("round"), roundTitle: $("round-title"), roundCloses: $("round-closes"), playBtn: $("play-btn"),
  roundHint: $("round-hint"), roundFinished: $("round-finished"), roundPlaying: $("round-playing"), roundWaiting: $("round-waiting"),
  tHead: $("t-head"), tRows: $("t-rows"), standingsNote: $("standings-note"),
  fixtures: $("fixtures"), fixtureRounds: $("fixture-rounds"),
  card: $("card"), backFromCard: $("back-from-card"), cardProgress: $("card-progress"),
  cardShapeWrap: $("card-shape-wrap"), cardShape: $("card-shape"), cardCapital: $("card-capital"),
  cardGuesses: $("card-guesses"), cardForm: $("card-form"), cardInput: $("card-input"), cardList: $("card-datalist"),
  cardSubmit: $("card-submit"), cardLeft: $("card-left"), cardItems: $("card-items"), cardDone: $("card-done"),
  confirmDialog: $("confirm-dialog"), confirmText: $("confirm-text"),
};

const params = new URLSearchParams(location.search);
let gid = params.get("g");
let tid = params.get("t");
let playing = params.get("jogar") === "1";

let view = null;    // last getTournament response
let card = null;    // last getCard / submitCardGuess response
let ac = null;
let picked = null;
let busy = false;

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut, setStatus,
  onUser: (u) => {
    el.pick.hidden = el.list.hidden = el.detail.hidden = el.card.hidden = true;
    if (!u) { view = null; card = null; return; }
    route();
  },
});

function route() {
  if (tid && playing) return openCard();
  if (tid) return loadTournament();
  if (gid) return loadList();
  // The nav links carry no ?g=, so this is the front door, not an error state.
  return loadGroups();
}

/** No group chosen yet: list the caller's groups and let them pick one. */
async function loadGroups() {
  el.list.hidden = el.detail.hidden = el.card.hidden = true;
  el.pick.hidden = false;
  try {
    const { groups } = await api.listGroups({});
    el.pickCards.replaceChildren(...groups.map((g) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `./torneios.html?g=${g.groupId}`;
      const name = document.createElement("span"); name.textContent = g.name;
      const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = t("players", { n: g.memberCount });
      a.append(name, meta);
      li.append(a);
      return li;
    }));
    el.pickEmpty.hidden = groups.length > 0;
    el.pickEmpty.textContent = t("noGroups");
    // One group is the common case: skip the pick and go straight in.
    if (groups.length === 1) {
      gid = groups[0].groupId;
      history.replaceState(null, "", `./torneios.html?g=${gid}`);
      el.pick.hidden = true;
      return loadList();
    }
    setStatus("");
  } catch (err) {
    setStatus(errorMessage(err), "err");
  }
}

// ---------------------------------------------------------------------------
// A group's tournaments
// ---------------------------------------------------------------------------

async function loadList() {
  el.pick.hidden = el.detail.hidden = el.card.hidden = true;
  el.list.hidden = false;
  el.backToGroup.href = `./grupos.html?g=${gid}`;
  try {
    const { tournaments, presets, canManage } = await api.listTournaments({ groupId: gid });
    el.cards.replaceChildren(...tournaments.map(tournamentCard));
    el.noTournaments.hidden = tournaments.length > 0;
    el.noTournaments.textContent = t("noTournaments");
    el.createForm.hidden = !canManage;
    if (canManage) renderPresets(presets);
    setStatus("");
  } catch (err) {
    setStatus(errorMessage(err), "err");
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

el.createForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const preset = el.presets.querySelector("input[name=preset]:checked")?.value;
  if (!preset) return;
  const button = ev.submitter;
  button.disabled = true;
  try {
    const { tournamentId } = await api.createTournament({ groupId: gid, name: el.createName.value.trim(), preset });
    el.createName.value = "";
    tid = tournamentId;
    history.pushState(null, "", `./torneios.html?g=${gid}&t=${tid}`);
    setStatus(t("tournamentCreated"), "ok");
    await loadTournament();
  } catch (err) {
    setStatus(errorMessage(err), "err");
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// One tournament
// ---------------------------------------------------------------------------

async function loadTournament() {
  el.pick.hidden = el.list.hidden = el.card.hidden = true;
  el.detail.hidden = false;
  try {
    view = await api.getTournament({ tournamentId: tid });
    gid = view.groupId;
    el.backToList.href = `./torneios.html?g=${gid}`;
    renderTournament();
    setStatus("");
  } catch (err) {
    setStatus(errorMessage(err), "err");
    el.detail.hidden = true;
  }
}

function renderTournament() {
  el.tName.textContent = view.name;
  el.tMeta.textContent = [
    t(`statusOf.${view.status}`),
    t("players", { n: view.participantCount }),
    `${view.itemCount} desafios por rodada`,
  ].join(" · ");

  renderActions();
  renderRound();
  renderStandings();
  renderFixtures();
}

function renderActions() {
  const actions = [];
  if (view.status === "draft") {
    if (view.canJoin) actions.push(button(t("join"), "primary", () => participate(true)));
    else if (view.isParticipant) actions.push(button(t("leaveTournament"), "link", () => leave()));
    if (view.canManage) actions.push(button(t("start"), "primary", start));
  }
  if (view.status === "running" && view.canManage) actions.push(button(t("closeRound"), "link", closeRound));
  if (view.canManage && (view.status === "draft" || view.status === "running")) {
    actions.push(button(t("cancelTournament"), "link", cancel));
  }
  el.tActions.replaceChildren(...actions);
}

function button(text, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try { await onClick(); } finally { b.disabled = false; }
  });
  return b;
}

function renderRound() {
  const cur = view.current;
  el.round.hidden = cur === null;
  if (!cur) {
    if (view.status === "draft") el.roundHint.textContent = t("drafting", { n: view.participantCount });
    return;
  }
  el.roundTitle.textContent = t("roundOf", { n: cur.n, max: view.rounds });
  el.roundCloses.textContent = t("closesAt", { when: formatWhen(cur.closesAt) });

  el.playBtn.hidden = !view.isParticipant || cur.myState === "finished";
  el.playBtn.textContent = cur.myState === "in_progress" ? t("continueCard") : t("playCard");

  // FR-5.6: states for everyone, scores for nobody until the round closes.
  el.roundHint.textContent = view.isParticipant
    ? (cur.myState === "finished" ? `${t("cardDone", { points: cur.myPoints ?? 0 })} ${t("waitingForOthers")}` : t("waitingForOthers"))
    : t("notPlaying");

  const by = (state) => cur.players.filter((p) => p.state === state).map(playerItem);
  el.roundFinished.replaceChildren(...by("finished"));
  el.roundPlaying.replaceChildren(...by("in_progress"));
  el.roundWaiting.replaceChildren(...by("not_started"));
}

function playerItem(p) {
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = p.displayName;
  li.append(name);
  return li;
}

/**
 * Two tables, one function. Under `match` the league is decided by match
 * points and the card total is only the first tiebreak, so both columns are
 * shown and the points column is NOT the one that ranks — labelling them apart
 * is the whole reason this varies by regime (D-49).
 */
function renderStandings() {
  const isMatch = view.regime === "match";
  const heads = isMatch
    ? ["#", t("colName"), t("colMatchPoints"), t("colRecord"), t("colCards"), t("colGuesses"), t("colTime")]
    : ["#", t("colName"), t("colPoints"), t("colRounds"), t("colGuesses"), t("colTime")];
  el.tHead.replaceChildren(...heads.map((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    return th;
  }));

  el.tRows.replaceChildren(...view.standings.map((r) => {
    const tr = document.createElement("tr");
    if (r.isMe) tr.className = "me";
    const rec = r.record;
    const cells = isMatch
      ? [r.rank, r.displayName, rec ? rec.matchPoints : 0, recordText(rec), r.points, r.totalGuesses, formatDuration(r.totalElapsedMs)]
      : [r.rank, r.displayName, r.points, r.played, r.totalGuesses, formatDuration(r.totalElapsedMs)];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      if (i === 1) td.className = "name";
      td.textContent = String(v);
      tr.append(td);
    });
    return tr;
  }));
  el.standingsNote.textContent = view.closedRounds === 0 ? t("standingsPending") : "";
}

/** "3-1-0" wins-draws-losses, with the byes named rather than folded in silently. */
function recordText(rec) {
  if (!rec) return "";
  const base = `${rec.won}-${rec.drawn}-${rec.lost}`;
  return rec.byes > 0 ? `${base} (${t("byeCount", { n: rec.byes })})` : base;
}

/**
 * The draw, newest round first so the current one is at the top. A fixture is
 * public as soon as its round opens; the outcome only appears once it closes,
 * which is FR-5.6 falling out of the data rather than being filtered here.
 */
function renderFixtures() {
  const rounds = view.fixtures || [];
  el.fixtures.hidden = rounds.length === 0;
  if (rounds.length === 0) return;

  const nameOf = (uid) => {
    const p = view.participants.find((x) => x.uid === uid);
    return p ? p.displayName : "";
  };

  el.fixtureRounds.replaceChildren(...[...rounds].reverse().map((r) => {
    const wrap = document.createElement("div");
    const h = document.createElement("h4");
    h.textContent = `${t("roundOf", { n: r.n, max: view.rounds })}${r.closed ? "" : ` · ${t("roundOpen")}`}`;
    const ul = document.createElement("ul");
    ul.className = "fixtures";
    ul.append(...r.pairings.map((p) => {
      const li = document.createElement("li");
      if (p.b === null) {
        li.textContent = t("byeFixture", { name: nameOf(p.a) });
        return li;
      }
      // The winner is marked rather than the score being shown: under `match`
      // the score does not carry, so leading with it would mislead.
      const mark = (side) => (p.outcome === null ? "" : p.outcome === side ? " ✓" : p.outcome === "draw" ? " =" : "");
      li.textContent = `${nameOf(p.a)}${mark("a")} × ${nameOf(p.b)}${mark("b")}`;
      return li;
    }));
    wrap.append(h, ul);
    return wrap;
  }));
}

el.playBtn.addEventListener("click", () => {
  playing = true;
  history.pushState(null, "", `./torneios.html?g=${gid}&t=${tid}&jogar=1`);
  openCard();
});

async function leave() {
  if (!(await ask(el.confirmDialog, el.confirmText, t("confirmLeaveTournament", { name: view.name })))) return;
  return participate(false);
}

async function participate(join) {
  try {
    await api.setParticipation({ tournamentId: tid, join });
    setStatus(join ? t("joined") : t("droppedOut"), "ok");
    await loadTournament();
  } catch (err) { setStatus(errorMessage(err), "err"); }
}

async function start() {
  if (!(await ask(el.confirmDialog, el.confirmText, t("confirmStart", { name: view.name, n: view.participantCount })))) return;
  try {
    await api.startTournament({ tournamentId: tid });
    setStatus(t("started"), "ok");
    await loadTournament();
  } catch (err) { setStatus(errorMessage(err), "err"); }
}

async function closeRound() {
  if (!(await ask(el.confirmDialog, el.confirmText, t("confirmCloseRound")))) return;
  try {
    const res = await api.advanceTournament({ tournamentId: tid });
    setStatus(res.status === "finished" ? t("tournamentOver") : t("roundClosed"), "ok");
    await loadTournament();
  } catch (err) { setStatus(errorMessage(err), "err"); }
}

async function cancel() {
  if (!(await ask(el.confirmDialog, el.confirmText, t("confirmCancelTournament", { name: view.name })))) return;
  try {
    await api.cancelTournament({ tournamentId: tid });
    setStatus(t("tournamentCancelled"), "ok");
    await loadTournament();
  } catch (err) { setStatus(errorMessage(err), "err"); }
}

// ---------------------------------------------------------------------------
// Playing the card
// ---------------------------------------------------------------------------

async function openCard() {
  el.pick.hidden = el.list.hidden = el.detail.hidden = true;
  el.card.hidden = false;
  el.backFromCard.href = `./torneios.html?g=${gid}&t=${tid}`;
  setBusy(true);
  try {
    if (!ac) {
      const index = createIndex(await loadCountries());
      ac = attach({
        input: el.cardInput, list: el.cardList, index,
        onPick: (entry) => { picked = entry; submit(); },
        onMiss: (text) => { picked = null; if (text.trim()) setStatus(t("noMatch"), "warn"); },
      });
    }
    card = await api.getCard({ tournamentId: tid });
    setStatus("");
    renderCard();
  } catch (err) {
    setStatus(errorMessage(err), "err");
    el.card.hidden = true;
    playing = false;
    await loadTournament();
  } finally {
    setBusy(false);
    focusInput();
  }
}

el.cardForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!picked) ac.commit();
  else submit();
});
el.cardInput.addEventListener("input", () => { picked = null; });

async function submit() {
  if (busy || !card || !picked || card.status !== "in_progress") return;
  const guess = picked.code;
  picked = null;
  setBusy(true);
  setStatus("");
  try {
    card = await api.submitCardGuess({ tournamentId: tid, guess });
    el.cardInput.value = "";
    renderCard();
  } catch (err) {
    // FR-6.5: a failed submission consumes nothing and stays retryable.
    setStatus(errorMessage(err), "err");
  } finally {
    setBusy(false);
    focusInput();
  }
}

function renderCard() {
  const done = card.status === "finished";
  el.cardProgress.textContent = t("challengeOf", { n: Math.min(card.cursor + 1, card.itemCount), max: card.itemCount });

  // One prompt shape per kind. An unknown kind means the client is older than
  // the server: say so rather than rendering nothing.
  const kind = card.prompt?.kind ?? null;
  el.cardShapeWrap.hidden = kind !== "shape";
  el.cardCapital.hidden = kind !== "capital";
  if (kind === "shape") renderShape(el.cardShape, card.prompt.shape);
  else if (kind === "capital") el.cardCapital.textContent = t("capitalPrompt", { city: card.prompt.capital });
  else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  el.cardGuesses.replaceChildren(...card.guesses.map(guessRow));
  el.cardForm.hidden = done;
  el.cardLeft.textContent = done ? "" : t("guessesLeft", { n: card.guessesUsed, max: card.guessesMax });

  el.cardItems.replaceChildren(...card.items.map((it, i) => {
    const li = document.createElement("li");
    li.className = `card-item ${it.status}`;
    const n = document.createElement("span");
    n.textContent = `${i + 1}.`;
    const label = document.createElement("span");
    label.className = "name";
    // An answer appears only for an item that is already over (SEC-1).
    label.textContent = it.answer ? it.answer.name : t(`itemState.${it.status}`);
    const pts = document.createElement("span");
    pts.className = "score";
    pts.textContent = it.points === null ? "" : `${it.points} pts`;
    li.append(n, label, pts);
    return li;
  }));

  el.cardDone.hidden = !done;
  if (done) el.cardDone.textContent = t("cardDone", { points: card.points });
}

function guessRow(g) {
  const li = document.createElement("li");
  li.className = `guess band-${band(g.proximity)}`;
  const name = document.createElement("span"); name.className = "name"; name.textContent = g.name;
  const dist = document.createElement("span"); dist.className = "dist";
  dist.textContent = g.distanceKm === 0 ? "🎉" : formatKm(g.distanceKm);
  const dir = document.createElement("span"); dir.className = "dir";
  if (g.distanceKm > 0) {
    dir.textContent = arrow(g.compass);
    dir.setAttribute("aria-label", t(`compass.${g.compass}`));
    dir.title = t(`compass.${g.compass}`);
  }
  const pct = document.createElement("span"); pct.className = "pct"; pct.textContent = formatPercent(g.proximity);
  li.append(name, dist, dir, pct);
  return li;
}

function focusInput() {
  if (card?.status === "in_progress" && !el.cardInput.disabled) el.cardInput.focus();
}

function setBusy(b) {
  busy = b;
  el.cardInput.disabled = b;
  el.cardSubmit.disabled = b;
}

// ---------------------------------------------------------------------------

window.addEventListener("popstate", () => {
  const p = new URLSearchParams(location.search);
  gid = p.get("g");
  tid = p.get("t");
  playing = p.get("jogar") === "1";
  route();
});

const whenFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" });
function formatWhen(iso) { return whenFmt.format(new Date(iso)); }

function formatDuration(ms) {
  if (!ms) return "–";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = cls;
}
