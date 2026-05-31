import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstreamManager,
  ReplayPolicy,
} from "@nats-io/jetstream";
import type { JsMsg, PubAck } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import type { Context } from "@opentelemetry/api";
import { ArkErrors, type Type } from "arktype";

import { extractTraceContext, injectTraceContext } from "./traceparent";

const MSG_ID_HEADER = "Nats-Msg-Id";

export type PublishOptions = {
  msgId?: string;
  /**
   * OTel context whose active span becomes the parent of the downstream consume.
   * Injected into NATS headers as W3C trace context; the payload is untouched.
   * Pass the context reconstructed at the outbox boundary — there is no fallback
   * to the ambient active context, which would be the relay poll, not the cause.
   */
  traceContext?: Context;
};

export type Publisher = {
  publish: (
    subject: string,
    payload: unknown,
    options?: PublishOptions,
  ) => Promise<{ ack: PubAck }>;
};

export function createPublisher(natsConnection: NatsConnection): Publisher {
  const js = jetstream(natsConnection);
  const encoder = new TextEncoder();

  return {
    publish: async (subject, payload, opts) => {
      const data = encoder.encode(JSON.stringify(payload));
      const pubOpts = {
        ...(opts?.msgId === undefined ? {} : { msgID: opts.msgId }),
        ...(opts?.traceContext === undefined
          ? {}
          : { headers: injectTraceContext(opts.traceContext) }),
      };
      const ack = await js.publish(subject, data, pubOpts);

      return { ack };
    },
  };
}

export type ConsumerHandlerArgs<Payload> = {
  subject: string;
  payload: Payload;
  eventId: string;
  /**
   * W3C trace context extracted from the message headers. Always a usable context:
   * `ROOT_CONTEXT` when the message carried none, so the handler starts a fresh trace
   * rather than continuing one.
   */
  traceContext: Context;
  ack: () => void;
};

export type ConsumerHandler<Payload> = (args: ConsumerHandlerArgs<Payload>) => Promise<void> | void;

export type ConsumerOptions<Payload> = {
  stream: string;
  subjectFilter: string;
  group: string;
  schema: Type<Payload>;
  handler: ConsumerHandler<Payload>;
  ackWaitMs?: number;
};

export type RunningConsumer = {
  stop: () => Promise<void>;
};

export async function createConsumer<Payload>(
  natsConnection: NatsConnection,
  options: ConsumerOptions<Payload>,
): Promise<RunningConsumer> {
  const { stream, subjectFilter, group, schema, handler, ackWaitMs } = options;
  // Wire-level failures here run outside Effect (the handler runs the service runtime
  // itself), so they go to `console.error` rather than the Effect Logger. This context
  // is merged into every diagnostic so the line is self-describing.
  const context = { stream, group, subjectFilter };

  const manager = await jetstreamManager(natsConnection);
  await ensureConsumer(manager, { stream, subjectFilter, group, ackWaitMs });

  const js = jetstream(natsConnection);
  const consumer = await js.consumers.get(stream, group);
  const messages = await consumer.consume();

  const decoder = new TextDecoder();

  const loop = (async () => {
    for await (const msg of messages) {
      await processMessage(msg, { schema, handler, decoder, context });
    }
  })();

  loop.catch((err: unknown) => {
    console.error("consumer loop terminated unexpectedly", { ...context, err });
  });

  return {
    stop: async () => {
      await messages.close();

      try {
        await loop;
      } catch {
        // loop errors are already logged above
      }
    },
  };
}

type EnsureConsumerArgs = {
  stream: string;
  subjectFilter: string;
  group: string;
  ackWaitMs: number | undefined;
};

async function ensureConsumer(
  manager: Awaited<ReturnType<typeof jetstreamManager>>,
  { stream, subjectFilter, group, ackWaitMs }: EnsureConsumerArgs,
): Promise<void> {
  try {
    await manager.consumers.info(stream, group);
    return;
  } catch (err) {
    if (!isConsumerNotFound(err)) throw err;
  }

  await manager.consumers.add(stream, {
    durable_name: group,
    filter_subject: subjectFilter,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    replay_policy: ReplayPolicy.Instant,
    ...(ackWaitMs === undefined ? {} : { ack_wait: ackWaitMs * 1_000_000 }),
  });
}

type ConsumerContext = { stream: string; group: string; subjectFilter: string };

type ProcessMessageArgs<Payload> = {
  schema: Type<Payload>;
  handler: ConsumerHandler<Payload>;
  decoder: TextDecoder;
  context: ConsumerContext;
};

async function processMessage<Payload>(
  msg: JsMsg,
  { schema, handler, decoder, context }: ProcessMessageArgs<Payload>,
): Promise<void> {
  const subject = msg.subject;
  const eventId = msg.headers?.get(MSG_ID_HEADER);

  if (!eventId) {
    console.error(`event missing ${MSG_ID_HEADER} header; terminating`, { ...context, subject });
    msg.term(`missing ${MSG_ID_HEADER} header`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(msg.data));
  } catch (err) {
    console.error("event payload is not valid JSON; terminating", {
      ...context,
      eventId,
      subject,
      err,
    });
    msg.term("invalid json");
    return;
  }

  const validated = schema(parsed);
  if (validated instanceof ArkErrors) {
    console.error("event payload failed schema validation; terminating", {
      ...context,
      eventId,
      subject,
      summary: validated.summary,
    });
    msg.term("schema validation failed");
    return;
  }

  let settled = false;
  const ack = (): void => {
    if (settled) return;
    settled = true;
    msg.ack();
  };

  const traceContext = extractTraceContext(msg.headers);

  try {
    // arktype distills the call result to `finalizeDistillation<Payload, ...>`; cast back to Payload.
    await handler({ subject, payload: validated as Payload, eventId, traceContext, ack });
    ack();
  } catch (err) {
    if (settled) {
      console.error("handler threw after acking; not redelivering", {
        ...context,
        eventId,
        subject,
        err,
        redelivered: msg.redelivered,
      });
      return;
    }

    settled = true;
    msg.nak();
    console.error("handler threw; nak-ing for redelivery", {
      ...context,
      eventId,
      subject,
      err,
      redelivered: msg.redelivered,
    });
  }
}

function isConsumerNotFound(err: unknown): boolean {
  return err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound;
}
