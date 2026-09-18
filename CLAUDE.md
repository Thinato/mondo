# CLAUDE.md

Context for AI coding agents working in this repo. Read `docs/00-brief.md` through
`docs/05-cost.md` before making changes.

## What this is

A daily country-guessing game served at `lisecki.dev/mondo/`, built for a small competitive
group. A day is four challenges — silhouette, flag, capital, GDP per capita — played in order
(D-52, D-53). A day is **five** challenges since D-66: `flagPick` — which of these eight flags
— joined them. There is also a practice mode: one kind, as many challenges as you like, scored
for nobody (FR-9, D-60). Vanilla frontend published from `site/` by GitHub Pages, Firebase
backend.

## Invariants — never violate these

1. **The server holds the answer.** The country for an in-progress round must never appear in
   any response body, DOM node, asset path, filename, or console log. Every guess is evaluated
   in a Cloud Function. If a change would put the answer on the client early, stop and flag it.
   This includes anything the answer can be *computed* from: never send the exact bearing
   alongside the exact distance (D-36), because the two solve for the answer's centroid from a
   single guess. The client gets `compass`, the 8-point arrow.
2. **No client writes to score-bearing or membership-bearing data.** `puzzles`, `attempts`,
   `practice`, `challenges`, `groups/**`, `invites`, and the `role`/`groups` fields on `users` are
   Admin-SDK-only. Firestore rules default-deny. The client never loads the Firestore SDK;
   every read goes through a callable.
3. **Server timestamps only.** Never trust client-supplied time for anything scored.
4. **No build step on the frontend.** Vanilla ES modules, Firebase SDK via CDN ESM import.
   Do not introduce a bundler, framework, or transpiler into `site/`.
5. **No secrets in the repo.** No service-account JSON, no `.env`. CI uses Workload Identity
   Federation.
6. **Email addresses are never exposed to other users.** Display names only.
7. **Never set `minInstances` on a function without reading `docs/05-cost.md` §3.1.** One
   always-warm instance costs an order of magnitude more than the whole free tier and bills
   when nobody is playing. Cold starts are free; warm instances are not.
8. **`tools/out/` is gitignored.** It holds the generated puzzle schedule. Committing it leaks
   every answer.

## Conventions

- Backend is TypeScript, Cloud Functions v2, Node 22, region `southamerica-east1`.
- All backend entry points are **callable** functions, not raw HTTP.
- Every callable: assert auth, validate input against an explicit schema, then act. No exceptions.
- Scoring and geo maths live in `backend/functions/src/lib/` as pure, unit-tested functions.
  Business rules do not live in handlers.
- Frontend files are lowercase, hyphenated. Page names are pt-BR (`grupos.html`, `desafio.html`).
- Firestore document IDs are deterministic where possible (`{uid}_{puzzleId}`) so writes are
  idempotent.
- Reference requirement IDs (`FR-2.7`, `SEC-3`) in commit messages and PR descriptions.

## Before you finish a task

- If you touched `firestore.rules`, add or update rules tests — including **negative** cases.
- If you touched scoring, run the unit tests and state what changed in plain language, because
  humans will argue about it.
- If you touched the geo pipeline, run `cd tools && npm test && npm run build-geo`, then say so
  — the preview at `tools/preview.html` is for a human to eyeball.
- Never commit anything under `tools/out/`.

## Things that are deliberate, not oversights

- Only the largest landmass of each country is rendered. France is metropolitan France. This is
  decision D-8; see `docs/03-geo-data-pipeline.md` §3.1.
- **No silhouette is Natural Earth** (D-69, which widened D-59 and reversed D-15). All 196 are
  traced from the drawn artwork in `tools/country-shapes/` by `tools/lib/artwork.mjs`, because
  ne_10m gives Monaco 12 vertices and Nauru 9 and what it does resolve is a simplification the
  build simplifies again. Only the OUTLINE comes from there — **centroids, and so every distance
  and compass hint, stay Natural Earth**, and `countries.json`'s centroids were byte-identical
  across the change. That artwork's origin and licence are **unknown**; `NOTICE` and
  `tools/country-shapes/README.md` say so, and the files are committed rather than read from the
  still-gitignored `assets/` so the gap is visible. Do not reintroduce a projection for
  silhouettes and do not put a drawing in the scoring path. **Tuvalu and the Marshall Islands
  have no silhouette at all** and are absent from `shapes.json`; they keep their other four
  kinds, and the list lives in `tools/shape-overrides.json` with a reason each.
- There are **no shape keys and no public shape files**. Shapes and centroids exist only in
  `backend/functions/src/data/`; `getRound` inlines one path per round (D-13). If a change puts
  a shape or centroid into `site/`, stop.
