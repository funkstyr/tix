import { type JSX, useEffect, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";

import { useAuth } from "../../auth/use-auth";

export const Route = createFileRoute("/auth/signout")({
  component: SignOutPage,
});

function SignOutPage(): JSX.Element {
  const auth = useAuth();
  const router = useRouter();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const result = await auth.signOut();
      if (cancelled) return;
      if (result.error !== null) {
        setError(result.error);
        return;
      }

      await router.invalidate();
      await navigate({ to: "/" });
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [auth, router, navigate]);

  return (
    <section>
      <h1>Signing out…</h1>
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}
