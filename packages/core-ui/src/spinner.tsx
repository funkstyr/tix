import { type ComponentProps, type JSX } from "react";

import { cn } from "./cn";

export type SpinnerProps = ComponentProps<"output"> & {
  label?: string;
};

export function Spinner({ className, label = "Loading", ...props }: SpinnerProps): JSX.Element {
  // `output` carries an implicit ARIA `status` role — the spinner's live region —
  // without an explicit `role` attribute (jsx-a11y/prefer-tag-over-role).
  return (
    <output data-slot="spinner" className={cn("inline-flex items-center", className)} {...props}>
      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      <span className="sr-only">{label}</span>
    </output>
  );
}
