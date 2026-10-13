// Versus — FR-12. A room, played live by everyone in it (D-87, D-88).
//
// This is the one page that LISTENS rather than asks. The room document, its
// prompts and its map are pushed to every player as they change, through the
// Firestore SDK — loaded here and nowhere else (firebase.js `realtime`). Every
// write is still a callable, `versus({ op })` (D-92); the listener is how the
// result of a write, anyone's, reaches the screen.
//
// Nothing here decides anything. The clock on screen is drawn from the server's
// own deadline and the server's own `now` (each reply carries it), and when it
// runs out the page asks the server to move on (`tick`) — the server checks the
// deadline against its clock and the first tick through wins.

import { auth, realtime } from "./firebase.js";
import "./theme.js";
import * as api from "./api.js";
import { ask, googleClick, watchAuth } from "./auth-ui.js";
import { mountProfile } from "./profile.js";
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, isPick, renderAbout, renderFlag, renderOptions, renderPerson, renderShape } from "./geo.js";
import { takeReport } from "./visibility.js";
import { errorMessage, t } from "./i18n.js";
import { mountPotato } from "./potato.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"),
  account: $("account"), profileBtn: $("profile-btn"), adminLink: $("admin-link"),
  create: $("create"), createForm: $("create-form"), createLocked: $("create-locked"), modes: $("modes"), createBtn: $("create-btn"),
  createGuest: $("create-guest"), createSignIn: $("create-sign-in"),
  cols: $("room-cols"), lobby: $("lobby"), lobbyTitle: $("lobby-title"), lobbyMode: $("lobby-mode"), lobbyWait: $("lobby-wait"),
  link: $("room-link"), copy: $("copy-link"), start: $("start-btn"), leave: $("leave-btn"),
  classic: $("classic"), progress: $("classic-progress"), giveUp: $("classic-giveup"),
  timerBar: $("classic-timer-bar"), clock: $("classic-clock"),
  shapeWrap: $("shape-wrap"), shape: $("shape"), flagWrap: $("flag-wrap"), flag: $("flag"), capital: $("capital"),
  personWrap: $("person-wrap"), personPhoto: $("person-photo"), personCredit: $("person-credit"),
  options: $("options"), guesses: $("guesses"), reveal: $("reveal"), revealText: $("reveal-text"),
  revealAbout: { box: $("reveal-about"), text: $("reveal-about-text"), link: $("reveal-about-link"), credit: $("reveal-about-credit") },
  form: $("guess-form"), combo: $("guess-combo"), input: $("guess-input"), list: $("guess-list"),
  money: $("guess-money"), number: $("guess-number"), left: $("left"),
  potato: $("potato"), finished: $("finished"), finishedText: $("finished-text"),
  missed: $("missed"), missedTitle: $("missed-title"), missedList: $("missed-list"), again: $("again-link"),
  board: $("board"), boardTitle: $("board-title"), status: $("status"),
  confirm: $("confirm-dialog"), confirmText: $("confirm-text"),
};

/** The presets the server knows (lib/versus.ts). Labels only — the server resolves the rest. */
const PRESETS = ["mundo", "dia", "bandeiras", "formas", "capitais", "misto-10"];

const roomId = new URLSearchParams(location.search).get("s")?.toUpperCase() ?? null;
let preset = PRESETS[0];
let gate = null;             // listGroups' reply: `canCreate` decides whether the create form is drawn
let room = null;             // the live room document
const prompts = new Map();   // Clássico: index → { prompt, reveal }
let mine = null;             // Clássico: my own guesses on the challenge on screen
let mineIndex = -1;
let offset = 0;              // server clock − this clock, from each reply's serverNow
let tickTimer = null;
let frame = null;
let busy = false;
let picked = null;
let ac = null;
let acLoading = null;
let potato = null;
let countryList = null;      // training's end: the public list of names, loaded once
let unsubscribe = [];

