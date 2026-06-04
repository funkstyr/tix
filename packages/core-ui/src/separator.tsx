import { type ComponentProps, type JSX } from "react";
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "./cn";

export type SeparatorProps = ComponentProps<typeof SeparatorPrimitive>;

export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorProps): JSX.Element {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}
