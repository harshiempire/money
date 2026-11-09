import type { NetEventLeg } from '@/lib/net-events/legs';
import { outstandingPaise } from './balances';

export function netSettlementDate(hasCash: boolean, requested: string | undefined, today: string) {
  if (hasCash && requested && requested !== today) return { ok: false as const, code: 'invalid_input' as const, message: "Cash settlements use today's date. Set the date to today or leave it empty." };
  return { ok: true as const, eventDate: requested || today };
}
export interface NetSettlementReceipt {
  netEventId: string; eventDate: string;
  legs: Array<{ kind: 'receivable' | 'payable'; target: { splitParticipantId: string } | { owedExpenseId: string }; method: NetEventLeg['method']; amountPaise: number; leftPaise: number }>;
  bankInflowPaise: number; bankOutflowPaise: number;
}
/** Every leg reports the final target balance, including other legs on that target. */
export function netSettlementReceipt(input: Omit<NetSettlementReceipt, 'legs'> & { legs: Array<NetSettlementReceipt['legs'][number] & { outstandingPaise: number }> }): NetSettlementReceipt {
  const key = (r: NetSettlementReceipt['legs'][number]) => 'splitParticipantId' in r.target ? `share:${r.target.splitParticipantId}` : `owed:${r.target.owedExpenseId}`;
  return { ...input, legs: input.legs.map(({ outstandingPaise: cap, ...leg }) => ({ ...leg, leftPaise: outstandingPaise(cap, input.legs.filter(r => key(r) === key(leg))) ?? 0 })) };
}