const setStatus = (text, cls = "") => { el.status.textContent = text; el.status.className = cls; };
const serverNow = () => Date.now() + offset;
const profile = mountProfile({ button: el.profileBtn, setStatus });

/** Every op goes through here, so every reply sets the clock. */
async function versus(op, data = {}) {
  const sent = Date.now();
  const r = await api.versus({ op, ...data });
  // Half the round trip is the best guess at when the server read its clock.
  offset = r.serverNow - (sent + Date.now()) / 2;
  return r;
}

// ---------------------------------------------------------------------------
// Sign-in and routing
// ---------------------------------------------------------------------------

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, profile, setStatus,
  onUser: (user) => {
    stop();
    if (!user) return render();
    if (roomId) join();
    else api.listGroups({}).then((r) => { gate = r; render(); }).catch((err) => setStatus(errorMessage(err, "versus"), "err"));
    render();
  },
});

function stop() {
  for (const u of unsubscribe) u();
  unsubscribe = [];
  room = null;
  prompts.clear();
  clearTimeout(tickTimer);
  cancelAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function buildModes() {
  if (el.modes.children.length > 0) return;
  el.modes.replaceChildren(...PRESETS.map((id) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.preset = id;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t(`versus.preset.${id}`);
    const about = document.createElement("span");
    about.className = "fine";
    about.textContent = t(`versus.presetAbout.${id}`);
    b.append(name, about);
    b.addEventListener("click", () => { preset = id; render(); });
    li.append(b);
    return li;
  }));
}

// Linking keeps the uid and reloads the page (auth-ui.js), so the page asks
// the server again who this is.
el.createSignIn.addEventListener("click", () => googleClick(el.createSignIn, setStatus));

el.createBtn.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  setStatus(t("loading"));
  try {
    const r = await versus("create", { presetId: preset });
    location.href = `./sala.html?s=${r.room}`;
  } catch (err) {
    setStatus(errorMessage(err, "versus"), "err");
  } finally {
    busy = false;
  }
});

// ---------------------------------------------------------------------------
// Join and listen
// ---------------------------------------------------------------------------

async function join() {
  setStatus(t("loading"));
  try {
    const r = await versus("join", { room: roomId });
    mine = r.mine;
    setStatus("");
    await listen();
  } catch (err) {
    setStatus(errorMessage(err, "versus"), "err");
  }
}

async function listen() {
  const { db, fs } = await realtime();
  unsubscribe.push(fs.onSnapshot(fs.doc(db, "rooms", roomId), (snap) => {
    room = snap.data() ?? null;
    onRoom();
  }, (err) => setStatus(errorMessage(err, "versus"), "err")));
  // Clássico: one small document per challenge, written when it opens and again
  // when it closes with the answer (SEC-1: never before).
  unsubscribe.push(fs.onSnapshot(fs.collection(db, "rooms", roomId, "prompts"), (snap) => {
    for (const d of snap.docs) prompts.set(Number(d.id), d.data());
    render();
  }));
  // Batata Quente: the grey land, then one document per country as it is named.
  unsubscribe.push(fs.onSnapshot(fs.collection(db, "rooms", roomId, "map"), (snap) => {
    potatoView().onMap(snap.docChanges().filter((c) => c.type === "added").map((c) => c.doc.data()));
  }));
}

function potatoView() {
  potato ??= mountPotato({ versus, me: () => auth.currentUser?.uid, confirm: confirmGiveUp });
  return potato;
}

