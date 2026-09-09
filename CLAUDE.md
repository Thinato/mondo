# CLAUDE.md

Context for AI coding agents working in this repo. Read `docs/00-brief.md` through
`docs/05-cost.md` before making changes.

## What this is

A daily country-silhouette guessing game served at `lisecki.dev/mondo/`, built for a small
competitive group. Vanilla frontend published from `site/` by GitHub Pages, Firebase backend.

## Invariants — never violate these

1. **The server holds the answer.** The country for an in-progress round must never appear in
   any response body, DOM node, asset path, filename, or console log. Every guess is evaluated
   in a Cloud Function. If a change would put the answer on the client early, stop and flag it.
   This includes anything the answer can be *computed* from: never send the exact bearing
   alongside the exact distance (D-36), because the two solve for the answer's centroid from a
   single guess. The client gets `compass`, the 8-point arrow.
2. **No client writes to score-bearing or membership-bearing data.** `puzzles`, `attempts`,
   `challenges`, `groups/**`, `invites`, and the `role`/`groups` fields on `users` are
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
- There are **no shape keys and no public shape files**. Shapes and centroids exist only in
  `backend/functions/src/data/`; `getRound` inlines one path per round (D-13). If a change puts
  a shape or centroid into `site/`, stop.
- D-8 exceptions (archipelagos that keep more than one island) live in `tools/overrides.json`
  with a reason each (D-14). Do not add distance heuristics to the pipeline instead.
- Challenge creators do not choose the country and play blind. Decision D-10.
- Territories and dependencies are excluded from the country pool. Changes go through
  `tools/include.json` via pull request. `VA` is excluded too: no usable geometry (D-20).
- `assets/` is gitignored reference material of unknown license (D-15, D-16). Nothing under
  `site/`, `backend/` or the build may read it; only `tools/preview.html` shows it, locally.
- Local runs use the `demo-mondo` project id and `npx firebase-tools`, not the Homebrew
  `firebase` binary. See `docs/02-architecture.md` §8.
- **Playing is invite-only** (FR-1.7, D-28): a `player` with no group gets `not-invited`. Groups
  have no public code; invitations are single-use 7-day tokens (D-32). Roles `admin > organizer
  > player` (FR-7) live on the profile; admin is granted only by `tools/set-role.mjs` (D-29).
- There is **no results fan-out and no standings subcollection** (D-21, D-22): `attempts` is
  the single source of truth and the nightly job writes windows onto `groups/*/members/*`.
  Window arithmetic is D-24; do not change it without changing `regras.html` and the fixture
  in `test/standings.test.ts`.
- Do **not** add a `referrer` policy to any page: the Firebase web API key is referrer-restricted,
  so `no-referrer` would break sign-in (D-37).
- Group management rights come from **owning** the group, not from the role (FR-7.5). Succession
  therefore grants no role (D-23), and `users/{uid}` is readable only by its owner, because a
  `signedIn()` read allow would also permit listing the collection (D-34).
