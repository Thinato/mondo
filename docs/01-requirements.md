# Requirements

Requirement IDs are stable. Reference them in commits, PRs, and tests.

- **FR** — functional
- **SEC** — security / anti-cheat
- **NFR** — non-functional
- **MUST / SHOULD / MAY** per RFC 2119.

---

## FR-1 — Accounts and identity

- **FR-1.1** A visitor MUST be able to sign in with Google. Email-link sign-in SHOULD be
  offered as a fallback.
- **FR-1.2** On first sign-in the system MUST create a `users/{uid}` profile with a randomly
  generated display name (e.g. `pinguim-veloz-4821`). It MUST NOT derive the display name from
  the email address.
- **FR-1.3** A user MUST be able to change their display name. Constraints: 3–24 characters,
  Unicode letters/digits/space/hyphen/underscore, no leading or trailing whitespace, uniqueness
  NOT required globally but MUST be unique within a group at join time (append a suffix if taken).
- **FR-1.4** A user's email address MUST NOT be exposed to any other user through any surface —
  API response, leaderboard, challenge result, or share text.
- **FR-1.5** A user MUST be able to delete their account. Deletion MUST remove the auth record
  and the `users/{uid}` document, MUST remove group memberships and the user's attempts, and
  MUST leave other players' boards coherent. *(Amended 2026-09-09, D-21: there is no per-group
  result history that names people, so a deleted account simply leaves every board, like a
  leaver — nothing renders `[removido]`.)* *(Amended again 2026-09-09, D-46: deletion MUST also
  scrub the display-name snapshot from every tournament the user entered. A bracket slot is
  structural — removing the participant would leave a hole and break the standings fold — so the
  uid stays and the personal data goes.)* Deletion MUST complete within 30 days and SHOULD be
  immediate.
- **FR-1.6** Sign-out MUST clear all client state.
- **FR-1.7** *(added 2026-09-09)* A signed-in user with role `player` and no group membership
  MUST NOT be able to start or continue a round. They see an "you need an invitation" screen.
  Playing is unlocked by accepting an invite (FR-4.3) or by holding a higher role (FR-7).

## FR-2 — Daily puzzle

- **FR-2.1** There MUST be exactly one daily puzzle, identified by `puzzleId` in `YYYY-MM-DD`
  form. The day boundary is **12:00 `America/Sao_Paulo`** (OQ-2, resolved). `puzzleId` names the
  date the puzzle *opens*; the puzzle stays live until 12:00 the following day.
- **FR-2.1a** *(amended 2026-09-22, D-75)* (D-52, D-53, D-66, D-72) A day MUST hold **one challenge
  of every kind the schedule asks** — silhouette, flag, capital, GDP per capita, "which of these
  eight flags" and "which of these eight silhouettes" — played strictly in order, one at a time.
  The order MUST be shuffled per day, so that no kind is always first. A day is worth 0–36. It is
  **not** "every shipped kind": a new kind reaches players through practice and a tournament preset
  first (FR-9, D-64), and joins the daily only when the schedule is regenerated to include it,
  which is a decision with a cost — the all-time column gains a seam (D-66, D-75). The authority on
  which kinds the schedule asks is `KINDS` in `tools/lib/schedule.mjs`, pinned by its own test.
- **FR-2.2** The puzzle answers MUST be selected from a pre-generated schedule, not chosen at
  request time.
- **FR-2.3** *(rewritten 2026-09-16, D-67)* A country MUST NOT be asked about **by the same
  kind** within **30 days**. That is the whole rule.

  Everything else is allowed, explicitly: the same country MAY be two different challenges on the
  same day — Monday's silhouette and Monday's capital — and MAY be asked by another kind the next
  day. This replaces D-52's pair of windows (120 days per kind, 30 days for any kind, never twice
  in a day), which existed for a pool under pressure and had a hard consequence: every day locked
  `kinds × 30` countries against *every* kind, capping how many kinds a day could ever hold at
  five. The single rule removes that ceiling — a kind now needs only more than 30 countries, and
  the smallest pool has 172.

  **The cost is accepted and measured.** Two challenges share a country about **21 days a year**,
  and on roughly 14 of those one gives the other away, because `gdp` and `flagPick` name their
  country in the prompt: *"qual o PIB do Brasil?"* beside an unsolved silhouette of Brazil. This
  is a knowing exception to the spirit of FR-8.4, taken by Paulo on 2026-09-16 — "it can appear
  again in the challenge, no problem" — after the number was put in front of him. It is worth
  revisiting if players notice.
