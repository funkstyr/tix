import { type FormEvent, type JSX, useCallback } from "react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { type } from "arktype";

import { Alert } from "@tix/core-ui/alert";
import { Button } from "@tix/core-ui/button";

import { AuthCard } from "../../auth/auth-card";
import { useAuth } from "../../auth/use-auth";
import { FormTextField } from "../../forms/form-text-field";
import { useSubmitState } from "../../forms/use-submit-state";

const signUpSchema = type({
  name: "string >= 1",
  email: "string.email",
  password: "string >= 8",
});

export const Route = createFileRoute("/auth/signup")({
  component: SignUpPage,
});

function SignUpPage(): JSX.Element {
  const auth = useAuth();
  const router = useRouter();
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    validators: {
      onChange: signUpSchema,
      onSubmitAsync: async ({ value }) => {
        const result = await auth.signUp(value);
        if (result.error !== null) return result.error;

        await router.invalidate();
        await navigate({ to: "/" });
        return undefined;
      },
    },
  });

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void form.handleSubmit();
    },
    [form],
  );

  const { canSubmit, isSubmitting, submitError } = useSubmitState(form);

  return (
    <AuthCard title="Sign up">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <form.Field name="name">
          {(field) => <FormTextField field={field} id="signup-name" label="Name" type="text" />}
        </form.Field>

        <form.Field name="email">
          {(field) => <FormTextField field={field} id="signup-email" label="Email" type="email" />}
        </form.Field>

        <form.Field name="password">
          {(field) => (
            <FormTextField
              field={field}
              id="signup-password"
              label="Password"
              type="password"
              hint="At least 8 characters"
            />
          )}
        </form.Field>

        {submitError == null ? null : <Alert>{submitError}</Alert>}

        <Button type="submit" disabled={!canSubmit || isSubmitting}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
