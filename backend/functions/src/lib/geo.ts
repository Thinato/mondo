/**
 * Distance, bearing and proximity maths (03-geo-data-pipeline.md §7, FR-2.7).
 * Pure functions; the only place these formulas live (NFR-8).
 */

/** [longitude, latitude] in degrees — GeoJSON order, same as countries.json. */
export type LonLat = readonly [number, number];

export const EARTH_RADIUS_KM = 6371;
/** ≈ half the circumference: the furthest two points on Earth can be. */
export const MAX_DISTANCE_KM = 20000;

export const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Compass = (typeof COMPASS)[number];

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance by the haversine formula, rounded to the nearest km. */
export function distanceKm(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Bearing from `from` towards `to`, in [0, 360) — the **rhumb** bearing, which
 * is the direction on a map rather than the direction you would fly (D-62).
 *
 * This used to be the initial great-circle bearing, which is the right answer
 * to a different question. Over a long distance a great circle arcs poleward,
 * so from Mongolia the shortest path to Mauritania *sets off* north-west, over
 * Kazakhstan and Europe, before coming down into West Africa — and the arrow
 * said NW about a country 27° of latitude to the SOUTH. Across every pair of
 * countries in the pool, the great-circle arrow's north/south half contradicted
 * the actual latitude difference in 8.3 % of cases, and 15.2 % of the pairs
 * over 7000 km. That is worst exactly where the arrow matters most: a player's
 * first, wildest guess.
 *
 * A rhumb line is a constant compass heading — a straight line on a Mercator
 * map — which is the mental model a player is actually using. It cannot
 * contradict the latitude: `dPhi` carries the sign of the latitude difference,
 * so a northward answer can never produce a southward arrow. `test/geo.test.ts`
 * pins that over the whole pool.
 *
 * Distance stays great-circle (FR-2.7): "how far" and "which way on the map"
 * are two questions and each gets its honest answer.
 *
 * `dPhi` is the difference of *isometric* latitudes, the Mercator y-coordinate.
 * At a pole it is infinite, which `atan2` handles as due north or due south;
 * no country centroid is near enough for that to matter, and it does not throw.
 */
export function bearingDeg(from: LonLat, to: LonLat): number {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const dPhi = Math.log(Math.tan(rad(lat2) / 2 + Math.PI / 4) / Math.tan(rad(lat1) / 2 + Math.PI / 4));
  // Cross the antimeridian the short way, or Fiji → Samoa points three quarters
  // of the way round the world.
  let dLon = rad(lon2 - lon1);
  if (Math.abs(dLon) > Math.PI) dLon = dLon > 0 ? dLon - 2 * Math.PI : dLon + 2 * Math.PI;
  const b = (deg(Math.atan2(dLon, dPhi)) + 360) % 360;
  return Math.round(b * 10) / 10;
}

/** Snap a bearing to one of 8 compass points, each covering 45° centred on the point. */
export function compass8(bearing: number): Compass {
  const i = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return COMPASS[i] as Compass;
}

/** 1 = same spot, 0 = antipode. Three decimals; the UI shows a rounded percentage. */
export function proximity(km: number): number {
  const p = Math.max(0, (MAX_DISTANCE_KM - km) / MAX_DISTANCE_KM);
  return Math.round(p * 1000) / 1000;
}
