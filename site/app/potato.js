// Batata Quente — FR-12.3. The map, the queue and the turn, for sala.html.
//
// The map arrives a piece at a time: the grey land when the game starts, then
// one document per country as it is named (D-89). The page never holds a map
// of its own — what it draws is exactly what this room has named, and that is
// all the server has sent it.
//
// There is no autocomplete here on purpose (D-90): one wrong letter is forgiven
// by the server, and suggestions would make that rule meaningless. What there
// is instead is ONE queued name (D-95) — typed while waiting, sent the instant
// the turn comes round. A pre-written hit lands with almost the whole clock
// left, which is worth almost the whole ten points; and because it is one name,
// a rival naming it first is a real risk, and the reason to keep watching the map.

import { errorMessage, t } from "./i18n.js";

const SVG = "http://www.w3.org/2000/svg";
/** Training's backlog, for names typed while an answer is still out (FR-12.5). */
const MAX_BACKLOG = 10;
const ICON = {
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7"/><path d="M12 13V9.5M10 3h4"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

export function mountPotato({ multiplayer, me, confirm }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    turn: $("potato-turn"), turnDot: $("potato-turn-dot"), secs: $("potato-secs"), pill: $("turn-pill"),
    timer: $("potato-timer-bar").parentElement, giveUp: $("potato-giveup"),
    head: $("potato-head"), title: $("potato-title"), round: $("potato-round"), count: $("potato-count"), meter: $("potato-meter"),
    wrap: $("world-wrap"), world: $("world"), land: $("world-land"), named: $("world-named"),
    zoomHint: $("zoom-hint"),
    dock: document.querySelector("#potato .dock"), form: $("potato-form"), input: $("potato-input"), send: $("potato-send"),
    slot: $("potato-slot"), hint: $("potato-hint"), feed: $("potato-feed"), feedTitle: $("feed-title"),
  };
  let room = null;
  /** Names waiting for the turn: one in a timed game (D-95), a backlog in training. */
  let queue = [];
  let lastTurn = null;
  let sending = false;
  /** The queued name that is out right now, for the slot to say so. */
  let flying = null;
  /** The last name of mine that landed, shown in the slot for a moment. */
  let landed = null;
  let landedTimer = 0;
  /** A turn came round while a send was still out: flush again when it lands. */
  let flushAgain = false;
  /** What the last answer was told — shown under the field until it stops being news. */
  let note = { text: "", cls: "" };
  const feed = [];
  let latest = null;
  /** The state the screen was last drawn in, to see the game end (onRoom moves `room` first). */
  let drawnState = null;

  const playing = () => room?.state === "playing";
  const myTurn = () => playing() && room.potato?.turnUid === me();
  /** Training has no clock (D-93): every answer is a new turn, so nothing is sent on a turn change. */
  const solo = () => room?.potato?.limitMs === null;
  const roomId = () => new URLSearchParams(location.search).get("s")?.toUpperCase();

  async function send(names) {
    if (names.length === 0) return;
    if (sending) { flushAgain = true; return; }
    sending = true;
    flying = solo() ? null : queue[0] ?? null;
    renderDock();
    try {
      // The server's own limits: one queued name and the box, or training's backlog.
      const r = await multiplayer("answer", { room: roomId(), names: names.slice(0, solo() ? MAX_BACKLOG : 2) });
      const gone = new Set(r.dropped.map((d) => d.name));
      for (const a of r.accepted) gone.add(a.name);
      queue = queue.filter((n) => !gone.has(n));
      if (gone.has(el.input.value.trim())) el.input.value = "";
      if (!solo() && r.accepted.length > 0) {
        const a = r.accepted[0];
        landed = { name: feed.find((d) => d.code === a.code)?.name ?? a.name, points: a.points };
        clearTimeout(landedTimer);
        landedTimer = setTimeout(() => { landed = null; renderDock(); }, 4000);
      }
      // What was refused, in words: "já está no mapa", "não reconheci".
      const why = r.dropped.map((d) => t(`multi.dropped.${d.reason}`, { name: d.name })).join(" ");
      note = r.accepted.length
        ? { text: why, cls: "" }
        : { text: `${why || t("multi.dropped.unknown", { name: names[0] })}${myTurn() && !solo() ? ` ${t("multi.stillYours")}` : ""}`, cls: "warn" };
    } catch (err) {
      note = { text: errorMessage(err, "multi"), cls: "err" };
    } finally {
      sending = false;
      flying = null;
      renderDock();
      el.input.focus();
      if (flushAgain) {
        flushAgain = false;
        if (myTurn()) flush();
      }
    }
  }

  el.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = el.input.value.trim();
    if (myTurn() && !sending) {
      // Training: the box is for the next name at once, not for the reply to come back.
      if (solo()) el.input.value = "";
      return send([...queue, ...(name ? [name] : [])]);
    }
    // Not my turn, or my last answer is still out: it waits, and goes the moment it can.
    if (!name) return;
    if (solo()) {
      if (queue.length < MAX_BACKLOG && !queue.includes(name)) queue.push(name);
    } else {
      // One slot: a new name takes the old one's place.
      const old = flying ? null : queue[0];
      queue = [name];
      landed = null;
      note = old && old !== name ? { text: t("multi.replaced", { old, name }), cls: "" } : { text: "", cls: "" };
    }
    el.input.value = "";
    if (sending) flushAgain = true;
    renderDock();
  });
  el.input.addEventListener("input", () => { note = { text: "", cls: "" }; renderDock(); });

  el.giveUp.addEventListener("click", async () => {
    if (!(await confirm(t(solo() ? "multi.soloGiveUp" : "multi.confirmGiveUp")))) return;
    try { await multiplayer("giveUp", { room: roomId() }); }
    catch (err) { note = { text: errorMessage(err, "multi"), cls: "err" }; renderDock(); }
  });

  /** The slot, the button and the line under them. */
  function renderDock() {
    const typed = el.input.value.trim();
    const queued = queue[0] ?? null;
    const mine = myTurn();
    el.slot.hidden = solo() || !playing();
    if (!el.slot.hidden) {
      el.slot.className = "slot";
      let label = "", name = "", icon = ICON.clock, extra = null;
      if (flying) {
        el.slot.classList.add("sending");
        [label, name, icon] = [t("multi.slotSending"), flying, ICON.send];
      } else if (queued) {
        el.slot.classList.add("armed");
        el.slot.classList.toggle("replacing", Boolean(typed) && !mine);
        [label, name] = [t("multi.slotQueued"), queued];
      } else if (landed) {
        el.slot.classList.add("landed");
        el.slot.style.setProperty("--c", room.players[me()]?.color ?? "var(--ok)");
        [label, name, icon] = [t("multi.slotLanded"), landed.name, ICON.check];
        extra = document.createElement("span");
        extra.className = "pts";
        extra.textContent = `+${landed.points}`;
      } else {
        el.slot.classList.add("empty");
        label = mine ? t("multi.slotEmptyMine") : t("multi.slotEmpty");
      }
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.innerHTML = icon; // static markup from ICON, never data
      const text = document.createElement("span");
      text.className = "text";
      const small = document.createElement("span");
      small.className = "label";
      small.textContent = label;
      text.append(small);
      if (name) {
        const b = document.createElement("b");
        b.textContent = name;
        if (extra) b.append(" ", extra);
        text.append(b);
      }
      el.slot.replaceChildren(glyph, text);
      if (queued && !flying) {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "unqueue";
        x.innerHTML = ICON.x;
        x.setAttribute("aria-label", t("multi.unqueue", { name: queued }));
        x.addEventListener("click", () => { queue = []; note = { text: "", cls: "" }; renderDock(); el.input.focus(); });
        el.slot.append(x);
      }
    }
    el.dock.classList.toggle("mine", mine && !solo());
    const swap = !solo() && !mine && queued && typed;
    el.send.textContent = mine || solo() ? t("multi.send") : swap ? t("multi.swap") : t("multi.queue");
    // The accent is for the thing that will happen on Enter: an answer, or a swap.
    const go = mine || solo() || Boolean(typed);
    el.send.classList.toggle("primary", go);
    el.send.classList.toggle("secondary", !go);
    el.input.placeholder = mine || solo() ? t("multi.placeholder") : queued ? t("multi.placeholderSwap") : t("multi.placeholderNext");
    el.hint.className = `fine ${note.cls}`;
    // A live region: written only when it says something new, never per keystroke.
    const hint = note.text || (solo() ? t("multi.soloHint")
      : mine ? t("multi.yourTurnHint")
      : swap ? t("multi.swapHint", { old: queued })
      : queued ? t("multi.queuedHint", { name: queued })
      : t("multi.queueHint"));
    if (el.hint.textContent !== hint) el.hint.textContent = hint;
  }

  /** New map documents: the land once, then each named country. */
  function onMap(docs) {
    for (const d of docs) {
      if (d.land !== undefined) {
        zoom.base(d.viewBox);
        el.land.setAttribute("d", d.land);
        el.land.setAttribute("fill-rule", "evenodd");
        continue;
      }
      const node = document.createElementNS(SVG, d.d ? "path" : "circle");
      if (d.d) { node.setAttribute("d", d.d); node.setAttribute("fill-rule", "evenodd"); }
      else { node.setAttribute("cx", d.dot[0]); node.setAttribute("cy", d.dot[1]); node.setAttribute("r", "3"); }
      node.setAttribute("fill", d.color);
      node.setAttribute("class", "named");
      node.dataset.code = d.code;
      const title = document.createElementNS(SVG, "title");
      title.textContent = d.name;
      node.append(title);
      el.named.append(node);
      feed.push(d);
      if (!latest || d.at >= latest.at) latest = { at: d.at, node };
    }
    // The newest country is outlined, and drawn last so the outline is not under a neighbour.
    for (const n of el.named.querySelectorAll(".latest")) n.classList.remove("latest");
    if (latest) { latest.node.classList.add("latest"); el.named.append(latest.node); }
    feed.sort((a, b) => b.at - a.at);
    renderFeed();
  }

  /**
   * A rematch (D-104) deletes the last game's map: its countries leave the
   * screen and the feed, and the land too when the next game is a Clássico.
   */
  function onMapRemoved(ids) {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    for (const n of [...el.named.children]) if (gone.has(n.dataset.code)) n.remove();
    if (gone.has("_base")) el.land.removeAttribute("d");
    for (let i = feed.length - 1; i >= 0; i--) if (gone.has(feed[i].code)) feed.splice(i, 1);
    if (latest && !latest.node.isConnected) latest = null;
    renderFeed();
  }

  /** Every country named, newest first. It scrolls inside its own box. */
  function renderFeed() {
    el.feedTitle.hidden = el.feed.hidden = feed.length === 0;
    el.feed.replaceChildren(...feed.map((d) => {
      const li = document.createElement("li");
      li.className = "card-item";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = d.color;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = d.name;
      if (!solo()) {
        const by = document.createElement("small");
        by.textContent = ` ${room?.players[d.by]?.name ?? ""}`;
        name.append(by);
      }
      const pts = document.createElement("span");
      pts.className = "score";
      pts.textContent = `+${d.points}`;
      li.append(dot, name, pts);
      return li;
    }));
  }

  /**
   * The queued name and whatever is in the box, in that order: the pre-written
   * one goes first. In training the box is left alone — it is a name half-typed,
   * not one written ahead.
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
      if (lastTurn !== null && !sending && !solo()) note = { text: "", cls: "" };
      if (myTurn() && !solo()) {
        flush();
        el.input.focus();
      }
    }
  }

  function render(next) {
    // The end shows the whole world: it is what the game was for.
    if (drawnState === "playing" && next.state === "finished") zoom.fit();
    drawnState = next.state;
    room = next;
    const p = room.potato;
    const gaveUp = p.gaveUp.includes(me());
    el.giveUp.hidden = !playing() || gaveUp;
    el.dock.hidden = !playing() || gaveUp;
    el.pill.hidden = !playing() || solo();
    el.timer.hidden = !playing() || solo();
    const turner = room.players[p.turnUid];
    el.turn.textContent = myTurn() ? t("multi.yourTurn") : t("multi.theirTurn", { name: turner?.name ?? "" });
    el.turnDot.style.background = turner?.color ?? "transparent";
    el.pill.classList.toggle("mine", myTurn());
    el.head.hidden = false;
    el.title.textContent = t(`multi.preset.${room.presetId}`);
    el.round.textContent = playing() && !solo() ? t("multi.round", { n: p.round, s: p.limitMs / 1000 }) : "";
    el.count.textContent = t("multi.namedCount", { n: p.named.length, total: p.total });
    el.meter.style.width = `${(100 * p.named.length) / p.total}%`;
    renderDock();
    renderFeed(); // the map can arrive before the room on a reload
  }

  function drawClock(left) {
    el.secs.textContent = `${Math.ceil(left / 1000)}s`;
  }

  const zoom = mountZoom(el);
  /** A new game in the same room (D-104): a name queued in the last one is not sent in this one. */
  function reset() {
    queue = [];
    note = { text: "", cls: "" };
    landed = null;
    clearTimeout(landedTimer);
    flushAgain = false;
    el.input.value = "";
  }

  return { onMap, onMapRemoved, onRoom, render, drawClock, reset };
}

