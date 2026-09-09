# Architecture

## 1. System shape

```
┌────────────────────────────────────────────┐
│ GitHub Pages (repo Thinato/mondo)          │
│   served at  lisecki.dev/mondo/            │
│  /site/               game (vanilla ESM)   │
│    - firebase-app.js via CDN ESM import    │
│    - no build step, no bundler             │
└───────────────┬────────────────────────────┘
                │ HTTPS, Firebase callable protocol
                │ ID token attached by SDK
┌───────────────▼────────────────────────────┐
│ Firebase / GCP project  lisecki-dev        │
│                                            │
│  Firebase Auth (Identity Platform)         │
│    Google provider + email link            │
│                                            │
│  Cloud Functions v2 (Node 22, southamerica-east1)
│    getRound        createGroup  acceptInvite│
│    submitGuess     createInvite listGroups │
│    updateProfile   getLeaderboard …        │
│    deleteAccount   admin: listUsers …      │
│    (Phase 3: tournaments)                  │
│    [scheduled] rebuildStandings 12:05 BRT  │
│    [scheduled] scheduleHealthCheck weekly  │
│                                            │
│  Firestore (native mode, southamerica-east1)
│    default-deny rules, Admin SDK writes    │
└────────────────────────────────────────────┘
```

**Why the game has its own repo and its own Pages site (D-3, revised):** the existing site
`Thinato/thinato.github.io` carries the `lisecki.dev` custom domain. A *project* Pages site in
`Thinato/mondo` inherits that domain and is served at `lisecki.dev/mondo/` — so the game reaches
its intended URL without a single commit landing in the other repo. That honours C-1 more
strictly than shipping inside it would, and keeps backend, infra, tools and frontend in one
history. The Firebase JS SDK ships as ES modules on a CDN, so
`import { initializeApp } from ".../firebase-app.js"` works directly in the browser with zero
tooling. `git push` is the deploy.

**Why `southamerica-east1`:** the players are in São Paulo. Firestore location is permanent
once set — pick it deliberately. It is a Tier 2 (more expensive) region, which does not matter
because free-tier allowances are the same size everywhere and the plan has no overage — see
`05-cost.md` §1.

**Why the project is `lisecki-dev` and not `mondo-prod`:** one GCP project holds everything on
lisecki.dev, so there is a single billing surface and a single place to look (D-12). Mondo is a
tenant, not the owner. Two things follow, and both can break a neighbouring app:
`firestore.rules` is per-database and a deploy **replaces** the whole ruleset, and Identity
Platform's `authorized_domains` is set **authoritatively, not additively**. Free-tier quotas are
per project too, so the headroom in `05-cost.md` §2 is shared rather than Mondo's alone. Full
consequences in `05-cost.md` §5.

## 2. Repository layout

Everything lives in `Thinato/mondo`. GitHub Pages publishes **only `site/`**, which is served
at `lisecki.dev/mondo/`. `backend/`, `infra/`, `tools/` and `docs/` are in the same repo but
never reach the published site — the Pages workflow uploads the `site/` directory alone.

```
/site/                    <- the only directory GitHub Pages publishes
  index.html              daily game
  grupos.html             group list + leaderboards + invite acceptance
  admin.html              admin dashboard (FR-7.2)
  desafio.html            challenge lobby + results (Phase 3)
  arquivo.html            past puzzles (Phase 4)
  regras.html             scoring rules (FR-3.7)
  privacidade.html        LGPD note
  app/
    firebase.js           SDK init, exported app/auth/functions handles
    api.js                thin typed wrapper over callable functions
    game.js               round state machine
    groups.js             grupos.html
    admin.js              admin.html
    geo.js                render silhouette, format distance/arrow
    autocomplete.js       country search (FR-6.3)
    share.js              emoji share text
    i18n.js               pt-BR / en strings
  data/
    countries.min.json    generated; codes, names, aliases — and nothing else (D-13)
  mondo.css
  .nojekyll               skip Jekyll processing

/backend/                 never published by Pages
  functions/
    src/
      index.ts            exports every function
      db.ts               document refs, puzzleDays, ensureProfile
      round.ts groups.ts leaderboard.ts admin.ts account.ts standings.ts health.ts
      lib/                pure, unit-tested: geo scoring puzzle-day round standings groups invite authz validate errors
      data/
        countries.json    generated; + centroids, tiers, discard stats (server-only)
        shapes.json       generated; one SVG path per country (server-only, D-13)
    test/
  firestore.rules
  firestore.indexes.json
  firebase.json

/infra/
  main.tf providers.tf variables.tf outputs.tf
  README.md

/tools/
  build-geo.mjs           Natural Earth -> the three generated data files above
  lib/shape.mjs           pure geometry helpers, unit-tested
  include.json            which entities are countries (PR to change)
  tiers.json              recognisability tier per country (PR to change)
  aliases.json            autocomplete aliases + pt-BR name overrides
  overrides.json          D-8 exceptions: archipelagos that keep more than one island (D-14)
  preview.html            GITIGNORED — every silhouette in a grid; look at it after a rebuild
  generate-schedule.mjs   deterministic puzzle schedule -> seeded into Firestore
  out/                    GITIGNORED — generated schedule, i.e. every answer

/docs/                    00-brief .. 04-roadmap
/.github/workflows/       pages.yml, backend.yml
```

