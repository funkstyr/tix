import { type ComponentProps, type JSX } from "react";

import { cn } from "./cn";

export type SpinnerProps = ComponentProps<"span"> & {
  label?: string;
};

export function Spinner({ className, label = "Loading", ...props }: SpinnerProps): JSX.Element {
  return (
    <span data-slot="spinner" role="status" className={cn("inline-flex items-center", className)} {...props}>
      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
