import type { LedgerErrorCode } from '../context';
import { formatPaisePlain } from '@/lib/format';
import { sumPaise } from './balances';

type Failure = { ok: false; code: LedgerErrorCode; message: string };
const fail = (code: LedgerErrorCode, message: string): Failure => ({ ok: false, code, message });
const exactRupees = (n: number | bigint) => `${BigInt(n) / 100n}.${String(BigInt(n) % 100n).padStart(2, '0')}`;
export interface OpenAllocation { id: string; date: string; order: string; leftPaise: number }
type AllocationResult = { ok: true; allocations: Array<{ id: string; amountPaise: number; leftPaise: number }>; remaining: number } | Failure;
const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;
export function allocateOldestFirst(available: number, shares: readonly OpenAllocation[]): AllocationResult {
  if (!valid(available) || shares.some(s => !valid(s.leftPaise))) return fail('invalid_amount', 'Allocations must be positive exact paise.');
  let remaining = available;
  const allocations: Array<{ id: string; amountPaise: number; leftPaise: number }> = [];
  for (const share of [...shares].sort((a,b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order) || a.id.localeCompare(b.id))) {
    const amountPaise = Math.min(remaining, share.leftPaise);
    if (amountPaise <= 0) continue;
    allocations.push({ id: share.id, amountPaise, leftPaise: share.leftPaise - amountPaise });
    remaining -= amountPaise;
  }
  return { ok: true, allocations, remaining };
}
export function validateAllocations(available: number, open: readonly OpenAllocation[], requested: readonly { id: string; amountPaise: number }[]): AllocationResult {
  if (!valid(available) || open.some(s => !valid(s.leftPaise))) return fail('invalid_amount', 'Allocations must be positive exact paise.');
  const totals = new Map<string, bigint>();
  for (const row of requested) {
    if (!Number.isSafeInteger(row.amountPaise) || row.amountPaise <= 0) return fail('invalid_amount', 'Allocations must be positive exact paise.');
    totals.set(row.id, (totals.get(row.id) ?? 0n) + BigInt(row.amountPaise));
  }
  const allocations = [];
  for (const [id, amount] of totals) {
    const share = open.find(s => s.id === id);
    if (!share) return fail('not_found', "That share isn't available for this person.");
    if (amount > BigInt(share.leftPaise)) return fail('over_allocation', `Allocation ₹${exactRupees(amount)} exceeds a share's outstanding ₹${exactRupees(share.leftPaise)}.`);
    allocations.push({ id, amountPaise: Number(amount), leftPaise: share.leftPaise - Number(amount) });
  }
  const used = allocations.reduce((n,a) => n + BigInt(a.amountPaise), 0n);
  if (used > BigInt(available)) return fail('over_allocation', `Allocations exceed the inflow's unallocated ₹${exactRupees(available)}.`);
  return { ok: true, allocations, remaining: available - Number(used) };
}
export interface InflowExplanationInput {
  inflowAmountPaise: number;
  allocations: readonly { amountPaise: number }[];
  netReservedPaise: number;
  owedSourced: boolean;
  residualDisposition: string | null;
  residualAcknowledgedPaise: number | null;
  /** A net event with no bank leg still makes this inflow unavailable to append. */
  hasNetEvent?: boolean;
}
export function inflowExplanation(input: InflowExplanationInput) {
  const allocatedPaise = sumPaise(input.allocations.map(a => a.amountPaise)) ?? Number.MAX_SAFE_INTEGER;
  const residualAcknowledgedPaise = input.residualDisposition ? input.residualAcknowledgedPaise ?? 0 : 0;
  const availablePaise = Math.max(0, input.inflowAmountPaise - allocatedPaise - input.netReservedPaise - residualAcknowledgedPaise);
  return { allocatedPaise, netReservedPaise: input.netReservedPaise, owedSourced: input.owedSourced, residualAcknowledgedPaise,
    availablePaise, hasNetEvent: input.hasNetEvent ?? input.netReservedPaise > 0, acknowledged: !!input.residualDisposition,
    status: (input.owedSourced || availablePaise === 0 ? 'explained' : allocatedPaise || input.netReservedPaise || residualAcknowledgedPaise ? 'partial' : 'unexplained') as 'unexplained' | 'partial' | 'explained' };
}
export function appendAllowed(e: ReturnType<typeof inflowExplanation>): { ok: true } | Failure {
  if (e.hasNetEvent) return fail('net_event', 'This inflow is part of a net event; undo that event first.');
  if (e.owedSourced) return fail('explained_inflow', 'This inflow already has an owed-expense explanation. Clear it first.');
  if (e.acknowledged) return fail('explained_inflow', "This inflow's leftover is already acknowledged. Clear its settlement first.");
  if (e.availablePaise <= 0) return fail('fully_allocated', 'This inflow is already fully allocated.');
  return { ok: true };
}
export interface Allocation { splitParticipantId: string; amountPaise: number }
export function sameAllocations(expected: readonly Allocation[], current: readonly Allocation[]): boolean {
  const keys = (rows: readonly Allocation[]) => rows.map(r => JSON.stringify([r.splitParticipantId, r.amountPaise])).sort();
  const a = keys(expected), b = keys(current);
  return a.length === b.length && a.every((v,i) => v === b[i]);
}
export interface SettlementReceipt {
  inflowTransactionId: string; mode: 'replace' | 'append';
  applied: Array<Allocation & { personName: string; leftPaise: number }>;
  appliedPaise: number; unallocatedPaise: number; stillOpenPaise: number;
  leftover: null | { kind: 'owed_back' | 'kept' | 'written_off'; paise: number };
}
export function settlementReceipt(input: Pick<SettlementReceipt, 'inflowTransactionId' | 'mode' | 'applied' | 'leftover'> & { availablePaise: number }): SettlementReceipt {
  const appliedPaise = sumPaise(input.applied.map(r => r.amountPaise))!;
  return { inflowTransactionId: input.inflowTransactionId, mode: input.mode, applied: input.applied, appliedPaise,
    unallocatedPaise: input.availablePaise - appliedPaise - (input.leftover?.paise ?? 0), stillOpenPaise: sumPaise(input.applied.map(r => r.leftPaise))!, leftover: input.leftover };
}
/** What remains of a payment once these allocations are applied, for marking as a leftover. */
export function leftoverCheck(availablePaise: number, allocatedPaise: number): { ok: true; paise: number } | Failure {
  const paise = availablePaise - allocatedPaise;
  return paise > 0 ? { ok: true, paise } : fail('fully_allocated', 'Nothing is left over on this payment after these allocations.');
}
export function cashAmountCheck(requestedPaise: number, outstandingPaise: number): { ok: true } | Failure {
  if (!Number.isSafeInteger(requestedPaise) || requestedPaise <= 0) return fail('invalid_amount', 'Enter an amount above ₹0.00.');
  if (outstandingPaise <= 0) return fail('over_allocation', 'Nothing is open on this share.');
  if (requestedPaise > outstandingPaise) return fail('over_allocation', `${formatPaisePlain(outstandingPaise)} is still open; record ${formatPaisePlain(outstandingPaise)} or less.`);
  return { ok: true };
}
