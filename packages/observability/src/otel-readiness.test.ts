import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { Duration, Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";

import { awaitCollector, readinessTimeoutFromEnv } from "./otel-readiness.js";

// A client that fails with a transport error for the first `failures` requests, then 200s.
// `attempts` records how many probes were made so the test can assert it actually retried.
const makeFlakyClient = (failures: number, attempts: Ref.Ref<number>): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.flatMap(
      Ref.updateAndGet(attempts, (n) => n + 1),
      (n) =>
        n <= failures
          ? Effect.fail(
              new HttpClientError.RequestError({
                request,
                reason: "Transport",
                cause: new Error("ECONNREFUSED"),
              }),
            )
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 })),
            ),
    ),
  );

const alwaysFailingClient: HttpClient.HttpClient = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.RequestError({ request, reason: "Transport", cause: new Error("down") }),
  ),
);

describe("awaitCollector", () => {
  it("retries transport failures until the collector is reachable", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const counter = yield* Ref.make(0);

        yield* awaitCollector("http://collector:4318").pipe(
          Effect.provideService(HttpClient.HttpClient, makeFlakyClient(3, counter)),
        );

        return yield* Ref.get(counter);
      }),
    );

    expect(attempts).toBe(4);
  });

  it("treats a non-2xx response as reachable (any response proves the listener is up)", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const counter = yield* Ref.make(0);

        // 0 failures → first probe returns 404, which must still count as reachable.
        yield* awaitCollector("http://collector:4318").pipe(
          Effect.provideService(HttpClient.HttpClient, makeFlakyClient(0, counter)),
        );

        return yield* Ref.get(counter);
      }),
    );

    expect(attempts).toBe(1);
  });

  it("gives up after the timeout and resolves rather than wedging boot", async () => {
    const exit = await Effect.runPromiseExit(
      awaitCollector("http://collector:4318", { timeout: Duration.millis(50) }).pipe(
        Effect.provideService(HttpClient.HttpClient, alwaysFailingClient),
      ),
    );

    expect(exit._tag).toBe("Success");
  });
});

describe("readinessTimeoutFromEnv", () => {
  it("returns undefined (gate off) when unset, zero, or unparseable", () => {
    expect(readinessTimeoutFromEnv(undefined)).toBeUndefined();
    expect(readinessTimeoutFromEnv("0")).toBeUndefined();
    expect(readinessTimeoutFromEnv("-5")).toBeUndefined();
    expect(readinessTimeoutFromEnv("nope")).toBeUndefined();
  });

  it("parses a positive millisecond budget into a Duration", () => {
    expect(readinessTimeoutFromEnv("60000")).toStrictEqual(Duration.millis(60000));
  });
});
