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
- A used, revoked or expired link is refused. A non-member gets `permission-denied` on every group
  document (rules tests) and on `getLeaderboard`.
- Organizer cannot reach any admin callable. `listUsers` never shows an e-mail.
- `deleteAccount` removes the user everywhere; the group they owned has a new owner.
- Phase 1 players have no group yet: **invite them before deploying**, or they are locked out (D-28).

**Shipping (Paulo):** push; confirm the two Cloud Scheduler jobs exist in `southamerica-east1`;
`cd tools && npm run set-role -- --project lisecki-dev --uid <your uid> --role admin`; check
Artifact Registry size once (18 Cloud Run services, docs/05-cost.md §3.2). **This is the point where
you share the link.** Talk to whoever owns security policy first.

---

## Phase 3 — Tournaments
*Effort: unknown until designed. Write the design doc first.*

Rescoped 2026-09-09. Paulo wants a tournament engine, not a single one-off challenge:

- **Formats:** single elimination, double elimination, round robin, Swiss, free-for-all. All must
  accommodate odd player counts (byes; the bye player may get an edge). Most settings configurable.
- **Rounds** are made of N challenges; the manager picks the order or randomises it. A round may be
  five challenges of one kind (e.g. flags only).
- **Challenge kinds:** today only "guess the country by its shape". Planned: by flag, by capital
  city, guess the GDP, and more. Each kind is its own pure evaluator; `attempts.mode`/a `kind`
  field distinguish them from the daily (`mode: "daily"` today).
- **Who:** admin and organizers create tournaments in groups they own (FR-7.3); players in the
  group take part (FR-7.4). Tournaments live under `groups/{gid}/tournaments/{tid}` behind the same
  `inGroup` rule. Tournament results do not move the daily boards (FR-5.9 survives).
- FR-5's one-off challenge (server-picked country, creator plays blind, D-10, hidden-until-finished
  FR-5.6) is the simplest "free-for-all of one round with one challenge" and is the natural first
  slice.

Steps: (1) `docs/06-tournaments.md` — formats, bracket generation with byes, scoring per format,
challenge-kind interface, data model, rules; (2) the shape kind as a match, one format end to end;
(3) the rest. Nothing in Phase 2 blocks this; see the plan's §4.10.

---

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
| Cold starts make lunchtime feel bad | Measure first. `minInstances: 1` if p95 is bad. |
| The public repo leaks the schedule | `tools/out/` gitignored; `puzzles` collection unreadable |
| Nobody plays after week two | Ship Phase 1 fast and find out cheaply. This is the real risk. |
| A surprise bill | Not the region — the region premium only applies to overage. The real risks are `minInstances`, Artifact Registry accumulation, and per-viewer leaderboard aggregation. `05-cost.md` §3. Budget alert fires at R$1. |
