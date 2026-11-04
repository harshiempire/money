import { Effect } from "effect";
import { ForbiddenError } from "@/lib/auth/forbidden";
import { LedgerError, type LedgerErrorCode } from "@/lib/ledger/context";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "./errors";

/**
 * Bridge from the shared ledger cores (src/lib/ledger, also used by the MCP
 * server) to defineAction. The cores signal expected failures by throwing a
 * LedgerError with a stable code; ownership asserts throw ForbiddenError.
 * Anything else stays a defect (logged, generic message).
 */

export type LedgerActionError = Invalid | NotFound | Conflict | Unavailable;

/**
 * Exhaustive on purpose: a new LedgerErrorCode fails typecheck here until it
 * is mapped. The core's message is kept as the user-facing text.
 */
export function ledgerFailure(err: LedgerError): LedgerActionError {
  const message = err.message;
  const code: LedgerErrorCode = err.code;
  switch (code) {
    case "invalid_input":
    case "invalid_row":
    case "invalid_cursor":
    case "invalid_amount":
    case "invalid_category":
    case "unknown_category":
    case "unknown_person":
    case "split_gap":
    case "over_allocation":
    case "invalid_source":
    case "duplicate_person":
    case "invalid_target":
    case "no_fields":
    case "no_payee":
      return new Invalid({ message });
    case "not_found":
      return new NotFound({ message });
    case "stale":
    case "idempotency_conflict":
    case "limit_reached":
    case "already_undone":
    case "existing_split":
    case "settled_split":
    case "net_event":
    case "explained_inflow":
    case "fully_allocated":
    case "no_open_shares":
      return new Conflict({ message });
    case "migration_required":
    case "unavailable":
      return new Unavailable({ message });
    default: {
      const unmapped: never = code;
      throw new Error(`Unmapped LedgerErrorCode: ${String(unmapped)}`);
    }
  }
}

/**
 * Run a ledger core call inside a defineAction handler.
 *
 *   const result = yield* fromLedger(() => createSplitForActor(ctx, input));
 */
export const fromLedger = <A>(
  call: () => Promise<A>,
): Effect.Effect<A, Forbidden | LedgerActionError> =>
  Effect.tryPromise({ try: call, catch: (err) => err }).pipe(
    Effect.catch((err): Effect.Effect<never, Forbidden | LedgerActionError> =>
      err instanceof ForbiddenError
        ? Effect.fail(new Forbidden())
        : err instanceof LedgerError
          ? Effect.fail(ledgerFailure(err))
          : Effect.die(err),
    ),
  );

/** Map the typed Effect core directly, retaining ownership failures from legacy helpers. */
export const ledgerEffectErrors = <A, R>(effect: Effect.Effect<A, LedgerError, R>): Effect.Effect<A, Forbidden | LedgerActionError, R> =>
  effect.pipe(Effect.mapError(ledgerFailure), Effect.catchDefect(error => error instanceof ForbiddenError ? Effect.fail(new Forbidden()) : Effect.die(error)));
