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
import { multiSelect } from "./multiselect.js";
import { ICONS } from "./kind-icons.js";

const $ = (id) => document.getElementById(id);
const el = {
  signedOut: $("signed-out"), signIn: $("sign-in"), signOut: $("sign-out"),
  account: $("account"), adminLink: $("admin-link"),
  soon: $("soon"), soonGuest: $("soon-guest"), soonSignIn: $("soon-sign-in"), modes: $("modes"),
  picker: $("picker"), tabPresets: $("tab-presets"), tabCustom: $("tab-custom"), custom: $("custom"),
  slots: $("slots"), slotsCount: $("slots-count"), shuffle: $("shuffle"),
  continentsBox: $("continents-box"), saveForm: $("save-form"), presetName: $("preset-name"), savedFull: $("saved-full"),
  cols: $("room-cols"), lobby: $("lobby"), lobbyTitle: $("lobby-title"), lobbyMode: $("lobby-mode"), lobbyWait: $("lobby-wait"),
  lobbyView: $("lobby-view"), lobbyOrder: $("lobby-order"), lobbyWaitDot: $("lobby-wait-dot"),
  roomTabs: $("room-tabs"), rtabRoom: $("rtab-room"), rtabNext: $("rtab-next"),
  roomHead: $("room-head"), roomName: $("room-name"), copyLabel: $("copy-label"), boardCount: $("board-count"),
  go: $("go"), goTitle: $("go-title"), goKinds: $("go-kinds"), goAbout: $("go-about"), lobbyHint: $("lobby-hint"),
  finishedSub: $("finished-sub"), showMap: $("show-map"), hideMap: $("hide-map"), railSteps: $("rail-steps"), rail: $("classic-rail"),
  savedTitle: $("saved-title"), savedList: $("saved-list"), presetList: $("preset-list"),
  copy: $("copy-link"), start: $("start-btn"), leave: $("leave-btn"),
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

/** Lucide's icons (ISC; credited in creditos.html), inline like every other icon here. */
const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const CROWN = svg('<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>');
const X = '<path d="M18 6 6 18M6 6l12 12"/>';
const PENCIL = '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>';
const TRASH = '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>';
const GRIP = '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>';
const PLUS = '<path d="M12 5v14M5 12h14"/>';
const TROPHY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';

/** The presets the server knows (lib/multiplayer.ts). Labels only — the server resolves the rest. */
const PRESETS = ["mundo", "dia", "bandeiras", "formas", "capitais", "misto-10"];
/** FR-12.10: what a custom game is made of. The server checks all of it again (lib/validate.ts). */
const KINDS = ["shape", "capital", "flag", "gdp", "flagPick", "shapePick", "person"];
const REGIONS = ["Africa", "Americas", "Asia", "Europe", "Oceania"];
const MAX_SLOTS = 15;
/** What each Clássico preset deals, for its chips and its length on the card. Labels only: the server deals. */
const PRESET_KINDS = {
  dia: KINDS,
  bandeiras: ["flag", "flag", "flag", "flagPick", "flagPick", "flagPick"],
  formas: ["shape", "shape", "shape", "shapePick", "shapePick", "shapePick"],
  capitais: ["capital", "capital", "capital", "capital", "capital"],
  "misto-10": ["shape", "shape", "flag", "flag", "capital", "capital", "flagPick", "shapePick", "gdp", "person"],
};
const MAX_SAVED = 10;

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
let saved = [];              // FR-12.11: my own saved custom games, from `join`
let tab = "presets";         // the picker's tab: "presets" | "custom"
let draft = { kinds: [...KINDS], shuffled: false, regions: [...REGIONS] }; // the Personalizar tab
let continents = null;       // the multi-select, built once
let phoneTab = "next";       // a phone's lobby tab: "next" | "room"
let mapOpen = false;         // between games: the last Batata Quente's map, opened from its result
const railPoints = new Map(); // Clássico: my points on each challenge already closed, for the rail
let dragFrom = null;         // the custom slot being dragged

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
function card(name, chips, meta) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mode";
  const n = document.createElement("span");
  n.className = "name";
  n.textContent = name;
  const m = document.createElement("span");
  m.className = "fine";
  m.textContent = meta;
  b.append(n, chipRow(chips), m);
  return b;
}