- **FR-2.4** Selection MUST be weighted by recognisability tier, not uniform. Target mix:
  tier 1 (well known) 50%, tier 2 (moderate) 35%, tier 3 (obscure) 15%, applied per kind over
  that kind's own pool. See `03-geo-data-pipeline.md` for tier definitions.
- **FR-2.5** Guesses are per challenge, and belong to the kind: **6** for a silhouette, **3** for
  a flag, a capital or a GDP. Fifteen in a day. A guess is a country for three of the kinds and a
  number for `gdp`, and the kind is what validates it (SEC-8).
- **FR-2.6** Each guess MUST be a country from the canonical list, selected via autocomplete.
  Free-text that does not resolve to a country MUST be rejected client-side before submission.
- **FR-2.7** After each incorrect guess the player MUST receive: great-circle distance in km,
  direction as one of 8 compass arrows, and proximity as a percentage. The direction MUST be the
  direction **on a map** — the rhumb bearing (D-62) — so that it can never point north at an answer
  that lies south. The exact bearing is never sent, only the 8-point arrow (D-36).
- **FR-2.8** A challenge ends on a correct guess or once its guesses are spent, and its answer
  is revealed then — never the answers of the challenges still to come (SEC-1). The **day** ends
  when its last challenge does.
- **FR-2.9** A player MUST be able to leave and return mid-round on any device and resume with
  guesses intact.
- **FR-2.10** A completed round MUST NOT be replayable.
- **FR-2.11** After completing, the player MUST see a share text using emoji squares and arrows
  that does **not** encode any answer, plus a link to the game. One row per challenge (D-52).
- **FR-2.12** Past puzzles MUST be viewable in an archive after their day has ended. Archive
  play SHOULD be permitted but MUST NOT count toward any leaderboard.
- **FR-2.13** *(added 2026-09-13, D-61)* A player MUST be able to **give up** on the challenge in
  front of them. Giving up ends that challenge at **zero points** and reveals its answer through
  the same reveal a challenge whose guesses ran out gets (FR-6.10); the day then continues to its
  next challenge, and giving up on the last one ends the day like any other last challenge. Guesses
  already spent are kept. The control MUST be present in **both** the daily and practice (FR-9).
  In the daily it MUST ask for confirmation, because the zero is permanent and reaches the group's
  ranking; in practice it MUST NOT, because nothing there is permanent or shared and "I just want
  to see the answer" is half of why it exists.

## FR-3 — Scoring

- **FR-3.1** Points for one **challenge**, on the 0–6 scale every kind shares (FR-8.2, D-44):

  | Solved on guess | 1 | 2 | 3 | 4 | 5 | 6 | Not solved |
  |---|---|---|---|---|---|---|---|
  | Silhouette | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
  | Flag, capital | 6 | 4 | 2 | — | — | — | 0 |

  For `gdp` (D-53) "solved" means the guess and the answer are **within 10 % of each other**
  (`min/max >= 0.9`), which is symmetric, so there is nothing to argue about. Nothing is paid for
  a near miss, exactly as a silhouette guessed 200 km away pays what one 10 000 km away pays.

  A **day** is the sum of its challenges, so it is worth **0–36** (D-75). Earlier days are worth
  less — 0–6 before D-52, 0–18 between D-52 and D-53, 0–24 between D-53 and D-66, 0–30 between
  D-66 and D-75 — and are left alone: the 7- and 30-day windows heal themselves within a month,
  and the all-time column keeps its seams rather than a rewrite of history. There are four of them
  now, and that is the cost of adding a kind: it is paid once, in a column nobody settles an
  argument with.

- **FR-3.2** Elapsed time (server `finishedAt - startedAt`, in ms) MUST be recorded and used as
  the tiebreaker. Lower is better.
- **FR-3.3** A day never started MUST score 0 and MUST be visually distinct from a played-and-failed 0.
- **FR-3.4** Rolling windows MUST be maintained: `all-time`, `last-7-days`, `last-30-days`.
- **FR-3.5** In the 30-day window the worst 2 daily scores per player MUST be dropped (OQ-5, resolved).
- **FR-3.6** Current streak and longest streak MUST be tracked per player. A streak breaks on a
  day with no completed attempt.
