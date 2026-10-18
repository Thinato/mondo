// Treino — FR-9. Pick a kind, play it until you are bored, leave, read the total.
//
// Two screens on one page. Without `?k=` it is the chooser: a grid of kinds and
// the continent chips. With `?k=<kind>` it is a run of that kind, and the
// chooser is one Back away — the URL is the only idea of which screen is up, so
// a reload, a shared link and the browser's own Back all agree with it.
//
// Inside a run, what shows is decided by `view` alone — `in_progress` is the
// challenge, `ended` is the summary — so there is no second idea of where the
// player is that could drift out of step with it.
//
// Like game.js, this file never computes anything about an answer. It has less
// reason to than game.js does: the server tells it outright whether the
// challenge on screen is over (`item.status`), so there is no cursor to compare
// and no way to render a reveal the server did not send.

import { auth } from "./firebase.js";
import "./theme.js";
import * as api from "./api.js";
import { ask, watchAuth } from "./auth-ui.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, isPick, renderAbout, renderFlag, renderHints, renderOptions, renderPerson, renderShape } from "./geo.js";
import { takeReport } from "./visibility.js";
import { attachHelp } from "./help.js";
import { errorMessage, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"),
  account: $("account"), adminLink: $("admin-link"),
  choose: $("choose"), kinds: $("kinds"), games: $("games"), chooseStatus: $("choose-status"),
  continents: $("continents"), continentsLabel: $("continents-label"),
  runCols: $("run-cols"), backLink: $("back-link"), runKind: $("run-kind"), runWhere: $("run-where"),
  train: $("train"),
  progress: $("progress"), helpBtn: $("help-btn"), leaveBtn: $("leave-btn"), giveUpBtn: $("giveup-btn"),
  helpDialog: $("help-dialog"), helpTitle: $("help-title"), helpBody: $("help-body"), helpClose: $("help-close"),
  shapeWrap: $("shape-wrap"), shape: $("shape"), flagWrap: $("flag-wrap"), flag: $("flag"), capital: $("capital"),
  personWrap: $("person-wrap"), personPhoto: $("person-photo"), personCredit: $("person-credit"),
  options: $("options"),
  guesses: $("guesses"), reveal: $("reveal"), revealText: $("reveal-text"), revealNext: $("reveal-next"),
  revealAbout: { box: $("reveal-about"), text: $("reveal-about-text"), link: $("reveal-about-link"), credit: $("reveal-about-credit") },
  revealHints: $("reveal-hints"),
  form: $("guess-form"), combo: $("guess-combo"), input: $("guess-input"), list: $("guess-list"),
  money: $("guess-money"), number: $("guess-number"), submit: $("guess-submit"),
  left: $("left"), status: $("status"), items: $("items"), stats: $("run-stats"),
  runSide: $("run-side"), runToggle: $("run-toggle"), runCount: $("run-count"), runLast: $("run-last"),
  sheetClose: $("sheet-close"), endBtn: $("end-btn"),
  summary: $("summary"), summaryText: $("summary-text"), again: $("again"), otherLink: $("other-link"),
  leaveDialog: $("leave-dialog"), leaveText: $("leave-text"),
};

/** The kinds on offer. A new kind joins practice by joining this list and
 *  i18n's `kindName` / `practice.about` — which it needs a label in anyway —
 *  and, if it wants one, an icon below. */
const KINDS = ["shape", "flag", "capital", "gdp", "flagPick", "shapePick", "person"];

/** Each card's glyph: inline stroke paths on a 24-unit box. A kind without one
 *  gets the target the tab bar uses for Treinar. */
