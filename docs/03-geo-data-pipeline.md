# Geo Data Pipeline

Everything here runs **offline at build time** via `tools/build-geo.mjs`. Output is committed
to the repo. Nothing in this pipeline runs at request time, and no map service is called from
the browser.

## 1. Sources

| Source | What it gives | License |
|---|---|---|
| Natural Earth `ne_50m_admin_0_countries` | Country polygons | Public domain |
| `world-countries` (npm) | ISO alpha-2/alpha-3, English + Portuguese names, region, lat/lng | ODbL-ish, permissive; attribute in `NOTICE` |
| `world-atlas` (npm) | Same Natural Earth data pre-converted to TopoJSON | Public domain |
| `mapshaper` (npm, dev only) | Simplification and format conversion | MPL-2.0 |
| `d3-geo` (npm, dev only) | Projection and path generation | ISC |

Downloading `world-atlas` avoids scraping and gives you a versioned artifact — prefer it over
crawling Natural Earth's site.

## 2. Which entities count as "countries"

This is a fight waiting to happen, so make it explicit and reviewable.

Maintain `tools/include.json`: an explicit array of ISO alpha-2 codes that are in play, with a
one-line justification per entry. Baseline: 193 UN member states + `VA`, `PS`, `TW`, `XK`.
Roughly 197 entries.

Dependencies and territories (`GL`, `PR`, `HK`, `NC`, …) are **excluded in v1**. If someone
wants Greenland in the pool, they open a pull request. This turns a lunch argument into a
contribution, which is the correct outcome for an open-source project.

## 3. Geometry processing

### 3.1 Largest-landmass rule (D-8)

For each country, keep **only the polygon with the greatest area**. Discard the rest.

This single rule solves most of the classic problems automatically:
- France's silhouette becomes metropolitan France, not a scatter of Caribbean and Pacific dots
- The USA becomes the contiguous 48, not a shape spanning 180° of longitude
- The Netherlands, Denmark, Norway, Portugal, Spain, Chile, Ecuador, and New Zealand all behave

Record `discardedPolygons` and `discardedAreaShare` in the output so you can eyeball the ~15
countries where the rule is contentious. Anything over ~25% discarded area deserves a manual look.
Known ones to inspect by hand: `NZ` (North vs South Island), `JP`, `PH`, `ID`, `FJ`.

### 3.2 Centroid

Compute the centroid of the retained polygon (`d3.geoCentroid`), not of the full multipolygon.
Because of §3.1 this is automatically the mainland centroid — which is what makes distances
feel honest.

Two known-awkward cases where the centroid falls outside the country (`HR`, `CL` is fine but
long, `VN`, `SO`): acceptable. If you want to be nicer, use `polylabel` to get the pole of
inaccessibility instead. **Pick one and use it for every country** — mixing methods makes
distances incomparable.

Store centroids in `countries.min.json` with 4 decimal places. Both the client (for nothing)
and the server (for scoring) need them; the **server copy must come from its own bundled file**,
never from the client payload.

### 3.3 Simplification

`mapshaper -simplify visvalingam 4% keep-shapes`. Target: every country under 4KB of path data,
whole `shapes/` directory under 400KB. Tune the percentage until both hold.

Verify visually. Over-simplified Italy stops looking like a boot, and that ruins the game.

### 3.4 Projection and normalisation

Do **not** use a single world projection — Greenland-style distortion would make high-latitude
countries unrecognisable and would leak latitude as a hint.

Per country: project with `d3.geoAzimuthalEqualArea` centred on that country's centroid, then
`fitExtent` into a fixed 500×500 viewBox with 24px padding. Every silhouette then occupies
similar screen area regardless of real size, satisfying FR-6.2 (area must not be a free hint).

### 3.5 Optional rotation

Generate a fixed random rotation (0–359°) per `shapeKey` at build time and bake it into the
path data. Rotation is a difficulty knob, not a security control, and baking it in at build
time means it cannot leak through a runtime parameter.

Default off in v1. Consider it for a "difícil" mode later.

### 3.6 Opaque keys (SEC-2)

Each country gets `shapeKey = "s_" + 8 random hex chars`, generated once and **persisted** in
`tools/shapekeys.json` so rebuilds are stable. It must not be derived from the country code or
name — a derived key is a rainbow table and defeats the whole point.

Shard the output: `data/shapes/{first-2-chars-of-key}.json`, each holding many countries. The
client fetches one shard and picks the key out of it, so network traffic doesn't reveal which
country was requested.

