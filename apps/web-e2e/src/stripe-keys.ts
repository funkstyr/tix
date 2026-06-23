// Stripe's public docs sample publishable key. Works against the test mode of
// any Stripe account when paired with a real test secret, and is harmless for
// the Seller flow (which never tokenizes a card).
const SAMPLE_PUBLISHABLE_KEY = "pk_test_TYooMQauvdEDq54NiTphI7jx";

// Resolve the Stripe publishable key the browser will use. CI sets
// `STRIPE_TEST_PUBLISHABLE_KEY` from a repo secret that may be UNSET — GitHub
// then injects it into the job env as an EMPTY STRING, not `undefined`. A bare
// `?? SAMPLE` only catches `undefined`, so an empty value would flow through and
// get baked into `VITE_STRIPE_PK`; the web app's `parseEnv` requires that var to
// be non-empty and throws at module load, so React never mounts and every spec
// times out waiting for a form that never renders. Treat empty the same as
// absent (mirroring the secret-key handling in `harness.ts`) and fall back.
export function resolveStripePublishableKey(raw: string | undefined): string {
  return raw === undefined || raw.length === 0 ? SAMPLE_PUBLISHABLE_KEY : raw;
}
