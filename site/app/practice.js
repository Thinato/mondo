// Treino — FR-9. Pick a kind, play it until you are bored, leave, read the total.
//
// The chooser is the rail and never leaves the screen, so what changes is only
// the middle column: a line telling you to pick something, the challenge, or the
// summary. Which one is up is decided by `view` alone — null is the hint,
// `in_progress` is the challenge, `ended` is the summary — so there is no second
// idea of where the player is that could drift out of step with it. `kind` is
// not that second idea: it says what the rail has selected, never what is up.
//
// Like game.js, this file never computes anything about an answer. It has less
// reason to than game.js does: the server tells it outright whether the
// challenge on screen is over (`item.status`), so there is no cursor to compare
// and no way to render a reveal the server did not send.

import { auth } from "./firebase.js";
import * as api from "./api.js";
import { ask, watchAuth } from "./auth-ui.js";
import { mountProfile } from "./profile.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, renderFlag, renderOptions, renderShape } from "./geo.js";
import { attachHelp } from "./help.js";
import { errorMessage, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"),
  account: $("account"), profileBtn: $("profile-btn"), adminLink: $("admin-link"),
  runCols: $("run-cols"), picker: $("picker"), hint: $("practice-hint"), train: $("train"),
  progress: $("progress"), helpBtn: $("help-btn"), leaveBtn: $("leave-btn"), giveUpBtn: $("giveup-btn"),
  helpDialog: $("help-dialog"), helpTitle: $("help-title"), helpBody: $("help-body"), helpClose: $("help-close"),
  shapeWrap: $("shape-wrap"), shape: $("shape"), flagWrap: $("flag-wrap"), flag: $("flag"), capital: $("capital"),
  options: $("options"),
  guesses: $("guesses"), reveal: $("reveal"), revealText: $("reveal-text"), revealNext: $("reveal-next"),
  form: $("guess-form"), combo: $("guess-combo"), input: $("guess-input"), list: $("guess-list"),
  money: $("guess-money"), number: $("guess-number"), submit: $("guess-submit"),
  left: $("left"), status: $("status"), items: $("items"), stats: $("run-stats"),
  summary: $("summary"), summaryText: $("summary-text"), again: $("again"),
  leaveDialog: $("leave-dialog"), leaveText: $("leave-text"),
};

/** The kinds on offer. A new kind joins practice by joining this list and
 *  i18n's `kindName` / `practice.about` — which it needs a label in anyway. */
const KINDS = ["shape", "flag", "capital", "gdp", "flagPick"];

let view = null;
/** Which kind the rail has selected, so the chooser can say so and so that
 *  "treinar de novo" starts another run of the same thing rather than sending
 *  the player back to a screen that no longer exists. */
let kind = null;
let picked = null;
let ac = null;
let busy = false;
/** FR-8.7 — the prompt of the challenge on screen, kept across its own reveal. */
let shownPrompt = null;
/** One line per finished challenge, kept client-side: the run's own history is
 *  nothing but the reveals the player has already read, so the server is not
 *  asked to remember it. Cleared when a new run starts, not when one ends. */
let run = [];

const help = attachHelp({
  button: el.helpBtn, dialog: el.helpDialog,
  title: el.helpTitle, body: el.helpBody, close: el.helpClose,
});

const profile = mountProfile({ button: el.profileBtn, setStatus: (text, cls) => setStatus(text, cls) });

// ---------------------------------------------------------------------------

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, profile, setStatus,
  onUser: (user) => {
    if (!user) { view = null; kind = null; run = []; shownPrompt = null; }   // FR-1.6: nothing survives sign-out
    if (user) buildPicker();
    render();
  },
});

/** Built once; the selected one is marked on every render. */
function buildPicker() {
  if (el.picker.children.length > 0) return;
  el.picker.replaceChildren(...KINDS.map((k) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.kind = k;
    button.setAttribute("aria-pressed", "false");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t(`kindName.${k}`);
    const about = document.createElement("span");
    about.className = "fine";
    about.textContent = t(`practice.about.${k}`);
    button.append(name, about);
    button.addEventListener("click", () => start(k));
    li.append(button);
    return li;
  }));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function start(next) {
  if (busy) return;
  setBusy(true);
  setStatus(t("loading"));
  kind = next;
  render();
  try {
    await countries();
    run = [];
    view = await api.startPractice({ kind: next });
    setStatus("");
  } catch (err) {
    setStatus(errorMessage(err), "err");
  } finally {
    setBusy(false);
    render();
    focusInput();
  }
}

/** Loaded once, on the first run: the picker is useless without the game and
 *  the game is useless without the country list. */
