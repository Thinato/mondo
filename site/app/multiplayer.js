// Multijogador — FR-12. A room, played live by everyone in it (D-87, D-88).
//
// This is the one page that LISTENS rather than asks. The room document, its
// prompts and its map are pushed to every player as they change, through the
// Firestore SDK — loaded here and nowhere else (firebase.js `realtime`). Every
// write is still a callable, `multiplayer({ op })` (D-92); the listener is how the
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
import { attach, createIndex, loadCountries } from "./autocomplete.js";
import { confetti } from "./confetti.js";
import { guessRow, isPick, renderAbout, renderFlag, renderHints, renderOptions, renderPerson, renderShape } from "./geo.js";
import { takeReport } from "./visibility.js";
import { errorMessage, t } from "./i18n.js";
import { mountPotato } from "./potato.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"),
  account: $("account"), adminLink: $("admin-link"),
  soon: $("soon"), soonGuest: $("soon-guest"), soonSignIn: $("soon-sign-in"), modes: $("modes"),
  cols: $("room-cols"), lobby: $("lobby"), lobbyTitle: $("lobby-title"), lobbyMode: $("lobby-mode"), lobbyWait: $("lobby-wait"),
  link: $("room-link"), copy: $("copy-link"), start: $("start-btn"), leave: $("leave-btn"),
  classic: $("classic"), progress: $("classic-progress"), giveUp: $("classic-giveup"),
  timerBar: $("classic-timer-bar"), clock: $("classic-clock"),
  shapeWrap: $("shape-wrap"), shape: $("shape"), flagWrap: $("flag-wrap"), flag: $("flag"), capital: $("capital"),
  personWrap: $("person-wrap"), personPhoto: $("person-photo"), personCredit: $("person-credit"),
  options: $("options"), guesses: $("guesses"), reveal: $("reveal"), revealText: $("reveal-text"),
  revealAbout: { box: $("reveal-about"), text: $("reveal-about-text"), link: $("reveal-about-link"), credit: $("reveal-about-credit") },
  revealHints: $("reveal-hints"),
  form: $("guess-form"), combo: $("guess-combo"), input: $("guess-input"), list: $("guess-list"),
  money: $("guess-money"), number: $("guess-number"), left: $("left"),
  potato: $("potato"), finished: $("finished"), finishedText: $("finished-text"),
  missed: $("missed"), missedTitle: $("missed-title"), missedList: $("missed-list"), again: $("again-link"), againRow: $("again-row"),
  board: $("board"), boardTitle: $("board-title"), status: $("status"),
  confirm: $("confirm-dialog"), confirmText: $("confirm-text"),
};

/** Lucide's "trophy" (ISC; credited in creditos.html), inline like every other icon here. */
const TROPHY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';

/** The presets the server knows (lib/multiplayer.ts). Labels only — the server resolves the rest. */
const PRESETS = ["mundo", "dia", "bandeiras", "formas", "capitais", "misto-10"];

const roomId = new URLSearchParams(location.search).get("s")?.toUpperCase() ?? null;
let gate = null;             // listGroups' reply: `canCreate` decides between opening a room and "Em breve"
let room = null;             // the live room document
const prompts = new Map();   // Clássico: index → { prompt, reveal }
let mine = null;             // Clássico: my own guesses on the challenge on screen
let mineKey = null;          // which game and challenge `mine` is about: `${startedAt}:${index}`
let gameKey = null;          // the game on screen: `room.startedAt` (D-104, a room plays many)
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

/** Every op goes through here, so every reply sets the clock. */
async function multiplayer(op, data = {}) {
  const sent = Date.now();
  const r = await api.multiplayer({ op, ...data });
  // Half the round trip is the best guess at when the server read its clock.
  offset = r.serverNow - (sent + Date.now()) / 2;
  return r;
}

// ---------------------------------------------------------------------------
// Sign-in and routing
// ---------------------------------------------------------------------------