function chipRow(chips) {
  const row = document.createElement("span");
  row.className = "chips";
  row.append(...chips.map((c) => Object.assign(document.createElement("span"), { className: "chip", textContent: c })));
  return row;
}

/** The list: my saved games first (FR-12.11), so the one I play every week is one click, then the built-ins. */
function drawModes() {
  el.savedTitle.hidden = el.savedList.hidden = saved.length === 0;
  el.savedList.replaceChildren(...saved.map((p) => {
    const li = document.createElement("li");
    li.className = "saved";
    const b = card(p.name, chipsOf(p.kinds), metaOf(p.kinds, p.regions));
    b.dataset.saved = p.name;
    b.addEventListener("click", () => act(() => multiplayer("configure", { room: roomId, custom: p })));
    const edit = iconButton(PENCIL, t("multi.edit", { name: p.name }), () => {
      draft = { kinds: [...p.kinds], shuffled: p.shuffled, regions: [...p.regions] };
      el.presetName.value = p.name;
      showTab("custom");
    });
    const drop = iconButton(TRASH, t("multi.delete", { name: p.name }), () =>
      act(async () => { saved = (await multiplayer("deletePreset", { name: p.name })).presets; drawModes(); }));
    const tools = document.createElement("span");
    tools.className = "tools";
    tools.append(edit, drop);
    li.append(b, tools);
    return li;
  }));
  el.presetList.replaceChildren(...PRESETS.map((id) => {
    const li = document.createElement("li");
    const kinds = PRESET_KINDS[id];
    const b = card(t(`multi.preset.${id}`), kinds ? chipsOf(kinds) : [t("multi.potatoChip")], kinds ? metaOf(kinds) : t("multi.potatoMeta"));
    b.dataset.preset = id;
    b.addEventListener("click", () => {
      if (room?.presetId !== id) act(() => multiplayer("configure", { room: roomId, presetId: id }));
    });
    li.append(b);
    return li;
  }));
  render();
}

function iconButton(paths, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn";
  b.innerHTML = svg(paths); // static markup from the constants above, never data
  b.setAttribute("aria-label", label);
  b.title = label;
  b.addEventListener("click", onClick);
  return b;
}

/** "Bandeira ×3", one chip per kind in the order dealt; a card of every kind says so instead. */
function chipsOf(kinds) {
  const counts = new Map();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  if (counts.size >= 5) return [t("multi.allKinds")];
  return [...counts].map(([k, n]) => capitalised(t(`kindName.${k}`)) + (n > 1 ? ` ×${n}` : ""));
}

/** How long a card takes: each challenge's clock (lib/multiplayer.ts `secondsFor`) plus its 5 s reveal. */
const minutesOf = (kinds) => Math.max(1, Math.round(kinds.reduce((sum, k) => sum + (k === "flagPick" || k === "shapePick" ? 20 : 45) + 5, 0) / 60));
const metaOf = (kinds, regions = REGIONS) => t("multi.meta", { n: kinds.length, min: minutesOf(kinds) })
  + (regions.length < REGIONS.length ? ` · ${whereOf(regions)}` : "");

// ---------------------------------------------------------------------------
// A custom game (FR-12.10, D-106): kinds in order, a shuffle, continents
// ---------------------------------------------------------------------------

const capitalised = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const whereOf = (regions) => (regions.length === REGIONS.length ? t("multi.allContinents")
  : REGIONS.filter((r) => regions.includes(r)).map((r) => t(`continentName.${r}`)).join(", "));
