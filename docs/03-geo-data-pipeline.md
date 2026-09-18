# Geo Data Pipeline

Everything here runs **offline at build time** via `tools/build-geo.mjs`. Output is committed
to the repo. Nothing in this pipeline runs at request time, and no map service is called from
the browser.

> **Status:** built 2026-09-06. `cd tools && npm install && npm run build-geo` regenerates
> everything in under two seconds and fails loudly on any validation below. Then open
> `tools/preview.html` and look.

## 1. Sources

| Source | What it gives | License |
|---|---|---|
| `tools/country-shapes/` (vendored, 196 files) | The silhouette artwork every shape is traced from (D-69) | **Unknown** — see `NOTICE` |
| Natural Earth `ne_10m_admin_0_countries`, via `world-atlas` (npm) | Country polygons as TopoJSON, for the **centroids** (D-69) | Public domain |
| `world-countries` (npm) | ISO alpha-2/alpha-3/numeric, English + Portuguese names, alt spellings, area | ODbL; attributed in `NOTICE` |
| `topojson-client` (npm, dev only) | TopoJSON → GeoJSON | ISC |
| `d3-geo` (npm, dev only) | Spherical area and centroid | ISC |
| `simplify-js` (npm, dev only) | Douglas-Peucker simplification in pixel space | BSD-2 |

**Two sources, split down the middle (D-69).** The artwork decides what a country *looks* like;
Natural Earth decides where it *is*. Drawn maps look like the countries and surveyed polygons do
not, at the scale a 500px silhouette needs — but a drawing must never reach the scoring path, so
every centroid, and so every distance and compass hint, is still Natural Earth's. That boundary is
D-59's, kept and widened. §3.5a has the history.

Flag artwork and GDP figures are **not** part of this pipeline. Each has its own offline build —
`tools/build-flags.mjs` (06-tournaments.md §5.3) and `tools/build-gdp.mjs` (§5.4) — over its own
source.

`world-atlas` is a versioned npm artifact of Natural Earth — prefer it over crawling the site.
**10m, not 50m:** the 50m set is missing Tuvalu entirely, and every microstate is better at 10m.
Since we simplify to a pixel tolerance anyway, the extra source detail costs nothing.

Two quirks of the source, both handled in the build:

- `world-atlas` features carry only the ISO numeric id. Kosovo has none, so it is matched by
  name (`BY_NAME` in `build-geo.mjs`).
- Natural Earth gives some dependencies their sovereign's id: at 10m *Ashmore and Cartier
  Islands* shares `036` with Australia. Same-id features are merged into one MultiPolygon before
  anything else happens; a naive lookup would have made Australia a reef.
- `world-countries`' Portuguese is **European** Portuguese (Irão, Estónia, Vietname). ~35 names
  are overridden to pt-BR in `tools/aliases.json`; the pt-PT form is kept as an alias.

## 2. Which entities count as "countries"

This is a fight waiting to happen, so make it explicit and reviewable.

Maintain `tools/include.json`: an explicit array of ISO alpha-2 codes that are in play, with a
one-line justification per entry. Baseline: 193 UN member states + `VA`, `PS`, `TW`, `XK`.
Roughly 196 entries: `VA` is on the baseline but excluded, because world-atlas 10m carries no usable polygon for it (two points on a line) and the build refuses degenerate geometry.

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

Record `discardedPolygons` and `discardedAreaShare` in the output so you can eyeball the
countries where the rule is contentious. Anything over 25% discarded area is pulled to the top
of `preview.html` in red.

**Exceptions (D-14).** Largest-only made Indonesia a blob of Kalimantan and Malaysia a slice of
Borneo — unrecognisable, not merely imperfect. Rather than a distance heuristic (which would
reintroduce France-in-the-Atlantic), `tools/overrides.json` lists explicit exceptions: for each
country there, every polygon with area ≥ `minShare` × the largest is kept too. Ten at launch:

| Code | minShare | Keeps |
|---|---|---|
| ID | 0.20 | Sumatra, Sulawesi, Java, Indonesian Papua |
| MY | 0.50 | the peninsula alongside East Malaysia |
| NZ | 0.50 | North Island |
| JP | 0.08 | Hokkaido, Kyushu, Shikoku |
| PH | 0.08 | Mindanao and the larger Visayas |
| GB | 0.05 | Northern Ireland |
| IT | 0.07 | Sicily, Sardinia |
| DK | 0.09 | Zealand, Funen |
| GR | 0.05 | Crete |
| FJ | 0.50 | Vanua Levu |

Everything else is largest-only. Australia loses Tasmania, Chile its Tierra del Fuego share,
Canada its Arctic archipelago; all still read as themselves. Known artefact: Natural Earth
splits Russia at the antimeridian, so Chukotka east of 180° is a separate polygon and is dropped
(2.6% of area). Russia is still Russia. Want a change? Edit `overrides.json`, rebuild, look at
the preview, open a PR.

### 3.2 Centroid

