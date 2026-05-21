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
import { ArkErrors, type Type } from "arktype";
import { pino, type Logger } from "pino";

const MSG_ID_HEADER = "Nats-Msg-Id";

const fallbackLogger: Logger = pino({ level: "warn" });

export type PublishOptions = {
  msgId?: string;
};

export type Publisher = {
  publish: (
    subject: string,
    payload: unknown,
    options?: PublishOptions,
  ) => Promise<{ ack: PubAck }>;
};

export type PublisherOptions = {
  logger?: Logger;
};

export function createPublisher(
  natsConnection: NatsConnection,
  options: PublisherOptions = {},
): Publisher {
  const js = jetstream(natsConnection);
  const log = options.logger ?? fallbackLogger;
  const encoder = new TextEncoder();

  return {
    publish: async (subject, payload, opts) => {
      const data = encoder.encode(JSON.stringify(payload));
      const pubOpts = opts?.msgId === undefined ? undefined : { msgID: opts.msgId };
      const ack = await js.publish(subject, data, pubOpts);

      log.info(
        { subject, msgId: opts?.msgId, stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate },
        "event published",
      );

      return { ack };
    },
  };
}

export type ConsumerHandlerArgs<Payload> = {
  subject: string;
  payload: Payload;
  eventId: string;
  ack: () => void;
};

export type ConsumerHandler<Payload> = (args: ConsumerHandlerArgs<Payload>) => Promise<void> | void;

export type ConsumerOptions<Payload> = {
  stream: string;
  subjectFilter: string;
  group: string;
  schema: Type<Payload>;
  handler: ConsumerHandler<Payload>;
  logger?: Logger;
  ackWaitMs?: number;
};

export type RunningConsumer = {
  stop: () => Promise<void>;
};

export async function createConsumer<Payload>(
  natsConnection: NatsConnection,
  options: ConsumerOptions<Payload>,
): Promise<RunningConsumer> {
  const { stream, subjectFilter, group, schema, handler, logger, ackWaitMs } = options;
  const log = (logger ?? fallbackLogger).child({ stream, group, subjectFilter });

  const manager = await jetstreamManager(natsConnection);
  await ensureConsumer(manager, { stream, subjectFilter, group, ackWaitMs });

  const js = jetstream(natsConnection);
  const consumer = await js.consumers.get(stream, group);
  const messages = await consumer.consume();

  const decoder = new TextDecoder();

  const loop = (async () => {
    for await (const msg of messages) {
      await processMessage(msg, { schema, handler, decoder, log });
    }
  })();

  loop.catch((err: unknown) => {
    log.error({ err }, "consumer loop terminated unexpectedly");
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

type ProcessMessageArgs<Payload> = {
  schema: Type<Payload>;
  handler: ConsumerHandler<Payload>;
  decoder: TextDecoder;
  log: Logger;
};

async function processMessage<Payload>(
  msg: JsMsg,
  { schema, handler, decoder, log }: ProcessMessageArgs<Payload>,
): Promise<void> {
  const subject = msg.subject;
  const eventId = msg.headers?.get(MSG_ID_HEADER);

  if (!eventId) {
    log.error({ subject }, `event missing ${MSG_ID_HEADER} header; terminating`);
    msg.term(`missing ${MSG_ID_HEADER} header`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(msg.data));
  } catch (err) {
    log.error({ eventId, subject, err }, "event payload is not valid JSON; terminating");
    msg.term("invalid json");
    return;
  }

  const validated = schema(parsed);
  if (validated instanceof ArkErrors) {
    log.error(
      { eventId, subject, summary: validated.summary },
      "event payload failed schema validation; terminating",
    );
    msg.term("schema validation failed");
    return;
  }

  let settled = false;
  const ack = (): void => {
    if (settled) return;
    settled = true;
    msg.ack();
  };

  try {
    // arktype distills the call result to `finalizeDistillation<Payload, ...>`; cast back to Payload.
    await handler({ subject, payload: validated as Payload, eventId, ack });
    ack();
    log.info({ eventId, subject, redelivered: msg.redelivered }, "event handled");
  } catch (err) {
    if (settled) {
      log.error(
        { eventId, subject, err, redelivered: msg.redelivered },
        "handler threw after acking; not redelivering",
      );
      return;
    }

    settled = true;
    msg.nak();
    log.error(
      { eventId, subject, err, redelivered: msg.redelivered },
      "handler threw; nak-ing for redelivery",
    );
  }
}

function isConsumerNotFound(err: unknown): boolean {
  return err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound;
}
