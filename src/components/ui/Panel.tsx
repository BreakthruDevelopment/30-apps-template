import type { ReactNode } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { PanelHeader, slug } from "./PanelHeader";

/** A titled white panel. `collapsible` swaps in the small client component that adds the toggle. */
export function Panel({
  title,
  count,
  action,
  collapsible = false,
  defaultOpen = true,
  openLabel = "Hide",
  closedLabel = "Show all",
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  openLabel?: string;
  closedLabel?: string;
  children: ReactNode;
}) {
  if (collapsible) {
    return (
      <CollapsiblePanel
        title={title}
        count={count}
        defaultOpen={defaultOpen}
        openLabel={openLabel}
        closedLabel={closedLabel}
      >
        {children}
      </CollapsiblePanel>
    );
  }
  return (
    <section aria-labelledby={`panel-${slug(title)}`} className="mb-6 rounded-card border border-border bg-surface p-4 sm:p-5">
      <PanelHeader id={`panel-${slug(title)}`} title={title} count={count} action={action} />
      {children}
    </section>
  );
}
