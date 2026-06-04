function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`synthetic: missing required env ${key}`);
  return value;
}

// The probe drives each service directly on its in-cluster URL (the same wiring api-e2e uses for
// the shared saga-client), not through the gateway: the gateway's oRPC router nests procedures
// under tickets/orders/payments and carries no auth at all, so the flat per-router clients only
// resolve against the services themselves. Gateway/edge liveness is covered by the blackbox probes.
// All values come from env (CronJob env + Secret); none are defaulted, so a misconfigured probe
// fails loudly rather than silently hitting the wrong target.
export function parseEnv() {
  return {
    authBaseUrl: required("AUTH_BASE_URL"),
    ticketsBaseUrl: required("TICKETS_BASE_URL"),
    ordersBaseUrl: required("ORDERS_BASE_URL"),
    paymentsBaseUrl: required("PAYMENTS_BASE_URL"),
    otelEndpoint: required("OTEL_EXPORTER_OTLP_ENDPOINT"),
    seller: {
      email: required("SYNTHETIC_SELLER_EMAIL"),
      password: required("SYNTHETIC_SELLER_PASSWORD"),
    },
    buyer: {
      email: required("SYNTHETIC_BUYER_EMAIL"),
      password: required("SYNTHETIC_BUYER_PASSWORD"),
    },
    paymentMethodId: required("SYNTHETIC_PAYMENT_METHOD_ID"),
  };
}

// The seed step provisions the probe's standing accounts; it only needs the auth service and the
// same credential pair the probe later signs in with (shares the SYNTHETIC_* Secret), so it parses
// a narrower env than parseEnv() — the seed Job isn't given the other services' URLs.
export function parseSeedEnv() {
  return {
    authBaseUrl: required("AUTH_BASE_URL"),
    seller: {
      email: required("SYNTHETIC_SELLER_EMAIL"),
      password: required("SYNTHETIC_SELLER_PASSWORD"),
    },
    buyer: {
      email: required("SYNTHETIC_BUYER_EMAIL"),
      password: required("SYNTHETIC_BUYER_PASSWORD"),
    },
  };
}
