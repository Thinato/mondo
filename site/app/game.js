// The day on screen: sign-in → load → guess loop → result (FR-2, FR-6).
// State comes from the server on every step; this file only renders it and
// never computes anything about the answer.
//
// D-52: a day is four challenges played in order, so this renders a cursor and
// one prompt at a time. It cannot know an answer it has not been sent: the
// server reveals a challenge only once that challenge is over.
//
// D-55: and when it does, that challenge keeps the screen until the player
// dismisses it. The old flow swapped the next prompt in on the same frame, so
// the answer to the one just played went past unread.

import { onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { auth, googleProvider } from "./firebase.js";
import * as api from "./api.js";
import { applyIdentity, ask, attachAccount, showAccount } from "./auth-ui.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, isPick, renderAbout, renderFlag, renderOptions, renderPerson, renderShape } from "./geo.js";
import { attachHelp } from "./help.js";
import { errorMessage, t } from "./i18n.js";
import { fillBuckets } from "./people.js";
import { mountProfile } from "./profile.js";
import { share } from "./share.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), game: $("game"), signIn: $("sign-in"), signOut: $("sign-out"),
  progress: $("progress"), items: $("items"), combo: $("guess-combo"),
  money: $("guess-money"), number: $("guess-number"),
  helpBtn: $("help-btn"), helpDialog: $("help-dialog"), helpTitle: $("help-title"),
  helpBody: $("help-body"), helpClose: $("help-close"),
  giveUpBtn: $("giveup-btn"), giveUpDialog: $("giveup-dialog"), giveUpText: $("giveup-text"),
  reveal: $("reveal"), revealText: $("reveal-text"), revealNext: $("reveal-next"),
  revealAbout: { box: $("reveal-about"), text: $("reveal-about-text"), link: $("reveal-about-link"), credit: $("reveal-about-credit") },
  side: $("side"), sideTitle: $("side-title"), sideGroup: $("side-group"), sideToday: $("side-today"),
  sideFinished: $("side-finished"), sidePlaying: $("side-playing"), sideWaiting: $("side-waiting"),
  sideGated: $("side-gated"), sideStats: $("side-stats"),
  shapeWrap: $("shape-wrap"), shape: $("shape"), flagWrap: $("flag-wrap"), flag: $("flag"), capital: $("capital"),
  personWrap: $("person-wrap"), personPhoto: $("person-photo"), personCredit: $("person-credit"),
  options: $("options"),
  guesses: $("guesses"), form: $("guess-form"), input: $("guess-input"), list: $("guess-list"),
  submit: $("guess-submit"), status: $("status"), result: $("result"), resultText: $("result-text"),
  shareBtn: $("share"), left: $("left"), profileBtn: $("profile-btn"),
  notInvited: $("not-invited"), adminLink: $("admin-link"), account: $("account"),
  streak: $("streak"), dayTitle: $("day-title"), dayTotal: $("day-total"), recap: $("recap"),
};

const profile = mountProfile({ button: el.profileBtn, setStatus: (text, cls) => setStatus(text, cls) });
attachAccount(el.account);

let round = null;
let picked = null;
let ac = null;
let busy = false;
/** D-55: the challenge that just ended, held until the player moves on. */
let reveal = null;
/**
 * FR-8.7 — the prompt of the challenge being revealed, kept because the server
 * has already moved on to the next one. Only a choice kind needs it: its reveal
 * is *which* option was right, and the options are artwork the client is no
 * longer being sent. Cleared with the reveal it belongs to.
 */
let revealPrompt = null;
/** D-57: the desktop panel. Never on the critical path — see loadPanel. */
let groups = [];
let boardGid = null;

