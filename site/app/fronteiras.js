// Fronteiras — FR-15. Two players, one continent, no dice; a room of sala.html.
//
// The board arrives once, as `rooms/{id}/map/_board` (D-109): outlines, dots,
// adjacency and where each numeral sits. The game itself is the room document's
// `fronteiras` field, perfect information, and every move is a callable the
// server judges (lib/fronteiras.ts). What this file computes — which territories
// are legal targets and what they cost — is for DRAWING only: `costOf` below
// mirrors the server's so the chips and the button say the right thing, and a
// move the server refuses is refused whatever this said.
//
// The entry (`sala?jogo=fronteiras`) is here too: find an opponent, challenge by
// link, play the bot, or read the ranking — which is fetched only when opened.

import { loadCountries } from "./autocomplete.js";
import { mountZoom } from "./potato.js";
import { errorMessage, t } from "./i18n.js";

const SVG = "http://www.w3.org/2000/svg";
export const BOT_UID = "~bot";
/** lib/fronteiras.ts, for drawing. The server's own constants decide. */
const RULES = { turns: 30, fortify: 2, capitalDefence: 12, trucePlies: 4, capitalMin: 2, picks: 3 };
/** D-111: the queue slot goes stale after 25 s without a poll. */
const POLL_MS = 10_000;
const BOT_OFFER_MS = 30_000;

const node = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const svgNode = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** Names for the chips and the bar: the public list the autocomplete loads. */
let names = null;
const namesReady = () => (names ??= loadCountries()
  .then((list) => new Map(list.map((c) => [c.code, c.pt])))
  .catch(() => { names = null; return new Map(); }));

// ---------------------------------------------------------------------------
// The rules, mirrored for display (lib/fronteiras.ts `draftable`, `costOf`)
// ---------------------------------------------------------------------------

const seatOf = (s, uid) => (s.order[0] === uid ? 0 : s.order[1] === uid ? 1 : -1);
const touches = (s, adj, seat, code) => (adj[code] ?? []).some((n) => s.owner[n] === seat);
const held = (s, seat) => Object.entries(s.owner).filter(([, o]) => o === seat);
const valueOf = (s, seat) => held(s, seat).reduce((n, [c]) => n + (s.values[c] ?? 0), 0);

function draftable(s, adj, seat) {
  const free = Object.keys(s.values).filter((c) => s.owner[c] === undefined);
  let ok = free.filter((c) => !touches(s, adj, 1 - seat, c));
  if (s.capital[seat] === null) {
    const roomy = ok.filter((c) => (adj[c] ?? []).length >= RULES.capitalMin);
    if (roomy.length) ok = roomy;
  }
  return new Set(ok.length ? ok : free);
}

/** The one action `code` offers `seat` now: `{ t, cost }` (cost null when it is not a move) . */
function offerOf(s, adj, seat, code, pickable) {
  const owner = s.owner[code];
  const value = s.values[code];
  if (s.phase === "draft") return { t: "pick", cost: owner === undefined && pickable.has(code) ? 0 : null };
  if (owner === undefined) return { t: "take", cost: touches(s, adj, seat, code) ? value : null };
  if (owner === seat) return { t: "fortify", cost: RULES.fortify };
  const ok = touches(s, adj, seat, code) && s.ply >= RULES.trucePlies;
  return { t: "attack", cost: ok ? value + (s.fort[code] ?? 0) + (s.capital[owner] === code ? RULES.capitalDefence : 0) : null };
}