- **FR-3.7** The scoring rules MUST be visible in the UI on a `/regras` page. This group will
  litigate them; put them in writing.

## FR-4 — Groups

- **FR-4.1** *(amended 2026-09-09)* Only users with role `admin` or `organizer` (FR-7) MAY
  create a group, with a name (3–40 chars).
- **FR-4.2** *(amended 2026-09-09, 2026-09-20)* Groups have **no public invite code**. An
  invitation is a token of 16 chars from the ambiguity-free alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, created by the group owner and revocable by them (D-32).
  It is **single-use and valid for 7 days**, or **multi-use and valid for 48 hours** (FR-4.12,
  D-71). The token is the same shape either way: "multi-use" never means short, guessable or
  browsable.
- **FR-4.3** *(amended 2026-09-09, 2026-09-20)* A user joins a group by following an invite link.
  The first signed-in account to accept **consumes a single-use token**; a multi-use token is not
  consumed by being accepted and keeps working until it expires or is revoked. A used, revoked,
  expired or unknown token MUST be rejected with a typed error.
- **FR-4.4** A user MAY belong to up to 10 groups.
- **FR-4.5** A group MUST have a maximum size (default 200).
- **FR-4.6** The group leaderboard MUST show, per member: rank, display name, points in the
  selected window, rounds played, average guesses, current streak.
- **FR-4.7** The leaderboard MUST be filterable by window (all-time / 7d / 30d).
- **FR-4.8** *(amended 2026-09-09, 2026-09-20)* The owner MUST be able to rename the group, create
  and revoke invites, and remove a member. Management rights follow **ownership**, not role
  (FR-7.5) — an organizer invites to the groups they own and to no others. The owner MUST be able
  to see every live invite of their group with its **kind**, its **expiry**, how many accounts have
  joined through it, a way to **copy the link again**, and a way to **revoke** it.
- **FR-4.9** A member MUST be able to leave a group. Their historical results stay but they
  disappear from the board. When the owner leaves, ownership MUST pass to the longest-standing
  remaining member without granting them any role (D-23); the last member leaving deletes the
  group and its pending invites.
- **FR-4.10** Group membership and the leaderboard MUST only be readable by members.
- **FR-4.11** A group MUST show a "today" panel: who has already played today (without revealing
  their score until they finish, to preserve drama), and who has not.
- **FR-4.12** *(added 2026-09-20)* An owner MAY mint a **multi-use** invite link, valid for **48
  hours**, which admits every account that follows it until it expires or is revoked. It counts
  against the same per-group cap on outstanding invites as a single-use one, and the invite records
  how many accounts joined through it. Single-use is the default: a request that names no kind MUST
  mint the 7-day single-use link.

## FR-5 — Tournaments *(rewritten 2026-09-09; design in `docs/06-tournaments.md`)*

The old FR-5 described a one-off 2–8 player challenge. That is the degenerate tournament —
free-for-all, one round, one shape challenge — so it is subsumed rather than kept alongside.

- **FR-5.1** An `admin` or `organizer` MUST be able to create a tournament in a group they own
  (FR-7.3, FR-7.5) by choosing one of the **built-in presets**. The preset is resolved
  server-side into the tournament's settings, which are then immutable. Client-supplied settings
  are not accepted in Phase 3; user-defined presets are a later phase (D-48).
- **FR-5.2** The **server** selects every challenge subject. The creator does not choose it and
  does not see it (D-10 unchanged). A subject MUST NOT be one already used in the same
  tournament, and MUST NOT appear in the daily schedule within ±60 days of today.
- **FR-5.3** A tournament MUST be visible only to members of its group (FR-4.10 applies). There
  is no join link and no public tournament: the group's invitation is the only door (FR-1.7).
- **FR-5.4** A tournament MUST support 2–200 participants in free-for-all and 2–32 in the
  pairing formats. Every format MUST handle an odd count, with byes.
- **FR-5.5** In a round, every participant still in the tournament MUST be served the identical
  card (D-38), and MUST play it under each kind's rules.
- **FR-5.6** No participant's result for an open round — score, guesses or outcome — MUST be
  visible to any other participant until the round closes. Their own result is visible
  immediately. This binds the admin surface too, on the same terms as D-31.
- **FR-5.7** A round MUST have a server-set deadline. A participant who has not finished the
  card by it scores 0 and loses their pairing: a forfeit, not a bye.
