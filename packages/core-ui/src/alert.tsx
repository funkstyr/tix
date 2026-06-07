import { type ComponentProps, type JSX } from "react";
import { cva } from "class-variance-authority";

import { cn } from "./cn";

const alertVariants = cva("rounded-md border px-3 py-2 text-sm", {
  variants: {
    variant: {
      destructive: "border-destructive/40 bg-destructive/10 text-destructive",
      info: "border-border bg-muted text-foreground",
    },
  },
  defaultVariants: {
    variant: "destructive",
  },
});

export type AlertVariant = "destructive" | "info";

export type AlertProps = ComponentProps<"div"> & {
  variant?: AlertVariant;
};

export function Alert({ className, variant, ...props }: AlertProps): JSX.Element {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}
