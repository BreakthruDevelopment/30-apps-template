import type { ReactNode } from "react";

/** Eyebrow ("BREAKTHRU VENTURES / SECTION"), display headline, one-line description, optional actions. */
export function PageIntro({
  section,
  title,
  description,
  actions,
}: {
  section: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <section className="mb-8 space-y-3">
      <p className="text-sm font-semibold uppercase tracking-wide text-accent">Breakthru Ventures / {section}</p>
      <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight wrap-anywhere sm:text-5xl">
        {title}
      </h1>
      {description && <p className="max-w-2xl wrap-anywhere text-lg text-muted">{description}</p>}
      {actions && <div className="flex flex-wrap gap-3 pt-2">{actions}</div>}
    </section>
  );
}