- **FR-5.8** A tournament MUST show a standing appropriate to its format and regime, and a
  bracket where the format has one, ranked by its own tiebreak chain.
- **FR-5.9** Tournament results MUST NOT contribute to any group or global daily leaderboard.
  *(Structurally enforced by D-40: a card play carries no `puzzleId`, and the daily standings
  query is a range on that field.)*
- **FR-5.10** The tournament manager MUST be able to close the open round early and to cancel
  the tournament. Both MUST be safe to repeat.
- **FR-5.11** A tournament MUST run under one of two regimes (D-49). Under `aggregate` card
  scores accumulate, the highest total wins, a player MAY become uncatchable before the final
  round, and nobody is eliminated. Under `match` a card score decides only which player won that
  round; it MUST be displayed and MUST NOT be carried into the final result, and the winner is
  whoever kept winning. `aggregate` MUST be offered only for free-for-all.
- **FR-5.12** A tie the comparator chain cannot separate MUST be resolved by the configured
  policy: sudden-death challenges until the scores differ, a replay of the round for the tied
  players, the better seed, or a recorded draw where the standing allows one. Both tied players
  MUST receive the identical sudden-death or replay card (D-38, D-50).
- **FR-5.13** Playing a tournament round MUST require current membership of its group, re-checked
  on every call — the same rule FR-1.7 applies to the daily. A participant who leaves or is
  removed keeps their slot in the standings (D-46) but MUST NOT be served further cards.

## FR-8 — Challenge kinds *(added 2026-09-09)*

- **FR-8.1** A challenge kind MUST define: the pool it can ask about, what prompt the client may
  see, how many guesses it allows, how a guess is validated and graded, what feedback it returns
  while unsolved, and how a finished challenge scores.
- **FR-8.2** Every kind MUST score a single challenge on the same 0–6 scale, so a card of mixed
  kinds is summable. Six for a first-guess solve matches FR-3.1.
- **FR-8.3** A card score is the sum of its challenges' points. Total elapsed server time over
  the card MUST be recorded and is the **default** next comparator, lower first — but whether it
  is in a given tournament's chain is a preset choice, because a knockout resolving ties by
  sudden death must be able to leave it out (D-44).
- **FR-8.4** A kind's prompt and feedback MUST NOT name or otherwise identify the answer to
  **its own challenge** while that challenge is unsolved. A country whose capital city names the
  country itself MUST therefore be excluded from the `capital` kind's pool.

  It says *its own* since D-67, and that word is doing work. A prompt may now name a country that
  is the answer to a **different** challenge on the same day — `gdp` and `flagPick` name theirs,
  and FR-2.3 no longer keeps a day's subjects distinct. That happens about 21 days a year and is
  a deliberate trade, not an oversight; see FR-2.3. Within a tournament card the old guarantee
  still holds, because `buildCard` keeps subjects distinct there and FR-2.3 does not apply to it.
- **FR-8.5** The manager MUST be able to specify a card as a multiset of kinds and choose whether
  the order is as listed or shuffled. A card MAY be several challenges of one kind.
- **FR-8.6** *(amended 2026-09-21, D-72)* Shipped kinds: `shape`, `capital`, `flag` (a vendored
  public-domain SVG set, flattened offline to filled paths; 24 countries have no flag), `gdp`
  (World Bank GDP per capita PPP for one pinned year; 10 countries have no figure), `flagPick`
  and `shapePick` (both FR-8.7). **All six are available to tournament card specs and to
  practice**; the first five are asked every day (FR-2.1a, D-66). `flagPick` reached players
  through practice and a tournament preset first, which is what FR-9 exists for, and joined the
  daily three days later once it had been played; `shapePick` is at that first stage now.