/** Why a territory is not a move, in words. */
function whyNot(s, adj, seat, code, offer) {
  if (s.owner[code] !== undefined && s.phase === "draft") return t("fronteiras.why.owned");
  if (offer.t === "pick") return s.capital[seat] === null && (adj[code] ?? []).length < RULES.capitalMin ? t("fronteiras.why.capital") : t("fronteiras.why.near");
  if (offer.t === "attack" && s.ply < RULES.trucePlies) return t("fronteiras.why.truce");
  return t("fronteiras.why.border");
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export function mountFronteiras({ multiplayer, me, confirm, roomId, serverNow, setStatus }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    section: $("fronteiras"), seats: $("fr-seats"), banner: $("fr-banner"), chipsTitle: $("fr-chips-title"), chips: $("fr-chips"),
    giveUp: $("fr-giveup"), wrap: $("fr-wrap"), world: $("fr-map"), terr: $("fr-terr"), labels: $("fr-labels"), zoomHint: $("fr-zoom-hint"),
    bar: $("fr-bar"), selName: $("fr-sel-name"), selMeta: $("fr-sel-meta"), act: $("fr-act"), pass: $("fr-pass"),
    result: $("fr-result"), resultText: $("fr-result-text"), resultSub: $("fr-result-sub"), resultRatings: $("fr-result-ratings"),
    wait: $("fr-wait"), waitTitle: $("fr-wait-title"), waitTime: $("fr-wait-time"), waitLink: $("fr-wait-link"), waitBot: $("fr-wait-bot"),
    copy: $("fr-copy"), copyLabel: $("fr-copy-label"),
  };
  let room = null;
  let board = null;
  let selected = null;
  let busy = false;
  let pollTimer = 0;
  let waitTimer = 0;
  let nameMap = new Map();
  const shapes = new Map();   // code → the path or dot
  const marks = new Map();    // code → the label group
  namesReady().then((m) => { nameMap = m; if (room) render(room); });
  const nameOf = (code) => nameMap.get(code) ?? code;

  const zoom = mountZoom({
    ...el, active: () => document.body.classList.contains("fr-room"),
    zoomIn: $("fr-zoom-in"), zoomOut: $("fr-zoom-out"), zoomFit: $("fr-zoom-fit"),
  });

  // -------------------------------------------------------------- the board

  /** `map/_board`, once (D-109). Drawn in neutral grey; `paint` colours it from the room. */
  function onBoard(b) {
    board = b;
    el.terr.replaceChildren();
    el.labels.replaceChildren();
    shapes.clear();
    marks.clear();
    for (const code of Object.keys(b.paths).sort()) {
      const p = b.paths[code];
      const shape = p.d ? svgNode("path", { d: p.d, "fill-rule": "evenodd" }) : svgNode("circle", { cx: p.dot[0], cy: p.dot[1], r: 1 });
      shape.setAttribute("class", `t${p.d ? "" : " dot"}`);
      shape.dataset.code = code;
      el.terr.append(shape);
      shapes.set(code, shape);
      const at = b.labels[code] ?? p.dot;
      if (!at) continue;
      const g = svgNode("g", { class: "mark" });
      g.dataset.x = at[0];
      g.dataset.y = at[1];
      marks.set(code, g);
      el.labels.append(g);
    }
    // Microstates last, so a dot is never under a neighbour's outline.
    for (const s of el.terr.querySelectorAll(".dot")) el.terr.append(s);
    zoom.base(b.viewBox);
    rescale();
    if (room) render(room);
  }

  /**
   * Dots, numerals and pips keep their size in SCREEN pixels whatever the zoom
   * (R-4: a dot is never under 6 px), so they are scaled by the units per pixel.
   */
  function rescale() {
    const vb = el.world.getAttribute("viewBox")?.split(/\s+/).map(Number);
    const w = el.world.clientWidth, h = el.world.clientHeight;
    if (!vb || !w || !h) return;
    const u = Math.max(vb[2] / w, vb[3] / h);
    for (const s of el.terr.querySelectorAll(".dot")) s.setAttribute("r", String(3.5 * u));
    for (const g of marks.values()) g.setAttribute("transform", `translate(${g.dataset.x} ${g.dataset.y}) scale(${u})`);
  }
  new MutationObserver(rescale).observe(el.world, { attributes: true, attributeFilter: ["viewBox"] });
  new ResizeObserver(rescale).observe(el.wrap);

  // A click selects; a drag that panned the map does not.
  let downAt = null;
  el.wrap.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
  el.wrap.addEventListener("click", (e) => {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    const code = e.target.closest?.(".t")?.dataset.code;
    if (code) select(code);
  });

  function select(code) {
    selected = selected === code ? null : code;
    render(room);
  }

  // -------------------------------------------------------------- the state

  const s = () => room?.fronteiras ?? null;
  const mySeat = () => (s() ? seatOf(s(), me()) : -1);
  const myTurn = () => Boolean(s() && !s().result && room.state === "playing" && s().turnUid === me());
  /** Every code that is a move for me now, affordable, with its offer. */
  function legal() {
    const st = s();
    const out = new Map();
    if (!st || !board || !myTurn()) return out;
    const seat = mySeat();
    const pickable = st.phase === "draft" ? draftable(st, board.adj, seat) : null;
    for (const code of Object.keys(st.values)) {
      const o = offerOf(st, board.adj, seat, code, pickable);
      if (o.cost !== null && o.cost <= st.gold[seat]) out.set(code, o);
    }
    return out;
  }

  async function send(action) {
    if (busy) return;
    busy = true;
    render(room);
    try {
      await multiplayer("move", { room: roomId, action });
      selected = null;
      setStatus("");
    } catch (err) {
      const code = err?.details?.code;
      // The server's clock passed the deadline first: settle the turn (FR-15.6).
      if (code === "deadline-passed") multiplayer("tick", { room: roomId }).catch(() => {});
      else setStatus(errorMessage(err, "fronteiras"), "err");
    } finally {
      busy = false;
      render(room);
    }
  }

  el.act.addEventListener("click", () => {
    const o = selected && legal().get(selected);
    if (o) send({ t: o.t, code: selected });
  });
  el.pass.addEventListener("click", () => send({ t: "pass" }));
  el.giveUp.addEventListener("click", async () => {
    const draft = s()?.phase === "draft";
    if (!(await confirm(t(draft ? "fronteiras.confirmAbort" : "fronteiras.confirmResign")))) return;
    try { await multiplayer("giveUp", { room: roomId }); }
    catch (err) { setStatus(errorMessage(err, "fronteiras"), "err"); }
  });

  // -------------------------------------------------------------- waiting

  /** The link is the challenge (FR-15.9): copying it says it worked. */
  let copiedTimer = 0;
  const link = () => `${location.origin}${location.pathname}?s=${roomId}`;
  el.copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(link()); }
    catch { return setStatus(link()); }
    el.copy.classList.add("copied");
    el.copyLabel.textContent = t("multi.copiedBtn");
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { el.copy.classList.remove("copied"); el.copyLabel.textContent = t("multi.copy"); }, 2000);
  });
  el.waitBot.addEventListener("click", () => go(() => multiplayer("bot")));

  /** Every entry op answers with a room: the one to be in (a match, a settled game, the same slot). */
  async function go(op) {
    if (busy) return;
    busy = true;
    try {
      const r = await op();
      if (r.room !== roomId) location.replace(`./sala?s=${r.room}`);
    } catch (err) {
      if (err?.details?.room && err.details.room !== roomId) return location.replace(`./sala?s=${err.details.room}`);
      setStatus(errorMessage(err, "fronteiras"), "err");
    } finally { busy = false; }
  }

  /** D-111: the waiting player's own room is the slot, kept alive by a poll every 10 s. */
  function poll() {
    clearTimeout(pollTimer);
    if (room?.state !== "lobby" || !room.queue) return;
    const due = Math.max(0, room.queue.seenAt + POLL_MS - serverNow());
    pollTimer = setTimeout(() => go(() => multiplayer("queue")), due);
  }

  function renderWait() {
    const queued = Boolean(room.queue);
    el.waitTitle.textContent = t(queued ? "fronteiras.searching" : "fronteiras.challengeOpen");
    el.waitLink.hidden = queued;
    poll();
    tickWait();
    clearInterval(waitTimer);
    waitTimer = setInterval(tickWait, 1000);
  }

  /** How long the slot has waited; the bot is offered at 30 s (FR-15.10). */
  function tickWait() {
    if (room?.state !== "lobby") return clearInterval(waitTimer);
    const waited = room.queue ? serverNow() - room.queue.since : null;
    el.waitTime.textContent = waited === null ? t("fronteiras.waitLink") : t("fronteiras.waited", { time: mmss(waited) });
    el.waitBot.hidden = waited === null || waited < BOT_OFFER_MS;
  }

  // -------------------------------------------------------------- render

  function render(next) {
    room = next;
    const st = s();
    const lobby = room.state === "lobby";
    el.wait.hidden = !lobby;
    el.section.hidden = lobby || !st;
    if (lobby) return renderWait();
    clearTimeout(pollTimer);
    clearInterval(waitTimer);
    // A slot closed when its player was matched elsewhere: no game was ever here.
    if (!st) return setStatus(t("fronteiras.closed"), "warn");
    const over = Boolean(st.result) || room.state === "finished";
    const seat = mySeat();
    const moves = legal();
    if (selected && !st.values[selected]) selected = null;

    paint(st, moves);
    renderSeats(st);
    renderBanner(st, seat, over);
    renderChips(moves, over);
    renderBar(st, seat, moves, over);
    renderResult(st, over);
    el.giveUp.hidden = over || seat === -1;
    el.giveUp.textContent = t(st.phase === "draft" ? "fronteiras.abort" : "fronteiras.resign");
  }

  function paint(st, moves) {
    for (const [code, shape] of shapes) {
      const o = st.owner[code];
      const uid = o === undefined ? null : st.order[o];
      shape.style.fill = uid ? room.players[uid]?.color ?? "" : "";
      shape.classList.toggle("owned", Boolean(uid));
      shape.classList.toggle("can", moves.has(code));
      shape.classList.toggle("sel", code === selected);
      const title = shape.querySelector("title") ?? shape.appendChild(svgNode("title"));
      title.textContent = `${nameOf(code)} · ${st.values[code] ?? "?"}`;
    }
    if (selected) shapes.get(selected)?.parentNode.append(shapes.get(selected)); // its outline on top
    for (const [code, g] of marks) {
      const cap = st.capital.indexOf(code);
      const pips = Math.min(st.fort[code] ?? 0, 6);
      const kids = [];
      if (cap !== -1 && st.owner[code] === cap) {
        kids.push(svgNode("circle", { r: 8.5, class: "cap", style: `stroke:${room.players[st.order[cap]]?.color ?? "currentColor"}` }));
      }
      const num = svgNode("text", { class: "num", y: 3.5 });
      num.textContent = String(st.values[code] ?? "");
      kids.push(num);
      for (let i = 0; i < pips; i++) kids.push(svgNode("circle", { class: "pip", r: 1.6, cx: (i - (pips - 1) / 2) * 4.2, cy: 11 }));
      g.replaceChildren(...kids);
    }
  }

  function renderSeats(st) {
    el.seats.replaceChildren(...st.order.map((uid, i) => {
      const p = room.players[uid] ?? { name: "?", color: "" };
      const li = node("li", "fr-seat");
      li.dataset.uid = uid;
      li.style.setProperty("--c", p.color);
      li.classList.toggle("turn", st.turnUid === uid && !st.result);
      li.classList.toggle("me", uid === me());
      const dot = node("span", "dot");
      dot.style.background = p.color;
      // FR-13: a person's name opens their profile once the game is over; the bot is never a profile (D-113).
      const linked = room.state === "finished" && uid !== BOT_UID;
      const name = node(linked ? "a" : "span", "name", uid === me() ? t("fronteiras.you", { name: p.name }) : p.name);
      if (linked) Object.assign(name, { href: `./perfil?u=${encodeURIComponent(uid)}`, target: "_blank", rel: "noopener" });
      const clock = node("span", "clock");
      clock.dataset.uid = uid;
      const terr = held(st, i).length;
      const vars = { gold: st.gold[i], income: terr, value: valueOf(st, i) };
      const stats = node("span", "stats", t("fronteiras.stats", vars));
      stats.title = t("fronteiras.statsLong", vars);
      li.append(dot, name, clock, stats);
      return li;
    }));
    drawClock();
  }

  /** Two clocks from the server's deadline (FR-15.6); the draft's is the pick's 30 s. */
  function drawClock() {
    const st = s();
    if (!st) return;
    const now = serverNow();
    for (const c of el.seats.querySelectorAll(".clock")) {
      const uid = c.dataset.uid;
      if (uid === BOT_UID) { c.textContent = "—"; continue; }
      const running = !st.result && st.turnUid === uid && room.state === "playing";
      const left = running ? st.deadline - now : st.clock[uid] ?? 0;
      c.textContent = mmss(left);
      c.classList.toggle("low", running && left < 20_000);
    }
  }

  function renderBanner(st, seat, over) {
    let text;
    if (over) text = "";
    else if (st.phase === "draft") {
      const mine = held(st, seat).length + 1;
      text = st.turnUid === me()
        ? st.capital[seat] === null ? t("fronteiras.pickCapital") : t("fronteiras.pickN", { n: mine, of: RULES.picks })
        : t("fronteiras.theyPick", { name: room.players[st.turnUid]?.name ?? "" });
    } else {
      const turn = Math.min(RULES.turns, Math.floor(st.ply / 2) + 1);
      const who = st.turnUid === me() ? t("fronteiras.yourTurn") : t("fronteiras.theirTurn", { name: room.players[st.turnUid]?.name ?? "" });
      text = `${t("fronteiras.turnOf", { n: turn, of: RULES.turns })} · ${who}` + (st.ply < RULES.trucePlies ? ` · ${t("fronteiras.truce")}` : "");
    }
    el.banner.textContent = text;
    el.banner.classList.toggle("mine", myTurn());
  }

  /** R-4: every legal target as a chip, in a box that scrolls on its own. */
  function renderChips(moves, over) {
    el.chips.hidden = el.chipsTitle.hidden = over;
    if (over) return;
    el.chipsTitle.textContent = myTurn() ? t("fronteiras.chips", { n: moves.size }) : t("fronteiras.chipsWait");
    const codes = [...moves.keys()].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "pt-BR"));
    el.chips.replaceChildren(...codes.map((code) => {
      const o = moves.get(code);
      const li = node("li");
      const b = node("button", `fr-chip ${o.t}`);
      b.type = "button";
      b.dataset.code = code;
      b.setAttribute("aria-pressed", String(code === selected));
      b.append(node("span", "n", nameOf(code)), node("span", "c", o.t === "pick" ? String(s().values[code]) : `${t(`fronteiras.short.${o.t}`)} ${o.cost}`));
      b.addEventListener("click", () => select(code));
      li.append(b);
      return li;
    }));
  }

  function renderBar(st, seat, moves, over) {
    el.bar.hidden = over || seat === -1;
    if (el.bar.hidden) return;
    const code = selected;
    el.pass.hidden = st.phase !== "play";
    el.pass.disabled = !myTurn() || busy;
    if (!code) {
      el.selName.textContent = t("fronteiras.noSelection");
      el.selMeta.textContent = myTurn() ? t("fronteiras.noSelectionHint") : "";
      el.act.textContent = t(st.phase === "draft" ? "fronteiras.do.pick" : "fronteiras.do.none");
      el.act.disabled = true;
      return;
    }
    const owner = st.owner[code];
    const whose = owner === undefined ? t("fronteiras.neutral") : owner === seat ? t("fronteiras.yours") : room.players[st.order[owner]]?.name ?? "";
    const facts = [whose, t("fronteiras.value", { n: st.values[code] })];
    if (st.fort[code]) facts.push(t("fronteiras.fort", { n: st.fort[code] }));
    if (st.capital.includes(code) && owner !== undefined) facts.push(t("fronteiras.capital"));
    el.selName.textContent = nameOf(code);
    const offer = offerOf(st, board?.adj ?? {}, seat, code, st.phase === "draft" ? draftable(st, board?.adj ?? {}, seat) : null);
    const label = offer.t === "pick"
      ? t(st.capital[seat] === null ? "fronteiras.do.capital" : "fronteiras.do.pick")
      : t(`fronteiras.do.${offer.t}`, { n: offer.cost ?? "" });
    el.act.textContent = label;
    el.act.disabled = !moves.has(code) || busy;
    let why = "";
    if (myTurn() && !moves.has(code)) {
      why = offer.cost === null ? whyNot(st, board?.adj ?? {}, seat, code, offer) : t("fronteiras.why.gold", { n: offer.cost - st.gold[seat] });
    }
    el.selMeta.textContent = [facts.join(" · "), why].filter(Boolean).join(" — ");
  }

  function renderResult(st, over) {
    el.result.hidden = !over || !st.result;
    if (el.result.hidden) return;
    const r = st.result;
    const name = (uid) => room.players[uid]?.name ?? "";
    const loser = r.winner ? st.order.find((u) => u !== r.winner) : null;
    el.resultText.textContent = r.reason === "abort" ? t("fronteiras.end.aborted")
      : r.winner === null ? t("fronteiras.end.draw")
      : r.winner === me() ? t("fronteiras.end.youWon") : t("fronteiras.end.won", { name: name(r.winner) });
    const sub = r.reason === "turns"
      ? t("fronteiras.reason.turns", { a: valueOf(st, 0), b: valueOf(st, 1) })
      : t(`fronteiras.reason.${r.reason}`, { name: name(loser) });
    el.resultSub.textContent = sub;
    const rows = Object.entries(r.ratings ?? {}).map(([uid, x]) => {
      const li = node("li");
      const d = Math.round(x.after) - Math.round(x.before);
      li.append(node("span", "name", name(uid)), node("span", "was", String(Math.round(x.before))), node("span", "now", String(Math.round(x.after))),
        node("span", `delta ${d > 0 ? "up" : d < 0 ? "down" : ""}`, d > 0 ? `+${d}` : String(d)));
      return li;
    });
    el.resultRatings.replaceChildren(...rows);
    if (!rows.length && r.reason !== "abort") {
      el.resultRatings.append(node("li", "fine", t(st.order.includes(BOT_UID) ? "fronteiras.unratedBot" : "fronteiras.unrated")));
    }
  }

  return { onBoard, render, drawClock };
}

