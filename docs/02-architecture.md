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
│    createTournament startTournament getCard│
│    submitCardGuess  advanceTournament …    │
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
  torneios.html           tournaments: list, create, bracket, card player
  arquivo.html            past puzzles (Phase 4)
  regras.html             scoring rules (FR-3.7)
  privacidade.html        LGPD note
  app/
    firebase.js           SDK init, exported app/auth/functions handles
    api.js                thin typed wrapper over callable functions
    game.js               round state machine
    groups.js             grupos.html
    admin.js              admin.html
    tournaments.js        torneios.html
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
      tournaments.ts      tournaments: lifecycle, reads, the card play path (Phase 3)
      lib/                pure, unit-tested: geo scoring puzzle-day round standings groups invite authz validate errors
                          kinds card tournament (Phase 3)
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
  capitals.json           pt-BR capital-city names for the `capital` kind (PR to change)
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
Client-readable **only by its owner** (D-34: a `signedIn()` read allow would also authorize a
`list` of the whole collection). Client-writable only for `displayName` and `locale`, via rules.

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
items          array<{ kind: "shape"|"flag"|"capital"|"gdp", subject: "PY" }>   D-52/D-53, play order
opensAt        timestamp     computed from OQ-2 in America/Sao_Paulo
```

A day is one challenge of every kind (D-52, D-53), and the array's order is the order they are
played in — the generator shuffles it per day. `subject` IS the answer, which is the whole reason
this collection is unreadable. For `gdp` the subject is the country the prompt *names*, and the
answer is the figure `gdp.json` holds for it: the only kind where the subject is public.

There is no shape key and no flag key. The server looks the artwork up by `subject` in its
bundled `shapes.json` / `flags.json` and inlines one per challenge into the `getRound` response
(D-13). Nothing about it is ever addressable from the client.

**Days seeded before D-52** carry `countryCode` and `tier` instead of `items`, and still play:
`puzzleItems()` reads either shape and treats the old one as a day of a single silhouette. The
seeder writes only the new shape, so this is a bridge for days already in Firestore at the
switchover, not a format to keep.

### 3.3 `attempts/{uid}_{puzzleId}` — Admin SDK writes only

Since D-52 this is a **card play** with a `puzzleId` — the same document shape a tournament
round writes (§3.14), plus the day's identity and the four summary fields the boards read.

```
uid, puzzleId
mode           "daily" | "archive"
startedAt      timestamp   server
finishedAt     timestamp   server, null until the last challenge is done
cursor         number      index of the challenge being played; === items.length once finished
items          array<{ kind, guesses[], solved, points, startedAt, finishedAt, elapsedMs }>
                           a country guess is { code, distanceKm, bearingDeg, proximity, at };
                           bearing is stored, never sent (D-36)
                           a gdp guess is { value, higher, proximity, at } (D-53)
