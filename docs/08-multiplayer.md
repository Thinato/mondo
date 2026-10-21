# 08 — Multijogador

Live rooms, played by everyone in them at once. Requirements are FR-12 and, for Fronteiras, FR-15;
decisions are D-87 to D-95, D-102 to D-106 and, for Fronteiras, D-107 to D-114 in `00-brief.md` §6.
Added 2026-10-12 as **Versus**; renamed Multijogador, and the room made to outlive its game, on
2026-10-18 (D-102–D-104); Fronteiras added 2026-10-21 (§5). Where this file says Versus it means the
same thing.

## 1. Why

Tournaments (`06-tournaments.md`) are asynchronous and belong to a group: you can only play
someone in your group, and a round takes a day. Versus is the replacement (D-88): a host makes a
**room**, sends its link to anyone — any group or none, a guest included — and everyone plays
**at the same time, on one clock**. Two games:

- **Clássico** — the challenge kinds of the daily, every player on the same challenge at once.
- **Batata Quente** — take turns naming a country nobody has named; the world map fills in.

And since 2026-10-21 a third, of another shape (§5): **Fronteiras**, two players on one continent's
map, a territory game with a rating — a room with no host, found by a queue, a link or the bot.

## 2. Shape

```
sala.html ──callable──▶ multiplayer({ op })     (one function, D-92)
    ▲                       │ transaction
    │ onSnapshot (D-87)     ▼
    └──────────── rooms/{id}              room: state, players, scores, the clock
                  rooms/{id}/prompts/{i}  Clássico: one prompt per challenge; reveal once closed
                  rooms/{id}/map/{code}   Batata Quente: one doc per named country; map/_base = land
                  rooms/{id}/map/_board   Fronteiras: the continent's board, written once at start
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
| `join { room }` | anyone signed in | takes a seat (≤ 8, between games only); idempotent; returns `mine` for a running Clássico, and the caller's own saved `presets`. A Fronteiras room (peeked first): the second seat starts the game; its creator reopening the link is a no-op |
| `leave { room }` | a player, between games | frees the seat; the host's seat passes on |
| `configure { room, presetId }` or `{ room, custom }` | the host, between games | the next game (FR-12.7): a preset, never `treino`, or a custom Clássico (FR-12.10, §3.1), refused here with `no-countries-left` if the pool cannot fill it; keeps the room open two more hours |
| `savePreset { preset }` | admin, invited, subscriber | saves a custom game under its name on `users/{uid}.presets` (FR-12.11): same name overwrites, ≤ 10; returns the list |
| `deletePreset { name }` | anyone signed in | removes one of their own saved games; returns the list |
| `remove { room, uid }` | the host, between games | takes another player's seat (FR-12.8); not a ban |
| `start { room }` | the host, ≥ 2 players, between games | builds the card (Clássico) or the turn order and the land (Batata Quente); after a game, first deletes its prompts and map (§2.3) |
| `tick { room }` | a player | moves the room on if — and only if — its deadline has passed. Fronteiras: a draft pick's timeout aborts, a play turn's flags the mover |
| `guess { room, guess, selfReport? }` | Clássico player | one guess on the challenge on screen |
| `answer { room, names[] }` | Batata Quente player on turn | the first acceptable of ≤ 2 names (≤ 10 in training, and every acceptable one); `accepted` is a list |
| `giveUp { room }` | a player | Clássico: this challenge at 0. Batata Quente: out of the turn order. Fronteiras: an abort in the draft, a resignation in play, a timeout once the deadline has passed (§5.3) |
| `queue {}` | anyone signed in | Fronteiras (FR-15.9): seats the caller in the nearest waiting slot and starts the game, or opens/refreshes the caller's own slot; `{ room, matched }`. Called again every 10 s while waiting |
| `challenge {}` | anyone signed in | Fronteiras: the caller's waiting room with its queue closed, or a new one — the link; `{ room }` |
| `bot {}` | anyone signed in | Fronteiras (FR-15.10): seats `~bot` in the caller's waiting room or a new one and starts an unrated game |
| `move { room, action }` | the Fronteiras player on turn | `action` is `{ t, code }` with `t` one of `pick`, `take`, `attack`, `fortify`, or `{ t: "pass" }`; then the bot, if it is its turn, until it is not |
| `ratings { scope }` | anyone signed in | `"all"` or `"groups"`: the top 100 settled ratings (FR-15.12); read-only |

### 2.2 What is pure

All the rules are in `backend/functions/src/lib/` and unit-tested without Firestore:
`room.ts` (lobby, configure, remove, finish), `multiplayer.ts` (presets, Clássico, speed points),
`potato.ts` (turns, timer, points, end), `match.ts` (typed names), `world.ts` (the map pieces),
`fronteiras.ts` (the board, values, actions, ends), `bot.ts`, `glicko.ts` and `ladder.ts` (rating,
pair cap, queue window). `multiplayer.ts` and `fronteiras.ts` at the top level are I/O only.

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

## 5. Fronteiras (FR-15)

Two players, one continent of the real map, no dice and nothing hidden: every number is on the
board, as on a chessboard. Rated games move a Glicko-2 rating. Decisions D-107 to D-114. Rules are
`lib/fronteiras.ts`, the bot `lib/bot.ts`, the rating `lib/glicko.ts` and `lib/ladder.ts`; the I/O is
`src/fronteiras.ts`, reached from the one switch in `multiplayer.ts` (D-92).

### 5.1 The rules

- **The board** (D-109): the server picks Europa (45), Ásia (48), Américas (35) or África (54) and
  writes `map/_board` once — `{ viewBox, paths, adj, links, labels, rules }`, each member's `world.json` outline or
  dot, 35–63 KB. Adjacency is `data/borders.json` (`03-geo-data-pipeline.md` §9): shared land
  borders within the continent plus reviewed sea routes (D-115), drawn on the map as dashed lines and
sent as `links: ["FR-GB", …]` (Firestore takes no array of arrays), so every board is connected.
- **Values** (D-108): 1–5, the territory's quintile of total GDP (PPP) within its continent,
  computed at start and stored in `fronteiras.values` — per-match, so Impérios can change them by
  era.
- **Draft**: order by coin; snake A B B A A B, three territories each, 30 s a pick. The first pick
  is the capital. A pick may not border a territory the opponent holds, and a capital must border at
  least two territories (D-114). Fallback, in order: the non-bordering picks, narrowed for a capital
  to those with two neighbours; if none has two, any non-bordering pick; if every free territory
  borders the opponent, any free one.
- **A turn is one action**, paid for in gold. At the start of each of your turns you get 1 gold per
  territory held (`incomeOf`, D-114). Then: **take** an adjacent neutral (its value); **attack** an
  adjacent enemy (its value + its fortification, + `CAPITAL_DEFENCE` 12 on the capital; it changes
  hands and its fortification goes); **fortify** your own (+1, cost 2); or **pass**. No attacks in
  the first `TRUCE_PLIES` (4) plies of play — each player's first two turns.
- **The end**: taking the enemy capital wins; a flagged clock loses; after 30 turns each the higher
  value held wins, equal is a draw. `giveUp` resigns in play and aborts in the draft.
- **The clock**: 5 min + 3 s a move each (`CLOCK_MS`, `INCREMENT_MS`), debited from
  `turnStartedAt` on the server; `deadline` is what the page counts down to and what `tick` checks. A
  `move` at or after it throws `deadline-passed` and writes nothing; the client then ticks, as Batata
  Quente does.

### 5.2 Meeting: queue, challenge, bot

- **The queue slot is the waiting player's own room** (D-111): `room.queue = { open, rating, since,
  seenAt }`, one seat, `hostUid: null`. `queue` scans `rooms where queue.seenAt ≥ now − 25 s` (50 at
  most) outside the transaction, picks the nearest rating within the wider of the two windows (±150,
  +50 per 10 s waited), then re-checks the pick inside it: still a one-seat lobby with its queue open,
  its owner's `fronteirasRoom` still pointing at it, still fresh and in window. A match starts the game
  in the candidate's room and closes the caller's own waiting room (`queue: null`, `finished`). No
  match refreshes `seenAt`. The waiting page calls `queue` every 10 s and is told of a match by the
  room listener it already has. After 30 s it offers the bot.
- **A challenge** is the caller's waiting room with `queue: null` (or a new one); its id is the link.
  `join` by a second player starts it; the creator reopening it is a no-op.
- **The bot** (D-113) is `~bot`: no clock entry, no user doc, never rated. It is seated in the
  caller's room and moves inside the transaction that hands it the turn — at start, draft included,
  and after every human `move` — until the turn is the human's.

### 5.3 Transactions

One rule makes "one live game per account" hold: **every Fronteiras transaction that can seat the
caller (`queue`, `challenge`, `bot`, `join`, settle) reads the caller's user document first**, with a
plain `tx.get`, and takes `fronteirasRoom` from that snapshot; **every read comes before any write**.
So a `queue` in one tab and a `join` in another conflict on the user document and the retry finds a
game `playing` → `already-playing`, with its id. `ensureProfile` is not called (it writes as it
reads); a missing profile is created in the write phase. Each op stamps `google`, `rating` and
`provisional` on **the caller's own seat**, from the caller's own token and user doc; `start` reads
both seats and never infers another player's provider.

- **Settle first.** `queue`, `challenge` and `bot` first run a transaction that reads the caller's
  room and, if it is `playing` and past its deadline, applies the timeout and ends it; the reply is
  `{ room, settled: true }` and the client calls again. That, or the opponent's `tick`, is how an
  abandoned game ends (D-112).
- **`join`** peeks the room's mode outside a transaction to choose which one runs — Fronteiras reads
  the joiner's user first, the other modes the room — at one read per join in every mode.
- **`move`** reads the room, applies the action and runs the bot (pure); only if that ended a rated
  game does it read the two users, still before any write.
- **`tick`** settles a passed deadline: in the draft an abort, in play a flag. **`giveUp`** after the
  deadline settles as that same timeout, not as a resignation.
- **`endGame`** runs only in the transaction that flips `playing → finished`: when `rated`, it rates
  both players and writes both `users/{uid}.fronteiras`, records the before/after on
  `fronteiras.result.ratings`, and calls `finishRoom` (D-105), which names the winner's trophy and
  closes the room (`expiresAt = finishedAt`, D-107). Every later `tick`, `move`, `giveUp` or settle
  reads `finished` and does nothing, so a rating moves exactly once. An unrated or aborted game writes
  nothing to `users` at the end.

### 5.4 Rating (FR-15.7, D-110)

Glicko-2, τ 0.5, start 1500 / 350 / 0.06, one rating period a day: a record is first grown by the
whole days since its last game (`preRate`, RD capped at 350), then rated on that one game with no
second inflation. Provisional while RD > 110 (`settled: false`): shown as "1500?" and off the
leaderboard. `users/{uid}.fronteiras` holds `rating`, `rd`, `vol`, `settled`, `games`,
`lastPlayedAt`, the last 30 games (`history`, the opponent by display name) and `recent` (the last
24 h's rated opponents by uid, for the pair cap). `getProfile` shows all of it but `recent`, at no
extra read. `ratings` is an Admin query, `fronteiras.settled == true` ordered by rating, limit 100,
over two composite indexes (one with `groups` for "Meus grupos"); it gives anyone signed in uid,
display name, rating, games and last game — never a role, a group or an email.

### 5.5 Integrity (FR-15.8, D-112)

Rated = both seats `google` (`sign_in_provider === "google.com"`; the emulator also takes
`password`), no bot, and neither player's `recent` holding the other 3 times in 24 h — decided at
start, recorded at finish. A guest gets no record. An abort (draft `giveUp` or a pick's 30 s) has no
result, no rating, no `recent`. Leaving is not a rule: the clock flags it.

### 5.6 Balance (D-114)

The spec's rules — income the sum of values, no draft constraints — were measured by
`test/fronteiras-sim.test.ts`: the greedy bot against itself, 10 % of moves random. CI asserts only
that every simulated game is legal and terminates; `SIM_GAMES=N npm test` prints the table, which is
recorded here, never asserted. As specified, at 2,000 games a continent, the Americas' median game
was 1 ply with 92 % of capitals taken before ply 8, and the first player won 81 % in Europe and 86 %
in the Americas; no `CAPITAL_DEFENCE` from 5 to 20 and no komi helped, because 12–15 gold a turn
outran every cost. With D-114's four rules and D-115's reviewed sea routes, 2,000 games a continent:

| | first player wins | draws | median plies | p10 | capital | 30-turn count | capital before ply 8 |
|---|---|---|---|---|---|---|---|
| Europa | 52.0 % | 0.9 % | 29 | 14 | 73.5 % | 26.4 % | 0 % |
| Ásia | 50.6 % | 1.8 % | 50 | 14 | 55.1 % | 44.9 % | 0 % |
| Américas | **59.3 %** | 0.9 % | 58 | 17 | 51.5 % | 48.5 % | 0 % |
| África | 46.5 % | 0.8 % | 32 | 14 | 68.1 % | 31.9 % | 0 % |

**Targets**: first player 45–55 %, draws ≤ 15 %, median 25–55 plies, no capital before ply 8. All
are met except the Americas' first player and its median, where half the games reach the 30-turn
count — partly the bot, which does not march down a long board. The Americas' 59 % is the bot's
draft, not the board: it takes the highest value with the fewest neighbours, and once the Florida
Straits gave the US four, its first pick became Chile in 90 % of games, a southern fortress that wins
60 %. Cutting one real route (US–Bahamas) reads 50 %; tuning geography to one bot's heuristic was
rejected (D-115). It is a bot, not people.
**Every one of the four rules is load-bearing** (each taken out alone breaks a continent; D-114 has
the numbers), so do not remove one without re-running `SIM_GAMES`. The knobs, in order:
`CAPITAL_DEFENCE`, `FORTIFY_COST`, then the rules.

## 6. Security notes

- Room doc: prompts and counts only (§3). Prompts: reveal only after close. Map: only named
  countries. `roomSecrets`: closed to everyone.
- **The residual** (D-89): a finished Batata Quente hands its players the outlines it named —
  what an atlas shows. The gate is being in a room; anyone with a link is. Since D-93 anyone
  signed in can open a training room alone, so the gate is now just being signed in.
- A Multijogador result never reaches `attempts`, so it cannot reach a board (D-40's mechanism).
- **Fronteiras holds nothing hidden** (SEC-19): no `roomSecrets`, no `dailyAhead` read. Its values
  are quintiles of total GDP, never of the per-capita `gdp` answer (D-108). **Its residual** (D-109):
  `map/_board` hands anyone signed in a continent's outlines and projected Natural Earth centroids —
  D-93's capability, a few clicks away instead of fifty names. `users/{uid}.fronteiras` and
  `fronteirasRoom` are functions-only; `ratings` exposes uid, name and rating of up to 100 players
  (D-110), and `recent` is never sent.
- `selfReport` (D-77) rides along with a Clássico guess exactly as on the daily: stored, never
  scored.

## 7. Cost

See `05-cost.md` §3.6: ~3,600 reads for an eight-player Batata Quente that fills the map; a dozen
such games a day fit in the free tier. Fronteiras is §3.7: ≈ 190 reads a game between people, ~90
against the bot, up to 100 per opened leaderboard. One callable, no `minInstances`.

## 8. Testing

- Unit: `test/match.test.ts`, `potato.test.ts`, `room.test.ts`, `multiplayer.test.ts`;
  Fronteiras `fronteiras.test.ts`, `bot.test.ts`, `glicko.test.ts` (Glickman's worked example),
  `ladder.test.ts`, and `fronteiras-sim.test.ts` (§5.6).
- Rules: `test/rules/firestore.rules.test.ts` — players read, outsiders, removed players and
  listing refused, `roomSecrets` closed, every client write denied; a Fronteiras player reads
  `map/_board`, and no client writes `users/{self}.fronteiras` or `fronteirasRoom`.
- E2E: `test/e2e/multiplayer.e2e.ts` — three accounts (invited host, plain account, guest) play a
  whole Batata Quente to a full map, then in the SAME room a whole Clássico and a rematch; the
  standing room, configure and remove. `test/e2e/fronteiras.e2e.ts` — queue match, challenge link,
  illegal moves, a capital capture rating both players once, the pair cap, a guest's unrated game, a
  draft abort, a flag, the bot first and second, the leaderboard, and a queue slot that can no longer
  be matched once its player joined a challenge. Both suites take their emulator hosts from the
  environment and refuse to start without them, so they cannot clear a running dev Firestore.
- By hand: `02-architecture.md` §8, "Multijogador with several players on one machine".

## 9. Not in v1

A Multijogador history or ranking; banning a player (remove is not a ban); per-challenge clocks
in a custom game; sharing a saved game with another player; spectators; Batata Quente by continent; deleting the tournament backend (D-88's
follow-up, once nothing is running); TTL cleanup of old rooms. Fronteiras: Impérios (values by
era, events); a rematch on the same link; Oceania; more than one time control; a cached top-100;
rating Clássico or Batata Quente.

**A whole-world Fronteiras board** was measured and deferred (Paulo, 2026-10-21). On one board of
all 196 (377 edges, diameter 26 hops) the four rules of §5.1 play fair only with one action a turn
and 60 turns each (bots, 1 000 games: first player 49.6 %, captures 55 %, ~8 min); at 30 turns it is
the continent game on a bigger picture, and two or three actions a turn hand the first player
54–57 % and flag a third of games. Either way a game touches about 15 % of the map. What stops it is
not balance but D-89: the board would be the whole labelled world map, outlines and microstate dots,
in a document anyone with a room link reads — the map D-89 keeps server-side because with the
distance hints it solves the daily. Revisit once that has an answer.