const customAbout = (g) => t("multi.customAbout", { n: g.kinds.length, where: whereOf(g.regions) });
const sameGame = (a, b) => JSON.stringify([a.kinds, a.shuffled, a.regions]) === JSON.stringify([b.kinds, b.shuffled, b.regions]);
/** A draft that is one of my saved games, unchanged, plays under its name; anything else is "personalizado". */
const asPlayed = () => ({ ...draft, name: saved.find((p) => sameGame(p, draft))?.name ?? null });

function showTab(which) {
  tab = which;
  el.tabPresets.setAttribute("aria-selected", String(tab === "presets"));
  el.tabCustom.setAttribute("aria-selected", String(tab === "custom"));
  el.modes.hidden = tab !== "presets";
  el.custom.hidden = tab !== "custom";
  if (tab === "custom") drawCustom();
  render();
}
el.tabPresets.addEventListener("click", () => showTab("presets"));
el.tabCustom.addEventListener("click", () => showTab("custom"));

function drawCustom() {
  if (!continents) {
    continents = multiSelect({
      label: t("multi.continents"),
      options: REGIONS.map((r) => ({ value: r, text: t(`continentName.${r}`) })),
      summary: (regions) => (regions.length === REGIONS.length ? t("multi.allShort") : whereOf(regions)),
      onChange: (regions) => { draft.regions = regions; render(); },
    });
    el.continentsBox.append(continents.node);
  }
  continents.set(draft.regions);
  el.shuffle.checked = draft.shuffled;
  el.slotsCount.textContent = t("multi.slots", { n: draft.kinds.length, max: MAX_SLOTS });
  const last = draft.kinds.length - 1;
  // Reorder by dragging a row by its grip, or with the arrow keys on the grip.
  const moveTo = (from, to) => {
    if (to < 0 || to > last || from === to) return;
    const [k] = draft.kinds.splice(from, 1);
    draft.kinds.splice(to, 0, k);
    drawCustom();
    render();
  };
  const rows = draft.kinds.map((kind, i) => {
    const li = document.createElement("li");
    li.className = "slot-row";
    li.draggable = true;
    li.addEventListener("dragstart", (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); li.classList.add("dragging"); });
    li.addEventListener("dragend", () => { dragFrom = null; li.classList.remove("dragging"); });
    li.addEventListener("dragover", (e) => { if (dragFrom === null) return; e.preventDefault(); li.classList.toggle("over", dragFrom !== i); });
    li.addEventListener("dragleave", () => li.classList.remove("over"));
    li.addEventListener("drop", (e) => { e.preventDefault(); if (dragFrom !== null) moveTo(dragFrom, i); });
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "grip";
    grip.innerHTML = svg(GRIP);
    grip.setAttribute("aria-label", t("multi.move", { n: i + 1 }));
    grip.addEventListener("keydown", (e) => {
      const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : null;
      if (to === null) return;
      e.preventDefault();
      moveTo(i, to);
      el.slots.children[to]?.querySelector(".grip")?.focus();
    });
    const n = Object.assign(document.createElement("span"), { className: "n", textContent: String(i + 1) });
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.innerHTML = svg(ICONS[kind] ?? ICONS.default);
    const pick = document.createElement("select");
    pick.setAttribute("aria-label", t("multi.slot", { n: i + 1 }));
    pick.append(...KINDS.map((k) => new Option(capitalised(t(`kindName.${k}`)), k, false, k === kind)));
    pick.addEventListener("change", () => { draft.kinds[i] = pick.value; glyph.innerHTML = svg(ICONS[pick.value] ?? ICONS.default); render(); });
    const drop = iconButton(X, t("multi.drop", { n: i + 1 }), () => { draft.kinds.splice(i, 1); drawCustom(); render(); });
    drop.disabled = last === 0;
    li.append(grip, n, glyph, pick, drop);
    return li;
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add-slot";
  add.innerHTML = svg(PLUS);
  add.append(t("multi.addSlot"));
  add.disabled = draft.kinds.length >= MAX_SLOTS;
  add.addEventListener("click", () => { draft.kinds.push(draft.kinds.at(-1) ?? "flag"); drawCustom(); render(); });
  const addRow = document.createElement("li");
  addRow.append(add);
  el.slots.replaceChildren(...rows, addRow);
  const isNew = !saved.some((p) => p.name.trim().toLowerCase() === el.presetName.value.trim().toLowerCase());
  const full = isNew && saved.length >= MAX_SAVED;
  el.savedFull.hidden = !full;
  el.saveForm.querySelector("button").disabled = full;
  el.savedFull.textContent = t("multi.savedFull", { max: MAX_SAVED });
}

el.shuffle.addEventListener("change", () => { draft.shuffled = el.shuffle.checked; render(); });
el.presetName.addEventListener("input", () => drawCustom());
el.saveForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = el.presetName.value.trim();
  if (!name) return;
  act(async () => {
    saved = (await multiplayer("savePreset", { preset: { ...draft, name } })).presets;
    drawModes();
    drawCustom();
    return true;
  }).then((done) => { if (done) setStatus(t("multi.savedOk", { name })); });
});

