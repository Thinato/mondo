# Tournaments (Phase 3) — design

Status: **§2 confirmed by Paulo 2026-09-09; slices 1–2 built the same day.** Written before any
code, because the roadmap says so and because one decision in §2 changes everything downstream.
Slices 3–6 (the pairing formats) are still design only. Where this document and the code
disagree, the code is right and this is a bug — the review notes in §16 say what was already
found that way.

Scope: the tournament engine Paulo asked for — single elimination, double elimination, round
robin, Swiss, free-for-all; every format tolerant of odd player counts; rounds made of N
challenges in a chosen or randomised order; challenge kinds beyond the silhouette (flag,
capital, GDP, …). Admin and organizers create tournaments in the groups they own (FR-7.3);
members of those groups take part (FR-7.4).

---

## 1. What is actually being built

Three things that get conflated and must not be:

| Concern | What it is | Where it lives |
|---|---|---|
| **Challenge kind** | how one question is asked and graded | `lib/kinds/*.ts`, pure |
| **Card** | N challenges in an order, played by one player, producing one score | `lib/card.ts`, pure; played through two callables |
| **Format** | who is compared to whom, who is out, what the standing is | `lib/tournament/*.ts`, pure |

The whole design is the claim that these three are independent: any format runs on any card,
any card is built from any kinds. Five formats × four kinds is nine pieces of code, not twenty.

---

## 2. The spine: duplicate scoring

**Any two scores that are ever compared come from the same card.** Nobody plays *against* anybody
in real time — this is an async game, and Phase 5 is where live head-to-head lives (roadmap).

That is the whole of **D-38**, and it is deliberately stated as a rule about *comparisons* rather
than about rounds. The normal consequence is one card per round, shared by everyone still in. The
exceptions are the tie-resolution cards of §6.4 — a sudden-death challenge, or a replayed round —
which only the tied players see. Those still honour the invariant, because the two scores being
compared came from the same card; they simply do not need the rest of the field.

What follows:

- **One card per round**, not one per pairing. Twenty players in a Swiss round read one card and
  write one play document each.
- **Fairness is structural.** Comparing scores across *different* cards would let card difficulty
  decide who advances. Comparing scores on the same card cannot. This is how duplicate bridge has
  scored pairs for a century, and how puzzle-rush tournaments work.
- **Byes become trivial.** A bye is "paired with nobody this round". The bye player can still play
  the card — their score counts for tiebreaks — and is credited a win.
- **Every format collapses to arithmetic over one table**: `round × uid → { points, elapsedMs }`.
  Formats differ only in how they pair, who they drop, and how they aggregate. No format needs its
  own play path, its own scoring, or its own client screen.
- **Eliminated players can keep playing.** The card is shared, so letting knocked-out players play
  it for a shadow ranking costs nothing and fixes elimination's real problem: half the group has
  nothing to do after round one. Config `consolation`, default on.

The cost of D-38: in a bracket, your result does not depend on who you were drawn against, only on
who else played that card. Beating a strong opponent and beating a weak one take the same
performance. Pairing still decides who is *knocked out*, and Swiss still pairs by standing, so the
draw is not decorative — but if Paulo's mental picture of "single elimination bracket" was two
people racing each other on the same puzzle at the same moment, that is Phase 5, not this.

The alternative (a card per pairing) was rejected: n−1 cards per round-robin player, cross-match
difficulty variance deciding brackets, and roughly five times the documents for a worse game.

---

## 3. Requirement changes

FR-5 currently describes a one-off two-to-eight player challenge. That is exactly the degenerate
tournament: **free-for-all, one round, one shape challenge**. So FR-5 is rewritten rather than
joined by a parallel FR, and the pieces worth keeping are kept.

Proposed replacement text, to be adopted into `01-requirements.md` when §15 is settled:

- **FR-5.1** An `admin` or `organizer` MUST be able to create a tournament in a group they own
  (FR-7.3, FR-7.5) by choosing one of the **built-in presets** (§6.5). The preset is resolved
  server-side into the tournament's settings, which are then immutable. Client-supplied settings
  are not accepted in Phase 3; user-defined presets are a later phase.
- **FR-5.2** The **server** selects every challenge subject. The creator does not choose it and
  does not see it (D-10 unchanged). A subject MUST NOT be one already used in the same tournament,
  and MUST NOT appear in the daily schedule within ±60 days of today.
  *(Amends the old FR-5.2, which excluded countries "either participant has seen in the last 60
  days". Under D-38 everybody plays the same card and everybody plays the same daily, so
  "either participant has seen" and "the daily schedule window" are the same set — with none of
  the per-participant history reads.)*
- **FR-5.3** A tournament MUST be visible only to members of its group (FR-4.10 applies).
  There is no join link and no public tournament: the group's invitation is the only door
  (FR-1.7 unchanged).
- **FR-5.4** A tournament MUST support 2 to 200 participants in free-for-all, and 2 to 32 in the
  pairing formats. Every format MUST handle an odd count (§7).
- **FR-5.5** In a round, every participant still in the tournament MUST be served the identical
  card, and MUST play it under that kind's rules (D-38).
- **FR-5.6** No participant's result for an open round — score, guesses, or outcome — MUST be
  visible to any other participant until the round closes. Their own result is visible immediately.
- **FR-5.7** A round MUST have a server-set deadline. A participant who has not finished the card
  by the deadline scores 0 for that round and loses their pairing (a forfeit, not a bye).
- **FR-5.8** A tournament MUST show a standing appropriate to its format and regime, and a bracket
  where the format has one, ranked by the tournament's own tiebreak chain.
- **FR-5.11** *(new)* A tournament MUST run under one of two regimes (§6.1). Under `aggregate`,
  card scores accumulate and the highest total wins, so a player MAY become uncatchable before the
  final round and nobody is eliminated. Under `match`, a card score decides only which player won
  that round; it MUST be displayed and MUST NOT be carried into the final result, and the winner
  is the player who kept winning. `aggregate` MUST be offered only for `free_for_all`; the four
  pairing formats MUST run under `match` (§6.1 says why for each).
- **FR-5.12** *(new)* A tie that the tournament's comparator chain cannot separate MUST be resolved
  by the configured policy: sudden-death challenges added until the scores differ, a replay of the
  round for the tied players, the better seed, or a recorded draw where the standing allows one.
  Both tied players MUST receive the identical sudden-death or replay card (D-38).
- **FR-5.9** *(unchanged, and now structurally enforced — §4.4)* Tournament results MUST NOT
  contribute to any group or global daily leaderboard.
- **FR-5.10** *(new)* The tournament manager MUST be able to close the open round early and to
  cancel the tournament. Both MUST be idempotent.

