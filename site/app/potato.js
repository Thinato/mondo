// Batata Quente — FR-12.3. The map, the queue and the turn, for sala.html.
//
// The map arrives a piece at a time: the grey land when the game starts, then
// one document per country as it is named (D-89). The page never holds a map
// of its own — what it draws is exactly what this room has named, and that is
// all the server has sent it.
//
// There is no autocomplete here on purpose (D-90): one wrong letter is forgiven
// by the server, and suggestions would make that rule meaningless. What there
// is instead is a QUEUE — names typed while waiting, sent the instant the turn
// comes round. A pre-written hit lands with almost the whole clock left, which
// is worth almost the whole ten points: the strategy the mode is built around.

import { errorMessage, t } from "./i18n.js";

const SVG = "http://www.w3.org/2000/svg";
const MAX_QUEUE = 10;

export function mountPotato({ versus, me, setStatus, confirm }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    turn: $("potato-turn"), round: $("potato-round"), giveUp: $("potato-giveup"),
    world: $("world"), land: $("world-land"), named: $("world-named"), count: $("potato-count"),
    form: $("potato-form"), input: $("potato-input"), send: $("potato-send"),
    hint: $("potato-hint"), queue: $("potato-queue"), feed: $("potato-feed"),
  };
  let room = null;
  let queue = [];
  let lastTurn = null;
  let sending = false;
  /** A turn came round while a send was still out: flush again when it lands. */
  let flushAgain = false;
  const feed = [];

  const myTurn = () => room?.state === "playing" && room.potato?.turnUid === me();
  /** Training has no clock (D-93): every answer is a new turn, so nothing is sent on a turn change. */
  const solo = () => room?.potato?.limitMs === null;

  async function send(names) {
    if (names.length === 0) return;
    if (sending) { flushAgain = true; return; }
    sending = true;
    try {
      const r = await versus("answer", { room: roomId(), names: names.slice(0, MAX_QUEUE) });
      const gone = new Set(r.dropped.map((d) => d.name));
      for (const a of r.accepted) gone.add(a.name);
      queue = queue.filter((n) => !gone.has(n));
      if (gone.has(el.input.value.trim())) el.input.value = "";
      // What was refused, in words: "já está no mapa", "não conheço".
      const why = r.dropped.map((d) => t(`versus.dropped.${d.reason}`, { name: d.name })).join(" ");
      setStatus(r.accepted.length ? why : why || t("versus.dropped.unknown", { name: names[0] }), r.accepted.length ? "" : "warn");
    } catch (err) {
      setStatus(errorMessage(err, "versus"), "err");
    } finally {
      sending = false;
      renderQueue();
      el.input.focus();
      if (flushAgain) {
        flushAgain = false;
        if (myTurn()) flush();
      }
    }
  }

  const roomId = () => new URLSearchParams(location.search).get("s")?.toUpperCase();

  el.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = el.input.value.trim();
    if (myTurn() && !sending) {
      // Training: the box is for the next name at once, not for the reply to come back.
      if (solo()) el.input.value = "";
      return send([...queue, ...(name ? [name] : [])]);
    }
    // Not my turn, or my last answer is still out: into the queue, to go the moment it can.
    if (!name || queue.length >= MAX_QUEUE) return;
    if (!queue.includes(name)) queue.push(name);
    el.input.value = "";
    if (sending) flushAgain = true;
    renderQueue();
  });

  el.giveUp.addEventListener("click", async () => {
    if (!(await confirm(t(solo() ? "versus.soloGiveUp" : "versus.confirmGiveUp")))) return;
    try { await versus("giveUp", { room: roomId() }); }
    catch (err) { setStatus(errorMessage(err, "versus"), "err"); }
  });

  function renderQueue() {
    el.queue.replaceChildren(...queue.map((name) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${name} ×`;
      b.setAttribute("aria-label", t("versus.unqueue", { name }));
      b.addEventListener("click", () => { queue = queue.filter((n) => n !== name); renderQueue(); });
      li.append(b);
      return li;
    }));
    el.hint.textContent = solo() ? t("versus.soloHint") : myTurn() ? t("versus.yourTurnHint") : t("versus.queueHint", { n: queue.length, max: MAX_QUEUE });
  }

  /** New map documents: the land once, then each named country. */
  function onMap(docs) {
    for (const d of docs) {
      if (d.land !== undefined) {
        el.world.setAttribute("viewBox", d.viewBox);
        el.land.setAttribute("d", d.land);
        el.land.setAttribute("fill-rule", "evenodd");
        continue;
      }
      const node = document.createElementNS(SVG, d.d ? "path" : "circle");
      if (d.d) { node.setAttribute("d", d.d); node.setAttribute("fill-rule", "evenodd"); }
      else { node.setAttribute("cx", d.dot[0]); node.setAttribute("cy", d.dot[1]); node.setAttribute("r", "3"); }
      node.setAttribute("fill", d.color);
      node.setAttribute("class", "named");
      const title = document.createElementNS(SVG, "title");
      title.textContent = d.name;
      node.append(title);
      el.named.append(node);
      feed.push(d);
    }
    feed.sort((a, b) => b.at - a.at);
    renderFeed();
  }

  function renderFeed() {
    el.feed.replaceChildren(...feed.slice(0, 8).map((d) => {
      const li = document.createElement("li");
      li.className = "card-item solved";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = d.color;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = solo() ? d.name : `${d.name} — ${room?.players[d.by]?.name ?? ""}`;
      const pts = document.createElement("span");
      pts.className = "score";
      pts.textContent = `+${d.points}`;
      li.append(dot, name, pts);
      return li;
    }));
  }

  /**
   * The queue and whatever is in the box, in that order: pre-written names go
   * first. In training the box is left alone — it is a name half-typed, not one
   * written ahead.
   */
  function flush() {
    const typed = solo() ? "" : el.input.value.trim();
    send([...queue, ...(typed ? [typed] : [])]);
  }

  /** Every room snapshot. A new turn that is mine flushes the queue at once. */
  function onRoom(next) {
    room = next;
    const p = room.potato;
    const turnKey = p && `${p.turnUid}@${p.turnStartedAt}`;
    if (turnKey !== lastTurn) {
      lastTurn = turnKey;
      // Last turn's refusals are about last turn.
      // In training every answer is a new turn, and the refusals beside it are news.
      if (lastTurn !== null && !sending && !solo()) setStatus("");
      if (myTurn() && !solo()) {
        flush();
        el.input.focus();
      }
    }
  }

  function render(next) {
    room = next;
    const p = room.potato;
    const playing = room.state === "playing";
    const gaveUp = p.gaveUp.includes(me());
    el.giveUp.hidden = !playing || gaveUp;
    el.form.hidden = !playing || gaveUp;
    const who = room.players[p.turnUid]?.name ?? "";
    el.turn.textContent = !playing || solo() ? "" : myTurn() ? t("versus.yourTurn") : t("versus.theirTurn", { name: who });
    el.turn.classList.toggle("mine", myTurn());
    el.round.textContent = playing && !solo() ? t("versus.round", { n: p.round, s: p.limitMs / 1000 }) : "";
    $("potato-timer-bar").parentElement.hidden = !playing || solo();
    el.count.textContent = t("versus.namedCount", { n: p.named.length, total: p.total });
    el.send.textContent = myTurn() ? t("versus.send") : t("versus.queue");
    renderQueue();
    renderFeed(); // the map can arrive before the room on a reload
  }

  function drawClock(left) {
    if (myTurn()) el.turn.textContent = `${t("versus.yourTurn")} ${Math.ceil(left / 1000)}s`;
    else if (room?.state === "playing") el.turn.textContent = `${t("versus.theirTurn", { name: room.players[room.potato.turnUid]?.name ?? "" })} ${Math.ceil(left / 1000)}s`;
  }

  return { onMap, onRoom, render, drawClock };
}
