import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { externalParent } from "./otel-trace.js";

const SPAN_CONTEXT = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
};

describe("externalParent", () => {
  it("builds an external span carrying the upstream trace and span ids", () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, SPAN_CONTEXT);

    const parent = externalParent(ctx);

    expect(parent).toEqual({
      _tag: "ExternalSpan",
      traceId: SPAN_CONTEXT.traceId,
      spanId: SPAN_CONTEXT.spanId,
      sampled: true,
      context: expect.anything(),
    });
  });

  it("marks the external span unsampled when the upstream is not sampled", () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      ...SPAN_CONTEXT,
      traceFlags: TraceFlags.NONE,
    });

    expect(externalParent(ctx)?.sampled).toBe(false);
  });

  it("returns undefined when the context carries no span", () => {
    expect(externalParent(ROOT_CONTEXT)).toBeUndefined();
  });
});
