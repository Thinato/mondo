import { test } from "node:test";
import assert from "node:assert/strict";
import { bearingDeg, compass8, distanceKm, proximity, MAX_DISTANCE_KM, type LonLat } from "../src/lib/geo";
import { COUNTRIES, countryByCode } from "../src/lib/countries";

const LONDON: LonLat = [-0.1278, 51.5074];
const PARIS: LonLat = [2.3522, 48.8566];
const NEW_YORK: LonLat = [-74.006, 40.7128];
const SAO_PAULO: LonLat = [-46.6333, -23.5505];

const within = (actual: number, expected: number, pct: number) =>
  assert.ok(Math.abs(actual - expected) <= expected * pct, `${actual} not within ${pct * 100}% of ${expected}`);

test("FR-2.7: haversine matches published great-circle distances within 1%", () => {
  within(distanceKm(LONDON, PARIS), 344, 0.01);
  within(distanceKm(NEW_YORK, LONDON), 5570, 0.01);
  within(distanceKm(SAO_PAULO, NEW_YORK), 7680, 0.01);
});

test("distance is symmetric, zero to itself, and an integer", () => {
  assert.equal(distanceKm(LONDON, PARIS), distanceKm(PARIS, LONDON));
  assert.equal(distanceKm(LONDON, LONDON), 0);
  assert.ok(Number.isInteger(distanceKm(SAO_PAULO, LONDON)));
});

test("antipodes are ~20,015 km apart and proximity bottoms out at 0", () => {
  const d = distanceKm([0, 0], [180, 0]);
  within(d, 20015, 0.001);
  assert.equal(proximity(d), 0);
  assert.equal(proximity(MAX_DISTANCE_KM), 0);
});

test("proximity: 1 at zero distance, linear, three decimals", () => {
  assert.equal(proximity(0), 1);
  assert.equal(proximity(10000), 0.5);
  assert.equal(proximity(1043), 0.948);
});

test("bearing: cardinal directions from the origin", () => {
  assert.equal(bearingDeg([0, 0], [0, 10]), 0);
  assert.equal(bearingDeg([0, 0], [10, 0]), 90);
  assert.equal(bearingDeg([0, 0], [0, -10]), 180);
  assert.equal(bearingDeg([0, 0], [-10, 0]), 270);
});

test("bearing: Paris is roughly ESE of London (~148°)", () => {
  // Short hop: a rhumb line and a great circle agree to within a degree, which
  // is why D-62 changed nothing anyone could see at this range.
  const b = bearingDeg(LONDON, PARIS);
  assert.ok(b > 140 && b < 155, `bearing ${b}`);
  assert.equal(compass8(b), "SE");
});

// ---------------------------------------------------------------------------
// D-62: the arrow is the direction on a MAP, not the direction you would fly
// ---------------------------------------------------------------------------

test("D-62: Mauritânia from Mongólia points west, not north-west", () => {
  const MONGOLIA = countryByCode("MN")!.centroid as LonLat;
  const MAURITANIA = countryByCode("MR")!.centroid as LonLat;
  // The reported case. The initial great-circle bearing here is 300.6° — NW —
  // because the shortest path arcs over Kazakhstan and Europe before dropping
  // into West Africa. True for an aeroplane, useless for a player holding a map
  // of a country 27° of latitude to the SOUTH.
  const b = bearingDeg(MONGOLIA, MAURITANIA);
  assert.ok(b > 250 && b < 258, `bearing ${b}`);
  assert.equal(compass8(b), "W");
});

test("D-62: no arrow in the whole pool contradicts the latitude it points at", () => {
  // The guarantee the rhumb line buys, checked exhaustively rather than argued:
  // a northward arrow never points at a country further south, and the reverse.
  // The great-circle bearing failed this for 8.3 % of these pairs.
  const all = [...COUNTRIES.values()];
  const northish = new Set(["N", "NE", "NW"]);
  const southish = new Set(["S", "SE", "SW"]);
  const broken: string[] = [];
  for (const a of all) {
    for (const b of all) {
      if (a.code === b.code) continue;
      const arrow = compass8(bearingDeg(a.centroid as LonLat, b.centroid as LonLat));
      const dLat = b.centroid[1]! - a.centroid[1]!;
      if ((northish.has(arrow) && dLat < 0) || (southish.has(arrow) && dLat > 0)) {
        broken.push(`${a.code}->${b.code} ${arrow} but dLat ${dLat.toFixed(1)}`);
      }
    }
  }
  assert.deepEqual(broken.slice(0, 5), [], `${broken.length} arrows point the wrong way north/south`);
});

test("D-62: a bearing across the antimeridian takes the short way", () => {
  // Fiji to Samoa: 10° east and 3° north, but the raw longitude difference is
  // -350°. Without normalising it, this points WEST, three quarters of the way
  // round the world, instead of east.
  const east = bearingDeg([178, -17], [-172, -14]);
  assert.ok(east > 0 && east < 90, `Fiji → Samoa should head east, got ${east}`);
  assert.equal(compass8(east), "E");
  const west = bearingDeg([-172, -14], [178, -17]);
  assert.ok(west > 180 && west < 360, `Samoa → Fiji should head west, got ${west}`);
  assert.equal(compass8(west), "W");
});

test("D-62: same latitude is due east or due west, never a diagonal", () => {
  assert.equal(bearingDeg([0, 40], [30, 40]), 90);
  assert.equal(bearingDeg([0, 40], [-30, 40]), 270);
  assert.equal(bearingDeg([0, -40], [30, -40]), 90);
});

test("compass8: 45° buckets centred on each point, boundaries round up", () => {
  assert.equal(compass8(0), "N");
  assert.equal(compass8(22.4), "N");
  assert.equal(compass8(22.5), "NE");
  assert.equal(compass8(67.4), "NE");
  assert.equal(compass8(67.5), "E");
  assert.equal(compass8(180), "S");
  assert.equal(compass8(337.4), "NW");
  assert.equal(compass8(337.5), "N");
  assert.equal(compass8(359.9), "N");
  assert.equal(compass8(-90), "W");
  assert.equal(compass8(720 + 90), "E");
});
