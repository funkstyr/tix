import {
  type Context,
  context as otelContext,
  ROOT_CONTEXT,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

const TRACEPARENT = "traceparent";

const propagator = new W3CTraceContextPropagator();

const carrierSetter: TextMapSetter<Record<string, string>> = {
  set: (carrier, key, value) => {
    carrier[key] = value;
  },
};

const carrierGetter: TextMapGetter<Record<string, string>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key],
};

/**
 * Serialize the active span of `ctx` to a W3C `traceparent` string for storage
 * on an outbox row. Returns `null` when `ctx` carries no valid span — the
 * propagator only injects when one is present — so the column stays null and
 * the relay publishes the row exactly as it did before tracing existed.
 *
 * Defaults to the ambient active context: at enqueue time that is the business
 * operation that produced the event, which is the causally meaningful moment.
 */
export function captureTraceparent(ctx: Context = otelContext.active()): string | null {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, carrierSetter);
  return carrier[TRACEPARENT] ?? null;
}

/**
 * Reconstruct an OTel `Context` from a stored `traceparent` string. Returns
 * `undefined` when there is nothing to reconstruct, so callers can omit the
 * trace context entirely rather than forward an empty one.
 */
export function contextFromTraceparent(
  traceparent: string | null | undefined,
): Context | undefined {
  if (!traceparent) return undefined;
  return propagator.extract(ROOT_CONTEXT, { [TRACEPARENT]: traceparent }, carrierGetter);
}
