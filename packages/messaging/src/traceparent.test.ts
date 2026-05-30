import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { extractTraceContext, injectTraceContext } from "./traceparent.ts";

const sampleSpanContext: SpanContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
};

function contextFrom(spanContext: SpanContext) {
  return trace.setSpanContext(ROOT_CONTEXT, spanContext);
}

describe("@tix/messaging/traceparent", () => {
  it("round-trips a span context through W3C headers", () => {
    const headers = injectTraceContext(contextFrom(sampleSpanContext));

    const extracted = trace.getSpanContext(extractTraceContext(headers));

    expect(extracted?.traceId).toBe(sampleSpanContext.traceId);
    expect(extracted?.spanId).toBe(sampleSpanContext.spanId);
    expect(extracted?.traceFlags).toBe(TraceFlags.SAMPLED);
  });

  it("writes the W3C traceparent header on inject", () => {
    const headers = injectTraceContext(contextFrom(sampleSpanContext));

    expect(headers.has("traceparent")).toBe(true);
    expect(headers.get("traceparent")).toContain(sampleSpanContext.traceId);
  });

  it("writes no traceparent header when the context carries no span", () => {
    const headers = injectTraceContext(ROOT_CONTEXT);

    expect(headers.has("traceparent")).toBe(false);
  });

  it("extracts a span-less root context from undefined headers", () => {
    const extracted = extractTraceContext(undefined);

    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });

  it("extracts a span-less root context from headers without trace context", () => {
    const headers = injectTraceContext(ROOT_CONTEXT);

    expect(trace.getSpanContext(extractTraceContext(headers))).toBeUndefined();
  });
});
