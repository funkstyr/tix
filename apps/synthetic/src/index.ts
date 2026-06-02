import { Clock, Effect, Layer } from "effect";

import { makeSagaClients } from "@tix/saga-client/clients";
import { runBuyerJourney } from "@tix/saga-client/journey";
import { makeServiceRuntime } from "@tix/service-runtime/runtime";

import { parseEnv } from "./config.ts";
import { recordJourney } from "./metrics.ts";

const env = parseEnv();

// All routers sit behind the one gateway URL in a live deployment, so every client shares it.
const clients = makeSagaClients({
  authBaseUrl: env.gatewayUrl,
  ticketsBaseUrl: env.gatewayUrl,
  ordersBaseUrl: env.gatewayUrl,
  paymentsBaseUrl: env.gatewayUrl,
});

// No app layer — the probe only needs the observability layer so its metrics/spans export.
const runtime = makeServiceRuntime({
  serviceName: "synthetic",
  otelEndpoint: env.otelEndpoint,
  appLayer: Layer.empty,
});

const program = Effect.gen(function* () {
  const startMs = yield* Clock.currentTimeMillis;
  const result = yield* Effect.promise(() =>
    runBuyerJourney({
      clients,
      seller: env.seller,
      buyer: env.buyer,
      paymentMethodId: env.paymentMethodId,
    }),
  );
  const endMs = yield* Clock.currentTimeMillis;

  yield* recordJourney(result.ok, endMs - startMs);

  if (result.ok) {
    yield* Effect.logInfo("synthetic journey ok").pipe(Effect.annotateLogs({ ...result.steps }));
  } else {
    yield* Effect.logError("synthetic journey failed").pipe(
      Effect.annotateLogs({ ...result.steps, error: result.error ?? "unknown" }),
    );
  }

  return result.ok;
});

// One shot: run the journey, dispose the runtime (flushes OTLP exporters), exit non-zero on
// failure so the CronJob surfaces a bad run.
runtime
  .runPromise(program)
  .then((ok) => runtime.dispose().then(() => process.exit(ok ? 0 : 1)))
  .catch((err: unknown) => {
    console.error("synthetic probe crashed", { err });
    void runtime.dispose().finally(() => process.exit(1));
  });
