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

const searchSchema = type({
  "redirect?": "string",
});

const signInSchema = type({
  email: "string.email",
  password: "string >= 1",
});

export const Route = createFileRoute("/auth/signin")({
  validateSearch: searchSchema,
  component: SignInPage,
});

function SignInPage(): JSX.Element {
  const auth = useAuth();
  const router = useRouter();
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();

  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: {
      onChange: signInSchema,
      onSubmitAsync: async ({ value }) => {
        const result = await auth.signIn(value);
        if (result.error !== null) return result.error;

        await router.invalidate();
        await navigate({ to: redirect ?? "/" });
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
    <AuthCard title="Sign in">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <form.Field name="email">
          {(field) => <FormTextField field={field} id="signin-email" label="Email" type="email" />}
        </form.Field>

        <form.Field name="password">
          {(field) => (
            <FormTextField field={field} id="signin-password" label="Password" type="password" />
          )}
        </form.Field>

        {submitError == null ? null : <Alert>{submitError}</Alert>}

        <Button type="submit" disabled={!canSubmit || isSubmitting}>
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthCard>
  );
}