const help = attachHelp({
  button: el.helpBtn, dialog: el.helpDialog,
  title: el.helpTitle, body: el.helpBody, close: el.helpClose,
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

el.signIn.addEventListener("click", async () => {
  el.signIn.disabled = true;
  setStatus(t("openingLogin"));
  try { await signInWithPopup(auth, googleProvider); }
  catch (err) { setStatus(errorMessage(err), "err"); }
  finally { el.signIn.disabled = false; }
});

el.signOut.addEventListener("click", async () => {
  await signOut(auth);
  round = null; picked = null; reveal = null; revealPrompt = null; // FR-1.6: nothing survives sign-out
  groups = []; boardGid = null;
  el.input.value = "";
  el.guesses.replaceChildren();
  el.side.hidden = true;
  el.streak.hidden = true;
});

onAuthStateChanged(auth, (user) => {
  el.signedOut.hidden = Boolean(user);
  el.game.hidden = !user;
  el.notInvited.hidden = true;
  el.adminLink.hidden = true;
  showAccount(el.account, user);
  if (user) load();
});

// ---------------------------------------------------------------------------
// Round
// ---------------------------------------------------------------------------

async function load() {
  setStatus(t("loading"));
  setBusy(true);
  try {
    if (!ac) {
      const index = createIndex(await loadCountries());
      ac = attach({
        input: el.input, list: el.list, index,
        onPick: (entry) => { picked = entry; submit(); },
        onMiss: (text) => { picked = null; if (text.trim()) setStatus(t("noMatch"), "warn"); console.debug("[mondo] autocomplete miss:", text); },
      });
    }
    // D-57: fired here, not awaited here. The panel is garnish; the game is
    // the page, and a slow or failing `listGroups` must not hold either up.
    const groupsSoon = api.listGroups({}).catch(() => null);
    round = await api.getRound({});
    // getRound already carries the display name and the role, so the daily is
    // the one page that does not have to ask a second time.
    applyIdentity({ account: el.account, user: auth.currentUser, adminLink: el.adminLink, profile }, round.me);
    setStatus("");
    render();
    loadPanel(groupsSoon).catch(() => { /* garnish; never the player's problem */ });
  } catch (err) {
    if (err?.details?.code === "not-invited") {
      // FR-1.7: signed in, not let in. The game stays hidden; Perfil/Sair remain.
      el.game.hidden = true;
      el.notInvited.hidden = false;
      return;
    }
    setStatus(errorMessage(err), "err");
  } finally {
    setBusy(false);
    focusInput();
  }
}

/** Focus only works once the input is enabled again, so call this after setBusy(false). */
function focusInput() {
  if (reveal) return el.revealNext.focus();
  if (round?.status !== "in_progress") return;
  // A choice challenge has no field to focus: the grid is the input, and
  // stealing focus to an invisible textbox would strand a keyboard user.
  if (isPick(round.prompt?.kind)) return;
  const field = round.prompt?.kind === "gdp" ? el.number : el.input;
  if (!field.disabled) field.focus();
}

el.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (round?.prompt?.kind === "gdp") {
    const value = Number(el.number.value);
    if (!Number.isFinite(value) || value <= 0) return setStatus(t("needNumber"), "warn");
    return submit(value);
  }
  if (!picked) ac.commit(); else submit();
});
el.input.addEventListener("input", () => { picked = null; });

async function submit(numberGuess) {
  // `advance` guards too, but the pick is consumed below and a click while busy
  // would otherwise throw it away.
  if (busy || reveal) return;
  if (numberGuess === undefined && !picked) return;
  const guess = numberGuess ?? picked.code;
  picked = null;
  await advance(() => api.submitGuess({ puzzleId: round.puzzleId, guess }));
}

/**
 * Both ways a challenge can move: a guess, and giving up (FR-2.13). What
 * happens afterwards is identical and is written once — the reveal, the
 * confetti, and re-reading the panel on the move that ends the day. The one
 * time this was two copies, one of them showed the wrong guess list (D-55).
 */
async function advance(call) {
  if (busy || reveal || !round || round.status !== "in_progress") return;
  setBusy(true);
  setStatus("");
  try {
    const before = round.cursor;
    // Captured before the call: after it, `round.prompt` is the NEXT challenge.
    const shown = round.prompt;
    round = await call();
    el.input.value = "";
    el.number.value = "";
    // A cursor that moved means that challenge is over — including the last
    // one, where it moves past the end. A finished item carries its answer and
    // its whole guess list, so the reveal is just that item; the top-level
    // `guesses` has already moved on to the challenge nobody has started.
    if (round.cursor > before) {
      reveal = round.items[before];
      revealPrompt = shown;
      if (reveal.status === "solved") confetti();
    }
    render();
    // FR-4.11 unlocks everyone else's score the moment YOUR day is done, so
    // that is the one time the panel is worth re-reading.
    if (round.status !== "in_progress") refreshBoard();
  } catch (err) {
    // FR-6.5: a failed submission consumes nothing; the text stays so they can retry.
    const code = err?.details?.code;
    if (code === "already-completed") { round = await api.getRound({}).catch(() => round); render(); }
    setStatus(errorMessage(err), "err");
  } finally {
    setBusy(false);
    focusInput();
  }
}

