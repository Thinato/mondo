# Cost

> Verified against Google's own pricing pages on **2026-09-04**. Cloud pricing
> changes; re-check before believing a number here. Sources are linked at the
> bottom so the next person can re-verify rather than re-guess.

NFR-3 says cost must stay inside the free tier at 100 daily players, with a
budget under R$5/month. This document is the arithmetic behind that claim, and
the list of things that would break it.

## 1. Does `southamerica-east1` cost more? Yes — and it does not matter

Two separate questions get conflated constantly, so keep them apart:

**Does the free tier exist in São Paulo?** Yes, at the same size as anywhere else.

- **Firestore's** free quota is uniform across locations. The pricing page states
  the same 50,000 reads / 20,000 writes / 20,000 deletes per day and 1 GiB of
  storage with no regional qualifier, and the free-quota page adds no location
  caveat either. What it *does* say is that you get exactly **one** free database
  per project — the `(default)` one. That line matters more than it looks now
  that the project is shared across lisecki.dev; see §5.
- **Cloud Run's** free tier (2M requests, 180,000 vCPU-seconds, 360,000
  GiB-seconds per month) carries no regional restriction on compute or requests.
  The single geographic caveat is the free egress allowance, which is *1 GB
  outbound from North America* — that one does not apply to us. Our egress is
  covered instead by Firestore's 10 GiB/month.

**Does São Paulo cost more per unit once you exceed free tier?** Yes.
`southamerica-east1` sits in Cloud Run's **Tier 2** pricing band (16 regions are
Tier 1, 24 are Tier 2). Google's own pricing page does not publish a single
headline multiplier, and third-party comparisons put the Tier 2 premium somewhere
around a third. Treat the exact figure as unverified — it does not change the
conclusion below, because the premium applies only to overage.

So the region premium is a multiplier on your overage — and the plan is to have
no overage. A 35% premium on zero is zero. Choosing `us-central1` to save money
would trade ~150ms of round-trip latency for every player, every guess, in
exchange for a discount on a bill we do not intend to generate. NFR-1 (p95 under
600ms from São Paulo) is worth more than that.

**Conclusion: keep `southamerica-east1`.** The reason to be careful about the
region was never cost — it is that Firestore's location is permanent.

## 2. What 100 daily players actually consume

Order-of-magnitude estimates, deliberately pessimistic.

**The allowances below are per project, and `lisecki-dev` is shared by
everything on lisecki.dev.** The headroom column is therefore what is left for
Mondo *after* whatever else lives in the project takes its share — not Mondo's
private budget. Every number here assumes Mondo is the only significant consumer;
if that stops being true, revisit §5.

| Resource | Daily use at 100 players | Free allowance | Headroom |
|---|---|---|---|
| Firestore reads | ~5,000 (rounds, profiles, boards) + ~3,000 once a night (players × 30 attempts, D-21) | 50,000/day | ~6× |
| Firestore writes | ~1,000 (attempt doc per guess) + memberships once a night | 20,000/day | ~19× |
| Firestore storage | a few MB/year | 1 GiB | enormous |
| Function invocations | ~1,000/day → ~30,000/month | 2,000,000/month | ~65× |
| Cloud Logging | well under 1 GiB/month | 50 GiB/month | large |

The tightest of these is Firestore reads, and the thing that drives it is the
leaderboard. This is exactly why the windows are precomputed nightly onto the
member documents (architecture §3.5, D-22, D-25) instead of aggregated per
page-load: a client-side aggregation over 30 days × 100 members would be 3,000
reads *per viewer*, which would blow the daily quota with roughly 16 people
looking at the board. The precomputed design makes a board read ≤ 200 member
documents plus ≤ 200 today-attempts for the live panel (FR-4.11).

The nightly job itself reads every attempt of the last 30 closed days once
(players × 30, D-21) — about 3,000 at 100 players, regardless of how many groups
they are in. Past ~1,000 players switch to per-member `getAll` of group members
only; the ceiling is marked in `backend/functions/src/standings.ts`.

Keep that in mind before "just querying attempts directly" from a per-viewer path.

## 3. The four things that would actually charge you

None of them are the region.

### 3.1 `minInstances` — by far the biggest risk

NFR-2 floats `minInstances: 1` to hide cold starts during the lunch window. It is
the most expensive single line available in this codebase.

Cloud Run's free compute allowance is 180,000 vCPU-seconds/month, i.e. **50
vCPU-hours**. One permanently warm instance occupies about **730 instance-hours
per month**. That is an order of magnitude past the free tier, in any region, and
it bills whether anybody plays or not — including every night and all weekend.

`backend/functions/src/lib/callable.ts` carries a comment saying exactly this at
the point of temptation. Measure real p95 before reaching for it. A cold start on
the day's first guess is free; a warm instance is a standing monthly charge.

### 3.2 Artifact Registry accumulation

Free storage is **0.5 GB/month**. Every functions deploy builds a container image
and pushes it, and old images are not removed automatically. A dozen deploys of a
handful of functions will quietly cross 0.5 GB, and then you are paying for
storage forever for images you will never run.

Set a cleanup policy once, after the first deploy:

```sh
gcloud artifacts repositories set-cleanup-policies gcf-artifacts \
  --location=southamerica-east1 \
  --project=lisecki-dev \
  --policy=- <<'JSON'
[
  {
    "name": "keep-recent",
    "action": {"type": "Keep"},
    "mostRecentVersions": {"keepCount": 3}
  },
  {
    "name": "delete-old",
    "action": {"type": "Delete"},
    "condition": {"olderThan": "30d"}
  }
]
JSON
```

