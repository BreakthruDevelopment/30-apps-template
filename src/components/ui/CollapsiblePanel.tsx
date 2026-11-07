"use client";

import { useId, useState, type ReactNode } from "react";
import { PanelHeader, slug } from "./PanelHeader";
import { buttonSecondary } from "./styles";

export function CollapsiblePanel({
  title,
  count,
  defaultOpen,
  openLabel,
  closedLabel,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen: boolean;
  openLabel: string;
  closedLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section aria-labelledby={`panel-${slug(title)}`} className="mb-6 rounded-card border border-border bg-surface p-4 sm:p-5">
      <PanelHeader
        id={`panel-${slug(title)}`}
        title={title}
        count={count}
        action={
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
            className={buttonSecondary}
          >
            {open ? openLabel : closedLabel}
            <span aria-hidden>{open ? "⌃" : "⌄"}</span>
          </button>
        }
      />
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