Because Pages uploads `site/` and nothing else, `backend/`, `infra/` and `tools/` cannot leak
through the published site even by accident. That is a stronger guarantee than a `.nojekyll`
convention, and it is why the frontend sits in its own directory rather than at the repo root.

## 3. Firestore data model

Naming: collections plural, document IDs deterministic wherever possible so writes can be
idempotent.

### 3.1 `users/{uid}`
Client-readable by any signed-in user (needed for leaderboards). Client-writable only for
`displayName`, via rules.

```
displayName    string      FR-1.2 / FR-1.3
createdAt      timestamp
lastPlayedOn   string      "YYYY-MM-DD"
currentStreak  number
longestStreak  number
totalPlayed    number
totalSolved    number
locale         "pt-BR" | "en"
role           "admin" | "organizer" | "player"   FR-7; functions-only (D-27, D-29); absent → player
groups         string[]                          membership index, ≤ 10 (FR-4.4, D-27); absent → []
```

Play is allowed when `role !== "player" || groups.length > 0` (FR-1.7, D-28).

Note: **email is deliberately not stored here.** It lives only in the Auth record, which
clients cannot enumerate. This is the mechanism behind FR-1.4.

### 3.2 `puzzles/{puzzleId}` — **no client access, ever (SEC-7)**

```
puzzleId       "2026-09-14"
countryCode    "PY"
opensAt        timestamp     computed from OQ-2 in America/Sao_Paulo
tier           1 | 2 | 3
```

There is no shape key. The server looks the path up by `countryCode` in its bundled
`shapes.json` and inlines it into the `getRound` response (D-13). Nothing about the shape is
ever addressable from the client.

### 3.3 `attempts/{uid}_{puzzleId}` — Admin SDK writes only

```
uid, puzzleId
startedAt      timestamp   server
finishedAt     timestamp   server, null while in progress
guesses        array<{ code, distanceKm, bearingDeg, proximity, at }>   bearing is stored, never sent (D-36)
guessCount     number
solved         boolean
points         number      FR-3.1
elapsedMs      number
mode           "daily" | "archive"
suspicious     boolean     set when elapsedMs < 2000 on a first-guess solve
history        Attempt[]   only after an admin retry (D-30): the earlier tries, oldest first
retries        number      only after an admin retry
```

Client may read its **own** attempt documents only. That is safe because by the time an attempt
doc exists with guesses in it, the client already knows those guesses.

### 3.4 `groups/{groupId}` — Admin SDK writes only

```
name           string
ownerUid       string
memberCount    number
maxMembers     number     default 200
createdAt      timestamp
```

There is no invite code on the group (FR-4.2 as amended); invitations are separate documents (§3.8).

### 3.5 `groups/{groupId}/members/{uid}` — Admin SDK writes only (D-22)

One document per membership carries the role in the group **and** the precomputed windows the
nightly `rebuildStandings` writes (D-25), so the client never aggregates.

```
uid            string
displayName    string     copied from the profile (D-26); uniqueness within the group is resolved at read time
role           "owner" | "member"
joinedAt       timestamp
allTime        { points, played, totalGuesses, avgGuesses, totalElapsedMs }
allTimeThrough string|null   last puzzle day folded into allTime — makes the job idempotent
last7          { ... }
last30         { ... }   worst 2 of the 30 days already dropped (FR-3.5, D-24)
currentStreak  number    effective streak as of the closed day (0 if the last play is older)
updatedAt      timestamp
```

