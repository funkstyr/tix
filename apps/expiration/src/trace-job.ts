import { type Context, ROOT_CONTEXT } from "@opentelemetry/api";

import { extractTraceparent, traceparentHeaders } from "@tix/observability/otel-http";

const TRACEPARENT = "traceparent";

// Serialize the active span to a W3C `traceparent` string for storage on the
// BullMQ job. A delayed job is decoupled from the `order.created.v1` consume that
// scheduled it — the worker fires it minutes later — so the carrier rides in the
// job data rather than an ambient context, exactly as trace context rides on the
// outbox row across the relay (ADR-0009). Returns `undefined` when no span is
// active (an uninstrumented producer), so the field is simply omitted.
export function captureJobTraceparent(): string | undefined {
  return traceparentHeaders()[TRACEPARENT];
}

// Reconstruct the OTel `Context` from a job's stored `traceparent` so the worker's
// expiry span continues the originating order's trace as a child. Returns
// `ROOT_CONTEXT` when the job carries none, which `externalParent` reads as
// "no parent" — a fresh root span.
export function jobTraceContext(traceparent: string | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;

  return extractTraceparent(new Headers({ [TRACEPARENT]: traceparent }));
}
