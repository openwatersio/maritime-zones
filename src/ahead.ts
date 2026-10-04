import type { Layer, Options, Rect, Zone } from "./queries.ts";
import type { QueryGeometry } from "./feature.ts";
import { tiles, wrapped } from "./tiles.ts";

export interface AheadOptions extends Options {
  /** Along-course horizon in nautical miles; positive, at most 480, default 480. */
  maxNm?: number;
}

export type Crossing =
  | { kind: "water"; distanceNm: number; point: [number, number]; leaving: Zone[]; entering: Zone[] }
  | { kind: "coast"; distanceNm: number; point: [number, number] };

export interface AheadResult {
  /** Selected layers containing the starting point. */
  start: Zone[];
  /** The start is in no zone of any layer: on land, or in a berth the coastline covers. */
  onLand: boolean;
  /** Territory transitions in order, ending at the first coastline contact if any. */
  crossings: Crossing[];
}

export const RAD = Math.PI / 180;
export const EARTH_NM = 3440.065;
const GROUP_NM = 1 / 1852;
const ENDPOINT_NM = 1e-8;
export const SOVEREIGN: Layer[] = ["internal", "archipelagic", "12nm"];
/** Every layer, innermost first. */
export const LAYERS: Layer[] = ["internal", "archipelagic", "12nm", "24nm", "eez", "high_seas"];
export const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
const mercator = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + latitude / 2));
/** Δφ/Δψ of a rhumb leg; a tiny Δφ takes the cosine limit, where the Mercator difference cancels. */
const stretch = (from: number, to: number) =>
  Math.abs(to - from) < 1e-6 ? Math.cos((from + to) / 2) : (to - from) / (mercator(to) - mercator(from));
const parties = (z: Zone): string[] => {
  const codes = [z.iso_ter ?? z.iso_sov, z.iso_ter2 ?? z.iso_sov2, z.iso_ter3 ?? z.iso_sov3].filter(
    (iso): iso is string => !!iso,
  );
  return codes.length ? codes : [`zone:${z.layer}:${z.mrgid}`];
};

