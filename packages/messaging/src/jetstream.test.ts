import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { ROOT_CONTEXT, type SpanContext, trace, TraceFlags } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ticketCreatedV1 } from "@tix/contracts/tickets";

import { createConsumer, createPublisher, type Publisher } from "./jetstream.ts";

const dockerAvailable = ((): boolean => {
  if (process.env["DOCKER_HOST"]) return true;
  const home = process.env["HOME"] ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.docker/run/docker.sock`,
    `${home}/.colima/default/docker.sock`,
    `${home}/.orbstack/run/docker.sock`,
  ];
  return candidates.some((p) => existsSync(p));
})();

let container: StartedTestContainer | undefined;
let natsUrl: string | undefined;

function requireUrl(): string {
  if (!natsUrl) throw new Error("nats container not started");
  return natsUrl;
}

async function connectNats(): Promise<NatsConnection> {
  return await connect({ servers: requireUrl() });
}

async function freshStream(nc: NatsConnection, subject: string): Promise<string> {
  const streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nc);
  await manager.streams.add({
    name: streamName,
    subjects: [subject],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });
  return streamName;
}

type TestContext = {
  nc: NatsConnection;
  subject: string;
  stream: string;
  group: string;
  publisher: Publisher;
};

async function setupContext(): Promise<TestContext> {
  const nc = await connectNats();
  const subject = `tickets.created.v1.${randomUUID()}`;
  const stream = await freshStream(nc, subject);
  const group = `g-${randomUUID()}`;
  const publisher = createPublisher(nc);
  return { nc, subject, stream, group, publisher };
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  container = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();
  natsUrl = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
}, 60_000);

afterAll(async () => {
  await container?.stop();
});

describe.skipIf(!dockerAvailable)("@tix/messaging/jetstream", () => {
  it("publishes a payload that the consumer validates and hands to the handler exactly once", async () => {
    const { nc, subject, stream, group, publisher } = await setupContext();

    const eventId = randomUUID();
    const payload = {
      ticketId: randomUUID(),
      sellerId: randomUUID(),
      title: "Test concert",
      quantityTotal: 4,
      unitPriceCents: 5000,
      createdAt: new Date().toISOString(),
    };

    let resolveHandled!: (eventId: string) => void;
    const handled = new Promise<string>((r) => {
      resolveHandled = r;
    });
    let invocations = 0;

    const consumer = await createConsumer(nc, {
      stream,
      subjectFilter: subject,
      group,
      schema: ticketCreatedV1,
      handler: ({ eventId: id }) => {
        invocations++;
        resolveHandled(id);
      },
    });

    try {
      const { ack } = await publisher.publish(subject, payload, { msgId: eventId });
      expect(ack.stream).toBe(stream);

      const observedEventId = await handled;
      expect(observedEventId).toBe(eventId);

      await new Promise((r) => setTimeout(r, 200));
      expect(invocations).toBe(1);
    } finally {
      await consumer.stop();
      await nc.close();
    }
  }, 20_000);

  it("terminates malformed payloads without invoking the handler and without redelivering", async () => {
    const { nc, subject, stream, group, publisher } = await setupContext();

    const badPayload = { ticketId: randomUUID() };

    let invocations = 0;
    const consumer = await createConsumer(nc, {
      stream,
      subjectFilter: subject,
      group,
      schema: ticketCreatedV1,
      ackWaitMs: 500,
      handler: () => {
        invocations++;
      },
    });

    try {
      await publisher.publish(subject, badPayload, { msgId: randomUUID() });

      // ack_wait is 500ms; wait well past it so a non-terminated message would redeliver.
      await new Promise((r) => setTimeout(r, 1500));

      expect(invocations).toBe(0);
    } finally {
      await consumer.stop();
      await nc.close();
    }
  }, 20_000);

  it("terminates messages missing the Nats-Msg-Id header without invoking the handler", async () => {
    const { nc, subject, stream, group, publisher } = await setupContext();

    const payload = {
      ticketId: randomUUID(),
      sellerId: randomUUID(),
      title: "Headerless concert",
      quantityTotal: 1,
      unitPriceCents: 100,
      createdAt: new Date().toISOString(),
    };

    let invocations = 0;
    const consumer = await createConsumer(nc, {
      stream,
      subjectFilter: subject,
      group,
      schema: ticketCreatedV1,
      ackWaitMs: 500,
      handler: () => {
        invocations++;
      },
    });

    try {
      await publisher.publish(subject, payload);

      await new Promise((r) => setTimeout(r, 1500));

      expect(invocations).toBe(0);
    } finally {
      await consumer.stop();
      await nc.close();
    }
  }, 20_000);

  it("does not redeliver when the handler acks early and then throws", async () => {
    const { nc, subject, stream, group, publisher } = await setupContext();

    const eventId = randomUUID();
    const payload = {
      ticketId: randomUUID(),
      sellerId: randomUUID(),
      title: "Early-ack concert",
      quantityTotal: 1,
      unitPriceCents: 100,
      createdAt: new Date().toISOString(),
    };

    let invocations = 0;
    const consumer = await createConsumer(nc, {
      stream,
      subjectFilter: subject,
      group,
      schema: ticketCreatedV1,
      ackWaitMs: 500,
      handler: ({ ack }) => {
        invocations++;
        ack();
        throw new Error("post-ack failure");
      },
    });

    try {
      await publisher.publish(subject, payload, { msgId: eventId });

      await new Promise((r) => setTimeout(r, 1500));

      expect(invocations).toBe(1);
    } finally {
      await consumer.stop();
      await nc.close();
    }
  }, 20_000);

  it("redelivers the same event id when the handler throws mid-processing", async () => {
    const { nc, subject, stream, group, publisher } = await setupContext();

    const eventId = randomUUID();
    const payload = {
      ticketId: randomUUID(),
      sellerId: randomUUID(),
      title: "Retry concert",
      quantityTotal: 2,
      unitPriceCents: 1000,
      createdAt: new Date().toISOString(),
    };

    const deliveredIds: string[] = [];
    let resolveSecond!: () => void;
    const second = new Promise<void>((r) => {
      resolveSecond = r;
    });

    const consumer = await createConsumer(nc, {
      stream,
      subjectFilter: subject,
      group,
      schema: ticketCreatedV1,
      ackWaitMs: 500,
      handler: ({ eventId: id }) => {
        deliveredIds.push(id);

        if (deliveredIds.length === 1) {
          throw new Error("simulated crash");
        }

        resolveSecond();
      },
    });

    try {
      await publisher.publish(subject, payload, { msgId: eventId });

      await second;

      expect(deliveredIds.length).toBeGreaterThanOrEqual(2);
      expect(deliveredIds[0]).toBe(eventId);
      expect(deliveredIds[1]).toBe(eventId);
    } finally {
      await consumer.stop();
      await nc.close();
    }
  }, 20_000);

  it("propagates W3C trace context from publish to the consumer handler", async () => {
    const { nc, subject, stream, group, publisher } = await setupContext();

    const parent: SpanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
    };
    const traceContext = trace.setSpanContext(ROOT_CONTEXT, parent);

    const payload = {
      ticketId: randomUUID(),
      sellerId: randomUUID(),
      title: "Traced concert",
      quantityTotal: 2,
      unitPriceCents: 2500,
      createdAt: new Date().toISOString(),
    };

    let resolveHandled!: (args: { spanContext: SpanContext | undefined; payload: unknown }) => void;
    const handled = new Promise<{ spanContext: SpanContext | undefined; payload: unknown }>((r) => {
      resolveHandled = r;
    });

    const consumer = await createConsumer(nc, {
      stream,
      subjectFilter: subject,
      group,
      schema: ticketCreatedV1,
      handler: ({ traceContext: ctx, payload: received }) => {
        resolveHandled({ spanContext: trace.getSpanContext(ctx), payload: received });
      },
    });

    try {
      await publisher.publish(subject, payload, { msgId: randomUUID(), traceContext });

      const observed = await handled;
      expect(observed.spanContext?.traceId).toBe(parent.traceId);
      expect(observed.spanContext?.spanId).toBe(parent.spanId);
      // trace context rides in headers only; the payload is untouched.
      expect(observed.payload).toEqual(payload);
    } finally {
      await consumer.stop();
      await nc.close();
    }
  }, 20_000);

  it("delivers a span-less root trace context when published without trace context", async () => {
    const { nc, subject, stream, group, publisher } = await setupContext();

    const payload = {
      ticketId: randomUUID(),
      sellerId: randomUUID(),
      title: "Untraced concert",
      quantityTotal: 1,
      unitPriceCents: 100,
      createdAt: new Date().toISOString(),
    };

    let resolveHandled!: (spanContext: SpanContext | undefined) => void;
    const handled = new Promise<SpanContext | undefined>((r) => {
      resolveHandled = r;
    });

    const consumer = await createConsumer(nc, {
      stream,
      subjectFilter: subject,
      group,
      schema: ticketCreatedV1,
      handler: ({ traceContext: ctx }) => {
        resolveHandled(trace.getSpanContext(ctx));
      },
    });

    try {
      await publisher.publish(subject, payload, { msgId: randomUUID() });

      expect(await handled).toBeUndefined();
    } finally {
      await consumer.stop();
      await nc.close();
    }
  }, 20_000);
});
