import { expect, test } from 'bun:test';
import { allocateOldestFirst, validateAllocations, inflowExplanation, appendAllowed, leftoverCheck, sameAllocations, settlementReceipt, cashAmountCheck } from './settlement-policy';
const shares = [
  { id: 'b', date: '2026-01-02', order: '1', leftPaise: 500 },
  { id: 'a', date: '2026-01-01', order: '2', leftPaise: 300 },
  { id: 'c', date: '2026-01-01', order: '1', leftPaise: 200 },
];
test('oldest first exact fit, partial last, creation order/id ties and multiple inflows', () => {
  expect(allocateOldestFirst(500, shares)).toEqual({ ok: true, allocations: [{ id: 'c', amountPaise: 200, leftPaise: 0 }, { id: 'a', amountPaise: 300, leftPaise: 0 }], remaining: 0 });
  const first = allocateOldestFirst(250, shares);
  expect(first).toMatchObject({ allocations: [{ id: 'c', amountPaise: 200 }, { id: 'a', amountPaise: 50, leftPaise: 250 }] });
  expect(allocateOldestFirst(750, shares.map(s => ({ ...s, leftPaise: s.id === 'c' ? 0 : s.id === 'a' ? 250 : 500 })))).toMatchObject({ remaining: 0 });
  expect(allocateOldestFirst(10, [{ ...shares[0], id: 'z' }, { ...shares[0], id: 'd' }])).toMatchObject({ allocations: [{ id: 'd', amountPaise: 10 }] });
  expect(allocateOldestFirst(2000, shares)).toMatchObject({ remaining: 1000 });
});
test('allocation validation combines rows, refuses over-allocation, invalid/unsafe integers and unknown shares', () => {
  expect(validateAllocations(300, shares, [{ id: 'a', amountPaise: 100 }, { id: 'a', amountPaise: 200 }])).toMatchObject({ ok: true, remaining: 0 });
  for (const amountPaise of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(validateAllocations(100, shares, [{ id: 'a', amountPaise }])).toMatchObject({ ok: false, code: 'invalid_amount' });
    if (amountPaise !== 0) expect(allocateOldestFirst(amountPaise, shares)).toMatchObject({ ok: false, code: 'invalid_amount' });
  }
  expect(validateAllocations(1000, shares, [{ id: 'a', amountPaise: 301 }])).toMatchObject({ code: 'over_allocation' });
  expect(validateAllocations(299, shares, [{ id: 'a', amountPaise: 300 }])).toMatchObject({ code: 'over_allocation' });
  expect(validateAllocations(100, shares, [{ id: 'foreign', amountPaise: 1 }])).toMatchObject({ code: 'not_found' });
});
const input = { inflowAmountPaise: 1000, allocations: [], netReservedPaise: 0, owedSourced: false, residualDisposition: null, residualAcknowledgedPaise: null };
test('one explanation accounts for plain, net, owed and leftover, with every append refusal', () => {
  expect(inflowExplanation(input)).toMatchObject({ allocatedPaise: 0, availablePaise: 1000, status: 'unexplained' });
  expect(appendAllowed(inflowExplanation(input))).toEqual({ ok: true });
  expect(inflowExplanation({ ...input, allocations: [{ amountPaise: 100 }], netReservedPaise: 200, residualDisposition: 'kept', residualAcknowledgedPaise: 300 })).toMatchObject({ availablePaise: 400, status: 'partial', allocatedPaise: 100, netReservedPaise: 200, residualAcknowledgedPaise: 300 });
  for (const netReservedPaise of [1, 1000]) expect(appendAllowed(inflowExplanation({ ...input, netReservedPaise }))).toEqual({ ok: false, code: 'net_event', message: 'This inflow is part of a net event; undo that event first.' });
  expect(appendAllowed(inflowExplanation({ ...input, hasNetEvent: true }))).toMatchObject({ code: 'net_event' });
  expect(appendAllowed(inflowExplanation({ ...input, owedSourced: true }))).toEqual({ ok: false, code: 'explained_inflow', message: 'This inflow already has an owed-expense explanation. Clear it first.' });
  expect(appendAllowed(inflowExplanation({ ...input, residualDisposition: 'kept', residualAcknowledgedPaise: 20 }))).toEqual({ ok: false, code: 'explained_inflow', message: "This inflow's leftover is already acknowledged. Clear its settlement first." });
  expect(appendAllowed(inflowExplanation({ ...input, allocations: [{ amountPaise: 1000 }] }))).toEqual({ ok: false, code: 'fully_allocated', message: 'This inflow is already fully allocated.' });
});
test('guard compares exact order-independent multisets', () => {
  const a = { splitParticipantId: 'a', amountPaise: 100 }, b = { splitParticipantId: 'b', amountPaise: 200 };
  expect(sameAllocations([a,b,a], [a,a,b])).toBe(true);
  expect(sameAllocations([a,a], [{ ...a, amountPaise: 200 }])).toBe(false);
  expect(sameAllocations([a], [b])).toBe(false);
});
test('receipt uses integer math and only touched open shares', () => {
  expect(settlementReceipt({ inflowTransactionId: 'inflow', mode: 'append', availablePaise: 1000, applied: [{ splitParticipantId: 'a', personName: 'Kiran', amountPaise: 301, leftPaise: 199 }], leftover: { kind: 'kept', paise: 699 } })).toEqual({ inflowTransactionId: 'inflow', mode: 'append', applied: [{ splitParticipantId: 'a', personName: 'Kiran', amountPaise: 301, leftPaise: 199 }], appliedPaise: 301, unallocatedPaise: 0, stillOpenPaise: 199, leftover: { kind: 'kept', paise: 699 } });
});
test('a leftover is what remains after allocations, and must be more than nothing', () => {
  expect(leftoverCheck(1000, 301)).toEqual({ ok: true, paise: 699 });
  const nothing = { ok: false, code: 'fully_allocated', message: 'Nothing is left over on this payment after these allocations.' };
  expect(leftoverCheck(1000, 1000)).toEqual(nothing);
  expect(leftoverCheck(0, 0)).toEqual(nothing);
});
test('cash never caps or rounds and keeps exact refusal messages', () => {
  for (const n of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(cashAmountCheck(n, 100)).toEqual({ ok: false, code: 'invalid_amount', message: 'Enter an amount above ₹0.00.' });
  expect(cashAmountCheck(1, 0)).toEqual({ ok: false, code: 'over_allocation', message: 'Nothing is open on this share.' });
  expect(cashAmountCheck(101, 100)).toEqual({ ok: false, code: 'over_allocation', message: '₹1.00 is still open; record ₹1.00 or less.' });
  expect(cashAmountCheck(100, 100)).toEqual({ ok: true });
});