- **FR-8.7** *(added 2026-09-16, D-64)* A kind MAY ask its question as **a set of options**, of
  which exactly one is right. For such a kind:
  - The options MUST be chosen once, when the card is built, and **stored** with the challenge.
    They MUST NOT be derived on read: a pool that changes would reshuffle a challenge that a
    player has open, and the picks they have already spent would point at different options.
  - The order MUST be shuffled when the card is built, and the position of the right option MUST
    be uniformly distributed. **The position is the answer** (SEC-1): it follows that nothing
    identifying an option — a country code, a name in any locale, an id — may appear in the
    prompt, in the DOM, or in a guess. A guess is an **index**.
  - A wrong pick MUST NOT be named, in the response or on screen. Naming it teaches the player
    that flag — or that silhouette — and artwork taught here can answer the `flag` or `shape`
    challenge on the same card.
  - Distractors MUST exclude every other subject on the same card, and SHOULD exclude the
    caller's own exclusion window (FR-5.2, FR-9.5) where the pool allows it.
  - Distractors MUST NOT be chosen by any property a player can read **off the artwork itself** —
    payload size, visual complexity, palette. A rule that preferred small artwork would make a
    complex flag rarer as a distractor than as an answer, and "pick the busiest one" would beat
    the game without knowing anything.
  - A property that requires *already knowing what the options are* is not in that class, and MAY
    be used (D-65): both pick kinds draw four of their eight from the answer's nearest countries,
    which is the whole difficulty of the kind, and reading it needs exactly the knowledge being
    asked for. Where such a structure exists the in-game help MUST say so — a mechanic that only
    rewards the players who noticed it is a worse game than one that explains itself.
  - The guess budget MUST reflect that picking is easier than naming: with `n` options and `g`
    guesses a blind player scores on `g/n` of challenges, and FR-8.2's shared 0–6 scale is only
    honest while that stays small. Both pick kinds are 8 options and 2 guesses, so 25 %.
  - *(added 2026-09-21, D-72)* A second pick kind MUST NOT be a second implementation: the option
    builder, the shuffle, the grading and the reveal are shared, and a new one differs only in its
    pool and its artwork. `shapePick` is `shape`'s pool drawn onto `flagPick`'s board.

## FR-6 — Client experience

- **FR-6.1** The game MUST work on mobile viewports down to 360px wide, and no page MUST scroll
  horizontally at any width from 360px up. Wide content — a ranking table, the scoring table —
  MUST scroll inside its own box instead. *(The second clause was added 2026-09-12 with D-57, and
  four pages were failing it: see the `nav`, `.cards li a`, `.cards .meta` and `main.prose
  .table-wrap` rules in `mondo.css`.)*
- **FR-6.2** The silhouette MUST render as inline SVG, scaled to fit, with a consistent visual
  size regardless of the country's real area (so area is not a free hint).
- **FR-6.3** Autocomplete MUST match on: canonical English name, pt-BR name, ISO alpha-2 and
  alpha-3 codes, and a curated alias list (`EUA`, `Holanda`, `Coreia do Sul`, `Inglaterra`, …).
  Matching MUST be diacritic-insensitive and case-insensitive.
- **FR-6.4** The UI MUST be usable by keyboard alone: type, arrow to select, Enter to submit.
- **FR-6.5** Loading and error states MUST be explicit. A failed guess submission MUST NOT
  consume a guess and MUST be retryable.
- **FR-6.6** The game MUST respect `prefers-color-scheme` and reuse the existing site's
  `theme.js` toggle.
- **FR-6.7** Colour MUST NOT be the only channel conveying proximity — always pair with the
  number and the arrow.
- **FR-6.8** *(added 2026-09-11, D-54)* Every place a `gdp` figure is shown or asked for — the
  prompt, the guess field, a guess row, the reveal — MUST state the unit. The figure is in
  international dollars and a Brazilian player reading a bare number assumes reais.
- **FR-6.9** *(added 2026-09-11, D-56)* A player MUST be able to read what the hints mean without
  leaving the game, from a control beside the challenge. That explanation MUST open itself the
  first time the player meets each hint vocabulary (country hints; number hints) and MUST be
  dismissed deliberately. Having been read once, it MUST NOT reappear unasked.
- **FR-6.11** *(added 2026-09-12, D-57)* From 960px up the game MUST use the extra width to show
  context beside the challenge — who else is playing today, and the player's own streak — WITHOUT
  changing the challenge's own layout. Below 960px the layout MUST be unchanged from the phone
  layout. Context MUST NOT delay or block the game: its requests are never awaited by the game and
  its failures are never shown to the player.
- **FR-6.10** *(added 2026-09-11, D-55)* A finished challenge MUST hold the screen — its outcome,
  its answer and the guesses that got there — until the player chooses to go on. The next prompt
  MUST NOT be rendered before that choice. A solve MAY be celebrated; any such animation MUST be
  suppressed under `prefers-reduced-motion`.

---

## FR-9 — Practice *(added 2026-09-13)*

Paulo, 2026-09-13: *"players can choose a challenge to practice on … practice scores are not
shared, they can practice as much as they want privately … this will also be a good way for us
to test new challenges."*

