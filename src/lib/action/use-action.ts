"use client";

import { useCallback, useState, useTransition } from "react";
import {
  GENERIC_ERROR_MESSAGE,
  type ActionFailure,
  type ActionResult,
} from "./result";

/**
 * Calls a `defineAction` server action inside a transition and keeps the
 * last failure around for display.
 *
 *   const save = useAction(createSplit);
 *   const result = await save.run(input);
 *   if (result.ok) close();
 *   ...
 *   {save.error && <p role="alert">{save.error.message}</p>}
 *
 * A network failure or a throw that escaped the server (shouldn't happen
 * with defineAction) becomes an INTERNAL failure instead of an exception.
 */
export function useAction<I, A>(action: (input: I) => Promise<ActionResult<A>>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionFailure | null>(null);

  const run = useCallback(
    (input: I) =>
      new Promise<ActionResult<A>>((resolve) => {
        setError(null);
        startTransition(async () => {
          let result: ActionResult<A>;
          try {
            result = await action(input);
          } catch (err) {
            console.error("[useAction]", err);
            result = { ok: false, code: "INTERNAL", message: GENERIC_ERROR_MESSAGE };
          }
          if (!result.ok) setError(result);
          resolve(result);
        });
      }),
    [action],
  );

  const clearError = useCallback(() => setError(null), []);

  return { run, pending, error, clearError };
}