New requirement group, for the kinds:

- **FR-8.1** A challenge kind MUST define: how a subject is picked, what prompt the client may
  see, how many guesses it allows, how a guess is graded, what feedback it returns while unsolved,
  and how a finished challenge scores.
- **FR-8.2** Every kind MUST score a single challenge on the same scale, 0 to 6 points, so a card
  of mixed kinds is summable. Six for a first-guess solve matches FR-3.1.
- **FR-8.3** A card score is the sum of its challenges' points. Total elapsed server time over the
  card MUST be recorded, and is the **default** next comparator, lower first (FR-3.2's rule) —
  but whether it is in a tournament's comparator chain is a preset choice, because a knockout that
  wants sudden death (FR-5.12) must be able to leave it out.
- **FR-8.4** A kind's feedback MUST NOT name or otherwise identify the answer while the challenge
  is unsolved (SEC-1 applies unchanged to every kind).
- **FR-8.5** The manager MUST be able to specify a card as a multiset of kinds and choose whether
  the order is as listed or shuffled. A card MAY be five challenges of one kind.

Two documents contradict this phase and must be amended, not quietly overridden:

1. `00-brief.md` §3 non-goals lists "Anything beyond country silhouettes (no flags, no capitals,
   no 'guess the country from a photo')". That was a **v1** boundary and Phase 3 crosses it
   deliberately. Photos stay out (an asset pipeline with a licensing problem, D-15's lesson).
2. **FR-1.5** (account deletion) gains a clause: deletion must also scrub the participant's name
   snapshot from every tournament they entered (§4.5). This is the one place where D-21's "a
   deleted account just leaves the board" cannot apply, because a bracket with a hole in it is
   unreadable.

---

## 4. Data model

### 4.1 `tournaments/{tid}` — **no client access**, Admin SDK writes only

Top level, not `groups/{gid}/tournaments/{tid}` as the Phase 2 plan §4.10 guessed. Three reasons,
all found while writing this:

1. The answers have to live somewhere near, and `groups/{gid}` is **member-readable**. One future
   edit adding `match /groups/{gid}/{document=**} { allow read: if inGroup(gid); }` — the obvious
   thing to write when someone wants tournament metadata on the client — would publish every
   answer. Nothing that holds an answer goes under a readable path.
2. Firestore does not delete subcollections with their parent. D-23 deletes a group when its last
   member leaves; nested tournaments would survive it, invisible and unreachable.
3. The client never loads the Firestore SDK (CLAUDE.md invariant 2), so `inGroup` would have bought
   nothing anyway. Membership is checked in the callable, exactly as `getLeaderboard` does.

```
groupId          string
name             string      3–40 chars, FR-4.1's validator
preset           string      which built-in preset it was created from (§6.5); kept for the record
format           "free_for_all" | "single_elim" | "double_elim" | "round_robin" | "swiss"
regime           "aggregate" | "match"                                        §6.1
config           map         the preset resolved into concrete settings (§6.5): card spec, rounds,
                             tiebreak chain, bye policy, consolation. Frozen at creation, so
                             editing a preset later cannot change a running tournament.
status           "draft" | "running" | "finished" | "cancelled"
createdBy        uid
createdAt        timestamp
startedAt        timestamp|null
endedAt          timestamp|null
participantUids  string[]    for the array-contains sweep in deleteAccount; ≤ 200
participants     map<uid, { seed: number, displayName: string, joinedAt: timestamp }>
currentRound     number|null
roundCount       number|null set at start for the formats that know it up front
```

`displayName` is a **snapshot** taken when the tournament starts. A tournament is a historical
record: it does not follow renames, unlike the daily board (D-26). It is scrubbed on account
deletion (§4.5).

### 4.2 `tournaments/{tid}/rounds/{n}` — **no client access**

The round log is the source of truth, and standings are a **pure fold over it** — recomputed from
scratch on every advance, never mutated incrementally. That is D-25's lesson applied: at ≤ 20
documents a full recompute is cheaper than a drift bug.

```
n           number      1-based
opensAt     timestamp
closesAt    timestamp   aligned to a puzzle-day noon boundary (§8)
closedAt    timestamp|null
cardId      string      "{tid}_r{n}" → cards/{cardId}
pairings    [{ a: uid, b: uid|null, winner: uid|null, drawn: boolean, bye: boolean }]
bracket     map         format-specific slot bookkeeping (which bracket, which slot feeds where)
results     map<uid, { points, elapsedMs, guessCount, played: boolean }>   written at close
tie         null | { k: number, uids: [uid, uid], cardId, closesAt, kind: "sudden_death"|"replay" }
            §6.4 — an unresolved pairing holds the round open as a sub-round; the next round is
            not paired until `tie` is null again

```

### 4.3 `cards/{tid}_r{n}` — **no client access, ever**, sibling of `puzzles` (SEC-7)

```
tournamentId  string
round         number
items         [{ kind: "shape"|"flag"|"capital"|"gdp", subject: "PY", ...kind payload }]
createdAt     timestamp
```

The card is **stored, not derived from a seed**. A seed plus a generator means the generator can
never change without rewriting history; `puzzles` set that precedent already.

### 4.4 Play documents live in `attempts` — and that is what enforces FR-5.9

`attempts/{uid}_{tid}_r{n}`, with `mode: "match"` and **no `puzzleId` field**.

Four things fall out for free, which is why the play path is not a new collection:

- `rebuildStandings` cannot see them. It queries `where("puzzleId", ">=", from)`, and a Firestore
  inequality filter never returns documents that lack the field. **FR-5.9 becomes a property of the
  data, not a filter somebody has to remember** — and it needs no composite index, which
  `firestore.indexes.json` being empty depends on. *Verified against the emulator 2026-09-09: with
  a daily attempt and a `mode: "match"` attempt side by side, the 30-day range query returned only
  the daily one, while `where("uid", "==", …)` — the deletion sweep — returned both. This is the
  single claim the whole §4.4 argument rests on, so it was measured rather than assumed; slice 1
  should pin it with a permanent test.*
- The rules read allow, `attemptId.split('_')[0] == request.auth.uid`, already gives a player their
  own play documents and nobody else's. Uids are alphanumeric (`requireUid`), so the split holds.
- `deleteAccount` already deletes `attempts where uid == uid` in batches: tournament play is swept
  with no new code.
- The admin's `listAttempts` needs **one small extension**, not a rewrite. Both of its paths miss
  match attempts today, and by construction rather than by accident: the `puzzleId` path filters on
  a field these documents lack, and the `uid` path `getAll`s 31 deterministic daily ids. So a third
  query is added — `where("uid", "==", target).where("mode", "==", "match")`, equality-only and
  therefore served by index merging with no composite index. This matters more than it looks:
  SEC-13 and SEC-14 below name the admin timing surface as the *whole* mitigation for tournament
  cheating, so leaving it blind to tournaments would make that mitigation fiction.

```
uid, tournamentId, roundId "{tid}_r{n}"
mode         "match"
startedAt    timestamp   server (SEC-3)
finishedAt   timestamp|null
cursor       number      index of the challenge being played; the card is strictly sequential
items        [{ kind, guesses: [...], solved, points, elapsedMs, finishedAt }]
points       number      sum over items
elapsedMs    number|null total over the card
suspicious   boolean     any item solved first-guess under SUSPICIOUS_SOLVE_MS
```

Sequential, no going back: a player cannot read all five prompts, then look five things up in
parallel. It does not stop them looking up the current one (§10).

### 4.5 Account deletion (FR-1.5 amendment)

`deleteAccount` gains one step: `tournaments where participantUids array-contains uid` — a
single-field query, no composite index, bounded by ten groups' worth of tournaments — and for each,
overwrite `participants.{uid}.displayName` with the neutral placeholder. The uid stays (it is the
bracket slot); the personal data goes. Their play documents are already deleted by the existing
attempts sweep, so every round they were in reads as a forfeit, and the fold in §4.2 keeps the
bracket coherent by construction.

### 4.6 Composite indexes

Still none. `participantUids array-contains`, `tournaments where groupId ==`, `status ==`, and
`getAll` by deterministic id are all single-field. `firestore.indexes.json` stays empty.

---

## 5. Challenge kinds

### 5.1 The interface

```ts
export interface ChallengeKind<Answer, Guess, Feedback> {
  id: "shape" | "flag" | "capital" | "gdp";

  /** Pick a subject not in `exclude` (FR-5.2). Deterministic given `rand`. */
  pick(exclude: ReadonlySet<string>, rand: () => number): Answer;

  /** What the client may see. MUST NOT identify the answer (FR-8.4, SEC-1). */
  prompt(a: Answer): unknown;

  /** How many tries this kind allows. */
  maxGuesses: number;

  /** Validate and grade one guess. `feedback` names nothing while unsolved. */
  guess(a: Answer, g: Guess, prior: readonly Guess[]): { correct: boolean; feedback: Feedback };

  /** 0..6 (FR-8.2), from the finished item. */
  score(item: { solved: boolean; guessCount: number }): number;

  /** What the client may see once the item is over. */
  reveal(a: Answer): { label: string };
}
```

The generics matter: `gdp`'s guess is a number and its feedback is "too low", so nothing in the
interface may assume the answer is a country or the guess is a country code.

**The shipped daily is not refactored onto this.** `lib/round.ts` works, is tested and is playing
in production; rewriting it to be "a card of one shape challenge" is a Phase 4+ consolidation at
best. The `shape` kind reuses `lib/geo.ts` and `lib/scoring.ts`, which are already pure, and
duplicates about fifteen lines of glue. That is the cheaper mistake.

### 5.2 The four kinds

| kind | prompt | answer | guesses | feedback | data | status |
|---|---|---|---|---|---|---|
| `shape` | one inlined SVG path (D-13) | country | 6 | km + 8-point compass + proximity | `shapes.json`, `countries.json` | **exists** |
| `capital` | a capital city name | country | 3 | km + compass from the guess (reuses geo) | `world-countries.capital` | **free** — already a dependency |
| `flag` | one inlined flag, as filled paths | country | 3 | km + compass | `flags.json`, built from a vendored public-domain SVG set | **exists** (§5.3) |
| `gdp` | a country name (public) | a number | 3 | higher / lower + how close | GDP per country, with a vintage | blocked, OQ-12 |

**Not every country can be asked as a `capital`.** Fifteen name themselves in their own capital
— Brasília/Brasil, Cidade do México/México, Singapura/Singapura, Bissau/Guiné-Bissau,
Argel/Argélia, Túnis/Tunísia and the city-states — and for four of them the prompt is
byte-identical to an entry in the client's autocomplete, so typing the prompt back solves the
item. That is SEC-1 broken by the prompt itself, not the cheap-lookup residual SEC-13 concedes,
so `capital.pool()` excludes any country whose folded capital name contains, or is contained in,
its folded country name. Found by the security review; `test/kinds.test.ts` pins the list.

`capital` is the second kind to build, precisely because it is nearly free and shares the
distance-feedback machinery with `shape`. An interface with one implementation is a fiction; two
implementations that share their feedback path prove the seam is in the right place before three
more formats get built on top of it.

### 5.3 The flag build (OQ-11)

`flag` is the only kind whose data is not simply "a field of `countries.json`", so it has its
own offline build: `tools/build-flags.mjs` reads the vendored `svg-country-flags` set (public
domain, Wikimedia-derived) and writes `backend/functions/src/data/flags.json`. Same shape as the
geo build: deterministic, committed, server-only, with a gitignored preview grid for a human to
eyeball. The dependency is pinned to an exact version rather than a caret range, because a bump
would silently redraw the pool; `flags.json` records the version it was built from.

**The wire format is data, not markup.** A flag is `{ viewBox, paths[] }`, where each path is a
`d` string plus a closed list of paint attributes, an optional `transform` and an optional
`clip`. `renderFlag` builds one `<path>` per entry and sets those attributes. The alternative —
shipping sanitised SVG source and parsing it in the browser — costs no flags and a client-side
allowlist, and the allowlist is where a mistake is a live XSS. Paying for it in a build script
instead is the trade this makes.

The converter flattens `<g>`, resolves `<use>` (which is how fifty identical stars are drawn
once) and folds a `<clipPath>` into the path that references it. It **refuses** what the flat
format cannot carry — a gradient, a filter, `<text>`, a clip inherited across a transform — and
the country is dropped with the reason printed. `<title>` is dropped rather than refused: in
this dataset it reads "Flag of Brazil", which is the answer (SEC-1).

**24 of the 196 countries have no flag**, and `flag.pool()` is what that means for play:

| why | countries |
|---|---|
| over the 40 KB per-flag budget | AD AF BT BZ DO ES HR HT ME OM PE RS SM SV TM |
| needs a gradient or a nested clip | BO CR EC GT MX NI |
| excluded by hand (SEC-1, `tools/flags.json`) | BN EG PY |

The budget is a per-response cap, since a card serves one item at a time, and it sits in the gap
the data itself leaves: Portugal's armillary sphere is the last flag under it at 36 KB, Oman's is
the first over it at 47 KB.

**That budget does most of the SEC-1 work by itself**, which was not the plan and is worth
recording. FR-8.4 says a prompt must not name its own answer, and a flag whose coat of arms
reads REPÚBLICA DOMINICANA does name it — an inlined SVG can be zoomed. Every such flag is a
coat-of-arms flag, and the emblem detail *is* the weight: Bolivia, Costa Rica, the Dominican
Republic, El Salvador, Guatemala, Nicaragua and Peru all fall out on size or on a gradient before
anyone judges their lettering. Three were small enough to slip through — Brunei, Egypt and
Paraguay — and those are the whole hand-maintained exclusion list, each with its reason, the
same shape as `tools/overrides.json` (D-14). Brazil stays: ORDEM E PROGRESSO is not its name.

`gdp` is the one that stresses the interface hardest — a numeric answer, error-band scoring, no
country to reveal — and it is the reason the interface is generic over the answer, the guess and
the feedback rather than assuming all three are countries. Suggested scoring: within 10 % → 6,
25 % → 4, 50 % → 2, else 0, minus one per extra guess, floored at 1 for any non-zero band. It is
sequenced after `flag` only because OQ-12 is still open, not because it is easier.

---

## 6. Scoring regimes, formats, and ties

### 6.1 Two regimes (D-49)

A format decides **who is compared to whom**. A *regime* decides **what a comparison is worth**,
and it is a separate switch:

| | `aggregate` — "points on" | `match` — "points off" |
|---|---|---|
| What a card score does | accumulates for the whole tournament | decides that round only |
| Who wins | the top of the table | whoever kept winning |
| Elimination | nobody | losers are out (or drop a bracket) |
| Can you clinch early? | yes — the leader can be uncatchable before the last round | no — you must keep winning |
| Are points visible? | they *are* the competition | shown every round, never carried |

`match` is the regime Paulo described as "like other games": you either win the round or you lose
it, your score is displayed but does not follow you, and a tie is settled by playing more rather
than by a stopwatch (§6.4).

The two regimes are **not** a free switch across all five formats, and the reason is D-38 itself.
Under a shared card, a pairing has no effect on anybody's score. So if pairings also do not decide
anything — which is what `aggregate` means — then the format is doing no work at all:

| format | `aggregate` | `match` |
|---|---|---|
| `free_for_all` | ✅ a league: totals decide, clinch early | ✅ heats: each round has one winner, most round wins takes it |
| `round_robin` | ❌ collapses | ✅ the classic table, 3/1/0 |
| `swiss` | ❌ collapses | ✅ classic Swiss, paired by standing |
| `single_elim` | ❌ incoherent | ✅ knockout |
| `double_elim` | ❌ incoherent | ✅ knockout |

Two different failures behind those crosses, both worth naming rather than discovering later:

- **Collapse.** `round_robin` or `swiss` under `aggregate` is *identical* to a `free_for_all`
  league with the same number of rounds — same cards, same totals, same winner — while displaying
  a fixture list that implies the draw matters. That is a worse product than not offering it.
  (This also kills a tempting analogy: the chess distinction between game points and match points
  does **not** apply here, because chess game points come from different games against different
  opponents, whereas card points under D-38 are opponent-independent by construction.)
- **Incoherence.** `aggregate` plus elimination cannot mean anything: a player knocked out in round
  two stops playing and cannot accumulate, and if they *do* keep playing (`consolation`, D-47) then
  the bracket has stopped deciding the winner. Elimination formats therefore run `match` and show
  an aggregate table beside the bracket as a side ranking — which is what the consolation players
  compete on.

So in practice "points on" means **`free_for_all` with several rounds**, and "points off" means
**any of the four pairing formats** — which is exactly the two games Paulo described. `regime`
stays an explicit field anyway, because `free_for_all` genuinely supports both and the heats
variant is a distinct game, not a degenerate one.

### 6.2 The formats

Each is one pure function over the score table and the round log. Everything they share is written
once, in `lib/tournament/core.ts`:

- `cardWinner(a, b, chain)` — points, then elapsed time, then seed. Draws only where a format
  allows them.
- `standings(rounds, config)` — match points, card points, total time. **Reuses `rankBy` from
  `lib/standings.ts` unchanged**: it already takes `(row) => { points, totalElapsedMs }` and
  already produces competition ranks (1, 2, 2, 4) exactly as D-24 wants.
- `assignBye(candidates, history, policy)` — §7.
- `seedOrder(participants, seedFrom, memberStats)` — `standing30` reads the group's member
  documents, which the 12:05 job has already computed (D-22). Zero new arithmetic.
- `alive(rounds, format)` — a fold, never a stored flag.

| format | regimes | rounds | pairing | standing | draws |
|---|---|---|---|---|---|
| `free_for_all` | both | config, default 1 | none | aggregate: card points → time · match: rounds won | n/a |
| `round_robin` | `match` | n−1 (even) or n (odd) | circle method | match points → card points | yes |
| `swiss` | `match` | config, default ⌈log₂ n⌉ | within score groups, no repeats | match points → card points | yes |
| `single_elim` | `match` | log₂(S), S = next power of two | bracket slots, top seeds meet last | last one standing | no |
| `double_elim` | `match` | ~2·log₂(S) | winners + losers brackets | last one standing | no |

### 6.3 Notes on each format

- **`free_for_all`** is FR-5's old one-off challenge with `rounds: 1` and a one-item card, and it
  is the first slice. With `rounds > 1` it is a league. `dropWorst` is available and defaults to 0
  (D-24's mechanism, borrowed, not re-implemented).
- **`round_robin`** uses the circle method with a ghost player when n is odd, which is the cheapest
  odd-count handling in the whole document: the player drawn against the ghost has the bye, and
  every player gets exactly one across the schedule. Match points default 3 / 1 / 0, configurable.
- **`single_elim`** seeds into the standard recursive bracket order (1 vs S, 2 vs S−1, …) so the
  top seeds cannot meet in round one. `S − n` byes go to the top seeds — the conventional reward
  for seeding well, and the "advantage" Paulo was willing to give the odd player.
- **`swiss`**: sort by standing, pair top half against bottom half within each score group, float
  the odd player down to the next group, bounded swap-and-retry when a pairing would repeat, bye to
  the lowest-standing player who has not had one. Buchholz stays off by default; it is a config
  flag, not a rewrite.
- **`double_elim`** is the only format with genuine bracket plumbing (the losers-bracket drop
  mapping, the grand final, and whether a bracket reset is allowed — `grandFinalReset`, default
  **off**, because a reset can double a tournament's length and these run at lunch). It is more
  work than the other four together. Build it last.

### 6.4 Ties (D-50)

A tie is resolved by a **comparator chain**, and only if the chain runs out does a policy fire:

```
tiebreak: {
  chain:      ["points", "time"] | ["points"],     // ordered comparators
  unresolved: "sudden_death" | "replay" | "seed" | "draw",
  suddenDeathMaxItems: number                       // default 5, a safety valve
}
```

- **`sudden_death`** appends one challenge at a time to a tiebreak card that only the tied players
  are served. First round in which their scores differ ends it. This is Paulo's "keep adding
  challenges until someone fails", and it honours D-38 because the two scores being compared still
  come from one card.
- **`replay`** issues a fresh full card to the tied players and re-runs the round for them alone;
  everyone else's result stands.
- **`seed`** hands it to the better seed — the silent, undramatic option, and the right one for a
  round that must resolve without another day passing.
- **`draw`** is legal only where the standing can hold one (`round_robin`, `swiss` under `match`).
  An elimination pairing cannot end drawn.

**Whether elapsed time is in the chain is the decision that matters here**, and it is a preset
choice rather than a global rule:

- With `["points", "time"]`, exact-millisecond ties are almost impossible, so `unresolved` will
  effectively never fire. This is right for `aggregate` presets — it is how the daily board already
  ranks (FR-3.2, D-24), so players already know the rule.
- With `["points"]` alone, ties are common and *meant* to be, because sudden death is the drama you
  wanted. This is right for knockout presets. It also amends D-44: total elapsed time is the
  **default** tiebreak, not a universal one.

Sudden-death and replay cards are stored like any other (§4.3) as `cards/{tid}_r{n}_t{k}`, and the
play documents as `attempts/{uid}_{tid}_r{n}_t{k}` — still no `puzzleId` field, so §4.4 holds.

One consequence worth stating: a sudden death or a replay **cannot** finish inside the same noon
boundary that closed the round, because the tied players have to actually play it. So a tie extends
the round: the round's `closedAt` is set, the tie is opened as a sub-round with its own deadline
(default: the next noon, or `advanceTournament` when everyone has played), and the next round is
not paired until it resolves. For a one-lunch tournament this is where the manual close earns its
keep (D-43).

### 6.5 Built-in presets (D-48)

A tournament is created **from a named preset**, not from a client-supplied config. The preset is
resolved server-side into a concrete config which is then **copied into the tournament document**
(§4.1) and frozen there.

Two things follow, and both are why this is the right shape rather than a shortcut:

- The entire question of "is this combination of settings even coherent?" disappears. Without
  presets, `createTournament` has to validate a config lattice — regime against format (§6.1),
  draws against elimination, bye policy against the circle method, sudden death against a time
  tiebreak — and every invalid corner is a bug that reaches a player as a broken bracket. With
  presets there are five known-good configs, each covered by a fixture.
- Because the *resolved* config is what gets stored, editing a preset later cannot retroactively
  change a running or finished tournament, and custom presets arrive later as a different way to
  produce the same stored shape. No migration.

| id | format | regime | card | rounds | ties | notes |
|---|---|---|---|---|---|---|
| `quintal` | `free_for_all` | `aggregate` | 5 × `shape` | 1 | points → time | the lunch default: everyone joins, everyone finishes over one meal |
| `mata-mata` | `single_elim` | `match` | 5 × `shape` | ⌈log₂ n⌉ | points → **sudden death** | byes to top seeds, `consolation` on |
| `liga` | `round_robin` | `match` (3/1/0) | 3 × `shape` | n−1 or n | points → time → draw | the classic table; one round per day |
| `suíço` | `swiss` | `match` | 3 × `shape` | 4 | points → time → draw | pairs by standing, no repeats |
| `bandeiras` | `free_for_all` | `aggregate` | 5 × `flag` | 1 | points → time | one-kind tournament, the thing Paulo asked for by name |

Preset ids are stable and are referenced in tests. `quintal` is the one built in slice 1; the rest
land with the format that carries them.

---

## 7. Byes and odd counts

Paulo's constraint: *"all tournaments must be able to accommodate odd player numbers, even if that
odd player has some kind of advantage."*

A bye is one config block, with per-format defaults:

```
byePolicy: {
  credit: "win" | "draw",                                    // default "win"
  play:   boolean,                                            // default true
  assign: "top_seed" | "lowest_standing" | "fewest_byes" | "random"
}
```

- `play: true` means the bye player still plays the round's card. They get the free win **and** a
  score that counts for every card-points tiebreak — the advantage is real, and they are not left
  sitting out at lunch.
- Defaults per format: `single_elim` / `double_elim` → `top_seed` (conventional); `swiss` →
  `lowest_standing`, never twice for the same player; `round_robin` → whatever the circle method
  hands out, which is already exactly one each; `free_for_all` → no byes exist, nobody is paired.
- A **forfeit is not a bye** (FR-5.7): missing the deadline is a loss with 0 points. A bye is
  assigned by the engine; a forfeit is earned by not turning up.
- Byes exist only under the `match` regime, because only pairing formats have them (§6.1). Under
  `aggregate` nobody is paired, so an odd field needs nothing at all — which is the cheapest
  possible answer to Paulo's odd-count requirement, and the reason `quintal` can take any number
  of players who turn up.

---

## 8. Lifecycle, deadlines, and who advances the rounds

```
draft ──start──> running ──(last round closes)──> finished
  └────────────────cancel───────────────> cancelled
```

- **draft**: the manager configures; members join (`entry: "open"`, the default) or the manager adds
  them (`entry: "managed"`). Nothing is generated yet.
- **start** (owner only): freezes the participant list, computes seeds, writes round 1 and its card,
  sets `closesAt`.
- **running**: participants play the open card. Results are invisible to everyone else until the
  round closes (FR-5.6).
- **close**: read the round's play documents, score them (absent = forfeit, 0), write `results` and
  the pairing outcomes, fold the round log, then either write the next round and its card or set
  `finished`.

**Round windows are puzzle days.** `closesAt` is a noon `America/Sao_Paulo` boundary,
`roundDays` (default 1) after the round opened — the same clock the whole game already runs on
(OQ-2), and the same sentence players already know: *o ranking fecha ao meio-dia*.

With a floor, `MIN_ROUND_MS` (12 hours), and the floor is the whole point. `puzzleIdAt` names the
day a puzzle *opens*, so before noon it still answers with yesterday, and "yesterday plus one
day" is *today's* noon — minutes away. The first implementation therefore gave a `quintal`
started at 11:50 a ten-minute round that closed at noon and forfeited everybody, in precisely
the hour that preset exists for. Worse, the unit test named *"a round opened just before noon
still gets a full window, not one minute"* asserted the one minute. Both are fixed; the test now
sweeps every opening hour of the day and asserts the floor.

**No new scheduled job.** The 12:05 `rebuildStandings` handler gains a second call —
`advanceOpenRoundsNow(now)` — each wrapped in its own try/catch so one failing cannot silence the
other. Reasons: Cloud Scheduler's free tier is **three jobs per billing account, not per project**
(`05-cost.md` §3.4) and Mondo already owns two of them, and a tournament round closing at noon
wants to be advanced at 12:05 anyway. Closing is idempotent — a round with `closedAt` set is
skipped — so a retry or a double run is harmless.

**`advanceTournament`** does the same thing on demand, owner-only and idempotent. It is not a
convenience: it is what lets a tournament run in an hour over one lunch instead of one round per
day, and it is what makes the whole engine testable without waiting for a cron.

---

## 9. API contract

Eight callables, region and CORS from `lib/callable.ts` as usual, every input validated (SEC-8).

| callable | who | does |
|---|---|---|
| `createTournament({ groupId, name, preset })` | group owner | resolves the preset (§6.5) into the stored config, `status: "draft"` → `{ tournamentId }` |
| `setParticipation({ tournamentId, join })` | group member | join or leave while `draft` |
| `startTournament({ tournamentId })` | owner | freeze, seed, write round 1 + card |
| `getTournament({ tournamentId })` | group member, or admin | config, standing, bracket, my state, deadline — other players' open-round results stripped (FR-5.6) |
| `getCard({ tournamentId })` | participant | the current item's prompt; creates the play document with a server `startedAt` on first call — the `getRound` analogue |
| `submitCardGuess({ tournamentId, guess })` | participant | one guess through the kind's evaluator, in a transaction on the play document — the `submitGuess` analogue |
| `advanceTournament({ tournamentId })` | owner | close the open round early; idempotent |
| `cancelTournament({ tournamentId })` | owner | `status: "cancelled"`; keeps the record |

New error codes: `tournament-not-open`, `not-a-participant`, `round-closed`. `challenge-expired`
already exists and is reused for a deadline that has passed.

Two functions that are deliberately *not* here, for the reason in §11. `listTournaments`:
`getLeaderboard` already returns the group, so the group view can carry its tournaments.
`listPresets`: the presets are static, their names and blurbs are pt-BR UI copy that belongs in
`i18n.js` anyway, and the client only ever sends an id the server validates. What a *running*
tournament is actually configured to do comes back from `getTournament` as the stored resolved
config, so the only thing the client can misdescribe is a tournament nobody has created yet.

Client pages: `site/torneios.html` + `app/tournaments.js` (list, create, bracket, standing) and the
card player, which is close enough to `game.js` to share `autocomplete.js` and `geo.js` but not the
round state machine. Still no build step (NFR-4), still no Firestore SDK.

---

## 10. Anti-cheat, honestly

Two new residual risks, both to be written into `01-requirements.md`:

- **SEC-13** — **Kinds differ in how easily the answer can be looked up, and no kind's difficulty
  is treated as a security control.** SEC-1 is unchanged and still holds absolutely: the server
  never sends an unsolved answer. But a silhouette needs geometry matching (SEC-12's conceded
  residual), while a capital city or a GDP figure is one search away. Tournament scoring therefore
  rests on *time* as much as correctness (FR-8.3), and the admin's timing surface (`intervalsMs`,
  `suspicious`) is the detection story, per OQ-8's posture: make cheating visible and socially
  expensive rather than technically impossible.
- **SEC-14** — **Within an open round every participant plays the same card (D-38), so someone who
  plays early can simply tell someone who plays later.** Mitigations: no result of any kind is
  visible until the round closes (FR-5.6), so there is no scoreboard feeding the temptation;
  timings are recorded; and the card is strictly sequential. The residual is accepted. The real fix
  is a synchronous round with a countdown, which is Phase 5's live head-to-head.

D-31 carries over unchanged: an admin who is also a participant sees other players' open-round
detail only after finishing their own card.

---

## 11. Cost

The play path is the cheapest thing in the project: per participant per round, one card read, one
play document, and one write per guess. A 20-player, 5-round Swiss with 5 challenges a round is
100 cards played and ~500 writes — against a 20,000-write daily free allowance. The advance job
reads ≤ 20 round documents and one attempts query per open tournament. Card generation reads the
±60-day puzzle window once per advance run and shares it across every tournament.

The real cost is somewhere else and it is worth saying out loud: **eight more callables are eight
more Cloud Run services and eight more container images in Artifact Registry**, whose free
allowance is 0.5 GB total (`05-cost.md` §3.2) — already the second-largest cost risk in the
project at 22 functions. Phase 3 takes it to 30. Before merging Phase 3, check the repository size
and tighten the cleanup policy (keep 1 recent, delete older than 7 days) rather than discovering
the charge later. Collapsing the eight callables into three action-dispatchers would save perhaps
R$0.50 a month and cost real clarity in validation and tests; not worth it, but the arithmetic
should be visible rather than assumed.

---

## 12. Build order

Each slice ends in something playable, and the risk rises monotonically.

1. **Free-for-all, `aggregate`, one round, one shape challenge** — the whole pipeline end to end:
   create from the `quintal` preset, card, play, close, standing. This *is* FR-5's old one-off
   challenge, so it retires a requirement rather than adding one.
2. **N challenges per round, plus the `capital` kind** — proves the card and the kind interface with
   two implementations before anything is built on top of them, and finishes `quintal`. Shuffled
   order.
3. **Round robin** — the circle method, byes for free, match points, draws. The first `match`
   regime and the first pairings, so it is where the shared primitives (`cardWinner`, match
   points, the bye credit) all get written and fixtured. The `liga` preset. **Built 2026-09-09**
   in `lib/tournament-core.ts` — flat, not `lib/tournament/core.ts` as sketched above, because
   `lib/` has sixteen flat siblings and no directories. `assignBye` was not written: the circle
   method's ghost hands out byes on its own, so a policy only becomes real in slice 5 (Swiss),
   which is the first format that has to *choose* who sits out.
4. **Single elimination, plus the tie policies** — seeding, bracket order, first-round byes,
   `consolation`, and sudden death (§6.4), which is the first place a tie cannot be waved away by
   the clock. The `mata-mata` preset. **Built 2026-09-10.** Two corrections to §4.2 came out of
   it: `tie.pairs` is a list of `{a, b}` **objects**, not `[a, b]` tuples, because Firestore
   rejects an array whose elements are arrays ("invalid nested entity") and only the emulator
   catches that; and one sub-round serves every level fixture at once rather than one tied pair,
   because resolving them one at a time would cost a day each.
5. **Swiss** — the pairing engine; the only genuinely fiddly pure algorithm here. **Built
   2026-09-10.** Two amendments to §6.3: the pairing search is **exhaustive**, not "bounded
   swap-and-retry" — `MAX_PAIRED_PARTICIPANTS` is 12, so the whole space is 11!! = 10,395 pairings
   and enumerating it removes T-3's failure mode rather than bounding it; and the round count is
   **capped at players − 1**, because a Swiss configured for more rounds than anybody has
   opponents must otherwise either repeat a fixture or stop pairing.
6. **Double elimination** — bracket plumbing, grand final. Last, deliberately. **Built
   2026-09-10**, with four amendments to §6.3 worth reading before anyone touches it:

   - **The two brackets run in the same tournament round.** Under D-38 one card is shared by
     everyone still in, so a winners round and a losers round can be scored off it together. That
     makes the format **2·log₂(S)** rounds rather than the conventional 3·log₂(S)−1 — the table in
     §6.2 said "~2·log₂(S)" and was right for a reason nobody had written down.
   - **The losers-bracket draw is chosen by search, not by a fixed reversal rule.** That fixed
     mapping is what T-2 calls subtly wrong in most implementations, and it stops being defined at
     all once byes make the two sides uneven — which happens for every field that is not a power
     of two. Preference is survivor-against-dropdown and the conventional fold; a fixture that
     repeats an earlier one is rejected unless the pool leaves no alternative.
   - **Losing the last grand final ends it, whatever your record.** With `grandFinalReset` off,
     the losers champion winning leaves *both* finalists on one defeat; without this rule the
     table shows two survivors and no champion. A property check over every field size caught it.
   - **`Pairing` carries a `bracket` field** (`w` / `l` / `gf`), because "who dropped out of
     winners round r" is only answerable if the fixtures remember which half they were.
7. **`flag` and `gdp` kinds** — `flag` is **built** (§5.3): a vendored public-domain SVG set,
   flattened offline to filled paths, with a `NOTICE` entry and the `bandeiras` preset. `gdp` is
   **not**, and stays blocked on OQ-12: the source, the vintage and nominal-vs-PPP are a
   game-design decision, and the answer has to be on `regras.html` before anybody plays it.

Tests: every format is a pure fold, so each gets a hand-checkable fixture in the style of
`test/standings.test.ts` — including one odd-count fixture per format, which is where these
engines actually break. Rules tests get negative cases for `tournaments/**` and `cards/**`. The
committed e2e (D-33) gains a full free-for-all and one bracket run with a manual advance.

---

## 13. Risks

| # | Risk | Mitigation |
|---|---|---|
| T-1 | D-38 is not what Paulo pictured | Settle §15 Q1 before slice 3. Slices 1–2 are format-agnostic and survive either answer. |
| T-2 | Double elimination's bracket mapping is subtly wrong | Last slice, hand-checked fixtures, odd counts included. It is the one place worth writing the table out by hand first. |
| T-3 | Swiss pairing loops or fails to pair | Bounded swap-and-retry with a deterministic fallback to any legal pairing; a fixture with a forced repeat conflict. |
| T-4 | Someone adds `match /groups/{gid}/{document=**}` later and publishes answers | §4.1: nothing that holds an answer lives under a readable path. `cards` is top level, alongside `puzzles`. |
| T-5 | Tournament attempts leak into the daily boards | §4.4: no `puzzleId` field, so the standings range query cannot see them. One rules test and one standings test pin it. |
| T-6 | The card generator changes and old cards become unreproducible | Cards are stored, not derived (§4.3). |
| T-7 | Artifact Registry crosses the free allowance | §11: measure and tighten the policy in the same phase, not after the bill. |
| T-8 | Collusion inside an open round | Accepted, documented as SEC-14. Real fix is Phase 5. |
| T-9 | A group deleted mid-tournament (D-23, last member leaves) orphans tournaments | **Implemented**, and it needed to be: `leaveTx`'s dissolve branch reads the group's draft and running tournaments before its writes and cancels them in the same transaction. Without it the 12:05 job kept closing rounds for a group that no longer existed, and no management callable could stop it — they all check ownership of a group that is gone. Paulo dissolved a production group by accident the day this shipped, which is how concrete the case is. |
| T-10 | `getTournament` reads one play document per participant on every view of an open round | Accepted, same order and same reasoning as the board's ceiling (plan R-12). Bounded by `maxParticipants` and trivial at lunch size; the upgrade path is to stamp a per-round state map on the round document as cards finish, which trades reads for contention on one document. Measure first (NFR-2). |

---

## 14. Decisions

| ID | Decision | Reasoning |
|----|----------|-----------|
| D-38 | **Duplicate scoring: every participant still alive in a round plays the identical card, and a match is a comparison of two scores from that card.** | §2. Cross-card comparison would let card difficulty decide brackets; per-pairing cards multiply play and documents for a worse game. Makes byes trivial, makes all five formats arithmetic over one table, and lets eliminated players keep playing for free. |
| D-39 | **Tournaments, rounds and cards are top-level collections with no client access, not subcollections of `groups`.** | §4.1: answers must never sit under a member-readable path; Firestore does not cascade deletes; the client never loads the Firestore SDK, so `inGroup` would buy nothing. |
| D-40 | **Tournament play lives in `attempts` with `mode: "match"` and no `puzzleId` field.** | §4.4: FR-5.9 becomes a property of the data — the daily standings range query cannot return a document lacking the field — with no composite index, no new rules, and no new deletion sweep. |
| D-41 | **Standings and elimination are a pure fold over the round log, recomputed on every advance, never stored incrementally.** | ≤ 20 documents. D-25's lesson: at this size a full recompute is cheaper than a drift bug, and it makes closing a round idempotent. |
| D-42 | **Cards are stored, not regenerated from a seed.** | A generator that can never change is a worse constraint than a stored document. `puzzles` set the precedent. |
| D-43 | **Rounds close on the puzzle-day noon boundary and are advanced by the existing 12:05 job; `advanceTournament` closes one early.** | No third Cloud Scheduler job (`05-cost.md` §3.4 — three free per *billing account*), one clock for the whole game (OQ-2), and the manual close is what makes a one-lunch tournament and an automated test possible. |
| D-44 | **Every kind scores one challenge 0–6 and a card is the sum. Total elapsed time is the default next comparator, not a universal one.** | The 0–6 scale is what makes a mixed-kind card meaningful, and six for a first-guess solve keeps FR-3.1's scale so a shape challenge and a daily score alike. Time was universal in the first draft of this document; revised the same day, because a knockout that resolves ties by sudden death (D-50) must be able to leave time out of the chain — with it in, millisecond ties never happen and sudden death never fires. |
| D-45 | **The shipped daily is not refactored onto the kind interface.** | `lib/round.ts` is live, tested and playing. Fifteen lines of glue duplicated in the `shape` kind is the cheaper mistake; consolidation is Phase 4+ if ever. |
| D-46 | **A participant's display name is snapshotted into the tournament at start, does not follow renames, and is scrubbed by `deleteAccount`.** | A tournament is a historical record, unlike the live board (D-26). D-21's "a deleted account just leaves" cannot apply to a bracket, which would be left with a hole; scrubbing the name keeps FR-1.5 while keeping the bracket readable. |
| D-47 | **Eliminated players may keep playing the round's card for a side ranking (`consolation`, default on).** | The card is already shared, so it costs nothing, and it fixes elimination's real social problem: after round one, half the group has nothing to do at lunch. |
| D-48 | **A tournament is created from a named, built-in preset, resolved server-side and copied into the tournament document. No client-supplied settings in Phase 3.** | Paulo asked for presets rather than a default. It also deletes the hardest validation problem in the phase: without it, `createTournament` must reject every incoherent corner of a settings lattice (regime against format, draws against elimination, sudden death against a time tiebreak) and each missed corner reaches a player as a broken bracket. Storing the *resolved* config means editing a preset cannot alter a running tournament, and user-defined presets later need no migration. |
| D-49 | **Two regimes. `aggregate` (points carry, totals decide, nobody eliminated) is offered only for `free_for_all`; the four pairing formats run `match` (the card score decides that round only, and is shown but never carried).** | Paulo's "points optional". The restriction is forced by D-38 rather than chosen: under a shared card a pairing cannot affect anyone's score, so a pairing format whose pairings also decide nothing is doing no work — `round_robin` under `aggregate` is bit-for-bit a `free_for_all` league while displaying a fixture list that pretends the draw matters. Elimination under `aggregate` fails differently and worse: a knocked-out player cannot accumulate, and if `consolation` lets them keep playing then the bracket decides nothing. Both are refused rather than half-supported. `free_for_all` keeps both regimes because heats (most round wins) is a real game, not a degenerate one. |
| D-50 | **Ties are resolved by a comparator chain and then by policy: sudden death, replay, seed, or a recorded draw. Sudden-death and replay cards go only to the tied players.** | "Keep adding challenges until someone fails" is the drama Paulo wanted, and it sharpened D-38: the invariant is that any two scores ever *compared* come from one card, which a two-player tiebreak card satisfies without involving the field. The cost is honest and stated: a tie holds the round open past its noon boundary, because the tied players have to actually play. |

---

## 15. Open questions — these block code

**Answered 2026-09-09:**

- **OQ-11 — Flag artwork: where from, and under what licence?** → **A vendored public-domain SVG
  set** (Wikimedia-derived), held server-side like `shapes.json`, inlined one per challenge, with a
  `NOTICE` entry. Built in slice 7 from `svg-country-flags`; see §5.3 for what the answer turned
  into, including the 24 countries it costs. D-15 and D-16 are the precedent. Emoji flags were considered and are disqualified
  on SEC-1 grounds rather than aesthetic ones: `world-countries` already carries `flag: "🇧🇷"`, but
  Windows Chrome renders the pair as the two letters `BR`, which spells the answer.
- **OQ-13 — What default does the create form offer?** → **None. Presets, not a default** (D-48).
  Built-in presets only in this phase; user-defined presets later. `quintal` is the first one
  (§6.5).

- **OQ-10 — Is D-38 (duplicate scoring) the game Paulo has in mind?** → **Yes**, confirmed
  2026-09-09, after D-49 and D-50 filled in the parts that felt missing: the win/lose regime and
  resolving a tie by playing more rather than by a stopwatch.

**Still open:**

- **OQ-12 — GDP data: which source and which vintage?** World Bank figures are CC-BY-4.0 and need
  a `NOTICE` entry and a stated year, because "the GDP of Argentina" is not a stable number and
  players will argue. Nominal or PPP is a game-design choice, and the answer has to be on
  `regras.html` before anybody plays it. Blocks slice 7 only.

---

## 16. What the reviews found

Slices 1–2 went through an independent code review and an independent security review before
merging. Both are worth recording, because two of the findings were in code this document
described as safe and one was a live hole older than this phase.

- **The rules let a player read their own attempt, and the stored guess carries `bearingDeg`.**
  D-36 removed the exact bearing from the *response* in Phase 2 and stopped there. The document
  it is stored in was readable by its owner over the Firestore REST API with their own ID token —
  no SDK required, and the project id is public in `site/app/firebase.js`. Exact distance plus
  exact bearing solves for the answer's centroid in closed form, so one guess named the country;
  on a card it named five. The rule was the only control and it was open. Closed as **D-51**, and
  the two rules tests that asserted the read *succeeds* now assert it fails. Verified on the
  emulator by the reviewer before and after.
- **The round window had no floor** (§8). Named after the bug, tested against itself.
- **`capital` prompts that name their own answer** (§5.2).
- **`listAttempts` had no D-31 gate on its new `matches` path**, so an admin who was also a
  participant could read a rival's open-round score before playing their own card — routing
  straight around the states-only panel `getTournament` is careful about. Now gated on the same
  rule the daily uses: closed rounds, or rounds the admin has already finished.
- **The play path never re-checked group membership.** A player removed from a group, or one who
  left it, kept receiving prompts and kept being scored, while `getTournament` correctly refused
  them. The participant list is frozen at start and a departed player keeps their slot (D-46) —
  but a slot is not a licence to keep playing. `loadPlayable` now re-checks membership and the
  play gate on every call, exactly as `submitGuess` re-checks `requireCanPlay`.
- **Expensive reads ran before authorization.** `startTournament` and `advanceTournament` did
  ~121 document reads (the ±60-day puzzle window) before checking ownership, so any signed-in
  account could spend them against an id it had never seen; `createTournament`'s cap query was an
  activity oracle on a private group. Cheap authorization first now.
- **One failing tournament stopped every other tournament advancing that night** — and would have
  again the next night. The sweep is now per-tournament try/catch with a `failed` count.
- Smaller: two raw `Error`s that reached the client as `internal`, an unguarded `card[i]!` in
  `cardView`, SEC-5's 400 ms floor resetting at every item boundary (a free un-throttled guess
  per item), duplicate draft seeds, a duplicated day-arithmetic helper, and three nav links to a
  page that rendered "no tournaments" because it had no group picker.

Left deliberately: T-10's read ceiling, the `uuid` advisory the review cleared as unreachable,
and one `qs` advisory that `firebase-functions` pins below its fix (`npm audit fix` took the
reachable `body-parser` one).