- **FR-9.1** A player MUST be able to choose **one challenge kind** and play challenges of that
  kind one after another, for as long as they like. Every kind listed in FR-8.6 MUST be
  practisable.
- **FR-9.2** A practice challenge MUST behave exactly as the same kind behaves in the daily and
  in a tournament: the same guess budget, the same hints, the same 0–6 score (FR-8.2), the same
  reveal (FR-6.10), and the same way out of it (FR-2.13). It follows that a new kind is playable
  in practice on the day it ships, which is the point of the mode as a test bench.
- **FR-9.3** A practice result MUST NOT be shared, ranked or counted. It MUST NOT reach any
  board, any streak, any profile counter, or any other player's screen — not even as a state.
  A player's own total for the session in progress is the only place it appears.
- **FR-9.4** Every practice challenge MUST offer a way out, and leaving MUST ask first. On
  leaving, the session's total MUST be shown. A challenge abandoned mid-way counts for nothing
  and MUST NOT reveal its answer.
- **FR-9.5** Practice MUST NOT ask about a country the daily schedule is about to use
  (D-60). Without this, practising `gdp` is a way to look up today's answer: that prompt names
  its own country, so a player could click through the pool until it came up.
- **FR-9.6** Practice is **invite-only**, on the same gate as the daily (FR-1.7).
- **FR-9.7** A session need not survive a reload. Reopening the page MAY start over.
- **FR-9.9** *(added 2026-09-18, D-70)* A player MUST be able to restrict a practice session to
  **one or more continents** — África, América, Ásia, Europa, Oceania — and the session MUST then
  ask only about countries on them. For a multiple-choice kind the **options** MUST come from the
  chosen continents too (FR-8.7): eight flags drawn from the whole world make a question about
  Oceania answerable by elimination, which is the opposite of what the filter is for.
  - The selection is fixed for the life of a session, like the kind, because the totals beside it
    are the sum of one exercise.
  - The default is every continent, which MUST be indistinguishable from how practice behaved
    before this requirement existed.
  - At least one continent MUST always be selected.
  - FR-9.5 still applies and wins: when the withheld window leaves a chosen continent with nothing
    to ask about, the player MUST be told *that* — not "no country is scheduled" — so they know
    which knob to turn.
- **FR-9.8** *(added 2026-09-13, D-63)* From 960px up, practice MUST show the run beside the
  challenge — the challenges already finished, and the totals they add up to: points, challenges,
  solves, and the share of challenges solved. Below 960px the layout MUST be unchanged from the
  phone layout. This is FR-6.11 applied to a run rather than to a group.

---

## FR-7 — Roles *(added 2026-09-09)*

- **FR-7.1** Every user has exactly one role: `admin` > `organizer` > `player`. Roles are stored
  server-side and MUST NOT be client-writable. New users are `player`.
- **FR-7.2** `admin` MAY do everything below plus: list all users and all groups, view any
  group's board, grant or remove `organizer`, grant a player an extra chance on today's puzzle
  (the previous try is kept, D-30), and inspect attempts — guess timings for cheating checks;
  today's guesses only after the admin has finished their own round (D-31). No admin surface
  MUST ever expose an e-mail address (FR-1.4 applies to the admin too).
- **FR-7.3** `organizer` MAY create groups and manage the groups they own; in Phase 3, create
  tournaments in them.
- **FR-7.4** `player` MAY play the daily once invited, practise (FR-9), view the boards of their
  groups, and take part in tournaments of their groups.
- **FR-7.5** Group **management** rights come from owning the group, not from the role: an admin
  sees every group but manages only the ones they own.
- **FR-7.6** `admin` is granted only out of band (a maintainer script with ADC, D-29). The API
  MUST refuse to grant or revoke `admin`, and MUST refuse a role change on the caller's own
  account.

## SEC — Security and anti-cheat

- **SEC-1** *(critical)* The answer for an unfinished round MUST NOT be present in any payload
  sent to the client — not in the response body, not in a hidden field, not inferable from an
  asset path or filename. Every guess is evaluated server-side.
- **SEC-2** Silhouette geometry MUST be delivered as raw SVG path data with no country name,
  ISO code, or identifying attribute anywhere in the payload or DOM. No client-reachable
  mapping from geometry to country may exist: no public shape files, no shape keys, no
  centroids in client data. The server inlines exactly one path per round (D-13).
