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

/** Initial great-circle bearing from `from` towards `to`, in [0, 360). */
export function bearingDeg(from: LonLat, to: LonLat): number {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const dLon = rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  const b = (deg(Math.atan2(y, x)) + 360) % 360;
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