- D-8 exceptions (archipelagos that keep more than one island) live in `tools/overrides.json`
  with a reason each (D-14). Do not add distance heuristics to the pipeline instead.
- **The compass arrow is a rhumb bearing, not a great-circle one** (FR-2.7, D-62). It is the
  direction on a *map*, and the property that matters is that it can never point north at an
  answer that lies south — the great-circle bearing did exactly that for 8.3 % of country pairs.
  `test/geo.test.ts` checks it over the whole pool. Distance stays great-circle; that mismatch is
  deliberate and is explained in the in-game help.
- **Giving up is a challenge ending with no guess** (FR-2.13, D-61). `giveUpCard` and
  `applyCardGuess` share `closeItem`, so there is exactly one way an item ends; do not add a
  second path that "skips" an item. `scoreItem` already returns 0 for anything unsolved, so
  there is nothing to special-case. The daily confirms before giving up and practice does not,
  and that asymmetry is the point: the daily's zero is permanent and shared.
- **Practice is a card of one item** (FR-9, D-60). `lib/practice.ts` owns only the sequence, the
  totals and the subject picker; the guess budget, the throttle, the score and the reveal are
  `lib/card.ts`'s, unchanged. Two things there are load-bearing. The session lives in
  **`practice/{uid}`, never in `attempts`** — a document that is not in `attempts` cannot reach a
  board at all, which is a stronger guarantee than remembering to filter it out. And the picker
  **withholds the daily's subjects from today to +7 days**: without that, practising `gdp` is a
  way to look up today's answer, because that prompt names its own country. Do not widen the
  window to FR-5.2's ±60 — that withholds more than half the pool from the drill it exists to be.
- **A group is one page; a tournament is another** (D-68). `grupos.html` carries the ranking, the
  group's tournaments and its members as three tabs, so the "escolha um grupo" screen that used to open
  `torneios.html` is gone — it asked a question that being on the group page had already answered, and
  arriving at `torneios.html` without a `?t=` now redirects there. What did NOT move is the card of a
  round: that is a game screen, not a group screen, and it shares `.play-col` and the rail with the daily.
- **The day's challenges are the rail, not a list under the form** (D-68). `#items` renders `.step` rows
  in a left column at 60rem and a strip of N boxes above the prompt below it — one markup, two shapes, and
  `mondo.css` decides which. It carries the KIND of each challenge and never the answer: the answers are
  `#recap`, which the result screen shows once the day is over. A rail reading "Peru · Gana · Capital ·
  PIB per capita" reads as a bug, and mid-day half of it would be blank anyway.
- **There is exactly one accent and it is blue** (D-68). `--accent` is `#1f4e8c` light, `#7aa9e0` dark, on
  one control per screen. It cannot be orange or green: the five `--band-*` colours already mean
  warm-to-cold, so a green primary button beside a green "you are close" bar would be two meanings in one
  colour. `.primary` is the filled one; what `.primary` used to look like is now `.secondary`.
- **`listGroups` carries a `me`** (D-68). The profile is already read there to work out `canCreate`, so
  the display name and the role are two free fields off a document in hand — and they are where every page
  but the daily gets its chrome: the initials on the avatar, whether the **Painel** link is drawn, and the
  name the Perfil dialog prefills. Do not prefill that dialog from the Firebase session instead: the Google
  account's name is not the name the group knows anyone by, and saving it would silently replace theirs.
  The role here draws a link and authorizes nothing; `admin.ts` asserts it on every call behind that link.
- **The phone's tab bar has two tabs** (FR-6.1, D-68). Hoje and Treinar. Grupos, torneios and the painel
  are in the account menu and not on the bar — nobody opens Mondo on a bus to rename a group. Above 60rem
  the bar is gone and the three destinations are back in the top bar.
- Challenge creators do not choose the country and play blind. Decision D-10.
- Territories and dependencies are excluded from the country pool. Changes go through
  `tools/include.json` via pull request. `VA` is excluded too: no usable geometry (D-20).
- `assets/` is still gitignored and still not a build input (D-16). D-69 took the 196 SVGs the
  pool needs out of it into `tools/country-shapes/` and reads them from there; the rest of
  `assets/` — the other 53 shapes, the coats of arms — stays out of the repo and out of the
  build. Do not add a read of `assets/` back.
- Local runs use the `demo-mondo` project id and `npx firebase-tools`, not the Homebrew
  `firebase` binary. See `docs/02-architecture.md` §8.
