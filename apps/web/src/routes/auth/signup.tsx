import { type ChangeEvent, type FormEvent, type JSX, useCallback, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";

import { Alert } from "@tix/core-ui/alert";
import { Button } from "@tix/core-ui/button";
import { FormField } from "@tix/core-ui/form-field";

import { AuthCard } from "../../auth/auth-card";
import { useAuth } from "../../auth/use-auth";

export const Route = createFileRoute("/auth/signup")({
  component: SignUpPage,
});

function SignUpPage(): JSX.Element {
  const auth = useAuth();
  const router = useRouter();
  const navigate = useNavigate();

  const [name, setName] = useState("");

  const [email, setEmail] = useState("");

  const [password, setPassword] = useState("");

  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState(false);

  const onName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setName(event.target.value);
  }, []);

  const onEmail = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  }, []);

  const onPassword = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  }, []);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPending(true);
      setError(null);

      const result = await auth.signUp({ name, email, password });
      if (result.error !== null) {
        setError(result.error);
        setPending(false);
        return;
      }

      await router.invalidate();
      await navigate({ to: "/" });
    },
    [auth, name, email, password, navigate, router],
  );

  return (
    <AuthCard title="Sign up">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FormField id="signup-name" label="Name" type="text" required value={name} onChange={onName} />

        <FormField id="signup-email" label="Email" type="email" required value={email} onChange={onEmail} />

        <FormField
          id="signup-password"
          label="Password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={onPassword}
        />

        {error === null ? null : <Alert>{error}</Alert>}

        <Button type="submit" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
