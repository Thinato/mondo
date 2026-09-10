# Roadmap

Five phases. Each ends in something you can actually play. **Do not start a phase before the
previous one has been used by real humans for at least a few days** — the whole point of this
ordering is that Phase 1 will teach you things that change Phase 2.

Rough effort assumes evenings and weekends, one person, with Claude Code doing the typing.

---

## Phase 0 — Foundations
*Effort: ~1 evening. No game yet.*

**Phase 0 complete — 2026-09-06.** `ping` returned `{ ok: true, region:
"southamerica-east1" }` to a signed-in browser on `lisecki.dev/mondo/`, deployed
from CI via WIF. The table below is the record of how it got there.

| # | Step | Status |
|---|------|--------|
| 1 | Resolve OQ-1 … OQ-9 | **Done** — `00-brief.md` §7 |
| 2 | GCP project, billing linked, R$20 budget alert (SEC-11) | **Done** — `lisecki-dev`, imported and applied 2026-09-06 |
| 3 | GCS bucket for Terraform state | **Done** — `gs://lisecki-dev-tfstate`, versioned |
| 3b | Cost model verified against current GCP pricing | **Done** — `05-cost.md` |
| 4 | `/infra` applied; Firestore **native** in **`southamerica-east1`** | **Done and verified** from state — 46 resources |
| 5 | Workload Identity Federation for GitHub Actions (SEC-10) | **Done** — pool + provider applied, 3 repo variables set |
| 6 | `LICENSE` (MIT) and `NOTICE` | **Done** |
| 7 | Enable the Google sign-in provider | **Done** 2026-09-06 |
| 8 | Push → CI deploys `ping`; Pages source set to *GitHub Actions* | **Done** — pushed 2026-09-06, Pages enabled at `lisecki.dev/mondo/` |
| 9 | Artifact Registry cleanup policy | **Done** 2026-09-06 — keep 3, delete >30d. First image was 98.7 MiB against 0.5 GB free. |
| 10 | Restrict the Firebase web API key to known referrers | **Done** 2026-09-06 — `infra/README.md` §9 |

Terraform cannot enable the Google sign-in provider: it needs an OAuth client
that Firebase provisions on toggle. That is the one irreducible manual step.

**Done when:** `terraform apply` on a fresh clone reproduces the project, and the
`ping` callable deployed from CI returns `{ ok: true }` to a browser on
`lisecki.dev/mondo/`. The smoke page at `site/index.html` performs exactly that
check — sign-in, CORS, region and deploy in one click.

**Verify with your own eyes before Phase 1**, because two of these are
irreversible: Firestore is in **Native mode**, in **`southamerica-east1`**, and
the budget alert exists.

---

## Phase 1 — Playable daily, single player
*Effort: ~2 weekends. This is the bulk of the work.*

Scope: FR-1 (except deletion), FR-2, FR-6, SEC-1 … SEC-9. Plus the whole geo pipeline.

1. ~~`tools/build-geo.mjs` end to end.~~ **Built 2026-09-06.** 196 countries (VA dropped 2026-09-08: no usable geometry), 10 D-8 exceptions,
   client file leak-checked. `tools/preview.html` is rendered — **look at every silhouette**.
2. ~~`tools/generate-schedule.mjs`, seeded into Firestore.~~ **Built 2026-09-08. Production seeded 2026-09-09**: seed 20260908, 365 days from 2026-09-08. Regenerable from those two numbers; re-seed with `--history` before 2027-09-07 (NFR-6).
3. ~~`backend/functions`: `getRound`, `submitGuess`. Pure `geo.ts` and `scoring.ts` with tests.~~ **Built 2026-09-08.** 46 unit tests plus an emulator smoke run; `updateProfile` added for FR-1.3.
4. ~~`firestore.rules` with **negative** rules tests.~~ **Built 2026-09-08.** Ten emulator tests, most negative, run in CI.
5. ~~`site/index.html` + `site/app/`: auth, silhouette render, autocomplete, guess loop, results,
   share text.~~ **Built 2026-09-08**, played end to end against the emulators.
6. ~~`regras.html` and `privacidade.html`.~~ **Built 2026-09-08.**

**Do not build groups yet.** You will be tempted. Don't.

**Acceptance:**
- Sign in on a phone, play, close the tab, reopen on a laptop, and the round resumes with
  guesses intact (FR-2.9).
- Open devtools, inspect every network response and the full DOM. **The answer appears nowhere**
  until the round ends (SEC-1, SEC-2). Have someone else try to break it too.
- A second attempt on the same day is rejected (FR-2.10).
- Rules unit tests pass, including all negative cases.
- Ship it, and play it yourself for a full week before Phase 2.

---

