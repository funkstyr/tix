import { context as otelContext, TraceFlags, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { Effect, Layer, type Tracer } from "effect";

// Bridges Effect's tracer to the global `@opentelemetry/api` context. Effect tracks the
// active span in a FiberRef, not in OTel's global context — but `@tix/db-core`
// (`captureTraceparent`) and `@tix/messaging` read `otelContext.active()` to propagate
// trace context across the outbox and NATS. This pair closes that gap:
//
//   - `bridgeOtelContext` is wired into the OTLP tracer (see `otlpLayer`); the tracer
//     invokes it around each fiber step that has a span, setting the global context to a
//     SpanContext matching the current Effect span.
//   - `globalContextManagerLayer` installs an AsyncLocalStorage-backed context manager so
//     that set context actually propagates across the `await`s inside the non-Effect
//     islands (`db.transaction(...)`, the oRPC client fetch) where the reads happen.
//
// Without a registered context manager `otelContext.with` runs synchronously but
// `otelContext.active()` always returns ROOT — so both halves are required.

// Run `f` with the global OTel context set to a SpanContext mirroring the current Effect
// span. Effect spans are always sampled, so we hard-set the sampled flag; `isRemote` is
// false because the span originates in this process.
export function bridgeOtelContext<X>(f: () => X, span: Tracer.AnySpan): X {
  const spanContext = {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };

  return otelContext.with(trace.setSpanContext(otelContext.active(), spanContext), f);
}

// Installs a global AsyncLocalStorage context manager for the runtime's lifetime, tearing
// it down on scope finalization. Idempotent: `setGlobalContextManager` returns false when
// one is already registered (e.g. a second runtime in the same test process), in which
// case we drop our manager and leave the global teardown to whoever installed it.
export const globalContextManagerLayer: Layer.Layer<never> = Layer.scopedDiscard(
  Effect.acquireRelease(
    Effect.sync(() => {
      const manager = new AsyncLocalStorageContextManager();
      manager.enable();

      const installed = otelContext.setGlobalContextManager(manager);
      if (!installed) manager.disable();

      return installed;
    }),
    (installed) => Effect.sync(() => (installed ? otelContext.disable() : undefined)),
  ),
);
