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
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, renderFlag, renderShape } from "./geo.js";
import { attachHelp } from "./help.js";
import { errorMessage, t } from "./i18n.js";
import { share } from "./share.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), game: $("game"), signIn: $("sign-in"), signOut: $("sign-out"),
  progress: $("progress"), items: $("items"), combo: $("guess-combo"),
  money: $("guess-money"), number: $("guess-number"),
  helpBtn: $("help-btn"), helpDialog: $("help-dialog"), helpTitle: $("help-title"),
  helpBody: $("help-body"), helpClose: $("help-close"),
  reveal: $("reveal"), revealText: $("reveal-text"), revealNext: $("reveal-next"),
  shapeWrap: $("shape-wrap"), shape: $("shape"), flagWrap: $("flag-wrap"), flag: $("flag"), capital: $("capital"),
  guesses: $("guesses"), form: $("guess-form"), input: $("guess-input"), list: $("guess-list"),
  submit: $("guess-submit"), status: $("status"), result: $("result"), resultText: $("result-text"),
  shareBtn: $("share"), left: $("left"), profileBtn: $("profile-btn"), profileDialog: $("profile-dialog"),
  profileForm: $("profile-form"), profileName: $("profile-name"), profileError: $("profile-error"),
  notInvited: $("not-invited"), adminLink: $("admin-link"),
  deleteBtn: $("delete-btn"), deleteDialog: $("delete-dialog"), deleteForm: $("delete-form"), deleteError: $("delete-error"),
};

let round = null;
let displayName = null;
let picked = null;
let ac = null;
let busy = false;
/** D-55: the challenge that just ended, held until the player moves on. */
let reveal = null;

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
  round = null; picked = null; reveal = null; // FR-1.6: nothing survives sign-out
  el.input.value = "";
  el.guesses.replaceChildren();
});

