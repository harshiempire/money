import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { indiaTodayIso } from '@/lib/dates/india';
import { netSettlementDate, netSettlementReceipt } from './net-settlement';
import { validateNetEventInvariant } from '@/lib/net-events/validate';
afterEach(() => setSystemTime());
test('cash date accepts today and omission, refuses past and future across IST midnight', () => {
  setSystemTime(new Date('2026-11-04T18:29:59Z'));
  expect(indiaTodayIso()).toBe('2026-11-04');
  setSystemTime(new Date('2026-11-04T18:30:00Z'));
  const today = indiaTodayIso();
  expect(today).toBe('2026-11-05');
  for (const date of [undefined, today]) expect(netSettlementDate(true, date, today)).toEqual({ ok: true, eventDate: today });
  for (const date of ['2026-11-04', '2026-11-06']) expect(netSettlementDate(true, date, today)).toEqual({ ok: false, code: 'invalid_input', message: "Cash settlements use today's date. Set the date to today or leave it empty." });
  expect(netSettlementDate(false, '2026-10-01', today)).toEqual({ ok: true, eventDate: '2026-10-01' });
});
test('receipt reports final balance for repeated target legs and exact bank totals', () => {
  const receipt = netSettlementReceipt({ netEventId: 'event', eventDate: '2026-11-05', bankInflowPaise: 101, bankOutflowPaise: 0,
    legs: [101, 200].map((amountPaise, i) => ({ kind: 'receivable', target: { splitParticipantId: 'share' }, method: i ? 'offset' : 'bank', amountPaise, leftPaise: 0, outstandingPaise: 501 })) });
  expect(receipt.legs.map(l => l.leftPaise)).toEqual([200, 200]);
  expect(receipt.bankInflowPaise).toBe(101);
  expect(receipt.legs[0]).not.toHaveProperty('outstandingPaise');
});
test('cash is excluded from bank reconciliation, remaining offsets must reconcile exactly', () => {
  const cash = { kind: 'receivable' as const, splitParticipantId: 'share', amountPaise: 501, method: 'cash' as const };
  expect(validateNetEventInvariant([cash], 0, 0)).toEqual({ ok: true });
  expect(validateNetEventInvariant([cash], 501, 0).ok).toBe(false);
  expect(validateNetEventInvariant([{ ...cash, method: 'offset' }], 0, 0).ok).toBe(false);
  expect(validateNetEventInvariant([{ ...cash, method: 'bank' }], 501, 0)).toEqual({ ok: true });
});