- **Playing is invite-only** (FR-1.7, D-28): a `player` with no group gets `not-invited`. Groups
  have no public code; invitations are single-use 7-day tokens (D-32). Roles `admin > organizer
  > player` (FR-7) live on the profile; admin is granted only by `tools/set-role.mjs` (D-29).
- **The daily and a tournament round are the same act** (D-52, which reversed D-45): both are a
  card of N challenges played one at a time, so the transitions live once in `lib/card.ts` and
  `lib/round.ts` keeps only what a *day* has — the schedule, the streak, the share grid, and the
  `puzzleId`. A daily attempt carries `puzzleId`; a tournament play must not (D-40).
- **A day is worth 0–30, and earlier days are worth less** (0–6 before D-52, 0–18 before D-53,
  0–24 before D-66). Do not "fix" the seams in the all-time column: leaving them is a deliberate
  call, and there are three now.
- **The daily schedule has exactly one rule** (FR-2.3, D-67): the same country is not asked by
  the **same kind** within 30 days. Nothing else. A country may be two challenges on one day, and
  about 21 days a year it is. There is no ceiling on how many kinds a day can hold — a kind needs
  only a pool bigger than 30.
- **`gdp` and `flagPick` name a country in their prompts**, because in both the country is the
  question — the figure is the answer in one, the flag in the other. Inside a **tournament card**
  what keeps that safe is `buildCard` holding subjects distinct; do not relax that. **The daily no
  longer has that guarantee** (D-67): about 14 days a year a `gdp` or `flagPick` prompt names the
  answer to another of that day's challenges. That was measured and accepted, not missed — if you
  are asked to "fix" it, the fix is FR-2.3, not a patch in `kinds.ts`.
- **In a multiple-choice kind the POSITION of the right option is the answer** (FR-8.7, D-64).
  Three rules follow and each has a test. An option carries artwork and nothing else — no code,
  no name, no id — so a guess is an index; **`buildCard` does the shuffling**, never the kind,
  so a new choice kind cannot ship with the answer at index 0 by forgetting; and the options are
  **stored on the card**, never derived from the subject, or a pool change reshuffles a challenge
  someone has open. A wrong pick is never named and distractors exclude the card's other
  subjects — naming one would teach a flag that answers the `flag` challenge beside it. Do not
  choose distractors by anything readable **off the artwork**: weighting by payload size would
  make a busy flag rarer as a distractor than as an answer, and "pick the busiest" would beat the
  game knowing nothing. Geography is not in that class and is the point — **four of `flagPick`'s
  eight are the answer's nearest countries by centroid** (D-65), which is what makes the kind
  hard, and the "?" and `regras.html` both say so on purpose.
- **`tools/generate-schedule.mjs` now needs the backend built** (D-66): it imports the server's
  own `buildOptions` from `backend/functions/lib/` rather than restating which eight flags are on
  offer. `poolsFrom` still duplicates the pool rules — a JSON generator cannot import TypeScript
  — and that duplication is pinned by tests on both sides; the option rules were too much to
  restate, because they ARE the difficulty of the kind.
- There is **no results fan-out and no standings subcollection** (D-21, D-22): `attempts` is
  the single source of truth and the nightly job writes windows onto `groups/*/members/*`.
  Window arithmetic is D-24; do not change it without changing `regras.html` and the fixture
  in `test/standings.test.ts`.
- Do **not** add a `referrer` policy to any page: the Firebase web API key is referrer-restricted,
  so `no-referrer` would break sign-in (D-37).
- **Tournaments** (Phase 3, `docs/06-tournaments.md`) live in top-level `tournaments`, `rounds`
  and `cards`, never under `groups/**` — the cards hold answers and a group is member-readable
  (D-39). Card plays live in `attempts` with `mode: "match"` and **no `puzzleId` field**: that
  absence is what keeps tournament scores off the daily boards (FR-5.9, D-40), because the
  nightly job selects on a `puzzleId` range. Do not add the field "for consistency".
- A tournament is created from a **built-in preset** resolved server-side (D-48); the client never
  supplies settings. Every challenge kind scores one challenge 0–6 (D-44), and a kind's prompt
  must never name its own answer — which is why the `capital` pool excludes Brasília, Singapura,
  Cidade do México and the rest (FR-8.4).
- Tournament rounds close on a noon boundary with a 12-hour floor (D-43). Without the floor a
  round opened at 11:50 closed at noon, because `puzzleIdAt` names the day a puzzle *opens*.
- Group management rights come from **owning** the group, not from the role (FR-7.5). Succession
  therefore grants no role (D-23), and `users/{uid}` is readable only by its owner, because a
  `signedIn()` read allow would also permit listing the collection (D-34).
