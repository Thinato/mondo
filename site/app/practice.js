// Treino — FR-9. Pick a kind, play it until you are bored, leave, read the total.
//
// Three screens and no cleverness between them: the picker, the challenge, the
// summary. Which one is up is decided by `view` alone — null is the picker,
// `in_progress` is the challenge, `ended` is the summary — so there is no
// second idea of where the player is that could drift out of step with it.
//
// Like game.js, this file never computes anything about an answer. It has less
// reason to than game.js does: the server tells it outright whether the
// challenge on screen is over (`item.status`), so there is no cursor to compare
// and no way to render a reveal the server did not send.

import { auth } from "./firebase.js";
import * as api from "./api.js";
import { ask, watchAuth } from "./auth-ui.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, renderFlag, renderShape } from "./geo.js";
import { attachHelp } from "./help.js";
import { errorMessage, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"),
  pick: $("pick"), picker: $("picker"), train: $("train"),
  progress: $("progress"), helpBtn: $("help-btn"), leaveBtn: $("leave-btn"), giveUpBtn: $("giveup-btn"),
  helpDialog: $("help-dialog"), helpTitle: $("help-title"), helpBody: $("help-body"), helpClose: $("help-close"),
  shapeWrap: $("shape-wrap"), shape: $("shape"), flagWrap: $("flag-wrap"), flag: $("flag"), capital: $("capital"),
  guesses: $("guesses"), reveal: $("reveal"), revealText: $("reveal-text"), revealNext: $("reveal-next"),
  form: $("guess-form"), combo: $("guess-combo"), input: $("guess-input"), list: $("guess-list"),
  money: $("guess-money"), number: $("guess-number"), submit: $("guess-submit"),
  left: $("left"), status: $("status"), items: $("items"),
  summary: $("summary"), summaryText: $("summary-text"), again: $("again"),
  leaveDialog: $("leave-dialog"), leaveText: $("leave-text"),
};

/** The kinds on offer. A new kind joins practice by joining this list and
 *  i18n's `kindName` / `practice.about` — which it needs a label in anyway. */
const KINDS = ["shape", "flag", "capital", "gdp"];

let view = null;
let picked = null;
let ac = null;
let busy = false;
/** One line per finished challenge, kept client-side: the run's own history is
 *  nothing but the reveals the player has already read, so the server is not
 *  asked to remember it. Cleared when a new run starts, not when one ends. */
let run = [];

const help = attachHelp({
  button: el.helpBtn, dialog: el.helpDialog,
  title: el.helpTitle, body: el.helpBody, close: el.helpClose,
});

// ---------------------------------------------------------------------------

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut, setStatus,
  onUser: (user) => {
    if (!user) { view = null; run = []; }          // FR-1.6: nothing survives sign-out
    render();
    if (user) buildPicker();
  },
});

function buildPicker() {
  if (el.picker.children.length > 0) return;
  el.picker.replaceChildren(...KINDS.map((kind) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t(`kindName.${kind}`);
    const about = document.createElement("span");
    about.className = "fine";
    about.textContent = t(`practice.about.${kind}`);
    button.append(name, about);
    button.addEventListener("click", () => start(kind));
    li.append(button);
    return li;
  }));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function start(kind) {
  setBusy(true);
  setStatus(t("loading"));
  try {
    await countries();
    run = [];
    view = await api.startPractice({ kind });
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

// Back to the picker. The run goes with the summary that reported it: leaving
// it on screen under a fresh picker reads as the run still being open.
el.again.addEventListener("click", () => { view = null; run = []; render(); });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A challenge is open when there is one and the server says it is not over. */
const challengeOpen = () => view?.status === "in_progress" && view.item?.status === "current";

function render() {
  const signedIn = Boolean(auth.currentUser);
  const running = signedIn && view?.status === "in_progress";
  const ended = signedIn && view?.status === "ended";

  el.pick.hidden = !signedIn || running || ended;
  el.train.hidden = !running;
  el.summary.hidden = !ended;

  if (running) renderChallenge();
  if (ended) {
    const { played, solved, points, maxPoints } = view.totals;
    el.summaryText.textContent = played === 0
      ? t("practice.doneNone")
      : t("practice.done", { n: played, points, max: maxPoints, solved: t("practice.solvedCount", { n: solved }) });
  }
  renderRun();
}

function renderChallenge() {
  const item = view.item;
  const revealing = item.status !== "current";
  const kind = revealing ? null : item.prompt?.kind ?? null;

  // The counter counts the challenge on screen, including while it is being
  // revealed — `totals` has not been told about that one yet (the server counts
  // it on `next`), and a reveal saying "+5 pontos" beside a total that still
  // says 0 reads as the 5 not having counted.
  const points = view.totals.points + (revealing ? item.points : 0);
  el.progress.textContent = t("practice.counter", { n: view.totals.played + 1, points });
  el.helpBtn.hidden = revealing;
  el.giveUpBtn.hidden = revealing;

  // One prompt shape per kind, and none at all during a reveal — the next
  // challenge has not been served yet, so there is nothing to hold back.
  el.shapeWrap.hidden = kind !== "shape";
  el.flagWrap.hidden = kind !== "flag";
  el.capital.hidden = kind !== "capital" && kind !== "gdp";
  if (kind === "shape") renderShape(el.shape, item.prompt.shape);
  else if (kind === "flag") renderFlag(el.flag, item.prompt.flag);
  else if (kind === "capital") el.capital.textContent = t("capitalPrompt", { city: item.prompt.capital });
  else if (kind === "gdp") el.capital.textContent = t("gdpPrompt", { country: item.prompt.country, year: item.prompt.year });
  else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  // Two inputs, one visible: a country autocomplete, or a number field (D-53).
  el.combo.hidden = kind === "gdp";
  el.money.hidden = kind !== "gdp";

  el.guesses.replaceChildren(...item.guesses.map(guessRow));
  el.form.hidden = revealing;
  el.left.textContent = revealing ? "" : t("guessesLeft", { n: item.guessesUsed, max: item.guessesMax });

  el.reveal.hidden = !revealing;
  if (revealing) {
    el.revealText.textContent = item.status === "solved"
      ? t("revealSolved", { points: item.points })
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

/** Focus only works once the input is enabled again, so call this after setBusy(false). */
function focusInput() {
  if (view?.status !== "in_progress") return;
  if (view.item.status !== "current") return el.revealNext.focus();
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
