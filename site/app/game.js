// The day on screen: sign-in → load → guess loop → result (FR-2, FR-6).
// State comes from the server on every step; this file only renders it and
// never computes anything about the answer.
//
// D-52: a day is three challenges played in order, so this renders a cursor and
// one prompt at a time. It cannot know an answer it has not been sent: the
// server reveals a challenge only once that challenge is over.

import { onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { auth, googleProvider } from "./firebase.js";
import * as api from "./api.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { arrow, band, formatKm, formatPercent, renderFlag, renderShape } from "./geo.js";
import { errorMessage, t } from "./i18n.js";
import { share } from "./share.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), game: $("game"), signIn: $("sign-in"), signOut: $("sign-out"),
  progress: $("progress"), items: $("items"),
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
  round = null; picked = null; // FR-1.6: nothing survives sign-out
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
  if (round?.status === "in_progress" && !el.input.disabled) el.input.focus();
}

el.form.addEventListener("submit", (ev) => { ev.preventDefault(); if (!picked) ac.commit(); else submit(); });
el.input.addEventListener("input", () => { picked = null; });

async function submit() {
  if (busy || !round || !picked || round.status !== "in_progress") return;
  const code = picked.code;
  picked = null;
  setBusy(true);
  setStatus("");
  try {
    round = await api.submitGuess({ puzzleId: round.puzzleId, code });
    el.input.value = "";
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
  // Once the day is done the counter would read "Desafio 3 de 3" for ever, and
  // the result block below says everything it said.
  el.progress.hidden = !inProgress;
  el.progress.textContent = inProgress ? t("challengeOf", { n: round.cursor + 1, max: round.itemCount }) : "";

  // One prompt shape per kind. An unknown kind means the client is older than
  // the server: say so rather than rendering nothing.
  const kind = round.prompt?.kind ?? null;
  el.shapeWrap.hidden = kind !== "shape";
  el.flagWrap.hidden = kind !== "flag";
  el.capital.hidden = kind !== "capital";
  if (kind === "shape") renderShape(el.shape, round.prompt.shape);
  else if (kind === "flag") renderFlag(el.flag, round.prompt.flag);
  else if (kind === "capital") el.capital.textContent = t("capitalPrompt", { city: round.prompt.capital });
  else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  el.guesses.replaceChildren(...round.guesses.map(guessRow));
  el.form.hidden = !inProgress;
  el.left.textContent = inProgress ? t("guessesLeft", { n: round.guessesUsed, max: round.guessesMax }) : "";

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

  el.result.hidden = inProgress;
  if (!inProgress) {
    el.resultText.textContent =
      round.points === round.maxPoints
        ? t("dayPerfect", { points: round.points, max: round.maxPoints })
        : t("dayDone", { points: round.points, max: round.maxPoints });
    el.shareBtn.textContent = t("share");
  }
}

function guessRow(g) {
  const li = document.createElement("li");
  li.className = `guess band-${band(g.proximity)}`;
  const name = document.createElement("span"); name.className = "name"; name.textContent = g.name;
  const dist = document.createElement("span"); dist.className = "dist"; dist.textContent = g.distanceKm === 0 ? "🎉" : formatKm(g.distanceKm);
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
  el.submit.disabled = b;
}

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = cls;
}
