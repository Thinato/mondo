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
│    getRound        startChallenge          │
│    submitGuess     joinChallenge           │
│    createGroup     getChallengeResults     │
│    joinGroup       deleteAccount           │
│    getLeaderboard                          │
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
  grupos.html             group list + leaderboards
  desafio.html            challenge lobby + results
  arquivo.html            past puzzles
  regras.html             scoring rules (FR-3.7)
  privacidade.html        LGPD note
  app/
    firebase.js           SDK init, exported app/auth/functions handles
    api.js                thin typed wrapper over callable functions
    game.js               round state machine
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
      index.ts
      round.ts groups.ts challenges.ts account.ts scheduled.ts
      lib/ geo.ts scoring.ts validate.ts errors.ts
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
```

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
guesses        array<{ code, distanceKm, bearingDeg, proximity, at }>
guessCount     number
solved         boolean
points         number      FR-3.1
elapsedMs      number
mode           "daily" | "archive"
suspicious     boolean     set when elapsedMs < 2000 on a first-guess solve
```

Client may read its **own** attempt documents only. That is safe because by the time an attempt
doc exists with guesses in it, the client already knows those guesses.

### 3.4 `groups/{groupId}`

```
name           string
ownerUid       string
inviteCode     string     also indexed in /inviteCodes
memberCount    number
maxMembers     number     default 200
createdAt      timestamp
```

### 3.5 `groups/{groupId}/members/{uid}`

```
displayName    string     denormalised for cheap leaderboard reads
role           "owner" | "member"
joinedAt       timestamp
```

### 3.6 `groups/{groupId}/results/{puzzleId}_{uid}` — Admin SDK writes only

Fan-out target. Written by `submitGuess` when a round completes, once per group the player
belongs to. Source of truth for windowed leaderboards.

```
uid, puzzleId, points, guessCount, solved, elapsedMs, completedAt
```

### 3.7 `groups/{groupId}/standings/{uid}` — Admin SDK writes only

Precomputed by the nightly `rebuildStandings` job so the client never aggregates.

```
displayName
allTime    { points, played, solved, avgGuesses, totalElapsedMs }
last7      { ... }
last30     { ... }   worst-2 already dropped (FR-3.5)
currentStreak
updatedAt
```

Leaderboard read = one indexed query: `standings` ordered by `last30.points desc,
last30.totalElapsedMs asc`, limit 200. Cheap and predictable.

### 3.8 `inviteCodes/{code}`
`{ groupId }`. Lets `joinGroup` resolve a code without granting the client any ability to
enumerate groups.

### 3.9 `challenges/{challengeId}` — **no client read access**

```
createdBy, countryCode, createdAt, expiresAt, status
participants   map<uid, { displayName, status, points, guessCount, elapsedMs }>
```

Client never reads this directly. `getChallengeResults` returns a filtered projection that
honours FR-5.6 by stripping other participants' results until the caller has finished.

### 3.10 Required composite indexes
- `groups/{gid}/standings`: `last7.points desc, last7.totalElapsedMs asc`
- `groups/{gid}/standings`: `last30.points desc, last30.totalElapsedMs asc`
- `groups/{gid}/results`: `uid asc, completedAt desc`

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
                 "bearingDeg": 315, "proximity": 0.95 } ],
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
  "distanceKm": 1043, "bearingDeg": 315, "proximity": 0.95,
  "guessesUsed": 3,
  "status": "in_progress",
  "answer": null,                   // revealed on solved | failed
  "points": null,                   // set when the round ends
  "shareGrid": null                 // set when the round ends
}
```

Transactional read-modify-write on the attempt doc (SEC-4). On completion, fans out
`groups/*/results` writes and updates streaks.

### Groups
- `createGroup({ name })` → `{ groupId, inviteCode }`
- `joinGroup({ inviteCode })` → `{ groupId, name }`; backfills the joiner's last 30 days of
  results into the group so they aren't starting from an empty board
- `getLeaderboard({ groupId, window })` → ranked standings
- `leaveGroup({ groupId })`, `removeMember({ groupId, uid })`, `rotateInviteCode({ groupId })`

### Challenges
- `startChallenge({ groupId?, maxParticipants })` → `{ challengeId, joinCode }`
- `joinChallenge({ joinCode })` → `{ challengeId }`
- `getChallengeResults({ challengeId })` → filtered per FR-5.6

### Account
- `updateProfile({ displayName, locale })`
- `deleteAccount({})` → FR-1.5; deletes auth user last, after data cleanup

### Error codes
`unauthenticated`, `invalid-argument`, `not-found`, `already-completed`,
`no-guesses-remaining`, `rate-limited`, `puzzle-not-open`, `group-full`, `challenge-expired`.

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
      allow read: if signedIn();
      allow update: if isSelf(uid)
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['displayName','locale']);
      allow create, delete: if false;          // functions only
    }

    match /puzzles/{id}      { allow read, write: if false; }   // SEC-7
    match /challenges/{id}   { allow read, write: if false; }
    match /inviteCodes/{c}   { allow read, write: if false; }

    match /attempts/{attemptId} {
      allow read:  if signedIn() && attemptId.split('_')[0] == request.auth.uid;
      allow write: if false;                    // SEC-6
    }

    match /groups/{gid} {
      allow read:  if inGroup(gid);
      allow write: if false;

      match /members/{uid}    { allow read: if inGroup(gid); allow write: if false; }
      match /standings/{uid}  { allow read: if inGroup(gid); allow write: if false; }
      match /results/{rid}    { allow read: if inGroup(gid); allow write: if false; }
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

`firebase emulators:start` gives Auth + Firestore + Functions locally. Serve the frontend with
`python3 -m http.server` and point `app/firebase.js` at the emulator when
`location.hostname === "localhost"`. Seed the emulator with a fixture schedule so tests are
deterministic.
