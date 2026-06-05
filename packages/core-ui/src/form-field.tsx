import { type ComponentProps, type JSX, useId } from "react";

import { cn } from "./cn";
import { Input } from "./input";
import { Label } from "./label";

export type FormFieldProps = ComponentProps<"input"> & {
  label: string;
  error?: string | null;
  hint?: string;
};

export function FormField({ label, error, hint, id, ...props }: FormFieldProps): JSX.Element {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;

  const describedBy = cn(error == null ? null : errorId, hint == null ? null : hintId) || undefined;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={fieldId}>{label}</Label>

      <Input
        id={fieldId}
        aria-invalid={error == null ? undefined : true}
        aria-describedby={describedBy}
        {...props}
      />

      {hint == null ? null : (
        <p id={hintId} className="text-muted-foreground text-sm">
          {hint}
        </p>
      )}

      {error == null ? null : (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
