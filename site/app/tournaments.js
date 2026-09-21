// One tournament (FR-5 as rewritten, FR-8; docs/06-tournaments.md §9).
//
// Two views on one page, chosen by the query string: the tournament (?t=) and
// playing its card (?t=…&jogar=1). The LIST of a group's tournaments is a
// section of grupos.html — a tournament lives inside a group, so the screen
// that used to open here by asking which group you meant was asking a question
// its own entry point had already answered.
//
// Like groups.js, this file renders what the server sent and computes nothing.
// It cannot know an answer: the card's prompt is one SVG path, one flag or one city name,
// and an item's answer arrives only once that item is over (SEC-1).

import { ask, watchAuth } from "./auth-ui.js";
import { mountProfile } from "./profile.js";
import * as api from "./api.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, isPick, renderFlag, renderOptions, renderShape } from "./geo.js";
import { attachHelp } from "./help.js";
import { errorMessage, t } from "./i18n.js";
import { fillBuckets } from "./people.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"), status: $("status"),
  account: $("account"), profileBtn: $("profile-btn"), adminLink: $("admin-link"),
  detail: $("detail"), backToList: $("back-to-list"), tName: $("t-name"), tMeta: $("t-meta"), tActions: $("t-actions"),
  round: $("round"), roundTitle: $("round-title"), roundCloses: $("round-closes"), playBtn: $("play-btn"),
  roundHint: $("round-hint"), roundFinished: $("round-finished"), roundPlaying: $("round-playing"), roundWaiting: $("round-waiting"),
  tHead: $("t-head"), tRows: $("t-rows"), standingsNote: $("standings-note"),
  fixtures: $("fixtures"), fixtureRounds: $("fixture-rounds"),
  card: $("card"), backFromCard: $("back-from-card"), cardProgress: $("card-progress"),
  cardShapeWrap: $("card-shape-wrap"), cardShape: $("card-shape"), cardCapital: $("card-capital"),
  cardFlagWrap: $("card-flag-wrap"), cardFlag: $("card-flag"),
  cardGuesses: $("card-guesses"), cardForm: $("card-form"), cardInput: $("card-input"), cardList: $("card-datalist"),
  cardSubmit: $("card-submit"), cardLeft: $("card-left"), cardItems: $("card-items"), cardDone: $("card-done"),
  cardRoundTitle: $("card-round-title"), cardTotal: $("card-total"),
  cardCombo: $("card-combo"), cardMoney: $("card-money"), cardNumber: $("card-number"),
  helpBtn: $("help-btn"), helpDialog: $("help-dialog"), helpTitle: $("help-title"),
  helpBody: $("help-body"), helpClose: $("help-close"),
  cardReveal: $("card-reveal"), cardRevealText: $("card-reveal-text"), cardRevealNext: $("card-reveal-next"),
  cardOptions: $("card-options"),
  cardSide: $("card-side"), cardSideTitle: $("card-side-title"),
  cardSideFinished: $("card-side-finished"), cardSidePlaying: $("card-side-playing"), cardSideWaiting: $("card-side-waiting"),
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
/** D-55, as on the daily: the challenge that just ended, held until dismissed. */
let reveal = null;

const help = attachHelp({
  button: el.helpBtn, dialog: el.helpDialog,
  title: el.helpTitle, body: el.helpBody, close: el.helpClose,
});

const profile = mountProfile({ button: el.profileBtn, setStatus: (text, cls) => setStatus(text, cls) });

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, profile, setStatus,
  onUser: (u) => {
    el.detail.hidden = el.card.hidden = true;
    if (!u) { view = null; card = null; reveal = null; return; }
    route();
  },
});

function route() {
  if (tid && playing) return openCard();
  if (tid) return loadTournament();
  // Nothing named. Every link into this page carries a ?t=, so arriving without
  // one means a stale bookmark from when the list lived here.
  location.replace(gid ? `./grupos.html?g=${gid}` : "./grupos.html");
}

// ---------------------------------------------------------------------------
// One tournament
// ---------------------------------------------------------------------------