guessCount     number      across the whole day
solved         boolean     EVERY challenge solved — a perfect day
points         number      the day's sum, 0–24 (FR-3.1)
elapsedMs      number
suspicious     boolean     set when any first-guess solve came back in under 2 s
history        Attempt[]   only after an admin retry (D-30): the earlier tries, oldest first
retries        number      only after an admin retry
```

`guessCount`, `solved`, `points` and `elapsedMs` stay at the top level rather than being derived
on read, because that is exactly the shape attempts written before D-52 have — so the nightly
job and the admin dashboard read both generations without a migration or a branch.

**No client read at all** (D-51, SEC-15). The earlier rule allowed a player to read their own
attempt, on the reasoning that they already knew their own guesses — but they do not know
`bearingDeg`, and distance plus bearing solves for the answer's centroid in closed form (D-36).
Tournament card plays live in this same collection with `mode: "match"` and **no `puzzleId`**;
see §3.14. That asymmetry is load-bearing: the nightly job selects on a `puzzleId` range, and a
Firestore inequality filter never returns a document lacking the field, so a daily is found and
a tournament card is not — with no filter to remember (FR-5.9, D-40).

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
currentStreak  number    live streak off the profile: kept when the last play was the closed
                         day *or today*, else 0. Alone among these fields it counts today, so it
                         can read 2 while last30.played reads 1 (FR-3.6, and regras.html says so)
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

### 3.10 `challenges/{challengeId}` — never created (superseded)

The one-off challenge FR-5 originally described is now the degenerate tournament: free-for-all,
one round, one shape challenge (`06-tournaments.md` §12 slice 1). Nothing writes this collection;
the rules still deny it explicitly so a stale client cannot reach it.

### 3.11 `tournaments/{tid}` — **no client access** (D-39)

Top level, not under `groups/{gid}`: the cards hold answers and a group is member-readable, and
Firestore does not delete subcollections with their parent, so D-23's dissolution would orphan
them. Membership is checked in the callable, as `getLeaderboard` does.

```
groupId, name, preset
format          "free_for_all" | "single_elim" | "double_elim" | "round_robin" | "swiss"
regime          "aggregate" | "match"     D-49
config          map        the preset resolved and frozen (D-48)
status          "draft" | "running" | "finished" | "cancelled"
createdBy, createdAt, startedAt, endedAt
participantUids string[]   for the array-contains sweep in deleteAccount
participants    map<uid, { seed, displayName, joinedAt }>   name snapshotted at start (D-46)
currentRound, roundCount
```

### 3.12 `tournaments/{tid}/rounds/{n}` — **no client access**

The round log is the source of truth and standings are a pure fold over it, recomputed on every
advance (D-41). Pairing and bracket fields arrive with the pairing formats.

```
n, opensAt, closesAt, closedAt
cardId       "{tid}_r{n}"
results      map<uid, { points, elapsedMs, guessCount, played }>   written at close
```

### 3.13 `cards/{tid}_r{n}` — **no client access, ever**, a sibling of `puzzles` (SEC-7)

```
tournamentId, round, createdAt
items        [{ kind: "shape"|"capital", subject: "PY" }]   subject IS the answer
```

Stored, not regenerated from a seed (D-42).

### 3.14 Tournament play lives in `attempts` (D-40)

`attempts/{uid}_{tid}_r{n}`, `mode: "match"`, and **no `puzzleId` field** — that absence is what
keeps tournament results off the daily boards (FR-5.9), because the nightly job selects on a
`puzzleId` range and a Firestore inequality filter never returns a document lacking the field.
`deleteAccount`'s existing `where uid ==` sweep collects them for free.

```
uid, tournamentId, roundId, mode "match"
startedAt, finishedAt, cursor
items        [{ kind, guesses[], solved, points, startedAt, finishedAt, elapsedMs }]
points, elapsedMs, suspicious
```

### 3.15 Required composite indexes

None. Every query is a single-field range or equality (`attempts.puzzleId`, `attempts.uid`,
`invites.groupId` + `usedBy` + `revokedAt` equalities, `users.createdAt`, `members.joinedAt`,
`tournaments.groupId`, `tournaments.status`, `tournaments.participantUids` array-contains) or a
`getAll` by deterministic id; ranking sorts ≤ 200 member documents in memory.
`firestore.indexes.json` is deliberately empty. The admin's match query pairs two equality
filters (`uid`, `mode`), which Firestore serves by merging single-field indexes — the cost is
that it cannot also be ordered, so it is capped and unordered.

## 4. API contract (callable functions)

All calls require auth. All reject with typed errors from a shared enum. Region
`southamerica-east1`. CORS restricted per SEC-9.

### `getRound({ puzzleId? })`
Returns the day the caller should see. Omitting `puzzleId` means today. `submitGuess` returns
the identical shape, so there is one renderer and one contract to keep honest.

Since D-52 a day is three challenges played in order, so the response carries **one prompt at a
time** — the current challenge's — plus a status line per challenge.

```jsonc
// response
{
  "puzzleId": "2026-09-14",
  "mode": "daily",
  "itemCount": 3,
  "cursor": 1,                      // the challenge being played
  "prompt": { "kind": "flag", "flag": { "viewBox": "0 0 6 3", "paths": [ … ] } },
                                    // or { kind: "shape", shape } / { kind: "capital", capital }
                                    // or { kind: "gdp", country: "Vietnã", year: 2023 } — the one
                                    //    prompt that names a country, because there it is the
                                    //    question and the figure is the answer (D-53)
                                    // null once the day is finished
  "guessesUsed": 2,                 // on the CURRENT challenge, not the day
  "guessesMax": 3,                  // the current kind's allowance
  "guesses": [ { "kind": "country", "code": "AR", "name": "Argentina", "distanceKm": 1043,
                 "compass": "NW", "proximity": 0.95 } ],   // 8-point arrow, never the exact bearing (D-36)
                                    // a gdp guess reads { kind: "number", value, higher, proximity }
  "items": [                        // one per challenge, in play order
    { "kind": "shape", "status": "solved", "guessCount": 2,
      "points": 5, "answer": { "code": "PY", "name": "Paraguai" },
      "guesses": [ … ] },           // D-55: a FINISHED challenge carries its whole guess list,
                                    //   including the one that ended it — which is exactly the
                                    //   one `guesses` above has already moved past. The reveal
                                    //   screen draws from here; the client cannot rebuild that
                                    //   last row, having never seen that guess graded.
    { "kind": "flag",  "status": "current", "guessCount": 2, "points": null, "answer": null,
      "guesses": null },            // open: its guesses are the top-level `guesses`
    { "kind": "capital", "status": "pending", "guessCount": 0, "points": null, "answer": null,
      "guesses": null }
  ],
  "status": "in_progress",          // in_progress | solved | failed; solved = every challenge fell
  "points": null,                   // the day's total, set when the day ends
  "maxPoints": 24,
  "elapsedMs": null,
  "shareGrid": null,                // set when the day ends
  "serverTime": "2026-09-14T15:02:11.482Z"
}
```

**An answer appears only on a challenge that is already over**, never on the ones ahead of the
cursor (SEC-1). That is the same line `getCard` draws for tournaments, and the reason both are
projected by one function each rather than by the client. `items[i].guesses` follows the same
line exactly: it is the player's own guesses, and it is non-null under precisely the condition
that already reveals the answer.

Side effect: creates the attempt document with a server `startedAt` on first call. This is
what makes the timer un-spoofable (SEC-3).

### `submitGuess({ puzzleId, guess })`

One guess against the **current** challenge; returns the whole `getRound` view again. `guess` is a
country code for three of the kinds and a **number** for `gdp` (D-53) — the callable checks only
that it is a scalar and hands it to the kind, because only the kind knows what a guess is (SEC-8).
`code` is still accepted as a name for the field: the site is served from a CDN, and a browser
holding yesterday's `game.js` would otherwise lose its lunch.

Transactional read-modify-write on the attempt doc (SEC-4). Solving or exhausting a challenge
advances the cursor and starts the next challenge's clock in the same write, so per-challenge
elapsed times are contiguous and the day's total is honest. On completion of the *day*, updates
the profile's streak and counters. Nothing is fanned out (D-21); the nightly job reads attempts.

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
  ever set on a solve, so it would announce an outcome by itself. The `uid` path also returns
  `matches`: that player's tournament cards with per-item timings, under the same D-31 gate —
  outcomes only for a closed round, or one the admin has already played
- `grantRetry({ uid, puzzleId })` — today only, never for yourself; resets the attempt, keeps `history` (D-30, D-35)

### Scheduled (Cloud Scheduler, `America/Sao_Paulo`)
- `rebuildStandings` — `5 12 * * *` (D-11, D-25). Also advances any tournament round past its
  deadline (D-43), each half in its own try/catch so one cannot silence the other. No third
  scheduler job: the free tier is three per *billing account* (`05-cost.md` §3.4)
- `scheduleHealthCheck` — `0 9 * * 1`; logs `SCHEDULE_LOW` under 30 days of puzzles left (NFR-6), and
  deletes invites past their expiry so `invites` stays bounded (a TTL policy would carry no free
  allowance at all, `05-cost.md` §3.3)

### Tournaments (FR-5 as rewritten, FR-8; `06-tournaments.md` §9)
- `createTournament({ groupId, name, preset })` → `{ tournamentId }` — group owner only; the
  preset is resolved server-side and frozen onto the document (D-48)
- `setParticipation({ tournamentId, join })` — join or drop out while still a draft
- `startTournament({ tournamentId })` → `{ round, closesAt }` — freezes the field, seeds it,
  opens round 1
- `listTournaments({ groupId })` → the group's tournaments plus the preset list for the form
- `getTournament({ tournamentId })` → config, standings, bracket, the open round's *states*
  only; another player's open-round score is never in the payload (FR-5.6)
- `getCard({ tournamentId })` → the current challenge's prompt; creates the play document with a
  server `startedAt` on first call. The `getRound` analogue
- `submitCardGuess({ tournamentId, guess })` → the `submitGuess` analogue. `guess` is untyped
  here because each kind validates its own shape (SEC-8)
- `advanceTournament({ tournamentId })` — owner; closes the open round early. Safe to repeat
- `cancelTournament({ tournamentId })` — owner; keeps the record

`getCard` and `submitCardGuess` re-check group membership and the play gate on every call
(FR-5.13), so a removed member keeps their standings slot but stops being served cards.

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

    // D-51 / SEC-15 — closed even to their own player: the stored guess carries
    // bearingDeg beside distanceKm, and the two solve for the answer's centroid
    // in closed form (D-36). Every read the game does goes through a callable.
    match /attempts/{attemptId} { allow read, write: if false; }

    match /tournaments/{tid} {                  // D-39
      allow read, write: if false;
      match /rounds/{n}      { allow read, write: if false; }
    }
    match /cards/{cardId}    { allow read, write: if false; }   // the answers

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
| Read your own attempt over the REST API and solve from distance + bearing | No attempt is client-readable at all (SEC-15, D-51) |
| Read a tournament card to get five answers at once | `cards` is closed like `puzzles` (D-39) |
| Tell a later player the answers inside an open round | Not defended. Results hidden until the round closes; accepted as SEC-14 |
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