onAuthStateChanged(auth, (user) => {
  el.signedOut.hidden = Boolean(user);
  el.game.hidden = !user;
  el.notInvited.hidden = true;
  el.adminLink.hidden = true;
  el.profileBtn.hidden = !user;
  el.signOut.hidden = !user;
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
    round = await api.getRound({});
    if (round.me) {
      displayName = round.me.displayName;
      el.adminLink.hidden = round.me.role !== "admin";
    }
    setStatus("");
    render();
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
  if (busy || reveal || !round || round.status !== "in_progress") return;
  if (numberGuess === undefined && !picked) return;
  const guess = numberGuess ?? picked.code;
  picked = null;
  setBusy(true);
  setStatus("");
  try {
    const before = round.cursor;
    round = await api.submitGuess({ puzzleId: round.puzzleId, guess });
    el.input.value = "";
    el.number.value = "";
    // A cursor that moved means that challenge is over — including the last
    // one, where it moves past the end. A finished item carries its answer and
    // its whole guess list, so the reveal is just that item; the top-level
    // `guesses` has already moved on to the challenge nobody has started.
    if (round.cursor > before) {
      reveal = round.items[before];
      if (reveal.status === "solved") confetti();
    }
    render();
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

function render() {
  const inProgress = round.status === "in_progress";
  const revealing = reveal !== null;
  // Once the day is done the counter would read "Desafio 4 de 4" for ever, and
  // the result block below says everything it said. During a reveal it would be
  // counting the challenge behind the panel, which nobody is playing yet.
  el.progress.hidden = !inProgress || revealing;
  el.helpBtn.hidden = !inProgress || revealing;
  el.progress.textContent = inProgress ? t("challengeOf", { n: round.cursor + 1, max: round.itemCount }) : "";

  // One prompt shape per kind. An unknown kind means the client is older than
  // the server: say so rather than rendering nothing. A reveal holds the next
  // prompt back rather than hiding it after the fact, so nothing about the
  // challenge to come reaches the DOM early.
  const kind = revealing ? null : round.prompt?.kind ?? null;
  el.shapeWrap.hidden = kind !== "shape";
  el.flagWrap.hidden = kind !== "flag";
  el.capital.hidden = kind !== "capital" && kind !== "gdp";
  if (kind === "shape") renderShape(el.shape, round.prompt.shape);
  else if (kind === "flag") renderFlag(el.flag, round.prompt.flag);
  else if (kind === "capital") el.capital.textContent = t("capitalPrompt", { city: round.prompt.capital });
  else if (kind === "gdp") el.capital.textContent = t("gdpPrompt", { country: round.prompt.country, year: round.prompt.year });
  else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  // Two inputs, one visible: a country autocomplete, or a number field (D-53).
  el.combo.hidden = kind === "gdp";
  el.money.hidden = kind !== "gdp";

  // `?? []` is the deploy window, not paranoia: GitHub Pages publishes on push
  // and the functions deploy separately, so for a few minutes this file can be
  // newer than the server that feeds it. A finished item from the old server
  // has no `guesses`, and without this the reveal would throw instead of
  // showing the answer with an empty list. D-52 shipped exactly this bug once.
  el.guesses.replaceChildren(...(revealing ? reveal.guesses ?? [] : round.guesses).map(guessRow));
  el.form.hidden = !inProgress || revealing;
  el.left.textContent = inProgress && !revealing ? t("guessesLeft", { n: round.guessesUsed, max: round.guessesMax }) : "";

  el.items.replaceChildren(...round.items.map((it, i) => {
    const li = document.createElement("li");
    li.className = `card-item ${it.status}`;
    const n = document.createElement("span");
    n.textContent = `${i + 1}.`;
    const label = document.createElement("span");
    label.className = "name";
    // An answer appears only for a challenge that is already over (SEC-1).
    label.textContent = it.answer ? it.answer.name : t(`kindName.${it.kind}`);
    const pts = document.createElement("span");
    pts.className = "score";
    pts.textContent = it.points === null ? "" : `${it.points} pts`;
    li.append(n, label, pts);
    return li;
  }));

  el.reveal.hidden = !revealing;
  if (revealing) {
    el.revealText.textContent = reveal.status === "solved"
      ? t("revealSolved", { points: reveal.points })
      : t("revealFailed", { answer: reveal.answer.name });
    el.revealNext.textContent = inProgress ? t("continueChallenge") : t("seeResult");
  } else {
    // FR-6.9 — the first challenge of each hint vocabulary explains itself.
    help(kind);
  }

  el.result.hidden = inProgress || revealing;
  if (!inProgress && !revealing) {
    el.resultText.textContent =
      round.points === round.maxPoints
        ? t("dayPerfect", { points: round.points, max: round.maxPoints })
        : t("dayDone", { points: round.points, max: round.maxPoints });
    el.shareBtn.textContent = t("share");
  }
}

el.revealNext.addEventListener("click", () => {
  reveal = null;
  render();
  focusInput();
});

el.shareBtn.addEventListener("click", async () => {
  const outcome = await share(round.shareGrid);
  el.shareBtn.textContent = outcome === "failed" ? t("share") : t("copied");
  if (outcome === "failed") setStatus(round.shareGrid, "");
});

// ---------------------------------------------------------------------------
// Profile (FR-1.3)
// ---------------------------------------------------------------------------

el.profileBtn.addEventListener("click", () => {
  el.profileError.textContent = "";
  el.profileName.value = displayName ?? "";
  el.profileDialog.showModal();
  el.profileName.select();
});
el.profileForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (ev.submitter?.value === "cancel") return el.profileDialog.close();
  try {
    const saved = await api.updateProfile({ displayName: el.profileName.value });
    displayName = saved.displayName;
    el.profileDialog.close();
    setStatus(t("saved"), "ok");
  } catch (err) {
    el.profileError.textContent = errorMessage(err);
  }
});

// FR-1.5: delete everything, then sign out (which clears client state, FR-1.6).
el.deleteBtn.addEventListener("click", () => {
  el.profileDialog.close();
  el.deleteError.textContent = "";
  el.deleteDialog.showModal();
});
el.deleteForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (ev.submitter?.value !== "ok") return el.deleteDialog.close();
  ev.submitter.disabled = true;
  try {
    await api.deleteAccount({});
    el.deleteDialog.close();
    await signOut(auth);
    setStatus(t("deleted"), "ok");
  } catch (err) {
    el.deleteError.textContent = errorMessage(err);
  } finally {
    ev.submitter.disabled = false;
  }
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