// ---------------------------------------------------------------------------
// Join and listen
// ---------------------------------------------------------------------------

async function join() {
  setStatus(t("loading"));
  try {
    const r = await multiplayer("join", { room: roomId });
    mine = r.mine;
    saved = r.presets ?? [];
    drawModes();
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
    if (gameKey !== null && game !== null) { prompts.clear(); mine = null; potato?.reset(); railPoints.clear(); mapOpen = false; }
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

/** The link is the room (D-87): copying it is how a room fills, so the button says it worked. */
let copiedTimer = null;
el.copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(location.href.split("#")[0]); }
  catch { return setStatus(location.href.split("#")[0]); }
  el.copy.classList.add("copied");
  el.copyLabel.textContent = t("multi.copiedBtn");
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { el.copy.classList.remove("copied"); el.copyLabel.textContent = t("multi.copy"); }, 2000);
});

// A phone's lobby is two tabs (the room, the next game); a desktop shows both.
el.rtabRoom.addEventListener("click", () => { phoneTab = "room"; render(); });
el.rtabNext.addEventListener("click", () => { phoneTab = "next"; render(); });

// Between games the last Batata Quente's map is a click away, not under everything.
el.showMap.addEventListener("click", () => { mapOpen = true; render(); });
el.hideMap.addEventListener("click", () => { mapOpen = false; render(); });

// In Personalizar the one start button is "Jogar": it sets the room to the draft, then starts it (FR-12.10).
el.start.addEventListener("click", () => act(async () => {
  if (tab === "custom") await multiplayer("configure", { room: roomId, custom: asPlayed() });
  await multiplayer("start", { room: roomId });
}));
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
  if (!open) railPoints.set(c.index, c.progress[auth.currentUser?.uid]?.points ?? 0);
  renderRail(c);
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

