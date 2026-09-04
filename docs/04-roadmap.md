# Roadmap

Five phases. Each ends in something you can actually play. **Do not start a phase before the
previous one has been used by real humans for at least a few days** — the whole point of this
ordering is that Phase 1 will teach you things that change Phase 2.

Rough effort assumes evenings and weekends, one person, with Claude Code doing the typing.

---

## Phase 0 — Foundations
*Effort: ~1 evening. No game yet.*

Repo-side work is **done**; the remaining steps need a Google account and a card,
so they are yours to run. `infra/README.md` is the runbook.

| # | Step | Status |
|---|------|--------|
| 1 | Resolve OQ-1 … OQ-9 | **Done** — `00-brief.md` §7 |
| 2 | GCP project, billing, R$20 budget alert (SEC-11) | **Written as Terraform**, needs `apply` |
| 3 | GCS bucket for Terraform state, by hand | **You** — `infra/README.md` §1 |
| 4 | `/infra` written and applied; Firestore native in `southamerica-east1` | **Written**, needs `apply` + console check |
| 5 | Workload Identity Federation for GitHub Actions (SEC-10) | **Written as Terraform**, needs `apply` + `gh variable set` |
| 6 | `LICENSE` (MIT) and `NOTICE` (Natural Earth, mledoze/countries) | **Done** |
| 7 | Enable the Google sign-in provider | **You** — console only, `infra/README.md` §4 |

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

1. `tools/build-geo.mjs` end to end. Render `tools/preview.html` and look at every silhouette.
2. `tools/generate-schedule.mjs`, seeded into Firestore.
3. `backend/functions`: `getRound`, `submitGuess`. Pure `geo.ts` and `scoring.ts` with tests.
4. `firestore.rules` with **negative** rules tests — prove a client cannot read `puzzles`,
   cannot write `attempts`, cannot read another user's attempt.
5. `site/index.html` + `site/app/`: auth, silhouette render, autocomplete, guess loop, results,
   share text.
6. `regras.html` and `privacidade.html`.

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

## Phase 2 — Groups and leaderboards
*Effort: ~1 weekend.*

Scope: FR-3, FR-4, FR-1.5 (account deletion), NFR-6.

1. `createGroup`, `joinGroup`, `leaveGroup`, `removeMember`, `rotateInviteCode`.
2. Results fan-out on round completion.
3. `rebuildStandings` scheduled at 12:05 America/Sao_Paulo (D-11), incl. worst-2-dropped logic.
4. `getLeaderboard` + composite indexes.
5. `grupos.html`: group list, leaderboard with window filter, "who has played today" panel (FR-4.11).
6. `deleteAccount` (FR-1.5) — **this must exist before you share the link with colleagues.**
7. `scheduleHealthCheck` weekly warning.

**Acceptance:**
- Create a group, invite two people by link, all three play, the board ranks correctly.
- A non-member gets `permission-denied` on every group document. Verify in rules tests.
- `deleteAccount` removes the user everywhere and leaves past leaderboards coherent
  (`[removido]` entries, scores intact).
- Standings after the nightly job match a hand calculation on a spreadsheet. Do this once by
  hand — the rolling-window drop-worst-2 logic is the easiest thing here to get subtly wrong.

**This is the point where you share the link.** Talk to whoever owns security policy first.

---

## Phase 3 — Challenges
*Effort: ~1 weekend.*

Scope: FR-5.

1. `startChallenge` — server picks the country, excludes recent-for-all-participants and the
   upcoming daily schedule (FR-5.2). The creator plays blind (D-10).
2. `joinChallenge`, `getChallengeResults` with the hidden-until-finished projection (FR-5.6).
3. `desafio.html`: create, share link, play, results screen.
4. 48-hour expiry cleanup.

**Acceptance:**
- The creator's own `getRound` response for a challenge contains no answer. Check it directly.
- Participant A cannot see participant B's score until A has finished. Check the raw response,
  not just the UI.
- Challenge results do not move any group leaderboard (FR-5.9).

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