async function loadTournament() {
  el.card.hidden = true;
  el.detail.hidden = false;
  try {
    view = await api.getTournament({ tournamentId: tid });
    gid = view.groupId;
    el.backToList.href = `./grupos.html?g=${gid}`;
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
    // Second filled button on the same row, so it takes the quieter one: one
    // accent per screen, or the accent stops meaning anything.
    if (view.canManage) actions.push(button(t("start"), view.canJoin ? "secondary" : "primary", start));
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
  const tie = cur.tie;
  el.roundTitle.textContent = tie
    ? `${t("roundOf", { n: cur.n, max: view.rounds })} · ${t("suddenDeath", { k: tie.k })}`
    : t("roundOf", { n: cur.n, max: view.rounds });
  el.roundCloses.textContent = t("closesAt", { when: formatWhen(cur.closesAt) });

  // During a tiebreak only the tied players have anything to play.
  const canPlay = tie ? tie.amIn : view.isParticipant;
  el.playBtn.hidden = !canPlay || cur.myState === "finished";
  el.playBtn.textContent = cur.myState === "in_progress" ? t("continueCard") : t("playCard");

  // FR-5.6: states for everyone, scores for nobody until the round closes.
  if (tie && !tie.amIn) {
    const names = tie.uids.map(nameOf).join(" e ");
    el.roundHint.textContent = t("suddenDeathTheirs", { names });
  } else if (tie) {
    el.roundHint.textContent = cur.myState === "finished" ? t("waitingForOthers") : t("suddenDeathMine");
  } else {
    el.roundHint.textContent = view.isParticipant
      ? (cur.myState === "finished" ? `${t("cardDone", { points: cur.myPoints ?? 0 })} ${t("waitingForOthers")}` : t("waitingForOthers"))
      : t("notPlaying");
  }

  // FR-5.6 again: names, never scores, until the round closes.
  fillBuckets({
    players: cur.players,
    finished: el.roundFinished, playing: el.roundPlaying, waiting: el.roundWaiting,
  });
}

/**
 * Two tables, one function. Under `match` the league is decided by match
 * points and the card total is only the first tiebreak, so both columns are
 * shown and the points column is NOT the one that ranks — labelling them apart
 * is the whole reason this varies by regime (D-49).
 */
/** Display name for a uid, from the participant list the view already carries. */
function nameOf(uid) {
  const p = view.participants.find((x) => x.uid === uid);
  return p ? p.displayName : "";
}

function renderStandings() {
  const isKnockout = view.format === "single_elim" || view.format === "double_elim";
  const isMatch = view.regime === "match";
  const heads = isKnockout
    ? ["#", t("colName"), t("colPhase"), t("colRecord"), t("colCards"), t("colGuesses"), t("colTime")]
    : isMatch
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
    if (isKnockout && r.eliminated) tr.className = `${tr.className} out`.trim();
    const cells = isKnockout
      ? [r.rank, r.displayName, phaseText(r), recordText(rec), r.points, r.totalGuesses, formatDuration(r.totalElapsedMs)]
      : isMatch
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

/**
 * How far a player got. "Still in" is only "champion" once the tournament is
 * actually over — calling a semifinalist champion is the sort of thing a table
 * does when nobody checks the status.
 */
function phaseText(r) {
  if (!r.eliminated) return view.status === "finished" ? t("phaseChampion") : t("phaseAlive");
  return r.survived === 0 ? t("phaseOutFirst") : t("phaseOut", { n: r.survived + 1 });
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

  el.fixtureRounds.replaceChildren(...[...rounds].reverse().map((r) => {
    const wrap = document.createElement("div");
    const h = document.createElement("h4");
    h.textContent = `${t("roundOf", { n: r.n, max: view.rounds })}${r.closed ? "" : ` · ${t("roundOpen")}`}`;
    const ul = document.createElement("ul");
    ul.className = "fixtures";
    ul.append(...r.pairings.map((p) => {
      const li = document.createElement("li");
      // Two brackets run in the same round, so each fixture names its own.
      if (p.bracket) {
        const tag = document.createElement("span");
        tag.className = "bracket-tag";
        tag.textContent = t(`bracketOf.${p.bracket}`);
        // A text node after the tag, so the line still reads as a sentence when
        // it is copied or spoken — the inline-block only separates it visually.
        li.append(tag, " · ");
      }
      if (p.b === null) {
        li.append(t("byeFixture", { name: nameOf(p.a) }));
        return li;
      }
      // The winner is marked rather than the score being shown: under `match`
      // the score does not carry, so leading with it would mislead.
      if (p.outcome === "draw") {
        li.append(`${nameOf(p.a)} × ${nameOf(p.b)} · ${t("drawn")}`);
        return li;
      }
      const mark = (side) => (p.outcome === side ? " ✓" : "");
      li.append(`${nameOf(p.a)}${mark("a")} × ${nameOf(p.b)}${mark("b")}`);
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
  el.detail.hidden = true;
  el.card.hidden = false;
  reveal = null;
  el.cardSide.hidden = true;
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
    // D-57: both in the same tick. The card is what the player came for; the
    // panel beside it is context and is never waited on, never surfaced as an
    // error, and simply stays hidden if it cannot load.
    const tournamentSoon = api.getTournament({ tournamentId: tid }).catch(() => null);
    card = await api.getCard({ tournamentId: tid });
    setStatus("");
    renderCard();
    loadCardSide(tournamentSoon).catch(() => { /* context only; never the player's problem */ });
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

/** FR-8.7 — the prompt being revealed, kept because the server has moved on. */
let revealPrompt = null;

el.cardForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (card?.prompt?.kind === "gdp") {
    const value = Number(el.cardNumber.value);
    if (!Number.isFinite(value) || value <= 0) return setStatus(t("needNumber"), "warn");
    return submit(value);
  }
  if (!picked) ac.commit();
  else submit();
});
el.cardInput.addEventListener("input", () => { picked = null; });

/** `raw` is a number for `gdp`, an index for `flagPick`, else the picked country. */
async function submit(raw) {
  if (busy || reveal || !card || card.status !== "in_progress") return;
  if (raw === undefined && !picked) return;
  const guess = raw ?? picked.code;
  picked = null;
  setBusy(true);
  setStatus("");
  try {
    const before = card.cursor;
    // Captured before the call: after it, `card.prompt` is the NEXT challenge.
    const shown = card.prompt;
    card = await api.submitCardGuess({ tournamentId: tid, guess });
    el.cardInput.value = "";
    el.cardNumber.value = "";
    // D-55: a cursor that moved means that challenge is over, and a finished
    // item carries both its answer and the guesses that got there.
    if (card.cursor > before) {
      reveal = card.items[before];
      revealPrompt = shown;
      if (reveal.status === "solved") confetti();
    }
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
  const revealing = reveal !== null;
  // Once the card is done the counter would read "Desafio 5 de 5" for ever, and
  // the result line below says everything it said — the same call the daily
  // makes. During a reveal it would be counting the challenge behind the panel,
  // which nobody has started.
  el.cardProgress.hidden = done || revealing;
  el.helpBtn.hidden = done || revealing;
  el.cardProgress.textContent = done ? "" : t("challengeOf", { n: Math.min(card.cursor + 1, card.itemCount), max: card.itemCount });

  // One prompt shape per kind. An unknown kind means the client is older than
  // the server: say so rather than rendering nothing. A reveal holds the next
  // prompt back, so nothing about the challenge to come reaches the DOM early.
  // A choice challenge's prompt outlives its challenge: its reveal is which
  // option was right (FR-8.7, D-64), so the grid stays with the answer marked.
  const shown = revealing ? revealPrompt : card.prompt;
  const kind = revealing ? (isPick(shown?.kind) ? shown.kind : null) : card.prompt?.kind ?? null;
  el.cardShapeWrap.hidden = kind !== "shape";
  el.cardCapital.hidden = kind !== "capital" && kind !== "gdp" && !isPick(kind);
  el.cardFlagWrap.hidden = kind !== "flag";
  el.cardOptions.hidden = !isPick(kind);
  if (kind === "shape") renderShape(el.cardShape, card.prompt.shape);
  else if (kind === "capital") el.cardCapital.textContent = t("capitalPrompt", { city: card.prompt.capital });
  else if (kind === "gdp") el.cardCapital.textContent = t("gdpPrompt", { country: card.prompt.country, year: card.prompt.year });
  else if (kind === "flag") renderFlag(el.cardFlag, card.prompt.flag);
  else if (isPick(kind)) {
    el.cardCapital.textContent = t(`${kind}Prompt`, { country: shown.country });
    renderOptions(el.cardOptions, shown.options, {
      guesses: revealing ? reveal.guesses ?? [] : card.guesses,
      answer: revealing ? reveal.answer : null,
      onPick: revealing ? null : (i) => submit(i),
    });
  } else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  // Three inputs, at most one visible: a country autocomplete, a number field
  // (D-53), or the grid above, which is its own input (D-64).
  el.cardCombo.hidden = kind === "gdp";
  el.cardMoney.hidden = kind !== "gdp";

  // `?? []` for the same deploy window game.js documents. A pick has no row:
  // it is struck out in the grid, which is the only place it could be, since
  // the client is never told which country it was.
  const rows = isPick(kind) ? [] : revealing ? reveal.guesses ?? [] : card.guesses;
  el.cardGuesses.replaceChildren(...rows.map(guessRow));
  el.cardForm.hidden = done || revealing || isPick(kind);
  el.cardLeft.textContent = done || revealing ? "" : t("guessesLeft", { n: card.guessesUsed, max: card.guessesMax });

  // The rail (FR-6.11), the same one the daily has: five boxes above the prompt
  // on a phone, a row per challenge in the left column on a desktop.
  el.cardItems.replaceChildren(...card.items.map((it, i) => {
    const li = document.createElement("li");
    li.className = `step ${it.status}`;
    const n = document.createElement("span");
    n.className = "step-n";
    n.textContent = String(i + 1);
    const label = document.createElement("span");
    label.className = "step-name";
    label.textContent = t(`kindName.${it.kind}`);
    const pts = document.createElement("span");
    pts.className = "step-score";
    pts.textContent = it.status === "current" ? t("stepNow") : it.points === null ? "" : String(it.points);
    li.append(n, label, pts);
    return li;
  }));
  const scored = card.items.reduce((sum, it) => sum + (it.points ?? 0), 0);
  el.cardTotal.textContent = `${scored} / ${card.maxPoints ?? card.itemCount * 6}`;

  el.cardReveal.hidden = !revealing;
  if (revealing) {
    el.cardRevealText.textContent = reveal.status === "solved"
      ? t("revealSolved", { points: reveal.points })
      : isPick(kind)
      ? t("revealPick")
      : t("revealFailed", { answer: reveal.answer.name });
    el.cardRevealNext.textContent = done ? t("seeResult") : t("continueChallenge");
  } else {
    help(kind);
  }

  el.cardDone.hidden = !done || revealing;
  if (done && !revealing) el.cardDone.textContent = t("cardDone", { points: card.points });
}

/**
 * Who else is in this round, beside the card (D-57, FR-6.11).
 *
 * Playing a card is the loneliest screen in the app: one prompt, one clock, no
 * sign that anyone else exists. This is the panel that makes a tournament feel
 * live — and it is names only, because FR-5.6 keeps every score out until the
 * round closes.
 */
async function loadCardSide(tournamentSoon) {
  const t2 = await tournamentSoon;
  const cur = t2?.current;
  if (!cur) return;
  el.cardSideTitle.textContent = t("roundOf", { n: cur.n, max: t2.rounds });
  el.cardRoundTitle.textContent = t("roundOf", { n: cur.n, max: t2.rounds });
  fillBuckets({
    players: cur.players,
    finished: el.cardSideFinished, playing: el.cardSidePlaying, waiting: el.cardSideWaiting,
  });
  el.cardSide.hidden = false;
}

el.cardRevealNext.addEventListener("click", () => {
  reveal = null;
  revealPrompt = null;
  renderCard();
  focusInput();
});


function focusInput() {
  if (reveal) return el.cardRevealNext.focus();
  if (card?.status !== "in_progress") return;
  // A choice challenge has no field: the grid is the input (FR-8.7).
  if (isPick(card.prompt?.kind)) return;
  const field = card.prompt?.kind === "gdp" ? el.cardNumber : el.cardInput;
  if (!field.disabled) field.focus();
}

function setBusy(b) {
  busy = b;
  el.cardInput.disabled = b;
  el.cardNumber.disabled = b;
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
