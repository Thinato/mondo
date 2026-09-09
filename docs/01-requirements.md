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
  leaver — nothing renders `[removido]`.)* Deletion MUST complete within 30 days and SHOULD be
  immediate.
- **FR-1.6** Sign-out MUST clear all client state.
- **FR-1.7** *(added 2026-09-09)* A signed-in user with role `player` and no group membership
  MUST NOT be able to start or continue a round. They see an "you need an invitation" screen.
  Playing is unlocked by accepting an invite (FR-4.3) or by holding a higher role (FR-7).

## FR-2 — Daily puzzle

- **FR-2.1** There MUST be exactly one daily puzzle, identified by `puzzleId` in `YYYY-MM-DD`
  form. The day boundary is **12:00 `America/Sao_Paulo`** (OQ-2, resolved). `puzzleId` names the
  date the puzzle *opens*; the puzzle stays live until 12:00 the following day.
- **FR-2.2** The puzzle answer MUST be selected from a pre-generated schedule, not chosen at
  request time.
- **FR-2.3** A country MUST NOT repeat within 180 days.
- **FR-2.4** Selection MUST be weighted by recognisability tier, not uniform. Target mix:
  tier 1 (well known) 50%, tier 2 (moderate) 35%, tier 3 (obscure) 15%. See
  `03-geo-data-pipeline.md` for tier definitions.
- **FR-2.5** A player gets **6 guesses**.
- **FR-2.6** Each guess MUST be a country from the canonical list, selected via autocomplete.
  Free-text that does not resolve to a country MUST be rejected client-side before submission.
- **FR-2.7** After each incorrect guess the player MUST receive: great-circle distance in km,
  direction as one of 8 compass arrows, and proximity as a percentage.
- **FR-2.8** After a correct guess, or after the 6th incorrect guess, the round ends and the
  answer is revealed.
- **FR-2.9** A player MUST be able to leave and return mid-round on any device and resume with
  guesses intact.
- **FR-2.10** A completed round MUST NOT be replayable.
- **FR-2.11** After completing, the player MUST see a share text using emoji squares and arrows
  that does **not** encode the answer, plus a link to the game.
- **FR-2.12** Past puzzles MUST be viewable in an archive after their day has ended. Archive
  play SHOULD be permitted but MUST NOT count toward any leaderboard.

## FR-3 — Scoring

- **FR-3.1** Points for a completed daily:

  | Solved on guess | 1 | 2 | 3 | 4 | 5 | 6 | Not solved |
  |---|---|---|---|---|---|---|---|
  | Points | 6 | 5 | 4 | 3 | 2 | 1 | 0 |

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
- **FR-4.2** *(amended 2026-09-09)* Groups have **no public invite code**. An invitation is a
  **single-use token** of 16 chars from the ambiguity-free alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, valid for 7 days, created by the group owner and revocable
  by them (D-32).
- **FR-4.3** *(amended 2026-09-09)* A user joins a group by following an invite link. The first
  signed-in account to accept consumes the token; a used, revoked, expired or unknown token
  MUST be rejected with a typed error.
- **FR-4.4** A user MAY belong to up to 10 groups.
- **FR-4.5** A group MUST have a maximum size (default 200).
- **FR-4.6** The group leaderboard MUST show, per member: rank, display name, points in the
  selected window, rounds played, average guesses, current streak.
- **FR-4.7** The leaderboard MUST be filterable by window (all-time / 7d / 30d).
- **FR-4.8** *(amended 2026-09-09)* The owner MUST be able to rename the group, create and revoke
  invites, and remove a member. Management rights follow **ownership**, not role (FR-7.5).
- **FR-4.9** A member MUST be able to leave a group. Their historical results stay but they
  disappear from the board. When the owner leaves, ownership MUST pass to the longest-standing
  remaining member without granting them any role (D-23); the last member leaving deletes the
  group and its pending invites.
- **FR-4.10** Group membership and the leaderboard MUST only be readable by members.
- **FR-4.11** A group MUST show a "today" panel: who has already played today (without revealing
  their score until they finish, to preserve drama), and who has not.

## FR-5 — Challenges

- **FR-5.1** A user MUST be able to create a challenge. The **server** selects the country;
  the creator does not choose and does not see it.
- **FR-5.2** The selected country MUST NOT be one either participant has seen in the last 60 days,
  and MUST NOT be the current or an upcoming daily.
- **FR-5.3** A challenge MUST produce a shareable link/code.
- **FR-5.4** A challenge MUST support 2–8 participants.
- **FR-5.5** All participants play the same country under daily rules (6 guesses).
- **FR-5.6** A participant's result MUST be hidden from other participants until they have
  finished their own attempt or the challenge expires.
- **FR-5.7** Challenges MUST expire 48 hours after creation.
- **FR-5.8** A challenge results screen MUST rank participants by points then time.
- **FR-5.9** Challenge results MUST NOT contribute to group or global leaderboards.

## FR-6 — Client experience

- **FR-6.1** The game MUST work on mobile viewports down to 360px wide.
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
- **FR-7.4** `player` MAY play the daily once invited, view the boards of their groups, and take
  part in tournaments of their groups.
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
