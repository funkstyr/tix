import {
  type BrowserConfig,
  type Faro,
  getWebInstrumentations,
  initializeFaro,
} from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";

// Browser RUM entry point (ADR-0013). Browser-safe: no Node-only imports, so it builds for the
// Vite bundle. Wires Grafana Faro (Web Vitals + JS errors + sessions) plus the OTel-web tracing
// instrumentation, which patches `fetch` to inject W3C `traceparent` toward the gateway origin —
// the browser→backend trace STITCH. Telemetry ships to the gateway RUM proxy (`config.url`),
// which forwards to the collector's faro receiver.

export type WebRumConfig = {
  // The gateway RUM proxy URL (e.g. `https://app.tix.test/otel/v1/faro`).
  url: string;
  appName: string;
  environment: string;
  // 0..1 — fraction of sessions sampled. Dev 1, prod a lower rate.
  sessionSampleRate: number;
  // Backend origins `traceparent` may be propagated to (the stitch). Anything else gets no header.
  propagateTraceHeaderCorsUrls: (string | RegExp)[];
};

// The Faro options object. Extracted as a pure builder so the cardinality rule and the wiring are
// unit-testable without a DOM. `initializeFaro` consumes exactly this shape.
export function buildFaroConfig(config: WebRumConfig): BrowserConfig {
  return {
    url: config.url,
    app: {
      name: config.appName,
      environment: config.environment,
    },
    sessionTracking: {
      enabled: true,
      samplingRate: config.sessionSampleRate,
    },
    instrumentations: [
      ...getWebInstrumentations(),
      new TracingInstrumentation({
        instrumentationOptions: {
          // Inject `traceparent` ONLY toward the backend origins — the trace stitch. Cross-origin
          // header propagation is opt-in by URL, so third-party fetches stay untouched.
          propagateTraceHeaderCorsUrls: config.propagateTraceHeaderCorsUrls,
        },
      }),
    ],
  };
}

export function initWebRum(config: WebRumConfig): Faro {
  return initializeFaro(buildFaroConfig(config));
}

// Set the active route as the bounded `view` label — the normalized PATTERN
// (`/tickets/$ticketId`), never the concrete path, per the cardinality rule (ADR-0013).
export function setRumRoute(faro: Faro, routePattern: string): void {
  faro.api.setView({ name: routePattern });
}

// Attach user identity as session-user METADATA, which Faro carries as a span/log attribute —
// NOT a metric label. Keeps user identity off the low-cardinality label set (ADR-0011/0013).
export function setRumUser(faro: Faro, userId: string): void {
  faro.api.setUser({ id: userId });
}
