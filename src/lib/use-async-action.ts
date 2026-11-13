"use client";

import { useCallback, useState } from "react";
import { GENERIC_ACTION_ERROR, runAsyncAction } from "./client-op";

/**
 * State for a button that starts async work: `pending` is true while it runs and ALWAYS resets (even when the work
 * throws), and a throw becomes `error` for an `role="alert"` message. Ignores a second click while pending.
 *
 *   const { run, pending, error } = useAsyncAction(async () => { setState(await summarizeAction()); }, "Couldn't summarize.");
 *   <button disabled={pending} onClick={run}>…</button>
 */
export function useAsyncAction(work: () => Promise<void>, fallbackMessage: string = GENERIC_ACTION_ERROR) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (pending) return;
    await runAsyncAction(work, { setPending, setError }, fallbackMessage);
  }, [pending, work, fallbackMessage]);
  return { run, pending, error };
}
