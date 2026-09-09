import { test } from "node:test";
import assert from "node:assert/strict";
import { bearingDeg, compass8, distanceKm, proximity, MAX_DISTANCE_KM, type LonLat } from "../src/lib/geo";

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
  const b = bearingDeg(LONDON, PARIS);
  assert.ok(b > 140 && b < 155, `bearing ${b}`);
  assert.equal(compass8(b), "SE");
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
