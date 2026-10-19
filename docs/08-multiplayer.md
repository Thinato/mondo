# 08 — Multijogador

Live rooms, played by everyone in them at once. Requirements are FR-12; decisions are D-87 to D-95
and D-102 to D-104 in `00-brief.md` §6. Added 2026-10-12 as **Versus**; renamed Multijogador, and
the room made to outlive its game, on 2026-10-18 (D-102–D-104). Where this file says Versus it
means the same thing.

## 1. Why

Tournaments (`06-tournaments.md`) are asynchronous and belong to a group: you can only play
someone in your group, and a round takes a day. Versus is the replacement (D-88): a host makes a
**room**, sends its link to anyone — any group or none, a guest included — and everyone plays
**at the same time, on one clock**. Two games:

- **Clássico** — the challenge kinds of the daily, every player on the same challenge at once.
- **Batata Quente** — take turns naming a country nobody has named; the world map fills in.

## 2. Shape

```
sala.html ──callable──▶ multiplayer({ op })     (one function, D-92; `versus` too, for one release, D-102)
    ▲                       │ transaction
    │ onSnapshot (D-87)     ▼
    └──────────── rooms/{id}              room: state, players, scores, the clock
                  rooms/{id}/prompts/{i}  Clássico: one prompt per challenge; reveal once closed
                  rooms/{id}/map/{code}   Batata Quente: one doc per named country; map/_base = land
                  roomSecrets/{id}        Clássico card + plays; Batata Quente throttle. No client.
```

- **Reads** are listeners on the room and its two subcollections, allowed by `firestore.rules`
  to the room's players only (`get`, never `list` — the id is the invite). This is the one place
  the client loads the Firestore SDK (`site/app/firebase.js` `realtime()`, loaded lazily by
  sala.html alone).
- **Writes** are only ever `multiplayer`. Every op asserts auth, validates its input, and runs one
  transaction. Every reply carries `serverNow`; the page keeps an offset from it and draws the
  countdown from the room's `deadline`.
- **The clock** is enforced lazily (invariant 3): an answer after the deadline is refused by the
  server's clock, and every client calls `op: "tick"` when its countdown ends. The first tick
  through the transaction moves the room on; the rest find nothing due and return
  `moved: false`. Nothing is scheduled, and a room every client has left simply stops.

### 2.1 Ops

| op | who | does |
|---|---|---|
| `create { presetId? }` | admin, invited, subscriber (FR-10.3) | the host's standing room (D-103): the one they are seated in if it is playing or not expired, else a new lobby on `mundo`. A named preset is applied between games |
| `join { room }` | anyone signed in | takes a seat (≤ 8, between games only); idempotent; returns `mine` for a running Clássico, and the caller's own saved `presets` |
| `leave { room }` | a player, between games | frees the seat; the host's seat passes on |
| `configure { room, presetId }` or `{ room, custom }` | the host, between games | the next game (FR-12.7): a preset, never `treino`, or a custom Clássico (FR-12.10, §3.1), refused here with `no-countries-left` if the pool cannot fill it; keeps the room open two more hours |
| `savePreset { preset }` | admin, invited, subscriber | saves a custom game under its name on `users/{uid}.presets` (FR-12.11): same name overwrites, ≤ 10; returns the list |
| `deletePreset { name }` | anyone signed in | removes one of their own saved games; returns the list |
| `remove { room, uid }` | the host, between games | takes another player's seat (FR-12.8); not a ban |
| `start { room }` | the host, ≥ 2 players, between games | builds the card (Clássico) or the turn order and the land (Batata Quente); after a game, first deletes its prompts and map (§2.3) |
| `tick { room }` | a player | moves the room on if — and only if — its deadline has passed |
| `guess { room, guess, selfReport? }` | Clássico player | one guess on the challenge on screen |
| `answer { room, names[] }` | Batata Quente player on turn | the first acceptable of ≤ 2 names (≤ 10 in training, and every acceptable one); `accepted` is a list |
| `giveUp { room }` | a player | Clássico: this challenge at 0. Batata Quente: out of the turn order |