- **SEC-3** `startedAt` and `finishedAt` MUST be server timestamps. Client-supplied timing MUST
  be ignored entirely.
- **SEC-4** Guess submission MUST be idempotent and transactional. Concurrent submissions for the
  same `(uid, puzzleId)` MUST NOT produce more than 6 recorded guesses.
- **SEC-5** Rate limits: at most 6 guess calls per `(uid, puzzleId)` and no more than 1 guess per
  400ms per user. Excess MUST be rejected with a typed error.
- **SEC-6** Firestore rules MUST default-deny. Score, standings, attempt, and puzzle documents
  MUST be write-only via the Admin SDK. No client write path to any of them.
- **SEC-7** The puzzle schedule collection MUST have no client read access at any time.
- **SEC-8** All callable functions MUST reject unauthenticated calls, and MUST validate every
  input against an explicit schema before use.
- **SEC-9** Callable functions MUST restrict CORS to `https://lisecki.dev` plus `localhost` for
  the emulator.
- **SEC-10** No secrets, service-account keys, or `.env` files in the repo. CI deploys via
  Workload Identity Federation, not a downloaded JSON key.
- **SEC-11** A GCP budget alert MUST be configured before the first public link is shared.
- **SEC-12** Accepted residual risk: a determined player can geometry-match the silhouette
  against public map data. This is documented, not defended against. Social deterrence only.
- **SEC-13** *(added 2026-09-09)* Challenge kinds differ in how easily their answer can be
  looked up elsewhere, and **no kind's difficulty is treated as a security control**. SEC-1 is
  unchanged and absolute: the server never sends an unsolved answer. But a silhouette needs
  geometry matching (SEC-12) while a capital city is one search away, so tournament scoring rests
  on time as much as correctness (FR-8.3) and the admin timing surface is the detection story
  (OQ-8's posture). A prompt that *states* its own answer is not covered by this and is a bug
  (FR-8.4).
- **SEC-14** *(added 2026-09-09)* Accepted residual risk: within an open tournament round every
  participant plays the same card (D-38), so whoever plays early can simply tell whoever plays
  later. Mitigations: no result is visible to anyone else until the round closes (FR-5.6), so
  there is no live scoreboard feeding the temptation; the card is strictly sequential; and
  timings are recorded. The real fix is a synchronous round with a countdown, which is Phase 5.
- **SEC-15** *(added 2026-09-09, D-51)* No `attempts` document MUST be client-readable, including
  by the player it belongs to. The stored guess carries `bearingDeg` beside `distanceKm`, and the
  two together solve for the answer's centroid in closed form (D-36) — so a readable attempt
  defeated SEC-1 in one guess over the Firestore REST API, with no SDK involved. Every read the
  game performs goes through a callable that projects the 8-point compass instead.

---

## NFR — Non-functional

- **NFR-1** Guess round-trip p95 under 600ms from São Paulo.
- **NFR-2** Cloud Functions cold starts SHOULD be measured before they are mitigated.
  `minInstances: 1` is the obvious fix and costs roughly an order of magnitude more than the
  entire free tier — see `05-cost.md` §3.1. Measure p95 against NFR-1 first; accepting a cold
  start on the day's first guess is free. Revisit only with real numbers.
- **NFR-3** Cost MUST stay within free-tier allowances at 100 daily players. Budget: under
  R$5/month; expected steady state is R$0.00. The binding constraint is Firestore reads, which
  is why standings are precomputed rather than aggregated per page-load. Arithmetic, headroom
  and the four real cost risks are in `05-cost.md`. Note that a GCP budget alert notifies and
  does not cap spend.
- **NFR-4** The frontend MUST have no build step. Vanilla ES modules, Firebase SDK via CDN ESM import.
- **NFR-5** Total frontend payload for a round MUST stay under 150KB gzipped, including geometry.
- **NFR-6** Puzzle schedule MUST be generated at least 180 days ahead. A cron check SHOULD warn
  when fewer than 30 days remain.
- **NFR-7** All infrastructure MUST be reproducible from Terraform + Firebase CLI in a fresh
  GCP project, documented well enough that someone else could stand it up.
- **NFR-8** Scoring logic MUST be pure functions with unit tests. This is the part people will argue about.
- **NFR-9** Repo MUST be licensed (MIT or Apache-2.0) with third-party data attributions in `NOTICE`.