### 3.3 Firestore features that are explicitly outside free usage

The quota page names these as carrying no free allowance: **TTL deletes,
point-in-time recovery, backups, restores, and clones**. All are off by default.
Leave them off — and specifically, do not switch on PITR or scheduled backups
"just to be safe" without pricing it first. The data here is a game score; the
puzzle schedule can be regenerated deterministically from its seed.

### 3.4 Cloud Scheduler beyond three jobs

Three jobs per month are free **per billing account, not per project**. Mondo
plans two (`rebuildStandings`, `scheduleHealthCheck`), so we fit — but the limit
is shared with every other project on the same billing account. Beyond it the
charge is about $0.10 per job per month, which is noise, but it is the one line
item where an unrelated project can push Mondo over.

Cloud Build (2,500 build-minutes/month) and Cloud Logging (50 GiB/month) have so
much headroom they are not worth tracking.

## 4. A budget alert is a smoke detector, not a spending cap

This is the part people get wrong. **Google Cloud does not hard-cap spend.** A
budget alert sends email; it does not stop anything. There is no "turn it off at
R$20" checkbox.

Because the expected steady-state bill is exactly zero, the alert is configured
to fire on *any* real spend rather than on approaching R$20:
`infra/main.tf` sets thresholds at 5%, 25%, 50%, 90% and 100% of R$20, plus a
forecast alert. The 5% threshold is R$1 — enough to notice a mistake within a day
or two instead of at the end of the month.

If you want an actual hard stop, the only real mechanism is a budget
Pub/Sub notification wired to a function that unlinks the billing account. That
genuinely stops charges, and it also takes the game offline until you relink it
by hand. Given the exposure here is a handful of reais, the alert is the better
trade. Revisit if the project ever holds something that could run away faster
than email travels.

## 5. Consequences of sharing one project across lisecki.dev

The project is deliberately shared: one GCP project holds everything on
lisecki.dev, so there is one billing surface, one budget and one place to look.
That is a reasonable call for a personal domain. It has four consequences worth
knowing before they surprise you.

### 5.1 The free tier is per project, not per app

Firestore's 50,000 reads / 20,000 writes / 20,000 deletes per day and 1 GiB of
storage are **project-wide**, and so is the *"exactly one free database per
project"* rule. Two apps in this project sharing the daily read quota have half
as much each. Mondo's estimate in §2 has ~10× headroom, so there is room — but
the headroom is now shared, and a chatty neighbour eats it.

### 5.2 There is exactly one free Firestore database

If a second app on lisecki.dev wants its own Firestore database for isolation,
that second database is **not covered by the free tier**. Isolation costs money
here. The free options are: share the `(default)` database and namespace
collections carefully, or keep the other app off Firestore entirely.

### 5.3 Two configs are authoritative and will overwrite a neighbour

These are the ones that can actually break something that currently works:

- **`firestore.rules`** — a ruleset is per database and a deploy **replaces** it
  wholesale. Mondo's rules default-deny everything. Deploying them from this repo
  locks out any other app storing data in the same database, and a deploy from
  that other app deletes Mondo's rules just as thoroughly. Last deploy wins.
  There is a warning block at the top of `backend/firestore.rules` saying so.
- **`authorized_domains`** in Identity Platform — Terraform sets the project's
  authorized domains **authoritatively, not additively**. Any domain another app
  in this project needs for sign-in must appear in `var.authorized_domains`, or
  `terraform apply` breaks that app's login.

Check both in the console before the first apply.

### 5.4 The budget alert covers the whole project

`infra/main.tf` filters the budget to this project, which now means all of
lisecki.dev. A R$1 breach no longer means "Mondo cost money" — it means
*something* on the domain did. That is arguably what you want from a single
billing surface, but do not read an alert as a Mondo bug without checking the
per-service breakdown first.

Nothing else in this repo is project-shared in a dangerous way: the service
accounts (`mondo-deployer`, `mondo-functions`), the WIF pool binding, the web app
and the function names are all Mondo-specific and coexist fine.

## 6. What to do the first week after launch

1. Look at the billing report on day 3. It should read R$0.00.
2. Check the Firestore usage graph against the read estimate in §2. If reads are
   an order of magnitude above the estimate, something is querying per-viewer
   that should be reading precomputed standings.
3. Set the Artifact Registry cleanup policy (§3.2) once the first deploy exists.
4. Only then measure p95 and decide whether cold starts are actually a problem
   worth paying for.

## Sources

- [Firestore free quota](https://firebase.google.com/docs/firestore/quotas) — 1 GiB, 50k reads, 20k writes, 20k deletes/day, 10 GiB egress/month; one free database per project; TTL/PITR/backup/restore/clone excluded
- [Firestore pricing](https://firebase.google.com/docs/firestore/pricing) — free quota stated without regional qualification
- [Google Cloud free tier](https://cloud.google.com/free/docs/free-cloud-features) — Cloud Run 2M requests, 180,000 vCPU-s, 360,000 GiB-s, 1 GB egress from North America; Cloud Build 2,500 build-min; Artifact Registry 0.5 GB; Cloud Logging 50 GiB
- [Cloud Run locations](https://cloud.google.com/run/docs/locations) — `southamerica-east1` listed under Tier 2 pricing
- [Cloud Run pricing](https://cloud.google.com/run/pricing) — Tier 1 / Tier 2 bands
- [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing) — 3 free jobs per billing account, then ~$0.10/job/month