### 2.2 What is pure

All the rules are in `backend/functions/src/lib/` and unit-tested without Firestore:
`room.ts` (lobby, configure, remove, finish), `multiplayer.ts` (presets, Clássico, speed points),
`potato.ts` (turns, timer, points, end), `match.ts` (typed names), `world.ts` (the map pieces).
`multiplayer.ts` at the top level is I/O only.

### 2.3 A room outlives its game (D-103, D-104)

Before D-104 a finished room was a dead end: to play again the host made a new room and sent a new
link, and every player had to come back through it. Now:

- **One room per host.** Opening Multijogador (`/sala` with no `?s=`) calls `create`, which returns
  `users/{uid}.hostRoom` while the host is still seated in it and it is playing or not past
  `expiresAt`; otherwise it makes a room and remembers it. The page goes there with
  `location.replace`. A `user` or a guest is not sent anywhere: they see "Em breve", and a link
  still seats them.
- **Finished is between games.** `join`, `leave`, `configure`, `remove` and `start` treat
  `finished` as they treat `lobby`, and finishing (`finishRoom`) sets `expiresAt` two hours on. The
  result stays on the room — scores on `players` or `potato.scores` — until the next start, so the
  page shows it above the lobby, and the map under both.
- **A rematch clears what the last game left, in the start transaction.** Every `prompts/*` and
  `map/*` is deleted except the one document the new game writes over (`prompts/0` or
  `map/_base`) — one write per document per commit — plus `roomSecrets` when a Batata Quente
  follows a Clássico. Left in place, `prompts/3` of the last game would show its reveal under the
  new game's third challenge. At most 196 countries and a card's prompts: well under 500 writes.
  Scores go to zero (`resetForGame`); seats and colours stay.
- **Trophies** (D-105): `finishRoom` gives the one player with the most points of the game just
  played (`potato.scores` or the seats' `score`) a win on their seat; a tie at the top gives none.
  `resetForGame` zeroes scores, never wins, so the board counts them across the room's games.
- **Training rooms are not rooms in this sense** (D-93): one player, played once, never a lobby.
- **The client keys a game on `startedAt`** and drops deleted `prompts` and `map` documents, so a
  page left open between games follows the host into the next one.

## 3. Clássico (FR-12.2)

- **Presets, or a custom game** (D-106): `mundo` (Batata Quente), `dia` (the 7 kinds),
  `bandeiras`, `formas`, `capitais`, `misto-10`, by id — or a custom Clássico by value (§3.1).
- Every player holds a `CardCore` of the room's card in `roomSecrets` and plays it through
  `lib/card.ts` **unchanged** — `applyCardGuess`, `giveUpCard`, `scoreItem`, the guess budget and
  SEC-5's floor. The room only decides when an item opens and closes: a guess is refused unless
  the player's cursor is on the room's current item, so an early finisher waits.
- At the deadline (or once everyone is done) the room gives up for whoever is still at it,
  scores everyone, writes the reveal onto `prompts/{i}`, and shows it for 5 s.
- **Points**: `round(points × (1 + 0.5 × timeLeft / duration))`, measured at the solving guess's
  server timestamp. Speed only adds to a solve; 0 stays 0. Ties: less total time solving.
- **SEC-1**: the room doc carries `kind.prompt(item)` (which never names its answer) and, per
  player, `{ guesses, done, solved, points }` — a count, never a graded guess, because a rival's
  distance and arrow are hints. Your own guesses come back in your reply. D-91 withholds the
  daily's next week of subjects from the card.

### 3.1 A custom game (FR-12.10, FR-12.11, D-106)

The host can put a Clássico together in the lobby's **Personalizar** tab: 1–15 kinds in order (a
slot list, with a shuffle switch) and the continents to draw from (a multi-select, every continent
by default). What the client sends is `{ kinds, shuffled, regions, name? }` — **never a country**;
`requireCustomGame` keeps that closed shape and nothing else.