function onRoom() {
  if (room?.mode === "classic" && room.classic && room.classic.index !== mineIndex) {
    // A new challenge: my guesses on the last one belong to the last one.
    if (mineIndex !== -1) mine = null;
    mineIndex = room.classic.index;
  }
  if (room?.mode === "potato" && room.potato) potatoView().onRoom(room);
  scheduleTick();
  render();
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

const deadline = () => (room?.state !== "playing" ? null : room.mode === "potato" ? room.potato?.deadline : room.classic?.deadline);

/** When the server's deadline passes, ask it to move on. Every player does; the first one through wins. */
function scheduleTick() {
  clearTimeout(tickTimer);
  const d = deadline();
  if (d == null) return;
  const wait = Math.max(0, d - serverNow()) + 250;
  tickTimer = setTimeout(async () => {
    try { await versus("tick", { room: roomId }); }
    catch { /* the next snapshot, or the retry below, will sort it out */ }
    // If no snapshot moved the deadline (a lost tick), try again shortly.
    if (deadline() === d) tickTimer = setTimeout(scheduleTick, 1000);
  }, wait);
}

function drawClock() {
  cancelAnimationFrame(frame);
  const d = deadline();
  if (d == null) return;
  const total = room.mode === "potato" ? room.potato.limitMs : room.classic.phase === "question" ? room.classic.durationMs : 5000;
  const left = Math.max(0, d - serverNow());
  const bar = room.mode === "potato" ? $("potato-timer-bar") : el.timerBar;
  bar.style.width = `${(100 * left) / total}%`;
  bar.classList.toggle("low", left < 3000);
  if (room.mode === "classic") el.clock.textContent = room.classic.phase === "question" ? t("versus.secondsLeft", { n: Math.ceil(left / 1000) }) : "";
  else potatoView().drawClock(left);
  frame = requestAnimationFrame(drawClock);
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

el.copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(el.link.value); setStatus(t("versus.copied"), "ok"); }
  catch { el.link.select(); }
});

el.start.addEventListener("click", () => act(() => versus("start", { room: roomId })));
el.leave.addEventListener("click", async () => {
  await act(() => versus("leave", { room: roomId }));
  location.href = "./sala.html";
});

async function act(fn) {
  if (busy) return;
  busy = true;
  try { const r = await fn(); setStatus(""); return r; }
  catch (err) { setStatus(errorMessage(err, "versus"), "err"); }
  finally { busy = false; render(); }
}

function confirmGiveUp(text) {
  return ask(el.confirm, el.confirmText, text);
}

// ---------------------------------------------------------------------------
// Clássico
// ---------------------------------------------------------------------------

function countries() {
  countryList ??= loadCountries();
  acLoading ??= countryList.then((list) => { ac = attachIndex(createIndex(list)); });
  return acLoading;
}

function attachIndex(index) {
  return attach({
    input: el.input, list: el.list, index,
    onPick: (entry) => { picked = entry; guess(entry.code); },
    onMiss: (text) => { picked = null; if (text.trim()) setStatus(t("noMatch"), "warn"); },
  });
}

el.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (current()?.prompt.kind === "gdp") {
    const value = Number(el.number.value);
    if (!Number.isFinite(value) || value <= 0) return setStatus(t("needNumber"), "warn");
    return guess(value);
  }
  if (!picked) ac?.commit(); else guess(picked.code);
});
el.input.addEventListener("input", () => { picked = null; });

async function guess(value) {
  picked = null;
  const r = await act(() => versus("guess", { room: roomId, guess: value, selfReport: takeReport() }));
  if (!r) return;
  mine = r.mine;
  el.input.value = "";
  el.number.value = "";
  if (mine?.solved) confetti();
  render();
  el.input.focus();
}

el.giveUp.addEventListener("click", async () => {
  const r = await act(() => versus("giveUp", { room: roomId }));
  if (r) { mine = r.mine; render(); }
});

const current = () => (room?.classic ? prompts.get(room.classic.index) ?? null : null);