const ICONS = {
  shape: '<path d="M6 5.5c2-1.6 4.6-.6 6.4-1.4 2-.9 4.4.2 5 2.4.5 1.8-.7 3-.3 4.8.4 1.9 2.3 3.3 1.3 5.4-1 2-3.6 1.6-5.3 2.8-1.6 1.1-2.4 3-4.6 2.4-2-.6-1.8-2.9-3.2-4.2-1.4-1.3-3.6-1.8-3.6-4 0-2.4 2.6-3 3.2-5.1.3-1.2.1-2.4 1.1-3.1z"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4.5c3-1.6 5.5 1.6 8.5 0s4.5-.8 5.5 0v8c-1-.8-2.5-1.6-5.5 0s-5.5-1.6-8.5 0"/>',
  capital: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><path d="M10.2 9.8l1.8-2.4 1.8 2.4-1.8 1.4z"/>',
  gdp: '<path d="M4 20h16"/><path d="M7 20v-6M12 20V8M17 20v-9"/><path d="M5 9l5-4 4 3 5-4"/>',
  flagPick: '<rect x="3.5" y="5" width="7" height="5" rx="1"/><rect x="13.5" y="5" width="7" height="5" rx="1"/><rect x="3.5" y="14" width="7" height="5" rx="1"/><rect x="13.5" y="14" width="7" height="5" rx="1"/><path d="M15.5 16.8l1.3 1.2 2.2-2.6"/>',
  shapePick: '<path d="M4.5 5.5c1.4-1 2.8.2 4-.4 1.2-.5 2.3.6 1.8 2-.4 1.2.4 2-.6 2.8-1 .8-2.4 0-3.4.6-1.2.6-2.6-.4-2.4-1.8.2-1.2-.6-2.4.6-3.2z"/><path d="M15 4.8c1.6-.4 3.6.2 4 1.8.4 1.4-.6 3-2.2 3.2-1.4.2-3.2-.2-3.4-1.8-.2-1.2.4-2.9 1.6-3.2z"/><path d="M5.6 14.6c1.8-.6 3.8 0 4 1.8.2 1.6-.8 3-2.6 3-1.6 0-3-.8-3-2.4 0-1 .6-2 1.6-2.4z"/><path d="M15.5 16.8l1.3 1.2 2.2-2.6"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"/>',
  potato: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.8" ry="8.5"/><path d="M3.8 9.3h16.4M3.8 14.7h16.4"/>',
  default: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.2"/>',
};

/** FR-9.9 — the continents, in the server's own ids (`world-countries`'
 *  `region`). Labels come from i18n; nothing here knows which country is where,
 *  and it must not: the field a silhouette is drawn from is the server's
 *  business (SEC-2). All five selected is "no filter", which is what the server
 *  reads an omitted `regions` as. */
const REGIONS = ["Africa", "Americas", "Asia", "Europe", "Oceania"];

let view = null;
/** The kind of the run on screen, so "treinar de novo" starts another of the
 *  same and a Forward back to `?k=` of that kind resumes it rather than
 *  restarting. */
let kind = null;
let picked = null;
/** Which continents the chips have ticked. Never empty — the last one on cannot
 *  be turned off, because "none" is not a thing to practise. */
let regions = new Set(REGIONS);
let ac = null;
let busy = false;
/** Which run is current. Every server call remembers the number it started
 *  under and drops its answer if another run began meanwhile — a Back and a
 *  click on another kind during a slow start would otherwise put the first
 *  kind's run on screen under the second kind's URL. */
let gen = 0;
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


// ---------------------------------------------------------------------------

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, setStatus,
  onUser: (user) => {
    if (!user) { view = null; kind = null; run = []; shownPrompt = null; }   // FR-1.6: nothing survives sign-out
    if (user) { buildKinds(); buildChips(); return route(); }
    render();
  },
});

// ---------------------------------------------------------------------------
// Which screen: the URL says
// ---------------------------------------------------------------------------

/** The kind `?k=` names, or null for the chooser. An unknown one is the chooser. */
function urlKind() {
  const k = new URLSearchParams(location.search).get("k");
  return KINDS.includes(k) ? k : null;
}

/** `?r=` is the continents, when they are not all five. */
function urlRegions() {
  const r = (new URLSearchParams(location.search).get("r") ?? "").split(",").filter((x) => REGIONS.includes(x));
  return new Set(r.length > 0 ? r : REGIONS);
}

/** Bring the screen in line with the URL. A run of the kind it names that is
 *  already on screen is kept; anything else starts one. */