watchAuth({
  signIn: el.signIn, signOut: el.signOut, signedOut: el.signedOut,
  account: el.account, adminLink: el.adminLink, setStatus,
  onUser: (user) => {
    stop();
    if (!user) return render();
    if (roomId) join();
    else api.listGroups({}).then((r) => { gate = r; if (r.canCreate) openRoom(); else render(); })
      .catch((err) => setStatus(errorMessage(err, "multi"), "err"));
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
// The host's room (D-103)
// ---------------------------------------------------------------------------

/**
 * A host does not make a room: opening Multijogador opens theirs, the one they
 * already have or a new one (the server decides which). `replace`, so Back
 * leaves Multijogador instead of landing here and being sent on again.
 * Drawn, not authorized: `create` asserts the rank itself (FR-10.3).
 */
async function openRoom() {
  setStatus(t("loading"));
  try {
    const r = await multiplayer("create");
    location.replace(`./sala?s=${r.room}`);
  } catch (err) {
    setStatus(errorMessage(err, "multi"), "err");
  }
}

// Linking keeps the uid and reloads the page (auth-ui.js), so the page asks
// the server again who this is — and an invited player lands in their room.
el.soonSignIn.addEventListener("click", () => googleClick(el.soonSignIn, setStatus));

/** FR-12.7: the host picks the next game in the lobby. Everyone sees it change. */
function buildModes() {
  if (el.modes.children.length > 0) return;
  el.modes.replaceChildren(...PRESETS.map((id) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.preset = id;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t(`multi.preset.${id}`);
    const about = document.createElement("span");
    about.className = "fine";
    about.textContent = t(`multi.presetAbout.${id}`);
    b.append(name, about);
    b.addEventListener("click", () => {
      if (room?.presetId !== id) act(() => multiplayer("configure", { room: roomId, presetId: id }));
    });
    li.append(b);
    return li;
  }));
}

// ---------------------------------------------------------------------------
// Join and listen
// ---------------------------------------------------------------------------

async function join() {
  setStatus(t("loading"));
  try {
    const r = await multiplayer("join", { room: roomId });
    mine = r.mine;
    setStatus("");
    await listen();
  } catch (err) {
    setStatus(errorMessage(err, "multi"), "err");
  }
}

async function listen() {
  const { db, fs } = await realtime();
  unsubscribe.push(fs.onSnapshot(fs.doc(db, "rooms", roomId), (snap) => {
    room = snap.data() ?? null;
    onRoom();
  }, (err) => {
    // The rules read the seat (D-87): a player the host removed (FR-12.8) is
    // cut off mid-listen, and that is the only way this listener is refused.
    if (err.code === "permission-denied" && room) {
      stop();
      render();
      return setStatus(t("multi.removed"), "warn");
    }
    setStatus(errorMessage(err, "multi"), "err");
  }));
  // Clássico: one small document per challenge, written when it opens and again
  // when it closes with the answer (SEC-1: never before). The whole set each
  // time: a rematch deletes the last game's (D-104), and those must go here too.
  unsubscribe.push(fs.onSnapshot(fs.collection(db, "rooms", roomId, "prompts"), (snap) => {
    prompts.clear();
    for (const d of snap.docs) prompts.set(Number(d.id), d.data());
    render();
  }, () => {}));
  // Batata Quente: the grey land, then one document per country as it is named;
  // a rematch takes them all away again.
  unsubscribe.push(fs.onSnapshot(fs.collection(db, "rooms", roomId, "map"), (snap) => {
    const changes = snap.docChanges();
    potatoView().onMapRemoved(changes.filter((c) => c.type === "removed").map((c) => c.doc.id));
    potatoView().onMap(changes.filter((c) => c.type === "added").map((c) => c.doc.data()));
  }, () => {}));
}

function potatoView() {
  potato ??= mountPotato({ multiplayer, me: () => auth.currentUser?.uid, confirm: confirmGiveUp });
  return potato;
}

function onRoom() {
  // A new game in the same room (D-104): nothing of the last one carries over.
  // The room's snapshot lands before the prompts' of the same commit, and that
  // commit always rewrites prompts/0, so clearing here never blanks the new one.
  const game = room?.startedAt ?? null;
  if (game !== gameKey) {
    if (gameKey !== null && game !== null) { prompts.clear(); mine = null; potato?.reset(); }
    gameKey = game;
  }
  const key = room?.classic ? `${room.startedAt}:${room.classic.index}` : null;
  if (key && key !== mineKey) {
    // A new challenge, or a new game: my guesses on the last one belong to the last one.
    if (mineKey !== null) mine = null;
    mineKey = key;
  }
  if (room?.potato) potatoView().onRoom(room);
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
    try { await multiplayer("tick", { room: roomId }); }
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
  if (room.mode === "classic") el.clock.textContent = room.classic.phase === "question" ? t("multi.secondsLeft", { n: Math.ceil(left / 1000) }) : "";
  else potatoView().drawClock(left);
  frame = requestAnimationFrame(drawClock);
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

el.copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(el.link.value); setStatus(t("multi.copied"), "ok"); }
  catch { el.link.select(); }
});

el.start.addEventListener("click", () => act(() => multiplayer("start", { room: roomId })));
// Not back to /sala: for a host, that opens a room again (D-103).
el.leave.addEventListener("click", async () => {
  await act(() => multiplayer("leave", { room: roomId }));
  location.href = "./";
});