- **The room holds a copy** (`room.custom`, `presetId: "custom"`). Choosing a preset clears it. A
  saved game edited or deleted later does not touch a room already set to it.
- **Dealt by `specOf` and `dealCard`**: one card entry per kind, `as_listed` unless shuffled — so
  the order the host chose is the order played. The continents are D-70's mechanism: every country
  outside them joins the exclusion `buildCard` already takes, beside D-91's week ahead, so the
  subjects and — while the continent leaves seven distractors — `flagPick`/`shapePick`'s eight
  options stay inside them.
- **A board never leaks, however small the continent.** `pickOptions` falls back to its WHOLE pool
  when the exclusion leaves fewer than seven distractors — built for tournaments' ±60-day window,
  harmless on a world-sized card, and on an Oceania card of the day's seven kinds it put another
  challenge's answer on 87–99 % of boards. `dealCard` re-deals any such board from the world minus
  the card's subjects and the week ahead: wider than asked, never an answer (FR-8.7, D-91).
- **Refused early.** Fifteen capitals of Oceania cannot be dealt; `configure` tries the deal (week
  ahead included) and says so with `no-countries-left`, after up to five draws, because whether a
  tight continent runs dry depends on the weighted draw. `start` deals the same way.
- **`start`'s race guard** compares `custom` as well as `presetId`.
- **Saved games** (FR-12.11) live on the host's own `users/{uid}.presets` — owner-only (D-34), no
  new collection, no rules change. Up to 10, named 1–24 characters; saving under a name already
  there (case and spacing ignored) overwrites it. `join` hands the caller their own list, and the
  page lists them above the presets with ✎ (into the tab, prefilled) and ✕. Saving takes hosting's
  rank, as the room it is for does; deleting takes none, so a lapsed subscriber can still tidy up.
- **Jogar.** On the Personalizar tab the lobby's one primary button reads "Jogar": it configures
  the room with the draft and starts it. The draft plays under a saved game's name only if it is
  that game unchanged; otherwise it is "Clássico · personalizado".
- A card holds 15 (`MAX_CARD_ITEMS`), up from 10: about 12.5 minutes at 45 s a challenge.

## 4. Batata Quente (FR-12.3)

- Turn order is join order; a round is every active player once. Turn length is
  `max(3, 21 − round)` s: 20, 19 … 4, 3, 3, 3.
- **An answer is text** (D-90), matched by `lib/match.ts`: the pt-BR name or an alias; accents,
  case and punctuation ignored; **one edit** forgiven for terms of 4+ characters; a one-edit
  guess that fits two countries refused as ambiguous; two-letter terms are not names.
- Valid and not yet on the map: `max(1, round(10 × (1 − t/T)))` points, the country's path is
  written to `map/{code}` in the namer's colour, and the turn passes. Unknown, ambiguous or
  already named: refused **and the turn stays** (with SEC-5's 400 ms floor between tries, within
  a turn). Timeout: the turn passes for nothing.
- **The queue**: there is no autocomplete. ONE name typed while waiting waits in a slot beside the
  field (D-95) — typing another and pressing Enter swaps it — and goes, with whatever is in the box,
  in one call the instant the turn comes round; the server takes the first acceptable and reports
  the rest, and refuses a third name on a timed turn. A pre-written hit lands with almost the whole
  clock left; a name somebody else said first is refused, and the turn stays.
- **The desktop room** (D-95): from 60rem a game that has started is the whole window — a side
  column (round and count, the board, every country named newest first, the page's footer links at
  the bottom) and the map everywhere else, with the turn, the clock, the zoom and the field floating
  over it. The map pans and zooms by moving its viewBox: a trackpad's pinch (ctrl+wheel, or Safari's
  gesture events) zooms around the pointer, two fingers pan, a mouse wheel zooms, a drag pans,
  1×–8×, and the borders stay a screen-pixel hairline so a small country left grey between two
  coloured ones can be seen. Below 60rem it is a page that scrolls, as before.
