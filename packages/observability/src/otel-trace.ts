import { type Context as OtelContext, TraceFlags, trace } from "@opentelemetry/api";
import { Tracer } from "effect";

// Turn an incoming OTel `Context` (extracted from HTTP headers or NATS message headers)
// into an Effect `ExternalSpan` suitable for `Effect.withSpan(name, { parent })`, so the
// span the handler opens continues the upstream trace as a child.
//
// Returns `undefined` when the context carries no span (e.g. an uninstrumented caller, or
// a message published before tracing existed) — passing that straight through to the
// `parent` option means "no explicit parent", i.e. a fresh root span.
export function externalParent(parent: OtelContext): Tracer.ExternalSpan | undefined {
  const spanContext = trace.getSpanContext(parent);
  if (spanContext === undefined) return undefined;

  return Tracer.externalSpan({
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    sampled: (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0,
  });
}