export function createAhead(
  read: (tile: string, rect: Rect, kind: string) => AsyncIterable<unknown>,
  listed: () => Record<string, unknown>,
  zones: () => Zone[],
  whereAmI: (lat: number, lon: number) => Promise<Zone[]>,
) {
  return async function ahead(
    lat: number,
    lon: number,
    cogDeg: number,
    { layers = SOVEREIGN, maxNm = 480 }: AheadOptions = {},
  ): Promise<AheadResult> {
    if (!Number.isFinite(lat) || Math.abs(lat) >= 90) throw new RangeError("latitude must be between -90 and 90");
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) throw new RangeError("longitude must be between -180 and 180");
    if (!Number.isFinite(cogDeg)) throw new RangeError("course must be finite");
    if (!Number.isFinite(maxNm) || maxNm <= 0 || maxNm > 480)
      throw new RangeError("maxNm must be positive and at most 480");
    if (!Array.isArray(layers) || layers.some((layer) => !LAYERS.includes(layer)))
      throw new RangeError("unknown layer");
    const heading = wrap(cogDeg) * RAD;
    const east = Math.abs(Math.sin(heading)) < 1e-14 ? 0 : Math.sin(heading);
    const north = Math.abs(Math.cos(heading)) < 1e-14 ? 0 : Math.cos(heading);
    const originLat = lat * RAD,
      originLon = lon * RAD,
      originY = mercator(originLat);
    if (Math.abs(originLat + (maxNm / EARTH_NM) * north) >= Math.PI / 2) throw new RangeError("course reaches a pole");

    function position(distanceNm: number): [number, number] {
      const latitude = originLat + (distanceNm / EARTH_NM) * north;
      return [latitude / RAD, (originLon + ((distanceNm / EARTH_NM) * east) / stretch(originLat, latitude)) / RAD];
    }
    if (Math.abs(position(maxNm)[1] - lon) > 16 * 360)
      throw new RangeError("course exceeds 16 longitude revolutions; shorten maxNm");
    const backPad = north
      ? Math.min(0.005, maxNm, ((Math.PI / 2 - Math.abs(originLat)) * EARTH_NM) / (2 * Math.abs(north)))
      : Math.min(0.005, maxNm);
    const here = (distanceNm: number) => {
      const [a, b] = position(distanceNm);
      return whereAmI(a, wrap(b));
    };
    const state = async (distanceNm: number) => (await here(distanceNm)).filter((z) => layers.includes(z.layer));
    const origin = await here(0);
    const result: AheadResult = {
      start: origin.filter((z) => layers.includes(z.layer)),
      onLand: !origin.length,
      crossings: [],
    };

    function intersect(ax: number, ay: number, bx: number, by: number, nearLon: number): number[] {
      // A leg's longitude branch keeps repeated polar revolutions and dateline crossings distinct.
      const x = (nearLon + wrap(ax - nearLon)) * RAD;
      const vx = wrap(bx - ax) * RAD,
        y = ay * RAD,
        vy = (by - ay) * RAD;
      // Stored segments are straight in lat/lon; their Mercator curves can cross the course twice.
      const f = (t: number) => (x + t * vx - originLon) * north - (east ? (mercator(y + t * vy) - originY) * east : 0);
      const stops = [0, 1];
      const ratio = vx * north ? (vy * east) / (vx * north) : NaN;
      if (ratio > 0 && ratio <= 1 && vy) {
        for (const latitude of [Math.acos(ratio), -Math.acos(ratio)]) {
          const t = (latitude - y) / vy;
          if (t > 0 && t < 1) stops.push(t);
        }
      }
      stops.sort((a, b) => a - b);
      const distances: number[] = [];
      const add = (t: number) => {
        const latitude = y + t * vy;
        distances.push(
          Math.abs(north) >= Math.abs(east)
            ? ((latitude - originLat) * EARTH_NM) / north
            : ((x + t * vx - originLon) * stretch(originLat, latitude) * EARTH_NM) / east,
        );
      };
      for (let i = 1; i < stops.length; i++) {
        let lo = stops[i - 1]!,
          hi = stops[i]!,
          left = f(lo),
          right = f(hi);
        if (Math.abs(left) < 1e-14 && Math.abs(right) < 1e-14) continue;
        if (Math.abs(left) < 1e-14) add(lo);
        if (Math.abs(right) < 1e-14) add(hi);
        if (left * right >= 0) continue;
        for (let j = 0; j < 45; j++) {
          const mid = (lo + hi) / 2,
            value = f(mid);
          if (left * value <= 0) hi = mid;
          else {
            lo = mid;
            left = value;
          }
        }
        add((lo + hi) / 2);
      }
      return distances;
    }

    const candidates: { distanceNm: number; coast: boolean }[] = [];
    for (let lo = -backPad; lo < maxNm;) {
      let hi = Math.min(maxNm, lo + 30);
      const a = position(lo);
      let b = position(hi);
      // Very high latitudes need shorter legs to keep wrapped boxes within one longitude branch.
      while (Math.abs(b[1] - a[1]) > 30) {
        hi = (lo + hi) / 2;
        b = position(hi);
      }
      const firstLon = wrap(a[1]),
        lastLon = firstLon + b[1] - a[1];
      const bounds: [number, number, number, number] = [
        Math.min(firstLon, lastLon) - 1e-7,
        Math.min(a[0], b[0]) - 1e-7,
        Math.max(firstLon, lastLon) + 1e-7,
        Math.max(a[0], b[0]) + 1e-7,
      ];
      for (const bb of wrapped(bounds)) {
        const rect = { minX: bb[0], minY: bb[1], maxX: bb[2], maxY: bb[3] };
        for (const tile of tiles(bb)) {
          if (!listed()[tile]) continue;
          for await (const raw of read(tile, rect, "line")) {
            const feature = raw as { properties: { kind: string; zone: number }; geometry: QueryGeometry };
            const coast = feature.properties.kind === "land";
            if (
              !coast &&
              (feature.properties.kind !== "boundary" || !layers.includes(zones()[feature.properties.zone]!.layer))
            )
              continue;
            const xy = feature.geometry.xy;
            for (let j = 2; j < xy.length; j += 2) {
              for (const rawDistance of intersect(xy[j - 2]!, xy[j - 1]!, xy[j]!, xy[j + 1]!, (a[1] + b[1]) / 2)) {
                const distanceNm =
                  Math.abs(rawDistance) <= ENDPOINT_NM
                    ? 0
                    : Math.abs(rawDistance - maxNm) <= ENDPOINT_NM
                      ? maxNm
                      : rawDistance;
                if (distanceNm < lo - 1e-7 || distanceNm > hi + 1e-7 || distanceNm < -backPad || distanceNm > maxNm)
                  continue;
                // Leaving land is no contact; zones mark the water side, so only a start in none needs the check.
                const exit =
                  coast &&
                  result.onLand &&
                  distanceNm >= 0 &&
                  !(await here(distanceNm - GROUP_NM)).length &&
                  (await here(distanceNm + GROUP_NM)).length > 0;
                candidates.push({ distanceNm, coast: coast && !exit });
              }
            }
          }
        }
      }
      if (candidates.some((c) => c.coast && c.distanceNm >= 0)) break;
      lo = hi;
    }
    candidates.sort((a, b) => a.distanceNm - b.distanceNm);
    const groups: { first: number; last: number; coast: number | null }[] = [];
    for (const c of candidates) {
      const previous = groups.at(-1);
      if (previous && previous.first < 0 === c.distanceNm < 0 && c.distanceNm - previous.first <= GROUP_NM) {
        previous.last = c.distanceNm;
        if (c.coast) previous.coast = Math.min(previous.coast ?? Infinity, c.distanceNm);
      } else groups.push({ first: c.distanceNm, last: c.distanceNm, coast: c.coast ? c.distanceNm : null });
    }
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (group.first < 0) continue;
      if (group.coast !== null) {
        const [a, b] = position(group.coast);
        result.crossings.push({ kind: "coast", distanceNm: group.coast, point: [a, wrap(b)] });
        break;
      }
      const margin = Math.min(
        0.005,
        (group.first - (groups[i - 1]?.last ?? -backPad)) / 3,
        ((groups[i + 1]?.first ?? (maxNm > group.last ? maxNm : group.last + 3e-7)) - group.last) / 3,
        north ? ((Math.PI / 2 - Math.abs(position(group.last)[0] * RAD)) * EARTH_NM) / (2 * Math.abs(north)) : Infinity,
      );
      const before = await state(group.first - margin),
        after = await state(group.last + margin);
      const from = new Set(before.flatMap(parties)),
        to = new Set(after.flatMap(parties));
      const leaving = before.filter((z) => parties(z).some((iso) => !to.has(iso)));
      const entering = after.filter((z) => parties(z).some((iso) => !from.has(iso)));
      if (leaving.length || entering.length) {
        const [a, b] = position(group.first);
        result.crossings.push({ kind: "water", distanceNm: group.first, point: [a, wrap(b)], leaving, entering });
      }
    }
    return result;
  };
}
