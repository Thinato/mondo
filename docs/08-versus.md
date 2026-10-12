# 08 — Versus

Live rooms, played by everyone in them at once. Requirements are FR-12; decisions are D-87 to D-92
in `00-brief.md` §6. Added 2026-10-12.

## 1. Why

Tournaments (`06-tournaments.md`) are asynchronous and belong to a group: you can only play
someone in your group, and a round takes a day. Versus is the replacement (D-88): a host makes a
**room**, sends its link to anyone — any group or none, a guest included — and everyone plays
**at the same time, on one clock**. Two games:

- **Clássico** — the challenge kinds of the daily, every player on the same challenge at once.
- **Batata Quente** — take turns naming a country nobody has named; the world map fills in.

## 2. Shape

```
sala.html ──callable──▶ versus({ op })          (one function, D-92)
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
- **Writes** are only ever `versus`. Every op asserts auth, validates its input, and runs one
  transaction. Every reply carries `serverNow`; the page keeps an offset from it and draws the
  countdown from the room's `deadline`.
- **The clock** is enforced lazily (invariant 3): an answer after the deadline is refused by the
  server's clock, and every client calls `op: "tick"` when its countdown ends. The first tick
  through the transaction moves the room on; the rest find nothing due and return
  `moved: false`. Nothing is scheduled, and a room every client has left simply stops.

### 2.1 Ops

| op | who | does |
|---|---|---|
| `create { presetId }` | admin, invited, subscriber (FR-10.3) | new lobby, host in the first seat |
| `join { room }` | anyone signed in | takes a seat (≤ 8, lobby only); idempotent; returns `mine` for a running Clássico |
| `leave { room }` | a player, in the lobby | frees the seat; the host's seat passes on |
| `start { room }` | the host, ≥ 2 players | builds the card (Clássico) or the turn order and the land (Batata Quente) |
| `tick { room }` | a player | moves the room on if — and only if — its deadline has passed |
| `guess { room, guess, selfReport? }` | Clássico player | one guess on the challenge on screen |
| `answer { room, names[] }` | Batata Quente player on turn | the first acceptable of ≤ 10 names (every acceptable one, in training); `accepted` is a list |
| `giveUp { room }` | a player | Clássico: this challenge at 0. Batata Quente: out of the turn order |

### 2.2 What is pure

All the rules are in `backend/functions/src/lib/` and unit-tested without Firestore:
`room.ts` (lobby), `versus.ts` (presets, Clássico, speed points), `potato.ts` (turns, timer,
points, end), `match.ts` (typed names), `world.ts` (the map pieces). `versus.ts` at the top level
is I/O only.

## 3. Clássico (FR-12.2)

- **Presets, not settings** (D-48's reasoning): `mundo` (Batata Quente), `dia` (the 7 kinds),
  `bandeiras`, `formas`, `capitais`, `misto-10`. The client sends the id.
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
- **The queue**: there is no autocomplete. Names typed while waiting go in a queue (≤ 10) and are
  sent in one call the instant the turn comes round; the server takes the first acceptable and
  reports the rest. A pre-written hit lands with almost the whole clock left.
- **The end**: every country named, or two full rounds with no answer (`passStreak ≥ 2 ×
  active`), or everyone gave up. Most points wins; ties to less total answer time.
- **The map** (D-89): Natural Earth 1:50m, Equal Earth, built by `tools/build-world.mjs` into
  `backend/functions/src/data/world.json` (167 outlines, 29 dots for countries too small to see,
  174 KB). Server-only. The grey land goes to `map/_base` at start; a country's mark is written
  only once it is named.

### 4.1 Training (FR-12.5, D-93)

The `treino` preset is Batata Quente for one, with no clock. It is started from the Treinar page (`praticar.html`, the last entry of the picker), and played on `sala.html`, because the map arrives by a listener and invariant 2 keeps listeners to that one page. `create` makes the room already
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

- Unit: `test/match.test.ts`, `potato.test.ts`, `room.test.ts`, `versus.test.ts`.
- Rules: `test/rules/firestore.rules.test.ts` — players read, outsiders and listing refused,
  `roomSecrets` closed, every client write denied.
- E2E: `test/e2e/versus.e2e.ts` — three accounts (invited host, plain account, guest) play a whole
  Batata Quente to a full map and a whole Clássico.
- By hand: `02-architecture.md` §8, "Versus with several players on one machine".

## 8. Not in v1

A Versus history or ranking; kicking a player; spectators; Batata Quente by continent; deleting
the tournament backend (D-88's follow-up, once nothing is running); TTL cleanup of old rooms.
