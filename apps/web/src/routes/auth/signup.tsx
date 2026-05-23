import { type ChangeEvent, type FormEvent, type JSX, useCallback, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";

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
    <section>
      <h1>Sign up</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="signup-name">Name</label>
        <input
          id="signup-name"
          type="text"
          aria-label="Name"
          required
          value={name}
          onChange={onName}
        />
        <label htmlFor="signup-email">Email</label>
        <input
          id="signup-email"
          type="email"
          aria-label="Email"
          required
          value={email}
          onChange={onEmail}
        />
        <label htmlFor="signup-password">Password</label>
        <input
          id="signup-password"
          type="password"
          aria-label="Password"
          required
          minLength={8}
          value={password}
          onChange={onPassword}
        />
        {error === null ? null : <p role="alert">{error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </section>
  );
}