function route() {
  const k = urlKind();
  if (k === null) {
    closeSheet();
    render();
    // Back where the player left: on the card they had opened.
    return el.kinds.querySelector(`[data-kind="${kind}"]`)?.focus();
  }
  regions = urlRegions();
  if (view && kind === k) { render(); return focusInput(); }
  return start(k);
}

addEventListener("popstate", () => { if (auth.currentUser) route(); });

/** From the chooser to a run: a history entry of its own, so Back comes home. */
function openKind(k) {
  const q = new URLSearchParams({ k });
  const chosen = REGIONS.filter((r) => regions.has(r));
  if (chosen.length < REGIONS.length) q.set("r", chosen.join(","));
  history.pushState({ fromChooser: true }, "", `?${q}`);
  start(k);
}

/** To the chooser. If the run was opened from it, that is one step back; if it
 *  was opened by a link, Back would leave the site, so the entry is replaced. */
function home(ev) {
  // A new tab or window is the browser's business, not a screen change.
  if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1)) return;
  ev?.preventDefault();
  if (history.state?.fromChooser) return history.back();
  history.replaceState(null, "", location.pathname);
  route();
}
el.backLink.addEventListener("click", home);
el.otherLink.addEventListener("click", home);

// ---------------------------------------------------------------------------
// The chooser
// ---------------------------------------------------------------------------