async function countries() {
  if (ac) return;
  const index = createIndex(await loadCountries());
  ac = attach({
    input: el.input, list: el.list, index,
    onPick: (entry) => { picked = entry; submit(); },
    onMiss: (text) => { picked = null; if (text.trim()) setStatus(t("noMatch"), "warn"); },
  });
}

el.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (view?.item?.prompt?.kind === "gdp") {
    const value = Number(el.number.value);
    if (!Number.isFinite(value) || value <= 0) return setStatus(t("needNumber"), "warn");
    return submit(value);
  }
  if (!picked) ac.commit(); else submit();
});
el.input.addEventListener("input", () => { picked = null; });

async function submit(numberGuess) {
  if (busy || !challengeOpen()) return;
  if (numberGuess === undefined && !picked) return;
  const guess = numberGuess ?? picked.code;
  picked = null;
  await advance(() => api.submitPracticeGuess({ guess }));
}

/**
 * Both ways a challenge can end: a guess, and giving up (FR-2.13). The run list
 * and the confetti hang off the end of it once, not once per caller.
 */
async function advance(call) {
  if (busy || !challengeOpen()) return;
  setBusy(true);
  setStatus("");
  try {
    view = await call();
    el.input.value = "";
    el.number.value = "";
    if (view.item.status !== "current") {
      // The challenge is over. Remember it for the run list before the next one
      // replaces it — the server sends the answer exactly once, here.
      run.push({ ...view.item, n: run.length + 1 });
      if (view.item.status === "solved") confetti();
    }
  } catch (err) {
    // FR-6.5: a failed submission consumes nothing and stays retryable.
    setStatus(errorMessage(err), "err");
  } finally {
    setBusy(false);
    render();
    focusInput();
  }
}

// FR-2.13 — zero points and the answer, with no confirmation: nothing in a
// practice run is permanent or shared, and "I just want to see it" is half the
// reason the button is there. The daily asks first, because its zero is real.
el.giveUpBtn.addEventListener("click", () => advance(() => api.giveUpPractice({})));

el.revealNext.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try { view = await api.nextPractice({}); setStatus(""); }
  catch (err) { setStatus(errorMessage(err), "err"); }
  finally { setBusy(false); render(); focusInput(); }
});

// FR-9.4 — leaving is a question, not a reflex: a mis-tap in the corner of the
// screen would otherwise end a run the player was enjoying.
el.leaveBtn.addEventListener("click", async () => {
  if (busy || !view) return;
  if (!(await ask(el.leaveDialog, el.leaveText, t("practice.confirmLeave")))) return focusInput();
  setBusy(true);
  try { view = await api.endPractice({}); setStatus(""); }
  catch (err) { setStatus(errorMessage(err), "err"); }
  finally { setBusy(false); render(); }
});

// Another run of the same kind. The chooser never left the screen, so "back to
// the picker" is not a thing that needs doing any more — and the run that just
// ended goes with the summary that reported it.
el.again.addEventListener("click", () => start(kind ?? KINDS[0]));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A challenge is open when there is one and the server says it is not over. */
const challengeOpen = () => view?.status === "in_progress" && view.item?.status === "current";

function render() {
  const signedIn = Boolean(auth.currentUser);
  const running = signedIn && view?.status === "in_progress";
  const ended = signedIn && view?.status === "ended";

  el.runCols.hidden = !signedIn;
  el.hint.hidden = running || ended;
  el.train.hidden = !running;
  el.summary.hidden = !ended;
  for (const b of el.picker.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
  }

  if (running) renderChallenge();
  if (ended) {
    const { played, solved, points, maxPoints } = view.totals;
    el.summaryText.textContent = played === 0
      ? t("practice.doneNone")
      : t("practice.done", { n: played, points, max: maxPoints, solved: t("practice.solvedCount", { n: solved }) });
  }
  renderRun();
  renderStats();
}

/**
 * The totals as they should read right now, which is not always what the server
 * last said: while a finished challenge is being revealed, `totals` has not been
 * told about it yet (the server counts it on `next`). A reveal saying "+5
 * pontos" beside a total that still says 0 reads as the 5 not having counted,
 * so the challenge on screen is folded in here — once, for every readout.
 */
function totalsNow() {
  const base = view?.totals ?? { played: 0, solved: 0, points: 0 };
  if (view?.status !== "in_progress" || view.item.status === "current") return base;
  const item = view.item;
  return {
    played: base.played + 1,
    solved: base.solved + (item.status === "solved" ? 1 : 0),
    points: base.points + item.points,
  };
}