/** The card down the side: each challenge by kind (never by answer), mine scored once it closed. */
function renderRail(c) {
  el.railSteps.replaceChildren(...c.kinds.map((kind, i) => {
    const li = document.createElement("li");
    li.className = i < c.index ? "done" : i === c.index ? "now" : "next";
    if (i === c.index) li.setAttribute("aria-current", "step");
    const n = Object.assign(document.createElement("span"), { className: "n", textContent: String(i + 1) });
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.innerHTML = svg(ICONS[kind] ?? ICONS.default);
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: capitalised(t(`kindName.${kind}`)) });
    const pts = railPoints.get(i);
    const score = Object.assign(document.createElement("span"), { className: "pts", textContent: pts === undefined ? "" : pts > 0 ? `+${pts}` : "0" });
    li.append(n, glyph, name, score);
    return li;
  }));
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
  el.boardTitle.textContent = room.state === "lobby" ? t("multi.playersTitle") : t("multi.board");
  el.boardCount.textContent = room.state === "playing" ? "" : t("multi.seats", { n: room.playerUids.length });
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
    name.textContent = p.name;
    const who = document.createElement("span");
    who.className = "who";
    who.append(name);
    // The host wears a crown rather than a word: it reads at a glance on a full board.
    if (p.uid === room.hostUid && !playing) {
      const crown = document.createElement("span");
      crown.className = "crown";
      crown.setAttribute("role", "img");
      crown.setAttribute("aria-label", t("multi.host"));
      crown.title = t("multi.host");
      crown.innerHTML = CROWN;
      who.append(crown);
    }
    // Clássico, mid-game: where each player is on the challenge — counts only, never a guess.
    const prog = room.mode === "classic" && room.state === "playing" ? room.classic.progress[p.uid] : null;
    if (prog) {
      const sub = document.createElement("span");
      sub.className = `sub${prog.done && prog.solved ? " ok" : ""}`;
      sub.textContent = prog.done ? t(prog.solved ? "multi.statusSolved" : "multi.statusMissed")
        : prog.guesses ? t("multi.tries", { n: prog.guesses }) : t("multi.statusIdle");
      who.append(sub);
    }
    const right = document.createElement("span");
    right.className = "score";
    if (playing) right.textContent = String(p.points);
    li.append(dot, who);
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
      li.append(iconButton(X, t("multi.remove", { name: p.name }), () => act(() => multiplayer("remove", { room: roomId, uid: p.uid }))));
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
  if (!room) { document.body.classList.remove("room-lobby", "room-classic", "map-open"); return; }
  const uid = user?.uid;
  const inRoom = room.playerUids.includes(uid);
  const host = room.hostUid === uid;

  const between = room.state === "lobby" || (room.state === "finished" && !training);
  const classic = room.state === "playing" && room.mode === "classic";
  // The room fills the window between games and through a Clássico; only its panels scroll.
  document.body.classList.toggle("room-lobby", Boolean(user && between));
  document.body.classList.toggle("room-classic", Boolean(user && classic));
  document.body.classList.toggle("room-host", host);
  document.body.classList.toggle("map-open", between && mapOpen && Boolean(room.potato));
  document.body.classList.toggle("tab-room", phoneTab === "room");
  el.roomTabs.hidden = !between;
  el.rtabRoom.textContent = t("multi.playersTab", { n: room.playerUids.length });
  el.rtabRoom.setAttribute("aria-selected", String(phoneTab === "room"));
  el.rtabNext.setAttribute("aria-selected", String(phoneTab === "next"));

  el.roomHead.hidden = el.leave.hidden = !between;
  el.roomName.textContent = t("multi.roomOf", { name: room.players[room.hostUid]?.name ?? "" });
  el.lobby.hidden = !between;
  el.go.hidden = !(between && host);
  if (between) {
    const custom = room.presetId === "custom" && room.custom;
    const title = custom ? room.custom.name ?? t("multi.preset.custom") : t(`multi.preset.${room.presetId}`);
    const kinds = custom ? room.custom.kinds : PRESET_KINDS[room.presetId] ?? null;
    // FR-12.7: the host picks; everyone else reads what was picked, large.
    el.picker.hidden = !host;
    el.lobbyView.hidden = host;
    el.lobbyTitle.textContent = title;
    el.lobbyMode.textContent = custom ? `${t("multi.classic")} · ${metaOf(room.custom.kinds, room.custom.regions)}`
      : kinds ? `${t(`multi.presetAbout.${room.presetId}`)} ${metaOf(kinds)}` : t(`multi.presetAbout.${room.presetId}`);
    el.lobbyWait.textContent = t("multi.waitHost", { name: room.players[room.hostUid]?.name ?? "" });
    el.lobbyWaitDot.style.background = room.players[room.hostUid]?.color ?? "";
    el.lobbyOrder.hidden = !kinds;
    el.lobbyOrder.replaceChildren(...(kinds ?? []).map((kind, i) => {
      const li = document.createElement("li");
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.innerHTML = svg(ICONS[kind] ?? ICONS.default);
      li.append(glyph, Object.assign(document.createElement("span"), { className: "n", textContent: String(i + 1) }),
        Object.assign(document.createElement("span"), { className: "name", textContent: capitalised(t(`kindName.${kind}`)) }));
      return li;
    }));
    if (host) {
      // Only what calls the server waits on it; the slot buttons edit a draft and keep their own limits.
      for (const b of el.picker.querySelectorAll(".seg button, #modes button")) b.disabled = busy;
      for (const b of el.modes.querySelectorAll("button[data-preset]")) b.setAttribute("aria-pressed", String(b.dataset.preset === room.presetId));
      for (const b of el.modes.querySelectorAll("button[data-saved]")) {
        const p = saved.find((x) => x.name === b.dataset.saved);
        b.setAttribute("aria-pressed", String(Boolean(custom && p && room.custom.name === p.name && sameGame(room.custom, p))));
      }
      // "A seguir": the room's pick, or the draft being built.
      const drafting = tab === "custom";
      const dName = asPlayed().name;
      el.goTitle.textContent = drafting ? dName ?? t("multi.preset.custom") : title;
      el.goKinds.replaceChildren(...chipRow(drafting ? chipsOf(draft.kinds) : kinds ? chipsOf(kinds) : [t("multi.potatoChip")]).children);
      el.goAbout.textContent = drafting ? metaOf(draft.kinds, draft.regions) + (draft.shuffled ? ` · ${t("multi.shuffled")}` : "")
        : custom ? metaOf(room.custom.kinds, room.custom.regions) : t(`multi.presetAbout.${room.presetId}`);
      el.saveForm.hidden = !drafting;
      if (!drafting) el.savedFull.hidden = true;
      const enough = room.playerUids.length >= 2;
      el.start.disabled = !enough || busy;
      el.start.textContent = drafting ? t("multi.play") : room.state === "finished" ? t("multi.again") : t("multi.start");
      el.lobbyHint.textContent = !enough ? t("multi.needPlayers") : drafting ? t("multi.secretDeal") : t("multi.readyHost");
    }
  }

  el.rail.hidden = !classic;
  el.classic.hidden = !classic;
  // The map: the game itself while it runs; between games, only once asked for.
  el.potato.hidden = !(room.potato && (room.state === "playing" || training || (between && mapOpen)));
  el.hideMap.hidden = !(between && mapOpen);
  $("potato-head").hidden = !room.potato || between;
  if (classic) { countries(); renderClassic(); }
  if (room.potato) potatoView().render(room);

  el.finished.hidden = room.state !== "finished";
  el.againRow.hidden = !training; // a room's way on is its lobby (D-104)
  el.showMap.hidden = !(between && room.state === "finished" && room.potato) || mapOpen;
  if (room.state === "finished") {
    const [top, second] = standings();
    // D-105: a tie at the top is a draw, as the trophies count it — the clock orders the board, it does not win.
    el.finishedText.textContent = !inRoom || !top ? t("multi.over")
      : second && second.points === top.points ? t("multi.draw", { points: top.points })
      : top.uid === uid ? t("multi.youWon", { points: top.points }) : t("multi.won", { name: top.name, points: top.points });
    el.finishedSub.textContent = room.potato
      ? `${t("multi.preset.mundo")} · ${t(`multi.end.${room.potato.endReason}`)}`
      : room.classic ? `${t("multi.classic")} · ${t("multi.meta", { n: room.classic.kinds.length, min: minutesOf(room.classic.kinds) })}` : "";
    if (training) renderSoloEnd();
  }

  renderBoard();
  drawClock();
}