/** The card every entry on the chooser is: glyph, name, question, how. */
function card({ icon, name, about, tag, onClick }) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kind-card";
  if (KINDS.includes(icon)) button.dataset.kind = icon;
  const glyph = document.createElement("span");
  glyph.className = "kind-icon";
  glyph.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon] ?? ICONS.default}</svg>`;
  const parts = [["name", name], ["fine", about], ["tag", tag]].map(([cls, text]) => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  });
  button.append(glyph, ...parts);
  button.addEventListener("click", () => onClick(button));
  li.append(button);
  return li;
}

/** How a kind is answered, for its card. */
const how = (k) => t(`practice.how.${k === "gdp" ? "number" : isPick(k) ? "pick" : "text"}`);

/** Built once. */
function buildKinds() {
  if (el.kinds.children.length > 0) return;
  el.kinds.replaceChildren(...KINDS.map((k) => card({
    icon: k, name: t(`kindName.${k}`), about: t(`practice.about.${k}`), tag: how(k),
    onClick: () => openKind(k),
  })));
  el.games.replaceChildren(potatoEntry());
}

/**
 * D-93 — Batata Quente alone, with no clock. Not a kind: it is a Versus room of
 * one, and its map is pushed by the listener only sala.html may load
 * (invariant 2), so this card opens the room there. The continents do not
 * reach it; its tag says so.
 */
function potatoEntry() {
  return card({
    icon: "potato", name: t("versus.preset.mundo"), about: t("versus.presetAbout.treino"), tag: t("practice.potatoTag"),
    onClick: async (button) => {
      button.disabled = true;
      setStatus(t("loading"));
      try {
        const r = await api.versus({ op: "create", presetId: "treino" });
        location.href = `./sala?s=${r.room}`;
      } catch (err) {
        setStatus(errorMessage(err, "versus"), "err");
        button.disabled = false;
      }
    },
  });
}

/** FR-9.9 — the continent chips. Built once; which are on is marked on every
 *  render, and the choice travels into the run's URL. */
function buildChips() {
  if (el.continents.children.length > 0) return;
  el.continentsLabel.textContent = t("practice.continents");
  el.continents.replaceChildren(...REGIONS.map((r) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.region = r;
    button.textContent = t(`continentName.${r}`);
    button.addEventListener("click", () => toggleRegion(r));
    li.append(button);
    return li;
  }));
}

function toggleRegion(r) {
  // The last one on stays on. Unticking everything would be a filter that
  // matches nothing, and the server would have to refuse it a moment later.
  if (regions.has(r) && regions.size === 1) return;
  if (regions.has(r)) regions.delete(r); else regions.add(r);
  render();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function start(next) {
  const mine = ++gen;
  setBusy(true);
  kind = next;
  view = null;
  run = [];
  closeSheet();
  render();
  setStatus(t("loading"));
  let started = null;
  let failed = null;
  try {
    await countries();
    // In the server's own ids, all five meaning "no filter". Sent in REGIONS
    // order rather than click order so two identical selections are one string.
    started = await api.startPractice({ kind: next, regions: REGIONS.filter((r) => regions.has(r)) });
  } catch (err) {
    failed = err;
  }
  if (mine !== gen) return;   // a newer run owns the screen, and the busy flag
  view = started;
  setStatus(failed ? errorMessage(failed) : "", failed ? "err" : "");
  setBusy(false);
  render();
  focusInput();
}

/** Loaded once, on the first run: the game is useless without the country list. */
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
  await advance(() => api.submitPracticeGuess({ guess, selfReport: takeReport() }));
}

/**
 * Both ways a challenge can end: a guess, and giving up (FR-2.13). The run list
 * and the confetti hang off the end of it once, not once per caller.
 */
async function advance(call) {
  if (busy || !challengeOpen()) return;
  await replaceView(call, (next) => {
    el.input.value = "";
    el.number.value = "";
    if (next.item.status !== "current") {
      // The challenge is over. Remember it for the run list before the next one
      // replaces it — the server sends the answer exactly once, here.
      run.push({ ...next.item, n: run.length + 1 });
      if (next.item.status === "solved") confetti();
    }
  });
}

// FR-2.13 — zero points and the answer, with no confirmation: nothing in a
// practice run is permanent or shared, and "I just want to see it" is half the
// reason the button is there. The daily asks first, because its zero is real.
el.giveUpBtn.addEventListener("click", () => advance(() => api.giveUpPractice({})));

/** One server call that replaces `view`, ignored if a newer run began meanwhile.
 *  `onView` sees the new view before it is drawn. */
async function replaceView(call, onView) {
  const mine = gen;
  setBusy(true);
  setStatus("");
  try {
    const next = await call();
    if (mine !== gen) return;
    view = next;
    onView?.(next);
  } catch (err) {
    // FR-6.5: a failed call consumes nothing and stays retryable.
    if (mine === gen) setStatus(errorMessage(err), "err");
  } finally {
    if (mine === gen) { setBusy(false); render(); focusInput(); }
  }
}

el.revealNext.addEventListener("click", () => { if (!busy) replaceView(() => api.nextPractice({})); });

// FR-9.4 — ending is a question, not a reflex: a mis-tap in the corner of the
// screen would otherwise end a run the player was enjoying.
async function leave() {
  closeSheet();
  if (busy || !view) return;
  if (!(await ask(el.leaveDialog, el.leaveText, t("practice.confirmLeave")))) return focusInput();
  await replaceView(() => api.endPractice({}));
}
el.leaveBtn.addEventListener("click", leave);
el.endBtn.addEventListener("click", leave);

// Another run of the same kind, with the history of the last one going with
// the summary that reported it.
el.again.addEventListener("click", () => start(kind ?? KINDS[0]));

// The phone's history sheet. Above 60rem the panel is always open and the
// toggle is not drawn, so none of this does anything there.
// While the sheet is up, everything behind it is inert, so it is modal to a
// keyboard and a screen reader as well as to the eye; focus goes into it and
// comes back to the bar that opened it. A window that grows past 60rem has no
// sheet to show, so it closes.
const behind = [document.querySelector("header"), document.querySelector(".run-bar"), document.querySelector("#run-cols .play-col")];
el.runToggle.addEventListener("click", () => setSheet(true));
el.runSide.addEventListener("click", (ev) => { if (ev.target === el.runSide) closeSheet(); });
el.sheetClose.addEventListener("click", closeSheet);
addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeSheet(); });
const wide = matchMedia("(min-width: 60rem)");
addEventListener("resize", () => { if (wide.matches) closeSheet(); });
function setSheet(open) {
  const was = el.runSide.classList.contains("open");
  if (was === open) return;
  el.runSide.classList.toggle("open", open);
  el.runToggle.setAttribute("aria-expanded", String(open));
  // The toggle too: it sits under the backdrop and only opens.
  for (const b of [...behind, el.runToggle]) b.inert = open;
  (open ? el.sheetClose : el.runToggle).focus();
}
function closeSheet() { setSheet(false); }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A challenge is open when there is one and the server says it is not over. */
const challengeOpen = () => view?.status === "in_progress" && view.item?.status === "current";

function render() {
  const signedIn = Boolean(auth.currentUser);
  const playing = signedIn && urlKind() !== null;
  const running = playing && view?.status === "in_progress";
  const ended = playing && view?.status === "ended";

  el.choose.hidden = !signedIn || playing;
  el.runCols.hidden = !playing;
  // The page is the height of the window while a run is up (mondo.css).
  document.body.classList.toggle("playing", playing);
  el.train.hidden = !running;
  // A run URL with no run: it failed to start. The summary's buttons are the retry.
  const failed = playing && view === null && !busy;
  el.summary.hidden = !ended && !failed;
  el.leaveBtn.hidden = !running;
  el.endBtn.hidden = !running;
  el.helpBtn.hidden = !running || view.item.status !== "current";

  for (const b of el.continents.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(regions.has(b.dataset.region)));
  }

  if (playing) {
    el.runKind.textContent = t(`kindName.${kind}`);
    el.runWhere.textContent = regions.size === REGIONS.length
      ? t("practice.everywhere")
      : REGIONS.filter((r) => regions.has(r)).map((r) => t(`continentName.${r}`)).join(" · ");
    const now = totalsNow();
    el.progress.hidden = !running;
    if (running) {
      // The counter counts the challenge on screen, including while it is being
      // revealed — see totalsNow.
      const revealing = view.item.status !== "current";
      el.progress.textContent = t("practice.counter", { n: revealing ? now.played : now.played + 1, points: now.points });
    }
  }

  if (running) renderChallenge();
  if (failed) el.summaryText.textContent = "";
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

  el.giveUpBtn.hidden = revealing;

  // One prompt shape per kind. A finished challenge keeps its prompt through
  // the reveal so the player can look at the question again knowing the answer
  // (FR-6.10) — kept client-side, because the server sends no prompt for a
  // closed item, and a load always starts a fresh challenge, never a reveal. A choice board marks the right option on it (FR-8.7, D-64).
  const shown = revealing ? shownPrompt : (shownPrompt = item.prompt);
  const kind = shown?.kind ?? null;
  // A board has no field and no guess rows, so it takes the whole width.
  el.train.classList.toggle("pick", isPick(kind));
  el.train.classList.toggle("revealing", revealing);

  el.shapeWrap.hidden = kind !== "shape";
  el.flagWrap.hidden = kind !== "flag";
  // `renderPerson` un-hides this itself, and hides it again if the photo never
  // arrives — so the only thing to do here is put it away for every other kind.
  if (kind !== "person") el.personWrap.hidden = true;
  el.capital.hidden = kind !== "capital" && kind !== "gdp" && kind !== "person" && !isPick(kind);
  el.options.hidden = !isPick(kind);
  if (kind === "shape") renderShape(el.shape, shown.shape);
  else if (kind === "flag") renderFlag(el.flag, shown.flag);
  else if (kind === "capital") el.capital.textContent = t("capitalPrompt", { city: shown.capital });
  else if (kind === "gdp") el.capital.textContent = t("gdpPrompt", { country: shown.country, year: shown.year });
  else if (kind === "person") {
    el.capital.textContent = t("personPrompt", { name: shown.name });
    renderPerson(el.personWrap, el.personPhoto, el.personCredit, shown);
  }
  else if (isPick(kind)) {
    el.capital.textContent = t(`${kind}Prompt`, { country: shown.country });
    renderOptions(el.options, shown.options, {
      guesses: item.guesses,
      answer: revealing ? item.answer : null,
      onPick: revealing ? null : (i) => advance(() => api.submitPracticeGuess({ guess: i, selfReport: takeReport() })),
    });
  } else if (kind !== null) setStatus(t("errors.invalid-argument"), "err");

  // Three inputs, at most one visible: a country autocomplete, a number field
  // (D-53), or the grid above, which is its own input (D-64).
  el.combo.hidden = kind === "gdp";
  el.money.hidden = kind !== "gdp";

  // A pick is struck out in the grid, not listed as a row: the client is never
  // told which country it was, so there is nothing to put in one. The rest are
  // newest first, so the last guess sits right under the field it came from.
  el.guesses.replaceChildren(...(isPick(kind) ? [] : item.guesses).map(guessRow).reverse());
  el.form.hidden = revealing || isPick(kind);
  el.left.hidden = revealing || isPick(kind);
  el.left.textContent = t("guessesLeft", { n: item.guessesUsed, max: item.guessesMax });

  el.reveal.hidden = !revealing;
  if (revealing) {
    const born = item.answer?.bornIn ? ` ${t("revealBorn", { city: item.answer.bornIn })}` : "";
    el.revealText.textContent = (item.status === "solved"
      ? t("revealSolved", { points: item.points })
      : isPick(kind)
      ? t("revealPick")
      : t("revealFailed", { answer: item.answer.name })) + born;
    renderAbout(el.revealAbout, item.answer);
    renderHints(el.revealHints, item.answer);
    el.revealNext.textContent = t("practice.next");
  } else {
    // FR-6.9 — the first challenge of each hint vocabulary explains itself, and
    // reads the same flag the daily wrote, so nobody meets it twice.
    help(kind);
  }
}

/** The run so far, newest first. Every line was already on screen once. */
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
    pts.className = `score pts-${it.points}`;
    pts.textContent = `+${it.points}`;
    li.append(n, label, pts);
    return li;
  }).reverse());

  // The phone's folded bar: how many, and the latest.
  const last = run.at(-1);
  el.runCount.textContent = t("practice.history", { n: run.length });
  el.runLast.textContent = last ? `${t("practice.last", { name: last.answer.name })} +${last.points}` : "";
}

/** The run's totals: points, solved of finished, average, and the streak of
 *  solved challenges ending at the latest one. */
function renderStats() {
  if (!view) return el.stats.replaceChildren();
  const { played, solved, points } = totalsNow();
  let streak = 0;
  for (let i = run.length - 1; i >= 0 && run[i].status === "solved"; i--) streak++;
  el.stats.replaceChildren(...[
    ["practice.statPoints", String(points)],
    ["practice.statSolved", `${solved}/${played}`],
    ["practice.statAvg", played === 0 ? "—" : (points / played).toLocaleString("pt-BR", { maximumFractionDigits: 1 })],
    ["practice.statStreak", String(streak)],
  ].map(([key, value]) => {
    const div = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = t(key);
    const dd = document.createElement("dd"); dd.textContent = value;
    div.append(dt, dd);
    return div;
  }));
}

/** Focus only works once the input is enabled again, so call this after setBusy(false). */
function focusInput() {
  if (view?.status === "ended") return el.again.focus();
  if (view?.status !== "in_progress") return;
  if (view.item.status !== "current") return el.revealNext.focus();
  // A choice challenge has no field: the grid is the input (FR-8.7), and the
  // screen's heading is where a keyboard starts reading it.
  if (isPick(view.item.prompt?.kind)) return el.runKind.focus();
  const field = view.item.prompt?.kind === "gdp" ? el.number : el.input;
  if (!field.disabled) field.focus();
}

function setBusy(b) {
  busy = b;
  el.input.disabled = b;
  el.number.disabled = b;
  el.submit.disabled = b;
}

/** Status goes under whichever screen is up. */
function setStatus(text, cls = "") {
  for (const s of [el.status, el.chooseStatus]) { s.textContent = ""; s.className = ""; }
  const target = urlKind() === null ? el.chooseStatus : el.status;
  target.textContent = text;
  target.className = cls;
}