- **The end**: every country named, or two full rounds with no answer (`passStreak ≥ 2 ×
  active`), or everyone gave up. Most points wins; ties to less total answer time.
- **The map** (D-89): Natural Earth 1:50m, Equal Earth, built by `tools/build-world.mjs` into
  `backend/functions/src/data/world.json` (167 outlines, 29 dots for countries too small to see,
  354 KB). One topology draws it all (D-96): the grey land is the union of the same 1:50m
  countries, simplified once on the topology's shared arcs (`topojson-simplify`, keeping 18 % of
  the points), so a border is the same line for both neighbours and for the land under them.
  Server-only. The grey land goes to `map/_base` at start; a country's mark is written
  only once it is named. Greenland, outside the pool (D-20) but a third of the northern map, is
  painted as part of Denmark (`PAINTED_WITH` in `tools/build-world.mjs`), so the map can fill;
  "Groenlândia" is still not an answer.

### 4.1 Training (FR-12.5, D-93)

The `treino` preset is Batata Quente for one, with no clock. It is started from the Treinar page (`praticar.html`, the card in its "Jogos" row, D-94), and played on `sala.html`, because the map arrives by a listener and invariant 2 keeps listeners to that one page. `create` makes the room already
`playing`: `newPotato([uid], now, false)`, with `limitMs` and `deadline` null. With a null deadline,
`checkTurn` never says time-up, `tick` finds nothing due, and the page draws no timer.

The other differences:

- Anyone signed in may create one, a guest included, because nobody else is in it.
- Every country is worth 1, so the score is the count.
- `answer` takes **every** acceptable name it is sent, not the first.
- The 400 ms floor is skipped. Each answer opens a new turn that is yours again, so the floor would only refuse names typed quickly.
- Joining is refused (`room-started`).
- Each account has one open training room (`users/{uid}.trainingRoom`), and creating another while it is open returns it.
- It ends when the map is full or the player stops. The end screen lists the missed countries by name, from the public `countries.min.json`.

Cost: a full map is about 197 writes and one listener's worth of reads.

## 5. Security notes

- Room doc: prompts and counts only (§3). Prompts: reveal only after close. Map: only named
  countries. `roomSecrets`: closed to everyone.
- **The residual** (D-89): a finished Batata Quente hands its players the outlines it named —
  what an atlas shows. The gate is being in a room; anyone with a link is. Since D-93 anyone
  signed in can open a training room alone, so the gate is now just being signed in.
- A Versus result never reaches `attempts`, so it cannot reach a board (D-40's mechanism).
- `selfReport` (D-77) rides along with a Clássico guess exactly as on the daily: stored, never
  scored.

## 6. Cost

See `05-cost.md` §3.6: ~3,600 reads for an eight-player Batata Quente that fills the map; a dozen
such games a day fit in the free tier. One callable, no `minInstances`.

## 7. Testing

- Unit: `test/match.test.ts`, `potato.test.ts`, `room.test.ts`, `multiplayer.test.ts`.
- Rules: `test/rules/firestore.rules.test.ts` — players read, outsiders, removed players and
  listing refused, `roomSecrets` closed, every client write denied.
- E2E: `test/e2e/multiplayer.e2e.ts` — three accounts (invited host, plain account, guest) play a
  whole Batata Quente to a full map, then in the SAME room a whole Clássico and a rematch; the
  standing room, configure, remove and the `versus` alias.
- By hand: `02-architecture.md` §8, "Multijogador with several players on one machine".

## 8. Not in v1

A Multijogador history or ranking; banning a player (remove is not a ban); per-challenge clocks
in a custom game; sharing a saved game with another player; spectators; Batata Quente by continent; deleting the tournament backend (D-88's
follow-up, once nothing is running); TTL cleanup of old rooms; dropping the `versus` alias (D-102's
follow-up, the next backend PR).
