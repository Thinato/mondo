# mapsicon — silhouettes for four microstates

Four SVGs vendored from **[mapsicon](https://github.com/djaiss/mapsicon) by
Régis Freyd**, fetched 2026-09-13 from `all/<cc>/vector.svg` at `master`.

## Why these four exist (D-59)

Natural Earth's 10m dataset — the finest world-atlas ships, and the source of
every other silhouette in the game — does not resolve a country of a few square
kilometres. Before this, Monaco was **12 vertices**, San Marino 19,
Liechtenstein 26 and Nauru 9, against a pool median of 210. They did not render
as crude versions of themselves; they rendered as the *same blob as each other*,
which makes them unanswerable rather than hard.

Mapsicon gives them 146, 120, 94 and 101 path commands. All four are a single
landmass, so D-8 is untouched.

## Terms

Mapsicon carries no formal licence. The README states, verbatim:

> Do what you want with them as long as you mention me in your project.
> Please don't resell them - I forbid it!

Mondo is free to play and sells nothing, so the second clause is satisfied. The
first is met by the entry in the repository's top-level `NOTICE` and by this
file. Paulo accepted these terms on 2026-09-13.

**This is the only art in the build from a source without an OSI licence**, and
it is committed rather than crawled precisely so the provenance is legible. It
is unrelated to the `assets/` directory, which remains gitignored reference
material of unknown origin (D-15, D-16) and is still never a build input — the
two were checked and are not the same files.

## Refreshing

These are static inputs, not a dependency. To update one, re-fetch
`https://raw.githubusercontent.com/djaiss/mapsicon/master/all/<cc>/vector.svg`
and re-run `npm run build-geo`. The converter refuses anything it does not
understand rather than guessing (`tools/lib/icon.mjs`).