Compute the spherical centroid of the **retained** polygons (`d3.geoCentroid`), not of the full
multipolygon. For largest-only countries this is the mainland centroid — which is what makes
distances feel honest. For the D-14 exceptions it is the centroid of the kept islands together
(New Zealand's sits in Cook Strait), which is the honest answer for those too.

Two known-awkward cases where the centroid falls outside the country (`HR`, `CL` is fine but
long, `VN`, `SO`): acceptable. If you want to be nicer, use `polylabel` to get the pole of
inaccessibility instead. **Pick one and use it for every country** — mixing methods makes
distances incomparable.

Store centroids with 4 decimal places in the **server-only** `backend/functions/src/data/countries.json`.
The client never receives a centroid: it has no use for one, and a centroid is a strong hint.

### 3.3 Simplification

Simplify **after** fitting, in pixel space, to a fixed tolerance of **1px** on the 500px
box (Douglas-Peucker via `simplify-js`). A percentage-of-vertices rule would give Russia and
Nauru wildly different visual fidelity; a pixel tolerance gives every silhouette the same.

Budget: every country's path ≤ **8 KB**. If a coastline does not fit at 1px, the tolerance is
escalated in 0.25px steps *for that country alone*, so a fjord-heavy Norway never forces a
coarser Italy. Since D-69, seven escalate: Nicaragua to 1.25px, the Bahamas, Canada, Denmark,
the UK and Norway to 1.5px, Ireland to 1.75px. Total for all 194 is ~510 KB against a 640 KB
cap, held server-side; one path (≤ 8 KB) travels per round, which is noise against NFR-5.

Verify visually. Over-simplified Italy stops looking like a boot, and that ruins the game.

### 3.4 Projection and normalisation

Do **not** use a single world projection — Greenland-style distortion would make high-latitude
countries unrecognisable and would leak latitude as a hint.

Since D-69 the build does not project at all: the artwork arrives already 2D, one file per
country, and `artwork.mjs` only applies D-8, fits the kept rings into a fixed 500×500 viewBox
with 24px padding, and simplifies. Every silhouette then occupies similar screen area regardless
of real size, satisfying FR-6.2 (area must not be a free hint).

**The rule above still has to hold, and it was checked rather than assumed.** If the artwork were
cut out of one world map, high-latitude countries would arrive pre-stretched and the projection
would be leaking latitude through the back door. It is not: each file is projected for its own
country, and width-to-height ratios match the `geoAzimuthalEqualArea` renders they replaced to
within **1.8 % in every latitude band, 60–90° included**. The files are frozen in git, so this is
a one-time check, recorded in `tools/country-shapes/README.md`.

### 3.5a Where Natural Earth runs out (D-59, D-69)

10m is the finest resolution `world-atlas` ships, and it is not fine enough. It showed first at
the bottom of the pool. Vertex counts straight out of `ne_10m_admin_0_countries`, against a pool
median of **210**:

| | vertices in ne_10m |
|---|---|
| Nauru | 9 |
| Monaco | 12 |
| Tuvalu | 13 |
| Marshall Islands | 17 |
| San Marino | 19 |
| Liechtenstein | 26 |

The failure was not that these looked crude. It was that Monaco, Nauru and San Marino looked
like **the same blob as each other**, so the question had no answer a player could reach. D-59
gave four of them outlines from [mapsicon](https://github.com/djaiss/mapsicon) and dropped two.

**D-69 finished the argument in the other direction.** The same complaint came back for the rest
of the pool — not blobs, but a simplification of a simplification — and the answer was to stop
projecting surveyed polygons for silhouettes entirely. All 196 are now traced from the drawn
artwork in `tools/country-shapes/` by `tools/lib/artwork.mjs`, mapsicon and `icon.mjs` are gone,
and Natural Earth keeps the job it is actually good at: §3.2's centroids.

`artwork.mjs` parses every `<path>` in the file (`M L H V C Z`, absolute and relative), flattens
curves, applies §3.1's D-8 selection in two dimensions, fits and simplifies. Two boundaries from
D-59 carry over unchanged, and they are the load-bearing ones:

1. **Outline only.** The centroid still comes from Natural Earth (§3.2), so every distance and
   compass hint is computed from surveyed geometry. The check that this held through the change
   was that `countries.json`'s centroids came out byte-identical.
2. **Refuse, never guess.** `artwork.mjs` throws `UnsupportedArtwork` on any path command it does
   not understand and on a file with no `<path>`. An arc quietly dropped is a country with a bite
   out of it and no error anywhere.

D-59's third boundary — single-landmass countries only, because mapsicon drew every island — is
gone, because D-8 now runs over the artwork like it runs over everything else, and
`tools/overrides.json`'s `minShare` is read on the same side. Indonesia keeps five landmasses,
the Philippines seven, New Zealand two.

**Two still get no silhouette at all.** Tuvalu and the Marshall Islands are atoll nations, and
the artwork does not rescue them: D-8 leaves Tuvalu a 13-point sliver of Funafuti, and the
Marshall Islands' largest atoll is a thread that disappears under simplification entirely. They
are absent from `shapes.json`, so `KINDS.shape.pool()` drops them, and they keep their other four
kinds. This is D-20's treatment of the Vatican, reached deliberately. The list lives in
`tools/shape-overrides.json` with a reason per country.

The artwork's provenance is unknown and `NOTICE` says so in full; `tools/country-shapes/README.md`
has the whole story, including what was checked before it was accepted.

### 3.5 Optional rotation

Generate a fixed random rotation (0–359°) per `shapeKey` at build time and bake it into the
path data. Rotation is a difficulty knob, not a security control, and baking it in at build
time means it cannot leak through a runtime parameter.

Default off in v1. Consider it for a "difícil" mode later.

### 3.6 Shapes never leave the server (SEC-2, D-13)

The original design here shipped opaque-keyed shape shards to the client. It had a hole: the
client also had `countries.min.json` with each country's key, so silhouette → key → country
was a JSON lookup. Opaque keys only protect anything if the key→country map is private, and
if it is private the client cannot use the keys either.

So there are **no shape keys and no public shape files**. `shapes.json` lives in
`backend/functions/src/data/`, keyed by country code, and `getRound` inlines exactly one path
per round. The only thing a determined player can match the path against is Natural Earth
itself, after reproducing this pipeline — which is SEC-12, the documented residual risk.

Path format: one `d` string per country, exterior rings and holes as separate subpaths, one
decimal place, rendered with `fill-rule="evenodd"`.

## 4. Names, aliases, autocomplete

`site/data/countries.min.json` per entry — codes, names, aliases, **nothing else**:

```jsonc
{ "code": "NL", "code3": "NLD", "en": "Netherlands", "pt": "Holanda",
  "aliases": ["Holland", "Nederland", "Países Baixos", "Netherlands", …] }
```

Whole file ≈ 24 KB. Centroids, tiers and shapes live only in the server copy.

Autocomplete index rules (FR-6.3):
- Normalise with `site/app/normalize.js` — `NFD`, strip combining marks, lowercase, collapse
  punctuation and whitespace. `são` matches `sao`; `Timor-Leste` matches `timor leste`. The
  build imports the **same file** for its duplicate check, so what the build calls unique is
  what the player experiences as unique.
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
3. For each day, draw **one country per kind** — silhouette, flag, capital, GDP (D-52, D-53) — weighted by
   tier over that kind's own pool, rejecting any country that fails FR-2.3's windows: same kind
   within 120 days, any kind within 30 days, or already used today.
4. Shuffle them into a play order, from the same seeded stream.
5. Emit `{ puzzleId, items: [{ kind, subject }], opensAt }` for 365 days.
6. Upload to the `puzzles` collection with the Admin SDK.

**The kind pools are derived in `tools/lib/schedule.mjs` from `countries.json` and `flags.json`,
duplicating the rules in `backend/functions/src/lib/kinds.ts`** — which is the authority. A
generator that cannot import the server's TypeScript is the price of keeping the schedule an
offline artefact (FR-2.2). The guard against drift is that both sides pin their pool sizes in
tests (196 shapes, 181 capitals, 172 flags, 186 GDPs), so changing either rule fails one of them
loudly.

Run it once at launch, then annually. The weekly `scheduleHealthCheck` function warns when
fewer than 30 future days exist (NFR-6).

**The generated schedule file must not be committed to the public repo.** Everything else in
`/tools` can be. Add `tools/out/schedule*.json` to `.gitignore` — this is the one place where
open-sourcing the project would leak the answers.

## 7. Scoring maths (shared server-side module)

Pure functions in `backend/functions/src/lib/geo.ts`, unit tested (NFR-8).

- **Distance**: haversine, earth radius 6371 km, rounded to the nearest km.
- **Bearing**: **rhumb** bearing from guess centroid to answer centroid, in degrees — the constant
  heading, which is the direction on a map (D-62). It was the initial great-circle bearing until
  2026-09-13; over long distances a great circle arcs poleward, so the arrow pointed north at
  countries to the south for 8.3 % of pairs in the pool (15.2 % of pairs over 7000 km). Distance
  stays great-circle: "how far" and "which way on the map" are two questions.
  Snap to 8 buckets of 45° for the arrow (`N NE E SE S SW W NW`), but return the raw degrees too
  so the UI can rotate an arrow smoothly if you want.
- **Proximity**: `max(0, (20000 - distanceKm) / 20000)`, rendered as a rounded percentage.
  20,000 km ≈ half the earth's circumference, i.e. the maximum possible separation.
- **Correct guess**: `distanceKm === 0` is not the test — compare ISO codes.

## 8. Build validation

`tools/build-geo.mjs` fails the build if any of these are violated:

- Any country in `include.json` has no geometry, or no entry in `world-countries`
- Any country lacks a tier in `tiers.json`
- Any centroid falls outside [-90, 90] × [-180, 180]
- Any path exceeds 8 KB even after tolerance escalation
- Any two countries share a name, alias or code once normalised
- Total shape bytes exceed the sanity cap (640 KB)

Pure helpers in `tools/lib/shape.mjs` have their own tests (`npm test` in `tools/`): polygon
selection with and without `minShare`, winding normalisation, fit-to-box, byte-cap escalation.

Add a `tools/preview.html` that renders all ~196 silhouettes in a grid. Look at it. Human eyes
catch a broken simplification in five seconds and no assertion will.