async function act(fn) {
  if (busy) return;
  busy = true;
  try { const r = await fn(); setStatus(""); return r; }
  catch (err) { setStatus(errorMessage(err, "multi"), "err"); }
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
  const r = await act(() => multiplayer("guess", { room: roomId, guess: value, selfReport: takeReport() }));
  if (!r) return;
  mine = r.mine;
  el.input.value = "";
  el.number.value = "";
  if (mine?.solved) confetti();
  render();
  el.input.focus();
}

el.giveUp.addEventListener("click", async () => {
  const r = await act(() => multiplayer("giveUp", { room: roomId }));
  if (r) { mine = r.mine; render(); }
});

const current = () => (room?.classic ? prompts.get(room.classic.index) ?? null : null);

function renderClassic() {
  const c = room.classic;
  const p = current();
  const open = c.phase === "question";
  const done = Boolean(mine?.done);
  el.progress.textContent = t("multi.challengeOf", { n: c.index + 1, total: c.kinds.length, kind: t(`kindName.${c.kinds[c.index]}`) });
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
    : open ? t("multi.waiting") : "";

  el.reveal.hidden = open || !p?.reveal;
  if (!open && p?.reveal) {
    const born = p.reveal.bornIn ? ` ${t("revealBorn", { city: p.reveal.bornIn })}` : "";
    const pts = c.progress[auth.currentUser?.uid]?.points ?? 0;
    el.revealText.textContent = (pts > 0 ? t("multi.revealSolved", { points: pts, answer: p.reveal.name }) : t("revealFailed", { answer: p.reveal.name })) + born;
    renderAbout(el.revealAbout, p.reveal);
    renderHints(el.revealHints, p.reveal);
  }
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** Everyone, best first: points, then time spent (FR-12.2, FR-12.3). */
function standings() {
  if (!room) return [];
  // By the game that was PLAYED: between games the host may already have
  // picked a Clássico for the next one, and the board still shows the last.
  const score = (uid) => room.potato
    ? { points: room.potato?.scores[uid]?.points ?? 0, timeMs: room.potato?.scores[uid]?.timeMs ?? 0 }
    : { points: room.players[uid]?.score ?? 0, timeMs: room.players[uid]?.timeMs ?? 0 };
  return [...room.playerUids].sort((a, b) => score(b).points - score(a).points || score(a).timeMs - score(b).timeMs)
    .map((uid) => ({ uid, ...room.players[uid], ...score(uid) }));
}

function renderBoard() {
  const playing = room.state !== "lobby";
  el.boardTitle.textContent = playing ? t("multi.board") : t("multi.players", { n: room.playerUids.length });
  el.board.replaceChildren(...(playing ? standings() : room.playerUids.map((uid) => ({ uid, ...room.players[uid] }))).map((p) => {
    const li = document.createElement("li");
    li.className = "board-row";
    if (p.uid === auth.currentUser?.uid) li.classList.add("me");
    if (room.mode === "potato" && room.potato?.turnUid === p.uid) li.classList.add("turn");
    if (room.state === "playing" && room.mode === "potato" && room.potato?.gaveUp.includes(p.uid)) li.classList.add("out");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = p.color;
    // FR-13: a name opens that player's profile — in a new tab, and never mid-game,
    // where a stray tap would leave the room on the one page that plays it.
    const linked = room.state !== "playing";
    const name = document.createElement(linked ? "a" : "span");
    if (linked) Object.assign(name, { href: `./perfil?u=${encodeURIComponent(p.uid)}`, target: "_blank", rel: "noopener" });
    name.className = "name";
    name.textContent = p.name + (p.uid === room.hostUid && !playing ? ` · ${t("multi.host")}` : "");
    const right = document.createElement("span");
    right.className = "score";
    if (playing) {
      const prog = room.mode === "classic" && room.state === "playing" ? room.classic.progress[p.uid] : null;
      const mark = !prog ? "" : prog.done ? (prog.solved ? "✓ " : "✗ ") : prog.guesses ? `${t("multi.tries", { n: prog.guesses })} · ` : "";
      right.textContent = `${mark}${p.points}`;
    }
    li.append(dot, name);
    // D-105: games won outright in this room. Ties at the top win nothing.
    const wins = room.players[p.uid]?.wins ?? 0;
    if (wins > 0) {
      const w = document.createElement("span");
      w.className = "wins";
      w.title = t("multi.wins", { n: wins });
      w.setAttribute("role", "img");
      w.setAttribute("aria-label", w.title);
      w.innerHTML = TROPHY;
      w.append(String(wins));
      li.append(w);
    }
    li.append(right);
    // FR-12.8: between games the host can take a seat nobody is using — the
    // next game would otherwise wait out their clock. Not a ban: the link works.
    if (linked && room.hostUid === auth.currentUser?.uid && p.uid !== room.hostUid && room.potato?.limitMs !== null) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "link remove";
      x.textContent = "✕";
      x.setAttribute("aria-label", t("multi.remove", { name: p.name }));
      x.addEventListener("click", () => act(() => multiplayer("remove", { room: roomId, uid: p.uid })));
      li.append(x);
    }
    return li;
  }));
}

