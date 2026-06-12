import { type ChangeEvent, type JSX, useCallback } from "react";
import { type AnyFieldApi } from "@tanstack/react-form";

import { cn } from "@tix/core-ui/cn";
import { Field, FieldDescription, FieldError, FieldLabel } from "@tix/core-ui/field";
import { Input, type InputProps } from "@tix/core-ui/input";

// Adapts a TanStack Form field to the core-ui Field primitives: binds
// value/onChange/onBlur, shows validation errors once the field is touched, and
// keeps the label/description/error wired to the input via aria. The onChange
// wrapper is memoized so the input doesn't trip the react-perf "no new function
// as prop" rule.
type FormTextFieldProps = Omit<InputProps, "value" | "onChange" | "onBlur" | "id"> & {
  field: AnyFieldApi;
  label: string;
  hint?: string;
  id?: string;
};

export function FormTextField({
  field,
  label,
  hint,
  id,
  ...props
}: FormTextFieldProps): JSX.Element {
  const fieldId = id ?? field.name;
  const hintId = `${fieldId}-description`;
  const errorId = `${fieldId}-error`;

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => field.handleChange(event.target.value),
    [field],
  );

  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const describedBy = cn(hint == null ? null : hintId, isInvalid ? errorId : null) || undefined;

  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>

      <Input
        {...props}
        id={fieldId}
        value={field.state.value}
        onChange={onChange}
        onBlur={field.handleBlur}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
      />

      {hint == null ? null : <FieldDescription id={hintId}>{hint}</FieldDescription>}

      {isInvalid ? <FieldError id={errorId} errors={field.state.meta.errors} /> : null}
    </Field>
  );
}