// FR-2.13 — zero points and the answer. It asks first: unlike in practice, this
// zero is permanent and lands on the group's ranking, so a mis-tap beside the
// "?" would cost something real.
el.giveUpBtn.addEventListener("click", async () => {
  if (busy || reveal || round?.status !== "in_progress") return;
  if (!(await ask(el.giveUpDialog, el.giveUpText, t("confirmGiveUp")))) return focusInput();
  await advance(() => api.giveUp({ puzzleId: round.puzzleId }));
});

function render() {
  const inProgress = round.status === "in_progress";
  const revealing = reveal !== null;
  // Once the day is done the counter would read "Desafio 4 de 4" for ever, and
  // the result block below says everything it said. During a reveal it would be
  // counting the challenge behind the panel, which nobody is playing yet.
  el.progress.hidden = !inProgress || revealing;
  el.helpBtn.hidden = !inProgress || revealing;
  el.giveUpBtn.hidden = !inProgress || revealing;
  el.progress.textContent = inProgress ? t("challengeOf", { n: round.cursor + 1, max: round.itemCount }) : "";

  // One prompt shape per kind. An unknown kind means the client is older than
  // the server: say so rather than rendering nothing. A reveal holds the next
  // prompt back rather than hiding it after the fact, so nothing about the
  // challenge to come reaches the DOM early.
  // A choice challenge is the one prompt that OUTLIVES its own challenge: the
  // reveal is which option was right, so the grid stays up with the answer
  // marked while every other kind's prompt goes away (FR-8.7, D-64).
  const shownPrompt = revealing ? revealPrompt : round.prompt;
  const kind = revealing ? (isPick(shownPrompt?.kind) ? shownPrompt.kind : null) : round.prompt?.kind ?? null;
  el.shapeWrap.hidden = kind !== "shape";
  el.flagWrap.hidden = kind !== "flag";
  // renderPerson un-hides this itself, and hides it again if Wikimedia does
  // not answer — so the only thing to do here is put it away for other kinds.
  if (kind !== "person") el.personWrap.hidden = true;
  el.capital.hidden = kind !== "capital" && kind !== "gdp" && kind !== "person" && !isPick(kind);
  el.options.hidden = !isPick(kind);
  if (kind === "shape") renderShape(el.shape, round.prompt.shape);
  else if (kind === "flag") renderFlag(el.flag, round.prompt.flag);
  else if (kind === "capital") el.capital.textContent = t("capitalPrompt", { city: round.prompt.capital });
  else if (kind === "gdp") el.capital.textContent = t("gdpPrompt", { country: round.prompt.country, year: round.prompt.year });
  else if (kind === "person") {
    el.capital.textContent = t("personPrompt", { name: round.prompt.name });
    renderPerson(el.personWrap, el.personPhoto, el.personCredit, round.prompt);
  }
  else if (isPick(kind)) {
    // `flagPickPrompt` or `shapePickPrompt`: the sentence differs by one noun,
    // so the key is derived rather than branched on (D-72).
    el.capital.textContent = t(`${kind}Prompt`, { country: shownPrompt.country });
    renderOptions(el.options, shownPrompt.options, {
      guesses: revealing ? reveal.guesses ?? [] : round.guesses,
      answer: revealing ? reveal.answer : null,
      onPick: revealing ? null : (i) => advance(() => api.submitGuess({ puzzleId: round.puzzleId, guess: i })),
    });
  } else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  // Three inputs, at most one visible: a country autocomplete, a number field
  // (D-53), or the grid above, which is its own input (D-64).
  el.form.hidden = !inProgress || revealing || isPick(kind);
  el.combo.hidden = kind === "gdp";
  el.money.hidden = kind !== "gdp";

  // `?? []` is the deploy window, not paranoia: GitHub Pages publishes on push
  // and the functions deploy separately, so for a few minutes this file can be
  // newer than the server that feeds it. A finished item from the old server
  // has no `guesses`, and without this the reveal would throw instead of
  // showing the answer with an empty list. D-52 shipped exactly this bug once.
  // A pick has no row: it is struck out in the grid instead, which is also the
  // only honest place for it — the client is never told which country it was.
  const rows = isPick(kind) ? [] : revealing ? reveal.guesses ?? [] : round.guesses;
  el.guesses.replaceChildren(...rows.map(guessRow));
  el.left.textContent = inProgress && !revealing ? t("guessesLeft", { n: round.guessesUsed, max: round.guessesMax }) : "";

  renderDay();

  el.reveal.hidden = !revealing;
  if (revealing) {
    const born = reveal.answer?.bornIn ? ` ${t("revealBorn", { city: reveal.answer.bornIn })}` : "";
    el.revealText.textContent = (reveal.status === "solved"
      ? t("revealSolved", { points: reveal.points })
      : isPick(kind)
      ? t("revealPick")
      : t("revealFailed", { answer: reveal.answer.name })) + born;
    renderAbout(el.revealAbout, reveal.answer);
    el.revealNext.textContent = inProgress ? t("continueChallenge") : t("seeResult");
  } else {
    // FR-6.9 — the first challenge of each hint vocabulary explains itself.
    help(kind);
  }

  renderStats();
  renderStreak();

  el.result.hidden = inProgress || revealing;
  if (!inProgress && !revealing) {
    el.resultText.textContent =
      round.points === round.maxPoints
        ? t("dayPerfect", { points: round.points, max: round.maxPoints })
        : t("dayDone", { points: round.points, max: round.maxPoints });
    el.shareBtn.textContent = t("share");
    renderRecap();
  }
}