## Phase 2 — Invite-only groups, roles, leaderboards, admin dashboard
*Effort: ~2 weekends.* Rescoped 2026-09-09 after Phase 1: **nobody uninvited plays** (FR-1.7),
three roles (FR-7), single-use invite links (FR-4.2/4.3 as amended), an admin dashboard.
Plan: `.omc/plans/phase-2-groups-leaderboards.md`.

Scope: FR-1.5, FR-1.7, FR-3, FR-4 as amended, FR-7, NFR-6.

1. ~~Pure libs: standings (D-24), groups, invites, authz; play gate.~~ **Built 2026-09-09**, 91 unit tests incl. a hand-checkable 30-day fixture.
2. ~~`createGroup`, `createInvite`, `listInvites`, `revokeInvite`, `acceptInvite`, `leaveGroup`, `removeMember`, `renameGroup`, `listGroups`.~~ **Built 2026-09-09.** No results fan-out (D-21).
3. ~~`getLeaderboard` with the live today panel.~~ **Built 2026-09-09.** No composite indexes needed.
4. ~~Admin: `listUsers`, `setRole`, `listAllGroups`, `listAttempts`, `grantRetry`; `tools/set-role.mjs`.~~ **Built 2026-09-09.**
5. ~~`rebuildStandings` 12:05 (D-11, D-25) and `scheduleHealthCheck` weekly.~~ **Built 2026-09-09.**
6. ~~`deleteAccount` (FR-1.5).~~ **Built 2026-09-09.**
7. ~~Rules for `groups/**` and `invites` with negative tests.~~ **Built 2026-09-09**, 19 emulator tests.
8. `grupos.html`, `admin.html`, invitation screen, account deletion in the profile dialog, `regras.html` ranking section.
9. Committed emulator e2e (`npm run test:e2e`, D-33); docs.

**Acceptance:**
- A brand-new Google account sees the invitation screen and no attempt document is created.
- Create a group, invite two people by link, all three play; after 12:05 the board ranks correctly
  and **matches a spreadsheet** built from the D-24 rules — do this once by hand.
  **Arithmetic done 2026-09-09.** The D-24 rules were re-derived from `regras.html` alone, without
  reading `lib/standings.ts`, and the two implementations were diffed over 299 attempts and 12
  players: every `points`, `played` and `totalElapsedMs` figure agrees in all three windows,
  including the two-worst drop and the unplayed-day-is-a-zero rule. The live board also matches a
  recompute from its own raw attempts. The one real divergence was the streak, which counts today
  while the windows do not — true, deliberate, and now said out loud in `regras.html`.
  **Still owed:** the multi-player half. `rebuildStandings` has never actually fired in production
  (Cloud Scheduler shows no last-attempt time), so the scheduled path is unexercised.
- A used, revoked or expired link is refused. A non-member gets `permission-denied` on every group
  document (rules tests) and on `getLeaderboard`.
- Organizer cannot reach any admin callable. `listUsers` never shows an e-mail.
- `deleteAccount` removes the user everywhere; the group they owned has a new owner.
- Phase 1 players have no group yet: **invite them before deploying**, or they are locked out (D-28).

**Shipping (Paulo):** push; confirm the two Cloud Scheduler jobs exist in `southamerica-east1`;
`cd tools && npm run set-role -- --project lisecki-dev --uid <your uid> --role admin`; check
Artifact Registry size once — **measured 2026-09-09: 192.7 MB of 0.5 GB, no action needed**
(docs/05-cost.md §3.2). **This is the point where
you share the link.** Talk to whoever owns security policy first.

---

## Phase 3 — Tournaments
*Slices 1–6 built 2026-09-09/10. Slice 7 designed, not built.*

Design: **`docs/06-tournaments.md`**, written before any code and confirmed with Paulo. The
spine is **D-38**: any two scores that are ever compared come from the same card, which normally
means one card per round played by everyone still in. That makes byes trivial, collapses all five
formats into arithmetic over one table, and lets eliminated players keep playing for a side
ranking at no cost. Two regimes (D-49) carry Paulo's "points optional": `aggregate` totals decide
and nobody is eliminated; `match` makes a round a win or a loss and never carries the score.
Ties resolve by sudden death or a replay (D-50). Tournaments are created from built-in presets,
never from client-supplied settings (D-48).

1. ~~Free-for-all, `aggregate`, one round, one shape challenge — create, card, play, close,
   standing.~~ **Built 2026-09-09.** This retires FR-5's old one-off challenge rather than adding
   to it.
2. ~~N challenges per round, the `capital` kind, shuffled order; the `quintal`, `capitais` and
   `mistura` presets; `torneios.html` and the card player.~~ **Built 2026-09-09.**
