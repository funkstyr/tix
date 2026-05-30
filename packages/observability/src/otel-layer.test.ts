import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeOtelLayer, otlpLayer } from "./otel-layer.js";

type OtlpLogRecord = {
  readonly traceId?: string;
  readonly spanId?: string;
};

const makeCapturingClient = (sink: Array<unknown>): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body;

      if (body._tag === "Uint8Array") {
        sink.push(JSON.parse(new TextDecoder().decode(body.body)));
      }

      return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
    }),
  );

const firstLogRecord = (sink: ReadonlyArray<unknown>): OtlpLogRecord => {
  for (const payload of sink) {
    const record = (payload as any)?.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0];

    if (record !== undefined) return record as OtlpLogRecord;
  }

  throw new Error("no OTLP log record was captured");
};

const runWith = (sink: Array<unknown>, program: Effect.Effect<void>) =>
  Effect.runPromise(
    Effect.provide(
      program,
      otlpLayer({ baseUrl: "http://collector:4318", serviceName: "test" }).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, makeCapturingClient(sink))),
      ),
    ),
  );

describe("otlpLayer", () => {
  it("attaches trace and span ids to logs emitted inside a span", async () => {
    const sink: Array<unknown> = [];

    await runWith(sink, Effect.log("hello").pipe(Effect.withSpan("unit-span")));

    const record = firstLogRecord(sink);

    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("emits a log with no trace/span ids when no span is active", async () => {
    const sink: Array<unknown> = [];

    await runWith(sink, Effect.log("hello"));

    const record = firstLogRecord(sink);

    expect(record.traceId ?? "").toBe("");
    expect(record.spanId ?? "").toBe("");
  });
});

describe("makeOtelLayer", () => {
  it("fails construction with a ConfigError when OTEL_SERVICE_NAME is unset", async () => {
    const exit = await Effect.runPromiseExit(
      Layer.build(makeOtelLayer()).pipe(
        Effect.scoped,
        Effect.asVoid,
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
