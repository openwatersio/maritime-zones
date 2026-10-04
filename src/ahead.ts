import type { Layer, Options, Read, Zone } from "./queries.ts";
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
  read: Read,
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

    type Box = [number, number, number, number];
    const legs: { lo: number; hi: number; a: [number, number]; b: [number, number]; boxes: Box[] }[] = [];
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
      const bounds: Box = [
        Math.min(firstLon, lastLon) - 1e-7,
        Math.min(a[0], b[0]) - 1e-7,
        Math.max(firstLon, lastLon) + 1e-7,
        Math.max(a[0], b[0]) + 1e-7,
      ];
      legs.push({ lo, hi, a, b, boxes: wrapped(bounds) });
      lo = hi;
    }
    // One read per tile covers every leg through it; each leg then keeps the lines a read of its own box returns.
    const spans = new Map<string, Box>();
    for (const leg of legs)
      for (const bb of leg.boxes)
        for (const tile of tiles(bb)) {
          const span = spans.get(tile);
          spans.set(
            tile,
            span
              ? [Math.min(span[0], bb[0]), Math.min(span[1], bb[1]), Math.max(span[2], bb[2]), Math.max(span[3], bb[3])]
              : bb,
          );
        }
    type Line = { coast: boolean; xy: Float64Array; box: Box };
    const loaded = new Map<string, Promise<Line[]>>();
    const lines = (tile: string) => {
      let pending = loaded.get(tile);
      if (!pending) {
        const [minX, minY, maxX, maxY] = spans.get(tile)!;
        pending = (async () => {
          const found: Line[] = [];
          for await (const raw of read(tile, { minX, minY, maxX, maxY }, ["boundary", "land"])) {
            const feature = raw as { properties: { kind: string; zone: number }; geometry: QueryGeometry };
            const coast = feature.properties.kind === "land";
            if (
              !coast &&
              (feature.properties.kind !== "boundary" || !layers.includes(zones()[feature.properties.zone]!.layer))
            )
              continue;
            const xy = feature.geometry.xy;
            const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
            for (let j = 0; j < xy.length; j += 2) {
              box[0] = Math.min(box[0], xy[j]!);
              box[1] = Math.min(box[1], xy[j + 1]!);
              box[2] = Math.max(box[2], xy[j]!);
              box[3] = Math.max(box[3], xy[j + 1]!);
            }
            found.push({ coast, xy, box });
          }
          return found;
        })();
        loaded.set(tile, pending);
      }
      return pending;
    };

    const candidates: { distanceNm: number; coast: boolean }[] = [];
    for (const { lo, hi, a, b, boxes } of legs) {
      for (const bb of boxes) {
        for (const tile of tiles(bb)) {
          if (!listed()[tile]) continue;
          for (const { coast, xy, box } of await lines(tile)) {
            // The same inclusive bbox test the tile index applies to a read of this leg's box.
            if (box[2] < bb[0] || box[0] > bb[2] || box[3] < bb[1] || box[1] > bb[3]) continue;
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
    const next = groups.findIndex((g) => g.first >= 0);
    const stop = next < 0 ? -1 : groups.findIndex((g, i) => i >= next && g.coast !== null);
    const water = next < 0 ? [] : groups.slice(next, stop < 0 ? undefined : stop);
    // Membership only changes at a group, so one sample inside each gap classifies both groups beside it.
    const edges = [groups[next - 1]?.last ?? -backPad, ...water.flatMap((g) => [g.first, g.last])];
    const last = edges.at(-1)!;
    edges.push(groups[stop]?.first ?? (maxNm > last ? maxNm : last + 3e-7));
    const states = await Promise.all(
      water.length
        ? Array.from({ length: water.length + 1 }, (_, k) => {
            const lo = edges[2 * k]!,
              hi = edges[2 * k + 1]!;
            // The start already lies in the first gap unless a crossing sits on it.
            if (k === 0 && hi > 0) return result.start;
            const pole = north
              ? ((Math.PI / 2 - Math.abs(position(lo)[0] * RAD)) * EARTH_NM) / (2 * Math.abs(north))
              : Infinity;
            return state(lo + Math.min((hi - lo) / 2, pole));
          })
        : [],
    );
    water.forEach((group, k) => {
      const before = states[k]!,
        after = states[k + 1]!;
      const from = new Set(before.flatMap(parties)),
        to = new Set(after.flatMap(parties));
      const leaving = before.filter((z) => parties(z).some((iso) => !to.has(iso)));
      const entering = after.filter((z) => parties(z).some((iso) => !from.has(iso)));
      if (leaving.length || entering.length) {
        const [a, b] = position(group.first);
        result.crossings.push({ kind: "water", distanceNm: group.first, point: [a, wrap(b)], leaving, entering });
      }
    });
    if (stop >= 0) {
      const distanceNm = groups[stop]!.coast!;
      const [a, b] = position(distanceNm);
      result.crossings.push({ kind: "coast", distanceNm, point: [a, wrap(b)] });
    }
    return result;
  };
}
