import { type ChangeEvent, type FormEvent, type JSX, useCallback, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { type } from "arktype";

import { useAuth } from "../../auth/use-auth";

const searchSchema = type({
  "redirect?": "string",
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

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

      const result = await auth.signIn({ email, password });
      if (result.error !== null) {
        setError(result.error);
        setPending(false);
        return;
      }

      await router.invalidate();
      await navigate({ to: redirect ?? "/" });
    },
    [auth, email, password, navigate, redirect, router],
  );

  return (
    <section>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="signin-email">Email</label>
        <input
          id="signin-email"
          type="email"
          aria-label="Email"
          required
          value={email}
          onChange={onEmail}
        />
        <label htmlFor="signin-password">Password</label>
        <input
          id="signin-password"
          type="password"
          aria-label="Password"
          required
          value={password}
          onChange={onPassword}
        />
        {error === null ? null : <p role="alert">{error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </section>
  );
}
