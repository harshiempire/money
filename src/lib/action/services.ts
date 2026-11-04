import { Context } from "effect";

/** The signed-in user. Resolved from the session, never from client input. */
export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string; readonly email: string | null }
>()("money/lib/action/CurrentUser") {}

export { Db, query, transaction, type Database, type Tx } from "@/lib/ledger/services";