3. ~~**Round robin** — the circle method (byes fall out for free), match points, draws. The first
   `match` regime and the first pairings, so `core.ts`'s shared primitives get written here.~~
   **Built 2026-09-09** as `lib/tournament-core.ts` (flat, like the rest of `lib/`): `cardWinner`,
   `competitionRanks`, the circle method, `resolvePairings`, `matchRecords`. The `liga` preset,
   capped at 12 players because n−1 rounds at group scale is a year-long tournament.
4. ~~**Single elimination** — seeding, bracket order, first-round byes, `consolation`, and the tie
   policies (§6.4), which is the first place a tie cannot be waved away by the clock.~~
   **Built 2026-09-10.** The `mata-mata` preset. Sudden death is a sub-round that holds the round
   open: the round's own `closedAt` is set, but the next round is not paired until it resolves.
5. ~~**Swiss** — the pairing engine; the only genuinely fiddly pure algorithm in the phase.~~
   **Built 2026-09-10.** The `suico` preset. The pairing search is exhaustive rather than the
   sketched swap-and-retry: at ≤ 12 players the worst case is 11!! = 10,395 candidate pairings, and
   enumeration cannot fail to find a repeat-free draw that exists — which is precisely risk T-3.
6. **Double elimination** — losers-bracket mapping and the grand final. Last, deliberately: it is
   more work than the other four together.
7. **`flag` and `gdp` kinds** — `flag` from a vendored public-domain SVG set with a `NOTICE` entry
   (OQ-11, answered); `gdp` still blocked on OQ-12 (source and vintage).

**Acceptance for what is built:**
- Create a `mistura` from `torneios.html`, have two accounts play it, close the round early, and
  the standings rank by points then time with the open round contributing nothing.
- Create a `liga` with an odd field: every pair meets exactly once, everybody sits out exactly
  once, the table ranks on match points, and a player can top the card-points column while
  finishing last.
- Create a `mata-mata` with a field that is not a power of two: the spare slots go to the top
  seeds, two perfect cards trigger sudden death rather than a coin toss, and an eliminated player
  keeps playing without ever climbing back above someone still in the bracket.
- Create a `suico`: its length is capped to the number of opponents that exist, no pair ever meets
  twice, and the bye moves down the table instead of landing on the same player again.
- Create a `chave-dupla`: losing once drops you to the losers bracket and you keep playing, losing
  twice ends it, both brackets appear in the same round, and the grand final leaves exactly one
  champion.
- Nothing from a tournament appears on any daily board (FR-5.9 — enforced by D-40, not by a
  filter).
- A non-member gets `permission-denied` on every tournament callable; a member who leaves the
  group stops being served cards but keeps their standings slot.
- 220 unit, 24 rules and 54 e2e tests pass.

**Before slice 3:** read `06-tournaments.md` §16. Slices 1–2 went through an independent code
review and security review that found a live production hole older than this phase (D-51), a
round-window bug in the exact hour the lunch preset is for, and a `capital` prompt that named its
own answer. Assume slice 3 has its own.

## Phase 4 — Polish
*Effort: ongoing.*

- Archive of past puzzles (FR-2.12), unranked
- Streak display and personal stats page
- pt-BR / en toggle (FR-6.6, OQ-6)
- Practice mode (OQ-7)
- Better share cards
- Autocomplete miss-log review, alias expansion
- `minInstances` tuning against real p95 latency (NFR-2)

---

## Phase 5 — Maybe, if people are still playing

- Live head-to-head: both players start on a countdown, Firestore `onSnapshot` for live
  opponent progress. Genuinely fun and genuinely more work.
- Hard mode with rotated silhouettes (§3.5 of the geo doc)
- Season resets with a hall of fame
- Group-level custom scoring rules

---

## Standing risks

| Risk | Mitigation |
|---|---|
| Firestore created in the wrong location or Datastore mode | Verify in the console at end of Phase 0. It is irreversible. |
| Answer leaks through some surface nobody thought of | Adversarial review at the end of Phase 1, by someone other than you |
| Rolling-window scoring is subtly wrong | Hand-verify once against a spreadsheet; pure functions with unit tests |
| A tournament format's bracket arithmetic is subtly wrong | Every format is a pure fold with a hand-checkable fixture, **including an odd-count fixture** — that is where these engines break |
| Cold starts make lunchtime feel bad | Measure first. `minInstances: 1` if p95 is bad. |
| The public repo leaks the schedule | `tools/out/` gitignored; `puzzles` collection unreadable |
| Nobody plays after week two | Ship Phase 1 fast and find out cheaply. This is the real risk. |
| A surprise bill | Not the region — the region premium only applies to overage. The real risks are `minInstances`, Artifact Registry accumulation, and per-viewer leaderboard aggregation. `05-cost.md` §3. Budget alert fires at R$1. |
