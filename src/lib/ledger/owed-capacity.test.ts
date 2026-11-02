import { expect, test } from "bun:test";
import { sourceInflowCapacity } from "./owed-capacity";

test("source capacity subtracts allocations and refuses competing explanations", () => {
  const input = { amountPaise: 10000, allocatedPaise: 2500, hasOtherPayable: false, residualDisposition: null };
  expect(sourceInflowCapacity(input)).toBe(7500);
  expect(sourceInflowCapacity({ ...input, allocatedPaise: 0 })).toBe(10000);
  expect(sourceInflowCapacity({ ...input, allocatedPaise: 12000 })).toBe(0);
  expect(sourceInflowCapacity({ ...input, hasOtherPayable: true })).toBe(0);
  for (const residualDisposition of ["kept", "written_off"])
    expect(sourceInflowCapacity({ ...input, residualDisposition })).toBe(0);
});
