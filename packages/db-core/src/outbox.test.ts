import { type Context, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "./client.ts";
import { bootstrapSchema } from "./fixtures.ts";
import { enqueueEvent, startOutboxRelay, type OutboxPublish } from "./outbox.ts";
import { defineOutbox } from "./schema.ts";

const SCHEMA_NAME = "outbox_test";
const SUBJECT = "test.thing.v1";

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

const outboxTable = defineOutbox(SCHEMA_NAME);

const widgetsTable = pgSchema(SCHEMA_NAME).table("widgets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

let container: StartedTestContainer | undefined;
let client: DbClient<Record<string, never>> | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "tix_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://postgres:postgres@${host}:${port}/tix_test`;

  client = createDbClient(SCHEMA_NAME, url);
  await bootstrapSchema(client.sql, SCHEMA_NAME);
  await client.sql`
    CREATE TABLE IF NOT EXISTS outbox_test.widgets (
      id text PRIMARY KEY,
      name text NOT NULL
    )
  `;
}, 120_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!client) return;
  await client.sql`TRUNCATE TABLE outbox_test.widgets, outbox_test.outbox RESTART IDENTITY CASCADE`;
});

function getClient(): DbClient<Record<string, never>> {
  if (!client) throw new Error("db client not initialized");
  return client;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  // eslint-disable-next-line no-await-in-loop
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out");
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function contextWithSpan(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
}

describe.skipIf(!dockerAvailable)("enqueueEvent", () => {
  it("writes the outbox row inside the caller's transaction", async () => {
    const { db } = getClient();
    const eventId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(widgetsTable).values({ id: "w1", name: "alpha" });
      await enqueueEvent(tx, outboxTable, {
        subject: SUBJECT,
        payload: { widgetId: "w1" },
        eventId,
      });
    });

    const widgets = await db.select().from(widgetsTable);
    expect(widgets).toHaveLength(1);

    const rows = await db.select().from(outboxTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe(SUBJECT);
    expect(rows[0]?.eventId).toBe(eventId);
    expect(rows[0]?.sentAt).toBeNull();
  });

  it("rolls back the outbox row when the domain insert's transaction throws", async () => {
    const { db } = getClient();
    const eventId = randomUUID();

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(widgetsTable).values({ id: "w2", name: "beta" });
        await enqueueEvent(tx, outboxTable, {
          subject: SUBJECT,
          payload: { widgetId: "w2" },
          eventId,
        });
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow(/intentional rollback/);

    const widgets = await db.select().from(widgetsTable);
    expect(widgets).toHaveLength(0);

    const rows = await db.select().from(outboxTable);
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(!dockerAvailable)("startOutboxRelay", () => {
  it("drains all pending outbox rows by calling publish and marking sent_at", async () => {
    const { db } = getClient();

    const eventIds: string[] = [];
    await db.transaction(async (tx) => {
      for (let i = 0; i < 100; i++) {
        const eventId = randomUUID();
        eventIds.push(eventId);
        // eslint-disable-next-line no-await-in-loop
        await enqueueEvent(tx, outboxTable, {
          subject: SUBJECT,
          payload: { i },
          eventId,
        });
      }
    });

    const calls: Array<{ subject: string; eventId: string }> = [];
    const publish: OutboxPublish = async (subject, _payload, opts) => {
      calls.push({ subject, eventId: opts.msgId });
      return undefined;
    };

    const relay = startOutboxRelay(db, outboxTable, publish, { pollIntervalMs: 25, batchSize: 50 });
    try {
      await waitUntil(() => calls.length === 100);
    } finally {
      await relay.stop();
    }

    expect(calls.map((c) => c.eventId).toSorted()).toEqual(eventIds.toSorted());

    const rows = await db.select().from(outboxTable);
    expect(rows).toHaveLength(100);
    for (const row of rows) {
      expect(row.sentAt).not.toBeNull();
    }
  }, 20_000);

  it("leaves sent_at null when publish throws and retries the row on the next poll", async () => {
    const { db } = getClient();

    const goodIds = [randomUUID(), randomUUID()] as const;
    const [firstGoodId] = goodIds;
    const flakyId = randomUUID();

    await db.transaction(async (tx) => {
      for (const eventId of [...goodIds, flakyId]) {
        // eslint-disable-next-line no-await-in-loop
        await enqueueEvent(tx, outboxTable, {
          subject: SUBJECT,
          payload: { eventId },
          eventId,
        });
      }
    });

    let flakyShouldFail = true;
    const flakyAttempts: string[] = [];
    const publish: OutboxPublish = async (_subject, _payload, opts) => {
      if (opts.msgId === flakyId) {
        flakyAttempts.push(opts.msgId);
        if (flakyShouldFail) throw new Error("simulated nats failure");
      }
      return undefined;
    };

    const relay = startOutboxRelay(db, outboxTable, publish, { pollIntervalMs: 25, batchSize: 10 });

    try {
      await waitUntil(async () => {
        const rows = await db
          .select()
          .from(outboxTable)
          .where(eq(outboxTable.eventId, firstGoodId));
        return rows[0]?.sentAt !== null;
      });

      // Wait for at least two failing attempts on the flaky row to prove retry.
      await waitUntil(() => flakyAttempts.length >= 2);

      const flakyRows = await db.select().from(outboxTable).where(eq(outboxTable.eventId, flakyId));
      expect(flakyRows[0]?.sentAt).toBeNull();

      flakyShouldFail = false;

      await waitUntil(async () => {
        const rows = await db.select().from(outboxTable).where(eq(outboxTable.eventId, flakyId));
        return rows[0]?.sentAt !== null;
      });
    } finally {
      await relay.stop();
    }
  }, 20_000);

  it("forwards trace context captured at enqueue to publish; untraced rows publish unchanged", async () => {
    const { db } = getClient();
    const tracedId = randomUUID();
    const untracedId = randomUUID();

    await db.transaction(async (tx) => {
      await enqueueEvent(tx, outboxTable, {
        subject: SUBJECT,
        payload: { traced: true },
        eventId: tracedId,
        traceContext: contextWithSpan(),
      });
      await enqueueEvent(tx, outboxTable, {
        subject: SUBJECT,
        payload: { traced: false },
        eventId: untracedId,
      });
    });

    const seen = new Map<string, Context | undefined>();
    const publish: OutboxPublish = async (_subject, _payload, opts) => {
      seen.set(opts.msgId, opts.traceContext);
      return undefined;
    };

    const relay = startOutboxRelay(db, outboxTable, publish, { pollIntervalMs: 25 });
    try {
      await waitUntil(() => seen.has(tracedId) && seen.has(untracedId));
    } finally {
      await relay.stop();
    }

    const tracedSpan = trace.getSpanContext(seen.get(tracedId) ?? ROOT_CONTEXT);
    expect(tracedSpan?.traceId).toBe(TRACE_ID);
    expect(tracedSpan?.spanId).toBe(SPAN_ID);

    expect(seen.get(untracedId)).toBeUndefined();
  }, 20_000);
});
