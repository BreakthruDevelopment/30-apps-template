"use client";

import { useActionState, useRef, useState } from "react";
import { DemoBadge } from "@/components/ui";
import { buttonPrimary, buttonSecondary, inputClass } from "@/components/ui/styles";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { useAsyncAction } from "@/lib/use-async-action";
import { type ActionState, type SummaryState, addItemAction, summarizeAction } from "./actions";

export function AddItemForm() {
  const formRef = useRef<HTMLFormElement>(null);
  // One op id per intent: a retry after a lost response reuses it, so the server returns the first item instead of
  // creating a second. Cleared once the server has answered; kept when the call throws (see src/lib/client-op.ts).
  const op = useRef<KeyedOp | null>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(async (prev, form) => {
    op.current = opFor(op.current, [form.get("title"), form.get("body")]);
    form.set("clientOpId", op.current.id);
    try {
      const result = await addItemAction(prev, form);
      op.current = null;
      if (result.ok) formRef.current?.reset();
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <label className="block space-y-1 text-sm font-medium">
        <span>Title</span>
        <input name="title" required maxLength={200} className={inputClass} />
      </label>
      <label className="block space-y-1 text-sm font-medium">
        <span>Details (optional)</span>
        <textarea name="body" rows={2} maxLength={5000} className={inputClass} />
      </label>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Adding…" : "Add item"}
      </button>
    </form>
  );
}

/** The AI result area: idle, pending, error and answer states, with the demo label when the answer is recorded. */
export function SummaryPanel() {
  const [state, setState] = useState<SummaryState | null>(null);
  // `pending` resets in a finally even if the action throws, and a throw becomes `error` below.
  const { run, pending, error: thrown } = useAsyncAction(async () => {
    setState(await summarizeAction());
  }, "Couldn't summarize right now. Try again.");
  const error = thrown ?? state?.error;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={run}
          className={buttonSecondary}
        >
          {pending ? "Summarizing…" : "Summarize my items"}
        </button>
        {state?.demo && !pending && <DemoBadge label="Demo answer" />}
      </div>
      <div aria-live="polite">
        {pending && <p className="text-sm text-muted">Working on it…</p>}
        {!pending && error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
        {!pending && !error && state?.summary && (
          <div className="space-y-2">
            <p>{state.summary}</p>
            {state.highlights && state.highlights.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {state.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!pending && !state && !error && (
          <p className="text-sm text-muted">Generates a short summary of your items with the app&apos;s model.</p>
        )}
      </div>
    </div>
  );
}
