/**
 * The Batata Quente board (D-89), from tools/build-world.mjs. Server-only, like
 * every other geometry file: a room receives the grey land when the game starts
 * and one country's outline at a time, as it is named there — never the file.
 */

import worldJson from "../data/world.json";

const world = worldJson as unknown as {
  viewBox: string;
  land: string;
  paths: Record<string, string>;
  dots: Record<string, [number, number]>;
};

export interface MapBase {
  viewBox: string;
  land: string;
}

/** A named country's mark: its outline, or a dot where it is too small to see as one. */
export type MapPiece = { d: string } | { dot: [number, number] };

export const mapBase = (): MapBase => ({ viewBox: world.viewBox, land: world.land });

export function mapPiece(code: string): MapPiece {
  const d = world.paths[code];
  if (d) return { d };
  const dot = world.dots[code];
  if (dot) return { dot };
  throw new Error(`world.json has no mark for ${code}`);
}
