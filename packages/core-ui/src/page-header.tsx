import { type JSX, type ReactNode } from "react";

import { cn } from "./cn";

export type PageHeaderProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  description,
  action,
  className,
}: PageHeaderProps): JSX.Element {
  return (
    <div
      data-slot="page-header"
      className={cn("mb-6 flex flex-wrap items-start justify-between gap-4", className)}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>

        {description == null ? null : (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>

      {action == null ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}
