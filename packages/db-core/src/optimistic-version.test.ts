import { eq } from "drizzle-orm";
import { integer, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "./client.ts";
import { updateVersioned } from "./optimistic-version.ts";

const SCHEMA_NAME = "optimistic_version_test";

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

const widgetsTable = pgSchema(SCHEMA_NAME).table("widgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull(),
  version: integer("version").notNull().default(1),
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
  await client.sql`CREATE SCHEMA IF NOT EXISTS ${client.sql(SCHEMA_NAME)}`;
  await client.sql`
    CREATE TABLE IF NOT EXISTS optimistic_version_test.widgets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      quantity integer NOT NULL,
      version integer NOT NULL DEFAULT 1
    )
  `;
}, 120_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!client) return;
  await client.sql`TRUNCATE TABLE optimistic_version_test.widgets RESTART IDENTITY CASCADE`;
});

function getClient(): DbClient<Record<string, never>> {
  if (!client) throw new Error("db client not initialized");
  return client;
}

async function insertWidget(name: string, quantity: number): Promise<string> {
  const { db } = getClient();
  const id = randomUUID();
  await db.insert(widgetsTable).values({ id, name, quantity });

  return id;
}

describe.skipIf(!dockerAvailable)("updateVersioned", () => {
  it("returns rowsAffected = 1 and increments version on the happy path", async () => {
    const { db } = getClient();
    const id = await insertWidget("alpha", 10);

    const result = await updateVersioned(db, widgetsTable, { id, version: 1 }, { quantity: 7 });

    expect(result.rowsAffected).toBe(1);

    const [row] = await db.select().from(widgetsTable).where(eq(widgetsTable.id, id));
    expect(row?.quantity).toBe(7);
    expect(row?.version).toBe(2);
  });

  it("returns rowsAffected = 0 when the expected version no longer matches", async () => {
    const { db } = getClient();
    const id = await insertWidget("beta", 10);

    const first = await updateVersioned(db, widgetsTable, { id, version: 1 }, { quantity: 5 });
    expect(first.rowsAffected).toBe(1);

    const stale = await updateVersioned(db, widgetsTable, { id, version: 1 }, { quantity: 3 });
    expect(stale.rowsAffected).toBe(0);

    const [row] = await db.select().from(widgetsTable).where(eq(widgetsTable.id, id));
    expect(row?.quantity).toBe(5);
    expect(row?.version).toBe(2);
  });

  it("lets exactly one of two parallel writers win the race at the same version", async () => {
    const { db } = getClient();
    const id = await insertWidget("gamma", 10);

    const [a, b] = await Promise.all([
      updateVersioned(db, widgetsTable, { id, version: 1 }, { quantity: 4 }),
      updateVersioned(db, widgetsTable, { id, version: 1 }, { quantity: 6 }),
    ]);

    const winners = [a, b].filter((r) => r.rowsAffected === 1);
    const losers = [a, b].filter((r) => r.rowsAffected === 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const [row] = await db.select().from(widgetsTable).where(eq(widgetsTable.id, id));
    expect(row?.version).toBe(2);
    expect([4, 6]).toContain(row?.quantity);
  });
});