/**
 * Pan and zoom, on a desktop (D-95). The map is redrawn by moving the SVG's
 * viewBox, so country borders keep their hairline at any zoom (non-scaling
 * stroke) and nothing is rasterised. A Mac trackpad's pinch arrives as a wheel
 * event with ctrlKey set (Chrome, Firefox) or as Safari's gesture events; its
 * two-finger scroll is a plain wheel, and pans. A mouse wheel zooms instead,
 * because a mouse has no other way to. Below 60rem the page scrolls as a page
 * and none of this intercepts anything. Fronteiras (FR-15) reuses it with its
 * own board, buttons and body class: `el.active`, `el.zoomIn/Out/Fit`.
 */
export function mountZoom(el) {
  const wide = matchMedia("(min-width: 60rem)");
  const MAX = 8;
  const active = el.active ?? (() => document.body.classList.contains("potato-room"));
  let vb = null;          // the map's own box: [x, y, w, h]
  let k = 1;
  let cx = 0, cy = 0;     // the map point at the centre of the view
  let geo = null;         // the last drawn view: { s, x, y } (px per unit, top-left)
  let drag = null;        // the one pointer that is panning: { id, x, y }
  let padAt = -Infinity;  // when a trackpad last scrolled

  function base(viewBox) {
    vb = viewBox.split(/\s+/).map(Number);
    k = 1;
    cx = vb[0] + vb[2] / 2;
    cy = vb[1] + vb[3] / 2;
    draw();
  }

  function draw() {
    if (!vb) return;
    const W = el.wrap.clientWidth, H = el.wrap.clientHeight;
    if (!wide.matches || !active() || W === 0 || H === 0) {
      el.world.setAttribute("viewBox", vb.join(" "));
      geo = null;
      return;
    }
    const s = Math.min(W / vb[2], H / vb[3]) * k;
    const w = W / s, h = H / s;
    // Never pan the map out of view: on an axis it overflows, keep it covering.
    const fit = (c, lo, size, view) => (view >= size ? lo + size / 2 : Math.min(lo + size - view / 2, Math.max(lo + view / 2, c)));
    cx = fit(cx, vb[0], vb[2], w);
    cy = fit(cy, vb[1], vb[3], h);
    geo = { s, x: cx - w / 2, y: cy - h / 2 };
    el.world.setAttribute("viewBox", `${geo.x} ${geo.y} ${w} ${h}`);
  }

  /** Zoom by `f`, keeping the map point under (px, py) — wrapper pixels — where it is. */
  function zoomAt(px, py, f) {
    if (!geo) return;
    const mx = geo.x + px / geo.s, my = geo.y + py / geo.s;
    const k2 = Math.min(MAX, Math.max(1, k * f));
    const s2 = (geo.s / k) * k2;
    k = k2;
    cx = mx - px / s2 + el.wrap.clientWidth / s2 / 2;
    cy = my - py / s2 + el.wrap.clientHeight / s2 / 2;
    used();
    draw();
  }

  function panBy(dx, dy) {
    if (!geo) return;
    cx -= dx / geo.s;
    cy -= dy / geo.s;
    used();
    draw();
  }

  const used = () => el.zoomHint.classList.add("used");
  const at = (e) => { const r = el.wrap.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onControl = (e) => e.target.closest?.("button, .turn-pill");

  el.wrap.addEventListener("wheel", (e) => {
    if (!geo) return;
    e.preventDefault();
    const [px, py] = at(e);
    // A wheel that clicks: whole lines, or whole 120-unit notches with no sideways
    // part — unless a trackpad was scrolling a moment ago, whose fast flicks can
    // look like that too. Then it is the same gesture, and it keeps panning.
    const notch = e.deltaMode === 1 || (e.deltaX === 0 && e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0);
    const mouse = notch && e.timeStamp - padAt > 300;
    if (!notch && !e.ctrlKey) padAt = e.timeStamp;
    if (e.ctrlKey) zoomAt(px, py, Math.exp(-e.deltaY * 0.01));
    else if (mouse) zoomAt(px, py, e.deltaY < 0 ? 1.25 : 0.8);
    else panBy(-e.deltaX, -e.deltaY);
  }, { passive: false });

  // Safari's pinch.
  let k0 = 1;
  el.wrap.addEventListener("gesturestart", (e) => { if (!geo) return; e.preventDefault(); k0 = k; });
  el.wrap.addEventListener("gesturechange", (e) => {
    if (!geo) return;
    e.preventDefault();
    const [px, py] = at(e);
    zoomAt(px, py, (k0 * e.scale) / k);
  });

  el.wrap.addEventListener("pointerdown", (e) => {
    // One pointer pans; a second finger on a touchscreen is ignored, not averaged in.
    if (!geo || drag || e.button !== 0 || onControl(e)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    el.wrap.setPointerCapture(e.pointerId);
    el.wrap.classList.add("grabbing");
  });
  el.wrap.addEventListener("pointermove", (e) => {
    if (drag?.id !== e.pointerId) return;
    panBy(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  const end = (e) => { if (drag?.id !== e.pointerId) return; drag = null; el.wrap.classList.remove("grabbing"); };
  el.wrap.addEventListener("pointerup", end);
  el.wrap.addEventListener("pointercancel", end);
  el.wrap.addEventListener("dblclick", (e) => {
    if (!geo || onControl(e)) return;
    const [px, py] = at(e);
    zoomAt(px, py, e.shiftKey ? 0.5 : 2);
  });

  const centre = (f) => zoomAt(el.wrap.clientWidth / 2, el.wrap.clientHeight / 2, f);
  const btn = (b, id) => b ?? document.getElementById(id);
  btn(el.zoomIn, "zoom-in").addEventListener("click", () => centre(1.6));
  btn(el.zoomOut, "zoom-out").addEventListener("click", () => centre(1 / 1.6));
  const fit = () => { if (vb) base(vb.join(" ")); };
  btn(el.zoomFit, "zoom-fit").addEventListener("click", fit);

  // The wrapper's size, and the window's, which is what crosses 60rem.
  new ResizeObserver(draw).observe(el.wrap);
  addEventListener("resize", draw);
  return { base, fit };
}
