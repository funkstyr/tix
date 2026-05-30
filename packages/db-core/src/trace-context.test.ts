import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { captureTraceparent, contextFromTraceparent } from "./trace-context.ts";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function contextWithSpan(): ReturnType<typeof trace.setSpanContext> {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
}

describe("captureTraceparent", () => {
  it("serializes a span-carrying context to a W3C traceparent string", () => {
    expect(captureTraceparent(contextWithSpan())).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("returns null when the context carries no span", () => {
    expect(captureTraceparent(ROOT_CONTEXT)).toBeNull();
  });
});

describe("contextFromTraceparent", () => {
  it("reconstructs a context whose span context matches the original", () => {
    const traceparent = captureTraceparent(contextWithSpan());

    const reconstructed = contextFromTraceparent(traceparent);
    const spanContext = trace.getSpanContext(reconstructed ?? ROOT_CONTEXT);

    expect(spanContext?.traceId).toBe(TRACE_ID);
    expect(spanContext?.spanId).toBe(SPAN_ID);
  });

  it("returns undefined for a null or empty traceparent", () => {
    expect(contextFromTraceparent(null)).toBeUndefined();
    expect(contextFromTraceparent(undefined)).toBeUndefined();
    expect(contextFromTraceparent("")).toBeUndefined();
  });
});
