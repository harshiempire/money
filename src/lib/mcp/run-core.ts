import 'server-only';
import type { Effect } from 'effect';
import { runLedger } from '@/lib/ledger/run';
import type { Actor, Db } from '@/lib/ledger/services';
import { LedgerError } from '@/lib/ledger/context';
import type { McpPrincipal } from './auth';

export function ledgerToolError(error: LedgerError) {
  return { code: error.code, message: error.message,
    ...(error.current_rev ? { current_rev: error.current_rev } : {}),
    ...(error.current_split_rev ? { current_split_rev: error.current_split_rev } : {}) };
}
export class CoreFailure extends Error {
  constructor(readonly error: ReturnType<typeof ledgerToolError>) { super(error.message); }
}
/** The MCP Effect boundary maps typed failures to the existing tool error shape. */
export async function runCore<A>(effect: Effect.Effect<A, LedgerError, Db | Actor>, principal: McpPrincipal): Promise<A> {
  try {
    return await runLedger(effect, principal.actor);
  } catch (error) {
    if (error instanceof LedgerError) throw new CoreFailure(ledgerToolError(error));
    throw error;
  }
}
