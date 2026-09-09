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
| D-13 | Silhouette geometry and centroids are **server-only**. `getRound` inlines one SVG path per round; there are no public shape files and no shape keys at all. | The original design shipped opaque-keyed shape shards to the client alongside a `countries.min.json` that carried each country's key — a trivial JSON lookup from silhouette to answer, defeating SEC-1 outright. With shapes held server-side there is nothing public to match against except Natural Earth itself (SEC-12). A key that is never public has no purpose, so `shapeKey` was removed from the data model entirely. Decided 2026-09-06. |
| D-14 | D-8 (largest landmass only) stays the default; exceptions are listed explicitly in `tools/overrides.json` with a `minShare` threshold and a reason. | Largest-only makes Indonesia a blob of Kalimantan and Malaysia a slice of Borneo. A distance heuristic would fix those but reintroduce France-in-the-Atlantic and Norway-with-Svalbard. An explicit, reviewable exception list is simpler, and it turns "Japan should have Shikoku" into a pull request. Ten entries at launch: ID MY NZ JP PH GB IT DK GR FJ. |
| D-12 | One shared GCP project, `lisecki-dev`, holds everything on lisecki.dev. Mondo is a tenant, not the owner. | One billing surface, one budget, one console to check — the right call for a personal domain. Accepted costs: free-tier quotas are per project and therefore shared, only one Firestore database is free, and both `firestore.rules` and Identity Platform's authorized domains are project-wide and authoritative, so a careless deploy from either side can break the other. See `05-cost.md` §5. Decided 2026-09-04, replacing `mondo-prod`. |
| D-15 | **Natural Earth stays the silhouette source.** The crawled SVGs under `assets/` are a local-only visual reference, never a build input, never shipped. | Their source site and license are unknown, so anything derived from them cannot land in a public MIT repo (C-2, NFR-9). The permissively licensed alternative (simplemaps / `world-map-country-shapes`) was checked and rejected as geometry: one 2000×1001 Robinson world map, 11 in-scope countries missing, microstates about one pixel wide, and a single world projection, which `03-geo-data-pipeline.md` §3.4 forbids. Decided 2026-09-08. |
| D-16 | `assets/` is gitignored wholesale. | Unknown license, and coats of arms are outside the v1 brief (§3). |
| D-17 | `tools/preview.html` shows the crawled reference SVG beside each Natural Earth silhouette when the file exists locally. | The only useful thing the crawl gives us is a second opinion for tuning `overrides.json` and tolerance by eye. A clean clone sees one image per card. |
| D-18 | Mondo honours the parent site's `light-mode` class and `lisecki-theme` storage key but does **not** load `lisecki.dev/theme.js`. | That script plays a sound from a relative path and paints a nine-second flash overlay; under `/mondo/` the path breaks and the flash is not a game feature. Reading the class and key delivers what FR-6.6 wants: one theme across the domain. |
| D-19 | Email-link sign-in (FR-1.1 SHOULD) is deferred past Phase 1. | Google covers the group; a second provider is a second flow to test. |
| D-20 | The schedule is seeded from the maintainer's machine with Application Default Credentials, never a key file. `VA` is excluded from the pool. | SEC-10. The Vatican has no usable polygon in world-atlas 10m (two points on a line), and the build now refuses degenerate geometry rather than emit an empty path. |
| D-21 | **No `groups/*/results` fan-out.** `attempts/{uid}_{puzzleId}` is the single source of truth; the nightly job reads attempts directly and writes per-member aggregates. | Result copies would have to be kept coherent on every join, leave, deletion and retry. Reading attempts once per night for all players (≤ players × 30 docs) is cheaper and has no consistency surface. Consequence: nothing ever renders `[removido]` — a deleted account leaves every board exactly like a leaver (FR-4.9). Revisit if historical boards are ever added. Decided 2026-09-09. |
| D-22 | **One document per membership**: `groups/{gid}/members/{uid}` carries role-in-group, join date and the precomputed windows. No `standings` subcollection. | Same readers, same writer, same key. One fewer write on every membership change and one fewer thing for rules tests. |
| D-23 | **Owner leaves or deletes account → ownership passes to the longest-standing remaining member, whatever their role, and no role is granted.** Last member leaving deletes the group and its pending invites. | A group without an owner cannot invite or remove anyone, and deleting a group with people in it would be hostile. The successor needs no role because management follows *ownership* (FR-7.5) and `requireOwner` is what gates renaming, inviting and removing. Revised 2026-09-09 after the security review: the original version promoted the successor to `organizer`, which quietly unlocked the invite-only system — an organizer could create a group, invite one player, leave, and that player was then free to create groups and invite strangers. |
| D-24 | **30-day window = the 30 puzzle days ending at the last closed day; an unplayed day scores 0; the two lowest of those 30 are dropped (FR-3.5).** 7-day and all-time drop nothing. Tiebreak = sum of `elapsedMs` over finished rounds in the window, lower wins. Ranks are competition-style (1, 2, 2, 4). | The reading under which OQ-5's "two is enough slack for a holiday" is true. FR-3.3's "visually distinct" is honoured in `played` and the today panel. `regras.html` states all of it. |
| D-25 | **Boards close at noon.** Standings cover puzzle days through yesterday (rebuilt 12:05, D-11); today is a live panel (FR-4.11). All-time advances idempotently via `allTimeThrough`. | One model for players ("o ranking fecha ao meio-dia"); exactly-once arithmetic without giant transactions. |
| D-26 | **Display-name uniqueness within a group (FR-1.3) is resolved at read time**, by `joinedAt`: earliest keeps the bare name, later ones get ` 2`, ` 3`… `updateProfile` copies the new name to the caller's member docs. | Fresh after a rename, always unique, nothing to undo. |
| D-27 | **`users/{uid}.groups: string[]`** (≤10) is the membership index and **`users/{uid}.role`** holds the role. Only functions write either; the rules' `hasOnly(['displayName','locale'])` already forbids the client. | Cheaper than a collection-group query; the role belongs with the profile. |
| D-28 | **Play access = `role !== "player" || groups.length > 0`** (FR-1.7). Losing your last group locks the game again. | "Uninvited people cannot join" stays true over time with no separate allowlist to maintain. The admin can always re-invite. |
| D-29 | **Admin bootstrap is one script run with ADC**: `tools/set-role.mjs --project lisecki-dev --uid <uid> --role admin`. Further roles are set from the dashboard; the API never grants admin. | No uid hardcoded in a public repo, reproducible (NFR-7), no console clicking. |
| D-30 | **Extra chance = reset today's attempt, keep the old one in `history`.** `recordCompletion` does not double count a day already recorded. Retries are today-only. | Today-only keeps `loadOpenPuzzle` unchanged; history keeps the cheating trail for the admin. |
| D-31 | **Admin inspection of today's guesses is available only after the admin has finished today's round**; before that: state, guess count and timings. Closed days are fully visible. | Paulo plays in the same groups; seeing colleagues' distances before finishing would be cheating by his own rules (SEC-1 spirit). |
| D-32 | **Invite tokens**: 16 chars from the FR-4.2 alphabet (32¹⁶ ≈ 10²⁴), single-use, 7-day expiry, stored at `invites/{token}`, resolvable only through `acceptInvite`. | Single-use plus unguessable means a forwarded link is at worst one wrong person, revocable, removable. |
| D-34 | **`users/{uid}` is client-readable only by its owner** (`isSelf`), not by any signed-in player. | A rules condition that mentions neither `resource` nor the `{uid}` wildcard also authorizes a **list** of the whole collection, and `groups` is an array: any signed-in account, including one FR-1.7 bars from playing, could have run `where('groups','array-contains', gid)` and read out a group's entire membership with display names, plus everyone's role — exactly what FR-4.10 forbids. Other players' names reach the client only through `getLeaderboard`, which checks membership first. Nothing is lost because the client never loads the Firestore SDK. Found by the security review 2026-09-09. |
| D-35 | **`grantRetry` and `setRole` refuse to act on the caller's own account, and `setRole` refuses to change an admin's role in either direction.** | By the time your own round is over you have seen the answer, so a self-granted retry is six free points (D-30, D-31 reasoning). Admin is granted and revoked out of band only (D-29, FR-7.6), so one admin cannot demote another through the dashboard. |
| D-36 | **The exact bearing is never sent to the client.** `getRound` and `submitGuess` return the 8-point `compass` the UI already drew; `bearingDeg` stays in the stored attempt. | An exact distance *and* an exact bearing from a guess whose centroid is public solve for the answer's centroid in closed form, so one guess plus an offline Natural Earth table named the country — functionally the centroid SEC-2 forbids shipping, and a far cheaper attack than the silhouette matching SEC-12 concedes. The UI never read the field, so removing it changed nothing on screen and a determined player must now trilaterate over several guesses. Found by the security review 2026-09-09. |
| D-37 | **No page sets a `referrer` policy.** | Putting an invite token in the query string is a mild concern, and `no-referrer` would be the obvious answer — but the Firebase web API key is **referrer-restricted** (`infra/README.md` §9, SEC-9), so sending no `Referer` would have the key rejected and break sign-in. Browsers already default to `strict-origin-when-cross-origin`, which sends only the origin off-site, and `groups.js` clears the token from the address bar with `replaceState`. |
| D-33 | **The emulator end-to-end script is committed** (`backend/functions/test/e2e/`), run locally with `npm run test:e2e`, not in CI. | Fourteen callables with multi-account, multi-role flows are past what a scratch file should carry; adding Functions + Auth emulators to CI is a follow-up. |

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