// ---------------------------------------------------------------------------
// The entry: sala?jogo=fronteiras (FR-15.1, FR-15.9, FR-15.12)
// ---------------------------------------------------------------------------

export function mountFronteirasEntry({ multiplayer, me }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    queue: $("fr-queue"), challenge: $("fr-challenge"), bot: $("fr-bot"), msg: $("fr-msg"),
    tabPlay: $("fr-tab-play"), tabRank: $("fr-tab-rank"), play: $("fr-play"), rank: $("fr-rank"),
    scopeAll: $("fr-scope-all"), scopeGroups: $("fr-scope-groups"), list: $("fr-rank-list"), empty: $("fr-rank-empty"),
  };
  let busy = false;
  let scope = "all";
  const cache = new Map();
  const say = (text, cls = "") => { el.msg.textContent = text; el.msg.className = `fine ${cls}`; };

  async function go(op) {
    if (busy) return;
    busy = true;
    for (const b of [el.queue, el.challenge, el.bot]) b.disabled = true;
    say(t("loading"));
    try {
      const r = await multiplayer(op);
      location.href = `./sala?s=${r.room}`;
    } catch (err) {
      // One live game per account (D-112): the one already running is where to go.
      if (err?.details?.room) return void (location.href = `./sala?s=${err.details.room}`);
      say(errorMessage(err, "fronteiras"), "err");
      busy = false;
      for (const b of [el.queue, el.challenge, el.bot]) b.disabled = false;
    }
  }
  el.queue.addEventListener("click", () => go("queue"));
  el.challenge.addEventListener("click", () => go("challenge"));
  el.bot.addEventListener("click", () => go("bot"));

  function showTab(which) {
    el.tabPlay.setAttribute("aria-selected", String(which === "play"));
    el.tabRank.setAttribute("aria-selected", String(which === "rank"));
    el.play.hidden = which !== "play";
    el.rank.hidden = which !== "rank";
    if (which === "rank") loadRank();
  }
  el.tabPlay.addEventListener("click", () => { history.replaceState(null, "", "#"); showTab("play"); });
  el.tabRank.addEventListener("click", () => { history.replaceState(null, "", "#ranking"); showTab("rank"); });
  for (const [b, v] of [[el.scopeAll, "all"], [el.scopeGroups, "groups"]]) {
    b.addEventListener("click", () => { scope = v; loadRank(); });
  }

  /** FR-15.12: ≤ 100 reads a view (§7), so only when the tab is opened, once per scope. */
  async function loadRank() {
    el.scopeAll.setAttribute("aria-selected", String(scope === "all"));
    el.scopeGroups.setAttribute("aria-selected", String(scope === "groups"));
    if (!cache.has(scope)) cache.set(scope, multiplayer("ratings", { scope }).catch((err) => { cache.delete(scope); throw err; }));
    const want = scope;
    el.empty.hidden = false;
    el.empty.textContent = t("loading");
    el.list.replaceChildren();
    try {
      const { players } = await cache.get(want);
      if (want !== scope) return;
      el.empty.textContent = t(want === "groups" ? "fronteiras.rankEmptyGroups" : "fronteiras.rankEmpty");
      el.empty.hidden = players.length > 0;
      el.list.replaceChildren(...players.map((p, i) => {
        const li = node("li", p.uid === me() ? "me" : "");
        const a = node("a", "name", p.displayName);
        a.href = `./perfil?u=${encodeURIComponent(p.uid)}`;
        li.append(node("span", "rank", String(i + 1)), a, node("span", "rating", String(Math.round(p.rating))), node("span", "games", t("fronteiras.games", { n: p.games })));
        return li;
      }));
    } catch (err) {
      if (want === scope) el.empty.textContent = errorMessage(err, "fronteiras");
    }
  }

  showTab(location.hash === "#ranking" ? "rank" : "play");
}
