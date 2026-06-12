import { type JSX, useCallback } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "./cn";

export type SelectOption = {
  value: string;
  label: string;
};

export type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  "aria-label"?: string;
  className?: string;
};

export function Select({
  value,
  onValueChange,
  options,
  className,
  "aria-label": ariaLabel,
}: SelectProps): JSX.Element {
  // base-ui can emit null (e.g. a programmatic clear); our callers only ever
  // deal in concrete string values, so drop the null case.
  const onRootValueChange = useCallback(
    (next: unknown) => {
      if (next !== null) onValueChange(next as string);
    },
    [onValueChange],
  );

  return (
    <SelectPrimitive.Root items={options} value={value} onValueChange={onRootValueChange}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        data-slot="select-trigger"
        className={cn(
          "inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon className="text-muted-foreground">▾</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner className="z-50" sideOffset={4}>
          <SelectPrimitive.Popup
            data-slot="select-popup"
            className="border-input bg-popover text-popover-foreground max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-y-auto rounded-md border p-1 shadow-md outline-none"
          >
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
