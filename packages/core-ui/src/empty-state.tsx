import { type JSX, type ReactNode } from "react";

import { cn } from "./cn";

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center",
        className,
      )}
    >
      <p className="text-lg font-medium">{title}</p>

      {description == null ? null : (
        <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      )}

      {action == null ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}
