function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`synthetic: missing required env ${key}`);
  return value;
}

// The probe targets the live gateway (single ingress) and signs into pre-provisioned standing
// accounts. All values come from env (CronJob env + Secret); none are defaulted, so a
// misconfigured probe fails loudly rather than silently hitting the wrong target.
export function parseEnv() {
  return {
    gatewayUrl: required("GATEWAY_BASE_URL"),
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