Board read = the group document plus its ≤ 200 member documents, ranked in memory for all three
windows, plus `getAll` of today's attempt per member for the live panel (FR-4.11).

### 3.6 Results — none (D-21)

There is **no** `groups/*/results` fan-out. `attempts` is the single source of truth; the nightly
job reads the last 30 closed days of attempts once (one range query on `puzzleId`) and buckets
them by uid. A new member's stats are backfilled from their own attempts at join time.

### 3.7 Standings — see §3.5

Folded into the member document (D-22).

### 3.8 `invites/{token}` — no client access (D-32)

```
groupId        string
groupName      string     denormalised for the confirm dialog
createdBy      uid
createdAt      timestamp
expiresAt      timestamp  createdAt + 7 days
usedBy         uid|null   set by acceptInvite, which consumes the token
usedAt         timestamp|null
revokedAt      timestamp|null
```

A token is pending while `usedBy` and `revokedAt` are null and `expiresAt` is in the future.
Resolvable only through `acceptInvite`; the owner lists and revokes their group's pending invites.

### 3.9 `challenges/{challengeId}` — **no client read access**

```
createdBy, countryCode, createdAt, expiresAt, status
participants   map<uid, { displayName, status, points, guessCount, elapsedMs }>
```

Client never reads this directly. `getChallengeResults` returns a filtered projection that
honours FR-5.6 by stripping other participants' results until the caller has finished.

### 3.10 Required composite indexes

None. Every query is a single-field range or equality (`attempts.puzzleId`, `attempts.uid`,
`invites.groupId` + `usedBy` + `revokedAt` equalities, `users.createdAt`, `members.joinedAt`) or a
`getAll` by deterministic id; ranking sorts ≤ 200 member documents in memory.
`firestore.indexes.json` is deliberately empty.

## 4. API contract (callable functions)

All calls require auth. All reject with typed errors from a shared enum. Region
`southamerica-east1`. CORS restricted per SEC-9.

### `getRound({ puzzleId? })`
Returns the round the caller should see. Omitting `puzzleId` means today.

```jsonc
// response
{
  "puzzleId": "2026-09-14",
  "mode": "daily",
  "shape": { "viewBox": "0 0 500 500", "d": "M12.3 44.1L...Z", "fillRule": "evenodd" },
  "guessesUsed": 2,
  "guessesMax": 6,
  "guesses": [ { "code": "AR", "name": "Argentina", "distanceKm": 1043,
                 "compass": "NW", "proximity": 0.95 } ],   // 8-point arrow, never the exact bearing (D-36)
  "status": "in_progress",          // in_progress | solved | failed
  "answer": null,                   // populated ONLY when status != in_progress
  "serverTime": "2026-09-14T15:02:11.482Z"
}
```

Side effect: creates the attempt document with a server `startedAt` on first call. This is
what makes the timer un-spoofable (SEC-3).

### `submitGuess({ puzzleId, code })`

```jsonc
{
  "correct": false,
  "distanceKm": 1043, "compass": "NW", "proximity": 0.95,
  "guessesUsed": 3,
  "status": "in_progress",
  "answer": null,                   // revealed on solved | failed
  "points": null,                   // set when the round ends
  "shareGrid": null                 // set when the round ends
}
```

Transactional read-modify-write on the attempt doc (SEC-4). On completion, updates the
profile's streak and counters. Nothing is fanned out (D-21); the nightly job reads attempts.

### Play gate (FR-1.7)
`getRound` and `submitGuess` throw `not-invited` for a `player` with no groups, before any attempt
document is created. `getRound.me` carries `{ displayName, role, groupCount }`.

### Groups (FR-4 as amended)
- `createGroup({ name })` → `{ groupId }` — admin/organizer only
- `createInvite({ groupId })` → `{ token, url, expiresAt }` — owner only; `url` is `…/grupos.html?convite=<token>`;
  at most 20 may be pending per group
- `listInvites({ groupId })` → pending invites — owner only
- `revokeInvite({ token })` — owner only, idempotent
- `acceptInvite({ token })` → `{ groupId, name }` — transactional, consumes the token, backfills the
  joiner's last 30 closed days from their attempts; errors `invalid-invite`, `group-full`, `too-many-groups`.
  A caller who is already a member is sent to the board **without** consuming the token, so a forwarded
  link is not burned on someone who did not need it
