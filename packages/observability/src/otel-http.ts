import {
  type Context,
  context as otelContext,
  ROOT_CONTEXT,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

const propagator = new W3CTraceContextPropagator();

const setter: TextMapSetter<Record<string, string>> = {
  set: (carrier, key, value) => {
    carrier[key] = value;
  },
};

const headersGetter: TextMapGetter<Headers> = {
  keys: (carrier) => [...carrier.keys()],
  get: (carrier, key) => carrier.get(key) ?? undefined,
};

// Serialize the active span into W3C `traceparent` (+ `tracestate`) HTTP headers for an
// outbound oRPC / fetch call. Returns `{}` when no span is active — the propagator only
// writes when one is present — so a call made outside any span sends no trace headers and
// behaves exactly as before tracing existed.
//
// Defaults to the ambient OTel context, which mirrors the current Effect span thanks to
// the global context-manager bridge (see otel-context.ts). Spread into the request headers
// alongside any static headers (e.g. a service token).
export function traceparentHeaders(ctx: Context = otelContext.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, setter);

  return carrier;
}

// Reconstruct the OTel `Context` from an inbound request's `traceparent` header so a
// handler span can continue the caller's trace. Returns `ROOT_CONTEXT` when no usable
// header is present (the common case until the gateway is instrumented), which
// `externalParent` reads as "no parent" — a fresh root span.
export function extractTraceparent(headers: Headers): Context {
  return propagator.extract(ROOT_CONTEXT, headers, headersGetter);
}
