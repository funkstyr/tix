import { headers as natsHeaders, type MsgHdrs } from "@nats-io/transport-node";
import {
  type Context,
  ROOT_CONTEXT,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

const propagator = new W3CTraceContextPropagator();

const setter: TextMapSetter<MsgHdrs> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

const getter: TextMapGetter<MsgHdrs> = {
  keys: (carrier) => carrier.keys(),
  get: (carrier, key) => (carrier.has(key) ? carrier.get(key) : undefined),
};

/** Inject the active span of `context` into a fresh `MsgHdrs` as W3C trace headers. */
export function injectTraceContext(context: Context): MsgHdrs {
  const carrier = natsHeaders();
  propagator.inject(context, carrier, setter);
  return carrier;
}

/** Extract W3C trace context from NATS headers; returns ROOT_CONTEXT when none is present. */
export function extractTraceContext(carrier: MsgHdrs | undefined): Context {
  if (!carrier) return ROOT_CONTEXT;
  return propagator.extract(ROOT_CONTEXT, carrier, getter);
}
