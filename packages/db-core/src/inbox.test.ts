import { pgSchema, text } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbClient, type DbClient } from "./client.ts";
import { bootstrapSchema } from "./fixtures.ts";
import { withInboxDedupe } from "./inbox.ts";
import { defineInbox } from "./schema.ts";

const SCHEMA_NAME = "inbox_test";
const SUBJECT = "order.created.v1";

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

const inboxTable = defineInbox(SCHEMA_NAME);

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
    CREATE TABLE IF NOT EXISTS inbox_test.widgets (
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
  await client.sql`TRUNCATE TABLE inbox_test.widgets, inbox_test.inbox RESTART IDENTITY CASCADE`;
});

function getClient(): DbClient<Record<string, never>> {
  if (!client) throw new Error("db client not initialized");
  return client;
}

describe.skipIf(!dockerAvailable)("withInboxDedupe", () => {
  it("runs handler and writes the inbox row on first call", async () => {
    const { db } = getClient();
    const eventId = randomUUID();
    const handler = vi.fn<() => Promise<string>>(async () => "handled");

    const result = await db.transaction((tx) =>
      withInboxDedupe(tx, inboxTable, { eventId, subject: SUBJECT }, handler),
    );

    expect(result).toEqual({ deduped: false, result: "handled" });
    expect(handler).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(inboxTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId, subject: SUBJECT });
  });

  it("returns deduped:true and skips handler on a repeated (eventId, subject)", async () => {
    const { db } = getClient();
    const eventId = randomUUID();
    const firstHandler = vi.fn<() => Promise<string>>(async () => "first");
    const secondHandler = vi.fn<() => Promise<string>>(async () => "second");

    await db.transaction((tx) =>
      withInboxDedupe(tx, inboxTable, { eventId, subject: SUBJECT }, firstHandler),
    );
    const second = await db.transaction((tx) =>
      withInboxDedupe(tx, inboxTable, { eventId, subject: SUBJECT }, secondHandler),
    );

    expect(second).toEqual({ deduped: true });
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).not.toHaveBeenCalled();

    const rows = await db.select().from(inboxTable);
    expect(rows).toHaveLength(1);
  });

  it("rolls back the inbox row when the outer transaction throws", async () => {
    const { db } = getClient();
    const eventId = randomUUID();

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(widgetsTable).values({ id: "w1", name: "alpha" });
        await withInboxDedupe(tx, inboxTable, { eventId, subject: SUBJECT }, async () => {
          // handler side-effect inside the same tx
          await tx.insert(widgetsTable).values({ id: "w2", name: "beta" });
        });
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow(/intentional rollback/);

    const widgets = await db.select().from(widgetsTable);
    expect(widgets).toHaveLength(0);

    const rows = await db.select().from(inboxTable);
    expect(rows).toHaveLength(0);
  });
});
