/**
 * Two small client-side patterns, framework-free so they can be tested. The React hook is in `use-async-action.ts`.
 *
 * 1. Idempotent mutations. A request can succeed on the server and the response can still be lost (flaky network, a
 *    double tap, a retry after a timeout). If the client mints a fresh id per click, the retry creates a second row.
 *    Instead: keep ONE op id in a `useRef` per user intent, send it with every attempt, and clear it only once the
 *    server has answered (ok, or a conflict/validation answer). A thrown network error keeps it, so the retry reuses
 *    it and the server (unique index on the op id; see `createItem`) returns the first result. If the user changes
 *    what they are sending, `opFor` mints a new id, because the intent changed.
 *
 *      const op = useRef<KeyedOp | null>(null);
 *      op.current = opFor(op.current, payload);
 *      try { const res = await save({ ...payload, clientOpId: op.current.id }); op.current = null; ... }
 *      catch { show an error and leave op.current alone }
 *
 * 2. Async buttons. `runAsyncAction` sets pending, clears the old error, runs the work, turns any throw into a
 *    fixed, user-safe message, and ALWAYS resets pending in `finally`, so a thrown action can't leave the button
 *    disabled forever or the error unseen.
 */
export type KeyedOp = { key: string; id: string };

/** Reuse the previous op while the payload is unchanged; otherwise start a new one. */
export function opFor(previous: KeyedOp | null, payload: unknown, newId: () => string = () => crypto.randomUUID()): KeyedOp {
  const key = JSON.stringify(payload);
  return previous && previous.key === key ? previous : { key, id: newId() };
}

export const GENERIC_ACTION_ERROR = "Something went wrong. Please try again.";

export async function runAsyncAction(
  work: () => Promise<void>,
  ui: { setPending: (pending: boolean) => void; setError: (message: string | null) => void },
  fallbackMessage: string = GENERIC_ACTION_ERROR,
): Promise<void> {
  ui.setPending(true);
  ui.setError(null);
  try {
    await work();
  } catch {
    // Never show err.message: it can carry server internals. Callers that know the cause set their own error inside `work`.
    ui.setError(fallbackMessage);
  } finally {
    ui.setPending(false);
  }
}
