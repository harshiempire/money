/** Sourced payables cannot reuse money already explained by another payable or acknowledgement. */
export function sourceInflowCapacity(input: {
  amountPaise: number; allocatedPaise: number; hasOtherPayable: boolean; residualDisposition: string | null;
}): number {
  return input.hasOtherPayable || input.residualDisposition ? 0 : Math.max(0, input.amountPaise - input.allocatedPaise);
}
