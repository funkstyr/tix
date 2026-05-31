import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { globalContextManagerLayer } from "./otel-context.js";
import { traceparentHeaders } from "./otel-http.js";
import { otlpLayer } from "./otel-layer.js";

const noopClient: HttpClient.HttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
);

const tracing = Layer.merge(
  otlpLayer({ baseUrl: "http://collector:4318", serviceName: "test" }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, noopClient)),
  ),
  globalContextManagerLayer,
);

describe("globalContextManagerLayer + bridgeOtelContext", () => {
  it("exposes the active Effect span to the global OTel context", async () => {
    // `traceparentHeaders()` reads `otelContext.active()`; it can only see the span if the
    // tracer bridges it into the global context AND a context manager makes that visible.
    const headers = await Effect.runPromise(
      Effect.sync(() => traceparentHeaders()).pipe(
        Effect.withSpan("bridge-span"),
        Effect.provide(tracing),
      ),
    );

    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("sees no active span outside of any Effect span", async () => {
    const headers = await Effect.runPromise(
      Effect.sync(() => traceparentHeaders()).pipe(Effect.provide(tracing)),
    );

    expect(headers).toEqual({});
  });
});
