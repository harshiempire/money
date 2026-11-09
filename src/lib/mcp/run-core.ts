import 'server-only';
import type { Effect } from 'effect';
import { runLedger } from '@/lib/ledger/run';
import type { Actor, Db } from '@/lib/ledger/services';
import type { LedgerError } from '@/lib/ledger/context';
import type { McpPrincipal } from './auth';

export function ledgerToolError(error: LedgerError) {
  return { code: error.code, message: error.message,
    ...(error.current_rev ? { current_rev: error.current_rev } : {}),
    ...(error.current_split_rev ? { current_split_rev: error.current_split_rev } : {}) };
}
/** The MCP Effect boundary. The error type is `never`, so a tool must turn every refusal into its own response first. */
export function runCore<A>(effect: Effect.Effect<A, never, Db | Actor>, principal: McpPrincipal): Promise<A> {
  return runLedger(effect, principal.actor);
}