- `leaveGroup({ groupId })`, `removeMember({ groupId, uid })` (owner), `renameGroup({ groupId, name })` (owner)
- `listGroups({})` → `[{ groupId, name, memberCount, isOwner }]`
- `getLeaderboard({ groupId })` → members or admin only:
  ```jsonc
  { "group": { "groupId", "name", "memberCount", "maxMembers", "isOwner", "ownerDisplayName" },
    "closedThrough": "2026-09-08",
    "rows": [ { "uid", "displayName", "isMe", "currentStreak",
                "allTime": { "points", "played", "totalGuesses", "avgGuesses", "totalElapsedMs", "rank" },
                "last7": { … }, "last30": { … } } ],
    "today": { "puzzleId", "viewerFinished",
               "players": [ { "uid", "displayName", "state": "finished|in_progress|not_started",
                              "points": null, "guessCount": null } ] } }   // numbers only when viewerFinished (FR-4.11)
  ```

### Admin (FR-7.2; role `admin`, else `permission-denied`)
- `listUsers({ cursor? })` → 50 per page by `createdAt`; no e-mail, ever
- `setRole({ uid, role })` — `organizer` | `player`; never `admin` in either direction, never yourself (FR-7.6, D-35)
- `listAllGroups({})`
- `listAttempts({ puzzleId } | { uid })` → per attempt: state, counts, `elapsedMs`, `suspicious`,
  `retries`, `intervalsMs` (start→first guess, guess→guess); `guesses`, `points`, `solved` and
  `suspicious` only for closed days or once the admin has finished today (D-31) — `suspicious` is only
  ever set on a solve, so it would announce an outcome by itself
- `grantRetry({ uid, puzzleId })` — today only, never for yourself; resets the attempt, keeps `history` (D-30, D-35)

### Scheduled (Cloud Scheduler, `America/Sao_Paulo`)
- `rebuildStandings` — `5 12 * * *` (D-11, D-25)
- `scheduleHealthCheck` — `0 9 * * 1`; logs `SCHEDULE_LOW` under 30 days of puzzles left (NFR-6), and
  deletes invites past their expiry so `invites` stays bounded (a TTL policy would carry no free
  allowance at all, `05-cost.md` §3.3)

### Challenges
- `startChallenge({ groupId?, maxParticipants })` → `{ challengeId, joinCode }`
- `joinChallenge({ joinCode })` → `{ challengeId }`
- `getChallengeResults({ challengeId })` → filtered per FR-5.6

### Account
- `updateProfile({ displayName, locale })` — also copies the name to the caller's member docs (D-26)
- `deleteAccount({})` → FR-1.5; leaves every group (D-23), **deletes** every invite naming the user in
  either `createdBy` or `usedBy`, deletes attempts and profile, then the auth user last; every step idempotent

### Error codes
`unauthenticated`, `invalid-argument`, `not-found`, `permission-denied`, `not-invited`,
`already-completed`, `no-guesses-remaining`, `rate-limited`, `puzzle-not-open`, `group-full`,
`too-many-groups`, `invalid-invite`, `challenge-expired`.

## 5. Security rules sketch

