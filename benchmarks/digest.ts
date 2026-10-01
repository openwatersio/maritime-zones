import { createHash } from "node:crypto";

type Zone = { layer: string; mrgid: number };
type Hit = { distanceNm: number; bearingDeg: number; point: [number, number]; zone: Zone | null };

/**
 * A safe-integer fingerprint of a whole query answer, so two revisions must
 * agree on every zone and on distance, bearing, point and zone of a hit.
 * Numbers are rounded to 1e-6 so floating-point noise does not count as a change.
 */
export function digest(answer: Zone[] | Hit | null): number {
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const canonical =
    answer === null
      ? null
      : Array.isArray(answer)
        ? answer.map((z) => [z.layer, z.mrgid])
        : [
            round(answer.distanceNm),
            round(answer.bearingDeg),
            answer.point.map(round),
            answer.zone && [answer.zone.layer, answer.zone.mrgid],
          ];
  return parseInt(createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12), 16);
}
