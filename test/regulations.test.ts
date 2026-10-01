import { expect, it } from "vitest";
import { assessDischarge } from "../demo/regulations.ts";
import type { Zone } from "../src/queries.ts";

it("applies the Canadian 3 NM example only with an unambiguous territory and known distance", () => {
  const canada = { iso_ter: "CAN", iso_ter2: null, iso_ter3: null } as Zone;
  expect(assessDischarge([canada], 2.9).status).toBe("too-close");
  expect(assessDischarge([canada], 3).status).toBe("distance-met");
  expect(assessDischarge([canada], 4).rule?.demoOnly).toBe(true);
  expect(assessDischarge([canada], null).status).toBe("unresolved");
  expect(assessDischarge([], 400).status).toBe("unresolved");
  expect(assessDischarge([{ ...canada, iso_ter: "USA" }], 4).status).toBe("unresolved");
  expect(assessDischarge([{ ...canada, iso_ter2: "USA" }], 4).status).toBe("unresolved");
  const overlap = assessDischarge([{ ...canada, iso_sov2: "USA" }], 4);
  expect(overlap.status).toBe("unresolved");
  expect(overlap.territories).toEqual(["CAN", "USA"]);
  expect(assessDischarge([canada], Infinity).status).toBe("unresolved");
  expect(assessDischarge([canada], -1).status).toBe("unresolved");
});