// ---------------------------------------------------------------------------
// The rail (FR-6.11). One list, two shapes: five boxes above the prompt on a
// phone, a row per challenge in the left column on a desktop. mondo.css decides
// which; this only ever renders the one list.
// ---------------------------------------------------------------------------

function renderDay() {
  el.dayTitle.textContent = formatPuzzleDay(round.puzzleId);
  el.items.replaceChildren(...round.items.map((it, i) => {
    const li = document.createElement("li");
    li.className = `step ${it.status}`;
    const n = document.createElement("span");
    n.className = "step-n";
    n.textContent = String(i + 1);
    // The KIND, never the answer: the rail is where you are, and the five
    // answers get their own list once the day is over (renderRecap). A rail
    // that read "Peru · Gana · Capital · PIB per capita" reads as a bug.
    const label = document.createElement("span");
    label.className = "step-name";
    label.textContent = t(`kindName.${it.kind}`);
    const pts = document.createElement("span");
    pts.className = "step-score";
    pts.textContent = it.status === "current" ? t("stepNow") : it.points === null ? "" : String(it.points);
    li.append(n, label, pts);
    return li;
  }));
  const scored = round.items.reduce((sum, it) => sum + (it.points ?? 0), 0);
  el.dayTotal.textContent = `${scored} / ${round.maxPoints ?? round.itemCount * 6}`;
}

/**
 * FR-2.11 — the day, once it is over: what each challenge was and what it was
 * worth. The answers used to be in the list the rail has taken over, where on a
 * phone the result screen pushed them off the bottom.
 */
function renderRecap() {
  el.recap.replaceChildren(...round.items.map((it) => {
    const li = document.createElement("li");
    li.className = it.status;
    const left = document.createElement("span");
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = t(`kindName.${it.kind}`);
    const answer = document.createElement("span");
    answer.className = "answer";
    // Every item is over by now, so every one of them carries its answer (SEC-1).
    answer.textContent = it.answer ? it.answer.name : "—";
    left.append(kind, answer);
    const pts = document.createElement("span");
    pts.className = "score";
    pts.textContent = String(it.points ?? 0);
    li.append(left, pts);
    return li;
  }));
}

const dayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
/**
 * "Quarta-feira, 16 de setembro" from a puzzleId of 20260916. Days roll at noon
 * São Paulo, so a player's own clock can disagree with the day they are
 * playing — the puzzle's id is the only honest source for this line.
 */