/**
 * Training's end (D-93): how many, and the names of the rest. The names are the
 * public list the autocomplete already loads; the outlines stay on the server.
 */
function renderSoloEnd() {
  const named = new Set(room.potato.named);
  el.finishedText.textContent = t("multi.soloDone", { n: named.size, total: room.potato.total });
  countryList ??= loadCountries();
  countryList.then((list) => {
    const missed = list.filter((c) => !named.has(c.code)).map((c) => c.pt).sort((a, b) => a.localeCompare(b, "pt-BR"));
    el.missed.hidden = missed.length === 0;
    el.missedTitle.textContent = t("multi.missed", { n: missed.length });
    el.missedList.textContent = missed.join(", ");
  }).catch(() => { countryList = null; el.missed.hidden = true; });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const user = auth.currentUser;
  // Only a page with no room says "Em breve", and only once the server has said this is not a host.
  el.soon.hidden = !user || Boolean(roomId) || !gate || gate.canCreate;
  el.soonGuest.hidden = !user?.isAnonymous;

  el.cols.hidden = !user || !room;
  // A training room (D-93) is played once; every other room outlives its game (D-104).
  const training = room?.potato?.limitMs === null;
  // D-95: a Batata Quente game, once it starts, is the whole window on a desktop.
  // Between games the room is a page again: the result, then the lobby, then the map.
  document.body.classList.toggle("potato-room", Boolean(user && room?.potato && (room.state === "playing" || training)));
  if (!room) return;
  const uid = user?.uid;
  const inRoom = room.playerUids.includes(uid);
  const host = room.hostUid === uid;

  const between = room.state === "lobby" || (room.state === "finished" && !training);
  el.lobby.hidden = !between;
  if (between) {
    el.lobbyTitle.textContent = t(`multi.preset.${room.presetId}`);
    el.lobbyMode.textContent = t(`multi.presetAbout.${room.presetId}`);
    el.lobbyMode.hidden = host; // the host reads it on the picked card
    el.link.value = location.href.split("#")[0];
    // FR-12.7: the host picks; everyone else reads what was picked, above.
    el.modes.hidden = !host;
    if (host) {
      buildModes();
      for (const b of el.modes.querySelectorAll("button")) {
        b.setAttribute("aria-pressed", String(b.dataset.preset === room.presetId));
        b.disabled = busy;
      }
    }
    const enough = room.playerUids.length >= 2;
    el.start.hidden = !host;
    el.start.disabled = !enough || busy;
    el.start.textContent = room.state === "finished" ? t("multi.again") : t("multi.start");
    el.lobbyWait.textContent = host
      ? (enough ? t("multi.readyHost") : t("multi.needPlayers"))
      : t("multi.waitHost", { name: room.players[room.hostUid]?.name ?? "" });
  }

  el.classic.hidden = !(room.state === "playing" && room.mode === "classic");
  // The finished map stays up under the result: it is what the game was for.
  // By the game PLAYED, not the mode picked for the next one.
  el.potato.hidden = !(room.state !== "lobby" && room.potato);
  $("potato-head").hidden = !room.potato;
  if (room.state === "playing" && room.mode === "classic") { countries(); renderClassic(); }
  if (room.potato) potatoView().render(room);

  el.finished.hidden = room.state !== "finished";
  el.againRow.hidden = !training; // a room's way on is its lobby, just below (D-104)
  if (room.state === "finished") {
    const [top, second] = standings();
    // D-105: a tie at the top is a draw, as the trophies count it — the clock orders the board, it does not win.
    el.finishedText.textContent = !inRoom || !top ? t("multi.over")
      : second && second.points === top.points ? t("multi.draw", { points: top.points })
      : top.uid === uid ? t("multi.youWon", { points: top.points }) : t("multi.won", { name: top.name, points: top.points });
    if (room.potato) el.finishedText.textContent += ` ${t(`multi.end.${room.potato.endReason}`)}`;
    if (training) renderSoloEnd();
  }

  renderBoard();
  drawClock();
}
