import type { Zone } from "../src/queries.ts";

export const canadianExample = { iso: "CAN", minimumDistanceNm: 3, demoOnly: true } as const;
export const canadianSource = "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2012-69/section-96.html";

/** Keep overlapping claims instead of silently choosing one country. */
export function territoryCodes(zones: Zone[]): string[] {
  return [
    ...new Set(
      zones
        .flatMap((zone) => [
          zone.iso_ter ?? zone.iso_sov,
          zone.iso_ter2 ?? zone.iso_sov2,
          zone.iso_ter3 ?? zone.iso_sov3,
        ])
        .filter((iso): iso is string => !!iso),
    ),
  ];
}

/** A caller-supplied demonstration rule, outside the maritime-zones library. */
export function lookupRegulations(iso: string) {
  return iso === "CAN" ? canadianExample : null;
}

export function assessDischarge(zones: Zone[], coastDistance: number | null) {
  const territories = territoryCodes(zones);
  const rule = territories.length === 1 ? lookupRegulations(territories[0]!) : null;
  const known = coastDistance !== null && Number.isFinite(coastDistance) && coastDistance >= 0;
  const status: "unresolved" | "distance-met" | "too-close" =
    !rule || !known ? "unresolved" : coastDistance >= rule.minimumDistanceNm ? "distance-met" : "too-close";
  return { status, territories, coastDistanceNm: coastDistance, rule };
}