function formatPuzzleDay(puzzleId) {
  const id = String(puzzleId ?? "");
  if (!/^\d{8}$/.test(id)) return "";
  const text = dayFmt.format(new Date(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6)}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The streak, in the bar, where it can be read before the day is finished. */
function renderStreak() {
  const n = round?.me?.currentStreak;
  el.streak.hidden = n === undefined;
  if (n === undefined) return;
  const b = document.createElement("b");
  b.textContent = String(n);
  el.streak.replaceChildren(b, document.createTextNode(t("streakDays", { n })));
}

// ---------------------------------------------------------------------------
// The desktop panel (D-57, FR-6.11). Hidden below 60rem by mondo.css, so on a
// phone this code renders into a box nobody sees — cheap, and cheaper than a
// second layout path that could disagree with the first.
//
// Nothing in here may reach `setStatus`. A panel that cannot load is a panel
// that stays hidden; telling a player their game is broken because a side list
// failed would be worse than the missing list.
// ---------------------------------------------------------------------------

const GROUP_KEY = "mondo.side.group";
const remembered = () => { try { return localStorage.getItem(GROUP_KEY); } catch { return null; } };
const remember = (gid) => { try { localStorage.setItem(GROUP_KEY, gid); } catch { /* private mode */ } };

async function loadPanel(groupsSoon) {
  const res = await groupsSoon;
  groups = res?.groups ?? [];
  if (groups.length === 0) return;              // no group, no "Hoje" — stats stand alone

  // One group needs no picker; several are remembered, because a player who
  // watches one group's board does not want to re-pick it every day.
  const saved = remembered();
  boardGid = groups.some((g) => g.groupId === saved) ? saved : groups[0].groupId;

  el.sideGroup.hidden = groups.length < 2;
  el.sideGroup.replaceChildren(...groups.map((g) => {
    const o = document.createElement("option");
    o.value = g.groupId; o.textContent = g.name; o.selected = g.groupId === boardGid;
    return o;
  }));

  refreshBoard();
}

el.sideGroup.addEventListener("change", () => {
  boardGid = el.sideGroup.value;
  remember(boardGid);
  refreshBoard();
});

/** Total by construction: every caller fires and forgets, so a rejection here
 *  would be an unhandled one. The panel's whole failure mode is staying hidden. */
async function refreshBoard() {
  if (!boardGid) return;
  try {
    const board = await api.getLeaderboard({ groupId: boardGid });
    if (board.group.groupId !== boardGid) return;   // a stale answer to an older pick
    renderBoard(board);
  } catch { /* hidden is the right outcome */ }
}

function renderBoard({ group, today }) {
  el.sideTitle.textContent = group.name;
  el.sideTitle.hidden = false;
  fillBuckets({
    players: today.players, withScore: today.viewerFinished,
    finished: el.sideFinished, playing: el.sidePlaying, waiting: el.sideWaiting,
  });
  el.sideToday.hidden = false;
  // FR-4.11: names now, numbers when your own day is done. Say so, or the
  // empty right-hand column reads as a bug rather than as suspense.
  el.sideGated.textContent = today.viewerFinished ? "" : t("scoresWhenDone");
  el.sideGated.hidden = today.viewerFinished;
  el.side.hidden = false;
}

/**
 * The counters, from `me` — which `submitGuess` returns too, so they tick on
 * the guess that ends the day rather than on the next load. The current streak
 * is not among them any more: it is the chip in the bar, readable from the
 * first challenge rather than only once the panel beside the game appears.
 *
 * These live in the rail now, so nothing here touches `el.side` — revealing an
 * empty panel because the stats arrived was the old bug in this function.
 */
function renderStats() {
  const me = round?.me;
  if (!me || me.currentStreak === undefined) return;
  el.sideStats.replaceChildren(...[
    ["statLongest", me.longestStreak],
    ["statPlayed", me.totalPlayed],
    ["statSolved", me.totalSolved],
  ].flatMap(([key, value]) => {
    const dt = document.createElement("dt"); dt.textContent = t(key);
    const dd = document.createElement("dd"); dd.textContent = String(value);
    return [dt, dd];
  }));
}

el.revealNext.addEventListener("click", () => {
  reveal = null;
  revealPrompt = null;
  render();
  focusInput();
});

el.shareBtn.addEventListener("click", async () => {
  const outcome = await share(round.shareGrid);
  el.shareBtn.textContent = outcome === "failed" ? t("share") : t("copied");
  if (outcome === "failed") setStatus(round.shareGrid, "");
});

// ---------------------------------------------------------------------------

function setBusy(b) {
  busy = b;
  el.input.disabled = b;
  el.number.disabled = b;
  el.submit.disabled = b;
}

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = cls;
}
