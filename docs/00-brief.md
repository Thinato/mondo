# Project Brief

> Name: **Mondo** (Italian/Portuguese-adjacent: "world"). Resolved — see OQ-1, decided 2026-09-03.
> Deliberately avoids `-le` naming. Game mechanics are not copyrightable, but NYT has been
> aggressive about Wordle-derivative naming, and this project is public and open source.

## 1. What this is

A daily country-silhouette guessing game, self-hosted on `lisecki.dev`, built to be played
by a small competitive group (a company team) over lunch.

Inspired by Worldle (https://worldle.teuteuf.fr/). No Worldle code or assets are used.

## 2. Why not just use Worldle

Three gaps drive this project:

| # | Gap in Worldle | What we build |
|---|---|---|
| G-1 | Progress lives in `localStorage`, lost on browser/device change | Authenticated accounts, server-side history |
| G-2 | No groups, no shared ranking | Groups with invite codes and leaderboards |
| G-3 | No way to play head-to-head with a friend | Async challenge mode |

## 3. Non-goals (v1)

Explicitly out of scope, to keep this finishable:

- Real-time synchronous multiplayer (both players racing on a live timer)
- Mobile native apps
- Anything beyond country silhouettes (no flags, no capitals, no "guess the country from a photo")
- Public global leaderboard across strangers
- Monetization, ads, analytics beyond basic error logging
- Internationalization beyond pt-BR + en

## 4. Users

- **Player** — a colleague. Signs in with a *personal* email. Plays the daily, joins a group,
  challenges people.
- **Group owner** — created the group, can rename it, rotate the invite code, remove members.
- **Maintainer** — the repo owner. Runs the puzzle-schedule generator, deploys, has GCP console access.

There is no admin UI in v1. Maintainer tasks are scripts + console.

## 5. Hard constraints

- **C-1** — The existing site (`Thinato/thinato.github.io`) is vanilla HTML/CSS/JS deployed by
  GitHub Pages. The game must not force a build step or framework onto that repo.
- **C-2** — Everything open source, including infrastructure-as-code. No secrets in the repo.
- **C-3** — The server is authoritative. The client must never be able to learn the answer early.
  This is the single most important architectural rule; see SEC-1 in `01-requirements.md`.
- **C-4** — Players use personal emails, not corporate identities. The system must never
  require, request, or store a corporate email address.
- **C-5** — Running cost must stay at or near zero at 100 players.

## 6. Decisions log

Decisions already made, with reasoning. Revisit deliberately, not accidentally.

| ID | Decision | Reasoning |
|----|----------|-----------|
| D-1 | Server-authoritative answer, delivered only after the round ends | The group is competitive and technical. A client-side answer makes any leaderboard meaningless. |
| D-2 | Firebase (Firestore + Cloud Functions v2 + Firebase Auth) | Easiest secure auth; generous free tier; the frontend can talk to it without a bundler. |
| D-3 | The whole project lives in `Thinato/mondo`, which publishes its own GitHub Pages site. Because the user site `thinato.github.io` carries the `lisecki.dev` custom domain, this project site is served at `lisecki.dev/mondo/`. | Honours C-1 by never touching the existing repo at all. One `git push` deploys. Backend, infra, tools and frontend stay in one place with one history. Revised 2026-09-03; originally the game was to ship inside the Pages repo. |
| D-4 | Callable Cloud Functions (not raw HTTP endpoints) | Auth token verification is handled by the SDK; no hand-rolled JWT checking. |
| D-5 | Google sign-in as primary provider, email-link as fallback | Personal emails are overwhelmingly Gmail. No password storage. |
| D-6 | Terraform manages the GCP/Firebase project; Firebase CLI deploys functions and rules | Terraform is good at project/resource shape, awkward at function source. Split by strength. |
| D-7 | Natural Earth as the geometry source, `world-countries` for names/translations | Both public-domain / permissively licensed and downloadable as static files. |
| D-8 | Silhouette shows the *largest landmass only*, not overseas territories | Fixes France-in-the-Atlantic and makes centroid distances honest. See `03-geo-data-pipeline.md`. |
| D-9 | Puzzle day boundary pinned to `America/Sao_Paulo` | Everyone flips at the same instant. Avoids UTC-midnight-at-21:00 confusion. |
| D-10 | Async challenges only in v1; creator plays blind | A challenge where the creator picks the country is not a contest. |
| D-11 | The puzzle day runs noon-to-noon, and `rebuildStandings` runs at **12:05** `America/Sao_Paulo`, not 00:05 | Follows from OQ-2. The nightly job must fire just after the day boundary, not in the middle of a live round. |

## 7. Resolved questions

All nine forks were closed on **2026-09-03**, before Phase 0. Each one changes the data model
or the UI, so they are settled here rather than discovered later. Reopen deliberately.

| ID | Question | Answer | Why |
|----|----------|--------|-----|
| OQ-1 | Project name | **Mondo** | Short, pronounceable in pt-BR and en, no `-le` suffix, domain path `lisecki.dev/mondo/` reads well. Considered and dropped: Contorno, Silhueta, Bússola, Recorte. |
| OQ-2 | Daily reset time | **12:00 `America/Sao_Paulo`** | The group plays at lunch. Flipping at noon means the puzzle is brand new when they sit down and nobody has had a morning to spoil it. Accepted cost: the day runs noon-to-noon, so `puzzleId` names the date the puzzle *opens*, and it stays live until noon the next day. See D-11 for the job-timing consequence. |
| OQ-3 | Group model | **Many user-created groups** | More general than one implicit company board and barely more work — FR-4 is already written this way. A single company board is just the degenerate case where one group exists. |
| OQ-4 | Daily puzzle scope | **Global** — one country per day for everyone | Simpler schedule (one `puzzles/{puzzleId}` doc, not one per group), and it enables cross-group bragging. Per-group schedules would multiply the generator and the anti-repeat window by the number of groups. |
| OQ-5 | Missed-day policy | **Drop the worst 2 scores per 30-day window** | A single missed day should not end someone's month. Two is enough slack for a holiday or a sick day without letting people cherry-pick. Codified in FR-3.5; a never-started day still shows distinctly from a played-and-failed 0 (FR-3.3). |
| OQ-6 | Language | **Both, pt-BR default** | Data model carries `locale` on `users/{uid}` from day one so nothing has to be migrated. The visible toggle ships in Phase 4 — until then the UI is pt-BR only, but the strings live in `i18n.js` from the start. |
| OQ-7 | Practice mode | **Deferred to Phase 4** | Unranked infinite play is a nice-to-have that adds a whole second round lifecycle. Phase 1 must stay small enough to actually ship. |
| OQ-8 | Anti-cheat posture | **Server basics + a visible "verified" badge on clean solves** | Full lockdown is impossible anyway — SEC-12 concedes that a determined player can geometry-match the silhouette. Make cheating *visible* and socially expensive rather than technically impossible. |
| OQ-9 | Card on the GCP billing account | **Yes, with a budget alert at R$20** | Required for Cloud Functions. Expected real cost at 100 daily players is zero: everything sits inside the Firebase free tier (NFR-3). The alert exists to catch a runaway loop, not an expected bill. |

## 8. Privacy posture

Players use personal emails, which lowers the corporate-policy stakes but does not remove
LGPD obligations — you are still a controller of personal data about identifiable people.

Rules:

- Collect only: Firebase `uid`, email (from the auth provider), chosen display name, game results.
- **Display name is user-chosen and defaults to a random generated handle**, never the email
  local-part and never a real name. The leaderboard must not become a de-facto staff directory.
- Email is never displayed to other users, ever. Not in groups, not in challenges.
- A working account-deletion path must exist before you share the link with anyone (Phase 2).
- A one-page privacy note lives at `/mondo/privacidade.html`: what is stored, why, how to delete.
- Give whoever owns security policy at the company a heads-up before sharing. Ten minutes of
  conversation now beats an awkward conversation later.

## 9. Success criteria

The project is a success if, three weeks after launch:

- 10+ colleagues have played 5+ days each
- At least one argument about the scoring rules has broken out
- Nobody has needed to ask you to fix their lost progress