## 4. Names, aliases, autocomplete

`countries.min.json` per entry:

```jsonc
{
  "code": "NL",
  "code3": "NLD",
  "names": { "en": "Netherlands", "pt-BR": "Países Baixos" },
  "aliases": ["Holanda", "Holland", "Nederland", "Paises Baixos"],
  "centroid": [5.2913, 52.1326],
  "tier": 1,
  "shapeKey": "s_4b19ce07"
}
```

Autocomplete index rules (FR-6.3):
- Normalise with `NFD` + strip combining marks, then lowercase. `são` matches `sao`.
- Match on prefix first, then substring, then fuzzy (Levenshtein ≤ 2) as a last tier.
- Both alpha-2 and alpha-3 codes are searchable.

**Seed the pt-BR alias list before launch or the input will feel broken.** Non-exhaustive
starting set: `EUA`/`Estados Unidos` → US, `Holanda` → NL, `Inglaterra`/`Reino Unido` → GB,
`Coreia do Sul` → KR, `Coreia do Norte` → KP, `Costa do Marfim` → CI, `Emirados` → AE,
`Suíça` → CH, `Suécia` → SE, `Alemanha` → DE, `Grécia` → GR, `Turquia` → TR, `Chéquia`/`República
Tcheca` → CZ, `Birmânia` → MM, `Timor-Leste` → TL, `Cabo Verde` → CV, `Costa do Marfim` → CI.

Expect to add ~20 more in the first week. Log every failed autocomplete query (the *string*,
not the user) so you can mine it. That log must never include the puzzle answer.

## 5. Difficulty tiers (FR-2.4)

Automatic first pass, then manual override.

| Tier | Rule | Weight |
|---|---|---|
| 1 | population > 20M **or** area > 500,000 km² **or** on the manual "famous" list | 50% |
| 2 | everything else not in tier 3 | 35% |
| 3 | population < 1M **or** area < 5,000 km² | 15% |

The manual famous list catches small-but-known countries that the rule misses: `CH`, `NL`,
`BE`, `AT`, `PT`, `GR`, `IL`, `CU`, `JM`, `IS`, `NZ`, `IE`, `DK`, `NO`, `UY`, `PY`, `CR`, `PA`.

Tiers live in `tools/tiers.json` with the same PR-to-argue convention as `include.json`.

## 6. Schedule generation

`tools/generate-schedule.mjs`:

1. Seeded PRNG (store the seed; the schedule must be reproducible).
2. Walk forward from a start date, day by day, in `America/Sao_Paulo`.
3. Weighted pick by tier, rejecting any country used in the previous 180 days (FR-2.3).
4. Emit `{ puzzleId, countryCode, tier, shapeKey, opensAt }` for 365 days.
5. Upload to the `puzzles` collection with the Admin SDK.

Run it once at launch, then annually. The weekly `scheduleHealthCheck` function warns when
fewer than 30 future days exist (NFR-6).

**The generated schedule file must not be committed to the public repo.** Everything else in
`/tools` can be. Add `tools/out/schedule*.json` to `.gitignore` — this is the one place where
open-sourcing the project would leak the answers.

## 7. Scoring maths (shared server-side module)

Pure functions in `backend/functions/src/lib/geo.ts`, unit tested (NFR-8).

- **Distance**: haversine, earth radius 6371 km, rounded to the nearest km.
- **Bearing**: initial great-circle bearing from guess centroid to answer centroid, in degrees.
  Snap to 8 buckets of 45° for the arrow (`N NE E SE S SW W NW`), but return the raw degrees too
  so the UI can rotate an arrow smoothly if you want.
- **Proximity**: `max(0, (20000 - distanceKm) / 20000)`, rendered as a rounded percentage.
  20,000 km ≈ half the earth's circumference, i.e. the maximum possible separation.
- **Correct guess**: `distanceKm === 0` is not the test — compare ISO codes.

## 8. Build validation

`tools/build-geo.mjs` must fail the build if any of these are violated:

- Any country in `include.json` has no geometry
- Any centroid falls outside [-90, 90] × [-180, 180]
- Any shape file exceeds 4KB
- Any `shapeKey` collides or changed since the last run
- Any two countries share a name or alias
- Total `data/` payload exceeds 400KB

Add a `tools/preview.html` that renders all ~197 silhouettes in a grid. Look at it. Human eyes
catch a broken simplification in five seconds and no assertion will.
