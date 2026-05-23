import { loadStripe, type Stripe } from "@stripe/stripe-js";

import { parseEnv } from "../env";

const env = parseEnv(import.meta.env);

// loadStripe caches by publishable key; calling at module load means the
// Stripe SDK is fetched once when the checkout module is first imported,
// not on every checkout render.
export const stripePromise: Promise<Stripe | null> = loadStripe(env.VITE_STRIPE_PK);
