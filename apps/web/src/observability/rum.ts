import type { WebRumConfig } from "@tix/observability/web-rum";

import type { WebEnv } from "../env";

// Translate parsed Vite env into a WebRumConfig, or null when RUM is not configured (no
// VITE_RUM_URL) so dev-without-collector and tests stay silent. The gateway origin is the ONLY
// traceparent-propagation target — the trace stitch reaches the backend, nothing third-party.
export function rumConfigFromEnv(env: WebEnv): WebRumConfig | null {
  if (env.VITE_RUM_URL === undefined) return null;

  return {
    url: env.VITE_RUM_URL,
    appName: env.VITE_RUM_APP_NAME ?? "tix-web",
    environment: import.meta.env.MODE,
    sessionSampleRate: env.VITE_RUM_SAMPLE_RATE ? Number(env.VITE_RUM_SAMPLE_RATE) : 1,
    propagateTraceHeaderCorsUrls: [env.VITE_GATEWAY_URL],
  };
}
