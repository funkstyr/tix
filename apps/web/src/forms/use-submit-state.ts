import { type AnyFormApi, useStore } from "@tanstack/react-form";

export type SubmitState = {
  canSubmit: boolean;
  isSubmitting: boolean;
  submitError: string | null;
};

// Fine-grained subscription for the submit area: each selector returns a
// primitive, so `useStore`'s identity check only re-renders on a real
// transition (validity flip, submit start/end, server error) — not on every
// keystroke the way a selector-less `form.Subscribe` would.
export function useSubmitState(form: AnyFormApi): SubmitState {
  const canSubmit = useStore(form.store, (state) => state.canSubmit);

  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);

  const submitError = useStore(form.store, (state) =>
    typeof state.errorMap.onSubmit === "string" ? state.errorMap.onSubmit : null,
  );

  return { canSubmit, isSubmitting, submitError };
}