function renderChallenge() {
  const item = view.item;
  const revealing = item.status !== "current";
  const kind = revealing ? null : item.prompt?.kind ?? null;

  // The counter counts the challenge on screen, including while it is being
  // revealed — see totalsNow.
  const now = totalsNow();
  el.progress.textContent = t("practice.counter", {
    n: revealing ? now.played : now.played + 1,
    points: now.points,
  });
  el.helpBtn.hidden = revealing;
  el.giveUpBtn.hidden = revealing;

  // One prompt shape per kind, and — for every kind but one — none at all
  // during a reveal, because the next challenge has not been served yet and
  // there is nothing to hold back.
  //
  // The exception is a choice challenge, whose prompt OUTLIVES its challenge:
  // its reveal is which option was right, and the options are artwork the
  // server does not send twice (FR-8.7, D-64). So the prompt is kept.
  const shown = revealing ? shownPrompt : (shownPrompt = item.prompt);
  const shownKind = revealing && shown?.kind === "flagPick" ? "flagPick" : kind;

  el.shapeWrap.hidden = kind !== "shape";
  el.flagWrap.hidden = kind !== "flag";
  el.capital.hidden = shownKind !== "capital" && shownKind !== "gdp" && shownKind !== "flagPick";
  el.options.hidden = shownKind !== "flagPick";
  if (kind === "shape") renderShape(el.shape, item.prompt.shape);
  else if (kind === "flag") renderFlag(el.flag, item.prompt.flag);
  else if (kind === "capital") el.capital.textContent = t("capitalPrompt", { city: item.prompt.capital });
  else if (kind === "gdp") el.capital.textContent = t("gdpPrompt", { country: item.prompt.country, year: item.prompt.year });
  else if (shownKind === "flagPick") {
    el.capital.textContent = t("flagPickPrompt", { country: shown.country });
    renderOptions(el.options, shown.options, {
      guesses: item.guesses,
      answer: revealing ? item.answer : null,
      onPick: revealing ? null : (i) => advance(() => api.submitPracticeGuess({ guess: i })),
    });
  } else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  // Three inputs, at most one visible: a country autocomplete, a number field
  // (D-53), or the grid above, which is its own input (D-64).
  el.combo.hidden = kind === "gdp";
  el.money.hidden = kind !== "gdp";

  // A pick is struck out in the grid, not listed as a row: the client is never
  // told which country it was, so there is nothing to put in one.
  el.guesses.replaceChildren(...(shownKind === "flagPick" ? [] : item.guesses).map(guessRow));
  el.form.hidden = revealing || shownKind === "flagPick";
  el.left.textContent = revealing ? "" : t("guessesLeft", { n: item.guessesUsed, max: item.guessesMax });

  el.reveal.hidden = !revealing;
  if (revealing) {
    el.revealText.textContent = item.status === "solved"
      ? t("revealSolved", { points: item.points })
      : shownKind === "flagPick"
      ? t("revealPick")
      : t("revealFailed", { answer: item.answer.name });
    el.revealNext.textContent = t("practice.next");
  } else {
    // FR-6.9 — the first challenge of each hint vocabulary explains itself, and
    // reads the same flag the daily wrote, so nobody meets it twice.
    help(kind);
  }
}

/** The run so far, newest last. Every line was already on screen once. */
function renderRun() {
  el.items.replaceChildren(...run.map((it) => {
    const li = document.createElement("li");
    li.className = `card-item ${it.status}`;
    const n = document.createElement("span");
    n.textContent = `${it.n}.`;
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = it.answer.name;
    const pts = document.createElement("span");
    pts.className = "score";
    pts.textContent = `${it.points} pts`;
    li.append(n, label, pts);
    return li;
  }));
}

/**
 * The run's totals, for the desktop panel (FR-6.11). Hidden below 60rem by
 * mondo.css, where the counter above the challenge already carries the score
 * and there is no room for anything else.
 */
function renderStats() {
  if (!view) return el.stats.replaceChildren();
  const { played, solved, points } = totalsNow();
  el.stats.replaceChildren(...[
    ["practice.statPoints", String(points)],
    ["practice.statPlayed", String(played)],
    ["practice.statSolved", String(solved)],
    ["practice.statRate", played === 0 ? "—" : `${Math.round((solved / played) * 100)}%`],
  ].flatMap(([key, value]) => {
    const dt = document.createElement("dt"); dt.textContent = t(key);
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
}

/** Focus only works once the input is enabled again, so call this after setBusy(false). */
function focusInput() {
  if (view?.status !== "in_progress") return;
  if (view.item.status !== "current") return el.revealNext.focus();
  // A choice challenge has no field: the grid is the input (FR-8.7).
  if (view.item.prompt?.kind === "flagPick") return;
  const field = view.item.prompt?.kind === "gdp" ? el.number : el.input;
  if (!field.disabled) field.focus();
}

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
