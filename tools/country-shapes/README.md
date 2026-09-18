# country-shapes — the silhouette artwork

196 SVGs, one per country in `tools/include.json`, `<cc>.svg` lowercase. Every silhouette in
the game is traced from here by `tools/lib/artwork.mjs` (D-69).

## Where they came from

They were crawled on **2026-09-08** into the gitignored `assets/` directory, whose origin was
never recorded. That is the honest and complete answer: **the source site and its licence are
unknown.** Paulo accepted that on 2026-09-18 and the 196 the game uses were moved here so the
provenance is at least legible and a clean clone can run the build (D-69 reverses D-15).

`assets/` itself stays gitignored and stays out of the build. These files are the build input
now; nothing reads `assets/` any more.

## Why they replaced Natural Earth

Natural Earth 10m is the finest world-atlas ships and it is not fine enough. It draws Nauru with
**9** vertices and Monaco with **12** — they rendered as the same blob as each other, which is
what D-59 patched for four microstates with mapsicon. The rest of the pool was not blobs, but it
was a simplification we then simplified again, and Paulo's verdict on the result was that the
generated silhouettes were bad. These are drawn maps and they look like the countries.

D-59's mapsicon vendoring is gone: those four are drawn here like everyone else, and a third
source for four countries would be three sources for one job.

## What was checked before accepting them

- **All 196 convert** under the 8 KB-per-country cap. Total 510 KB against a 640 KB budget.
  Seven escalate above the 1px tolerance (BS, CA, DK, GB, IE, NI, NO); none above 1.75px.
- **They are not a world map.** A single world projection would stretch high-latitude countries
  and leak latitude as a hint (03-geo-data-pipeline.md §3.4). Each file is projected for its own
  country: width-to-height ratios match the azimuthal equal-area renders they replaced to within
  **1.8 % at every latitude band**, including 60–90°.
- **Tuvalu and the Marshall Islands are still hopeless.** The artwork has both, but D-8 leaves
  Tuvalu a 13-point sliver of Funafuti and the Marshall Islands' largest atoll disappears under
  simplification entirely. They stay on `shape-overrides.json`'s `noShape` list.

## Refreshing

Static inputs, not a dependency. Replace a file and re-run `npm run build-geo`; the converter
refuses any path command it does not understand rather than guessing, because a converter that
silently skips an arc draws a country with a bite out of it and nobody would know which.
