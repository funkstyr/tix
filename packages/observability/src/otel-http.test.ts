import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { traceparentHeaders } from "./otel-http.js";

const SPAN_CONTEXT = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
};

describe("traceparentHeaders", () => {
  it("serializes the span into a W3C traceparent header", () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, SPAN_CONTEXT);

    expect(traceparentHeaders(ctx)).toEqual({
      traceparent: `00-${SPAN_CONTEXT.traceId}-${SPAN_CONTEXT.spanId}-01`,
    });
  });

  it("emits no headers when no span is active", () => {
    expect(traceparentHeaders(ROOT_CONTEXT)).toEqual({});
  });
});