Default deny, then narrow allows. Everything score-bearing is Admin-SDK-only.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {

    function signedIn()   { return request.auth != null; }
    function isSelf(uid)  { return signedIn() && request.auth.uid == uid; }
    function inGroup(gid) {
      return signedIn() &&
        exists(/databases/$(db)/documents/groups/$(gid)/members/$(request.auth.uid));
    }

    match /users/{uid} {
      allow read: if isSelf(uid);          // NOT signedIn: that also allows a list (D-34)
      allow update: if isSelf(uid)
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['displayName','locale']);
      allow create, delete: if false;          // functions only
    }

    match /puzzles/{id}      { allow read, write: if false; }   // SEC-7
    match /challenges/{id}   { allow read, write: if false; }
    match /invites/{token}   { allow read, write: if false; }   // D-32

    match /attempts/{attemptId} {
      allow read:  if signedIn() && attemptId.split('_')[0] == request.auth.uid;
      allow write: if false;                    // SEC-6
    }

    match /groups/{gid} {
      allow read:  if inGroup(gid);
      allow write: if false;

      match /members/{uid}    { allow read: if inGroup(gid); allow write: if false; }
      // no standings/results subcollections exist (D-21, D-22); the catch-all denies them
    }

    match /{document=**} { allow read, write: if false; }
  }
}
```

Test these with the Firestore emulator's rules unit-testing library. Untested rules are the
single most common way a Firebase project gets owned — write the negative tests, not just the
positive ones.

## 6. Anti-cheat, concretely

| Vector | Mitigation |
|---|---|
| Read answer from network tab | Answer never sent while in progress (SEC-1) |
| Infer from an asset URL or match the path against a public shape file | No public shape files exist; the only copy is server-side and one path is inlined per round (SEC-2, D-13) |
| Fake a fast solve time | Server timestamps only (SEC-3) |
| Brute-force all ~200 countries | Hard cap of 6 server-side, plus 400ms floor (SEC-5) |
| Replay a solved day | Deterministic attempt ID, `already-completed` (FR-2.10, SEC-4) |
| Write directly to Firestore standings | Rules deny all client writes (SEC-6) |
| Read tomorrow's puzzle | `puzzles` collection unreadable (SEC-7) |
| Geometry-match the SVG against Natural Earth | Not defended. Documented residual risk (SEC-12) |

The `suspicious` flag on attempts is not enforcement — it's material for lunch.

## 7. Infrastructure split

**Terraform** (`/infra`) owns the durable shape of the project:
`google_project`, `google_project_service` (firebase, firestore, identitytoolkit,
cloudfunctions, run, cloudbuild, eventarc, cloudscheduler), `google_firebase_project`,
`google_firestore_database` (`type = "FIRESTORE_NATIVE"`, `location_id = "southamerica-east1"`),
`google_firebase_web_app`, `google_identity_platform_config` (Google provider +
`authorized_domains = ["lisecki.dev", "localhost"]`), `google_billing_budget`, and the
service accounts + WIF pool for CI.

Requires the `google-beta` provider. Two pitfalls, both from the official Firebase Terraform guide:
1. **Firestore location is permanent once set.** Get it right the first time.
2. If the default database gets created in Datastore mode, it is invisible to Firebase SDKs,
   Auth, and Security Rules — you'd have to empty it and convert. Set `FIRESTORE_NATIVE` explicitly.

State backend: a GCS bucket in the same project, created once by hand (chicken-and-egg),
then referenced. Do not commit `terraform.tfstate`.

**Firebase CLI** (`/backend`) owns things Terraform handles badly: function source deploys,
`firestore.rules`, and indexes. Driven by a GitHub Actions workflow on push to `main` that
touches `backend/**`, authenticating via Workload Identity Federation (SEC-10).

Everything in `/infra` is safe to open-source: project IDs and region names are not secrets.

## 8. Local development

Three terminals. Everything runs under the demo project id `demo-mondo`, which the emulators
accept without a real project and which `site/app/firebase.js` substitutes whenever the page is
served from `localhost`, so a stray call can never reach production.

```sh
# 1. emulators (Auth + Firestore + Functions). Needs Java; on this Mac it is Homebrew's:
export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
cd backend && npx --yes firebase-tools@latest emulators:start --only functions,firestore,auth --project demo-mondo
# functions reload on `npm run build` in backend/functions

# 2. a schedule for the emulator (generate once, seed whenever the emulator restarts)
cd tools && npm run schedule -- --seed 1 --start $(date +%F)
npm run seed -- --file out/schedule-1.json --emulator

# 3. the site
cd site && python3 -m http.server 8000
```

Then open `http://localhost:8000/`. Google sign-in goes to the Auth emulator's fake account
picker. Playing needs an invitation (FR-1.7): make your emulator account an admin once with
`cd tools && npm run set-role -- --uid <uid> --role admin --emulator` (the uid is in the Auth
emulator UI at `http://127.0.0.1:4000/auth`), then create a group and invite the other test
accounts from `grupos.html`. The emulator registers the scheduled jobs as Pub/Sub triggers (so the
`pubsub` emulator is in `firebase.json`); run one locally from the Emulator UI's trigger button or
call `rebuildStandingsNow` / `healthCheckNow` in-process, as the e2e does.

Tests: `npm test` in `tools/` and `backend/functions/` need nothing running; `npm run test:rules`
in `backend/functions/` starts its own Firestore emulator; `npm run test:e2e` (D-33) starts
Functions + Firestore + Auth emulators and drives every Phase 2 callable with several accounts.

Use `npx firebase-tools`, not the Homebrew `firebase` binary: on macOS the latter is killed with
exit 137 on its first network call.
