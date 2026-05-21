import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ticketCreatedV1 } from "@tix/contracts/tickets";

import { createConsumer, createPublisher } from "./jetstream.ts";

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
    const nc = await connectNats();
    const subject = `tickets.created.v1.${randomUUID()}`;
    const stream = await freshStream(nc, subject);
    const group = `g-${randomUUID()}`;

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

    const publisher = createPublisher(nc);

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
    const nc = await connectNats();
    const subject = `tickets.created.v1.${randomUUID()}`;
    const stream = await freshStream(nc, subject);
    const group = `g-${randomUUID()}`;

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

    const publisher = createPublisher(nc);

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

  it("redelivers the same event id when the handler throws mid-processing", async () => {
    const nc = await connectNats();
    const subject = `tickets.created.v1.${randomUUID()}`;
    const stream = await freshStream(nc, subject);
    const group = `g-${randomUUID()}`;

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

    const publisher = createPublisher(nc);

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
});
