import { type ComponentProps, type JSX } from "react";

import { cn } from "./cn";

export type LabelProps = ComponentProps<"label">;

export function Label({ className, ...props }: LabelProps): JSX.Element {
  return (
    // oxlint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
