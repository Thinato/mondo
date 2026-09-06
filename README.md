# Mondo

A daily country-silhouette guessing game, served at **lisecki.dev/mondo/**.

Six guesses to name a country from its outline. After each miss you get the
great-circle distance, a compass arrow and a proximity percentage. Sign in, join
a group, argue about the scoring.

Inspired by [Worldle](https://worldle.teuteuf.fr/). No Worldle code or assets are
used. Built for a small competitive team that wanted three things Worldle does
not have: accounts that survive changing devices, group leaderboards, and
head-to-head challenges.

## Status

**Phase 0 — foundations.** No game yet. The project, infrastructure and deploy
pipeline exist; `site/` currently serves a smoke-test page. See
[`docs/04-roadmap.md`](docs/04-roadmap.md).

## The one rule everything else follows

**The server holds the answer.** The country for an in-progress round never
appears in a response body, a DOM node, an asset path, a filename or a console
log. Every guess is evaluated in a Cloud Function; silhouettes are addressed by
opaque random keys, not by country code. A client-side answer would make the
leaderboard meaningless, and this group would find it within a day.

## Layout

```
site/       vanilla ES modules — the ONLY directory GitHub Pages publishes
backend/    Cloud Functions v2 (TypeScript, Node 22) + Firestore rules
infra/      Terraform: GCP project, Firestore, Auth, budget, CI identity
tools/      offline geo pipeline and puzzle-schedule generator
docs/       brief, requirements, architecture, geo pipeline, roadmap, cost
```

Pages uploads `site/` and nothing else, so `tools/out/` — the generated schedule,
which is literally every future answer — cannot leak through the published site
even by accident.

## Stack

Vanilla ES modules with no build step, Firebase SDK over CDN. Firebase Auth,
Firestore and Cloud Functions v2 in `southamerica-east1`. Terraform for project
shape, Firebase CLI for deploys. GitHub Actions authenticates by Workload
Identity Federation — there is no service-account key anywhere.

## Getting started

Read [`docs/00-brief.md`](docs/00-brief.md) through
[`docs/05-cost.md`](docs/05-cost.md) first; they are short and they explain why
things are the way they are.

```sh
# Infrastructure — see infra/README.md for the full runbook
cd infra && terraform init -backend-config=backend.hcl && terraform apply

# Backend
cd backend/functions && npm install && npm test

# Frontend — no build step, just serve it
cd site && python3 -m http.server 8000
```

## Contributing

Two arguments are settled by pull request rather than by shouting:

- Which entities count as countries → `tools/include.json`
- How well known a country is → `tools/tiers.json`

Territories and dependencies are excluded in v1. If you want Greenland in the
pool, open a PR.

## Licence

Code is [MIT](LICENSE). Map and country data come from Natural Earth and
`mledoze/countries` under their own terms — see [NOTICE](NOTICE), which you
should read before redistributing the generated data files.