function renderClassic() {
  const c = room.classic;
  const p = current();
  const open = c.phase === "question";
  const done = Boolean(mine?.done);
  el.progress.textContent = t("versus.challengeOf", { n: c.index + 1, total: c.kinds.length, kind: t(`kindName.${c.kinds[c.index]}`) });
  el.giveUp.hidden = !open || done;

  const prompt = p?.prompt ?? null;
  const kind = prompt?.kind ?? null;
  el.shapeWrap.hidden = kind !== "shape";
  el.flagWrap.hidden = kind !== "flag";
  if (kind !== "person") el.personWrap.hidden = true;
  el.capital.hidden = !(kind === "capital" || kind === "gdp" || kind === "person" || isPick(kind));
  el.options.hidden = !isPick(kind);
  if (kind === "shape") renderShape(el.shape, prompt.shape);
  else if (kind === "flag") renderFlag(el.flag, prompt.flag);
  else if (kind === "capital") el.capital.textContent = t("capitalPrompt", { city: prompt.capital });
  else if (kind === "gdp") el.capital.textContent = t("gdpPrompt", { country: prompt.country, year: prompt.year });
  else if (kind === "person") {
    el.capital.textContent = t("personPrompt", { name: prompt.name });
    renderPerson(el.personWrap, el.personPhoto, el.personCredit, prompt);
  } else if (isPick(kind)) {
    el.capital.textContent = t(`${kind}Prompt`, { country: prompt.country });
    renderOptions(el.options, prompt.options, {
      guesses: mine?.guesses ?? [],
      answer: open ? null : p.reveal,
      onPick: open && !done ? (i) => guess(i) : null,
    });
  }

  el.combo.hidden = kind === "gdp";
  el.money.hidden = kind !== "gdp";
  el.guesses.replaceChildren(...(isPick(kind) ? [] : mine?.guesses ?? []).map(guessRow));
  el.form.hidden = !open || done || isPick(kind) || !prompt;
  el.left.textContent = open && !done ? t("guessesLeft", { n: mine?.guesses.length ?? 0, max: c.guessesMax })
    : open ? t("versus.waiting") : "";

  el.reveal.hidden = open || !p?.reveal;
  if (!open && p?.reveal) {
    const born = p.reveal.bornIn ? ` ${t("revealBorn", { city: p.reveal.bornIn })}` : "";
    const pts = c.progress[auth.currentUser?.uid]?.points ?? 0;
    el.revealText.textContent = (pts > 0 ? t("versus.revealSolved", { points: pts, answer: p.reveal.name }) : t("revealFailed", { answer: p.reveal.name })) + born;
    renderAbout(el.revealAbout, p.reveal);
  }
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** Everyone, best first: points, then time spent (FR-12.2, FR-12.3). */
function standings() {
  if (!room) return [];
  const score = (uid) => room.mode === "potato"
    ? { points: room.potato?.scores[uid]?.points ?? 0, timeMs: room.potato?.scores[uid]?.timeMs ?? 0 }
    : { points: room.players[uid]?.score ?? 0, timeMs: room.players[uid]?.timeMs ?? 0 };
  return [...room.playerUids].sort((a, b) => score(b).points - score(a).points || score(a).timeMs - score(b).timeMs)
    .map((uid) => ({ uid, ...room.players[uid], ...score(uid) }));
}

function renderBoard() {
  const playing = room.state !== "lobby";
  el.boardTitle.textContent = playing ? t("versus.board") : t("versus.players", { n: room.playerUids.length });
  el.board.replaceChildren(...(playing ? standings() : room.playerUids.map((uid) => ({ uid, ...room.players[uid] }))).map((p) => {
    const li = document.createElement("li");
    li.className = "board-row";
    if (p.uid === auth.currentUser?.uid) li.classList.add("me");
    if (room.mode === "potato" && room.potato?.turnUid === p.uid) li.classList.add("turn");
    if (room.state === "playing" && room.mode === "potato" && room.potato?.gaveUp.includes(p.uid)) li.classList.add("out");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = p.color;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name + (p.uid === room.hostUid && !playing ? ` · ${t("versus.host")}` : "");
    const right = document.createElement("span");
    right.className = "score";
    if (playing) {
      const prog = room.mode === "classic" && room.state === "playing" ? room.classic.progress[p.uid] : null;
      const mark = !prog ? "" : prog.done ? (prog.solved ? "✓ " : "✗ ") : prog.guesses ? `${t("versus.tries", { n: prog.guesses })} · ` : "";
      right.textContent = `${mark}${p.points}`;
    }
    li.append(dot, name, right);
    return li;
  }));
}

/**
 * Training's end (D-93): how many, and the names of the rest. The names are the
 * public list the autocomplete already loads; the outlines stay on the server.
 */
function renderSoloEnd() {
  const named = new Set(room.potato.named);
  el.finishedText.textContent = t("versus.soloDone", { n: named.size, total: room.potato.total });
  // Started from the Treinar page (D-93), so that is where "again" goes.
  el.again.href = "./praticar.html";
  el.again.textContent = t("versus.trainAgain");
  countryList ??= loadCountries();
  countryList.then((list) => {
    const missed = list.filter((c) => !named.has(c.code)).map((c) => c.pt).sort((a, b) => a.localeCompare(b, "pt-BR"));
    el.missed.hidden = missed.length === 0;
    el.missedTitle.textContent = t("versus.missed", { n: missed.length });
    el.missedList.textContent = missed.join(", ");
  }).catch(() => { countryList = null; el.missed.hidden = true; });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const user = auth.currentUser;
  el.create.hidden = !user || Boolean(roomId);
  if (!roomId && user) {
    buildModes();
    // Drawn, not authorized: `create` asserts the rank itself (FR-10.3). A
    // guest is told to sign in, not that they lack a rank — an admin who has
    // not signed in on this browser yet is a guest too.
    const guest = Boolean(user.isAnonymous);
    const can = Boolean(gate?.canCreate);
    el.createForm.hidden = !can;
    el.createGuest.hidden = !guest;
    el.createLocked.hidden = gate === null || can || guest;
    for (const b of el.modes.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.preset === preset));
  }

  el.cols.hidden = !user || !room;
  // D-95: a Batata Quente game, once it starts, is the whole window on a desktop.
  document.body.classList.toggle("potato-room", Boolean(user && room?.mode === "potato" && room.state !== "lobby"));
  if (!room) return;
  const uid = user?.uid;
  const inRoom = room.playerUids.includes(uid);

  el.lobby.hidden = room.state !== "lobby";
  if (room.state === "lobby") {
    el.lobbyTitle.textContent = t(`versus.preset.${room.presetId}`);
    el.lobbyMode.textContent = t(`versus.presetAbout.${room.presetId}`);
    el.link.value = location.href.split("#")[0];
    const host = room.hostUid === uid;
    const enough = room.playerUids.length >= 2;
    el.start.hidden = !host;
    el.start.disabled = !enough || busy;
    el.lobbyWait.textContent = host
      ? (enough ? t("versus.readyHost") : t("versus.needPlayers"))
      : t("versus.waitHost", { name: room.players[room.hostUid]?.name ?? "" });
  }

  el.classic.hidden = !(room.state === "playing" && room.mode === "classic");
  // The finished map stays up under the result: it is what the game was for.
  el.potato.hidden = !(room.state !== "lobby" && room.mode === "potato");
  if (room.state === "playing" && room.mode === "classic") { countries(); renderClassic(); }
  if (room.mode === "potato" && room.potato) potatoView().render(room);

  el.finished.hidden = room.state !== "finished";
  if (room.state === "finished") {
    const top = standings()[0];
    el.finishedText.textContent = !inRoom || !top ? t("versus.over")
      : top.uid === uid ? t("versus.youWon", { points: top.points }) : t("versus.won", { name: top.name, points: top.points });
    if (room.mode === "potato" && room.potato) el.finishedText.textContent += ` ${t(`versus.end.${room.potato.endReason}`)}`;
    if (room.potato?.limitMs === null) renderSoloEnd();
  }

  renderBoard();
  drawClock();
}
