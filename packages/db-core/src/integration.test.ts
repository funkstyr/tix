import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient } from "./client.ts";
import { bootstrapSchema } from "./fixtures.ts";

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
let host = "";
let port = 0;

function adminUrl(): string {
  return `postgres://postgres:postgres@${host}:${port}/tix_test`;
}

function roleUrl(role: string, password: string): string {
  return `postgres://${role}:${password}@${host}:${port}/tix_test`;
}

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

  host = container.getHost();
  port = container.getMappedPort(5432);

  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`
      CREATE ROLE tickets_test WITH LOGIN PASSWORD 'tickets_pw';
      CREATE ROLE auth_test    WITH LOGIN PASSWORD 'auth_pw';
      CREATE SCHEMA tickets AUTHORIZATION tickets_test;
      CREATE SCHEMA auth    AUTHORIZATION auth_test;
    `);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const ticketsClient = createDbClient("tickets", roleUrl("tickets_test", "tickets_pw"));
  try {
    await bootstrapSchema(ticketsClient.sql, "tickets");
  } finally {
    await ticketsClient.close();
  }

  const authClient = createDbClient("auth", roleUrl("auth_test", "auth_pw"));
  try {
    await bootstrapSchema(authClient.sql, "auth");
  } finally {
    await authClient.close();
  }
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe.skipIf(!dockerAvailable)("createDbClient", () => {
  it("sets search_path to <schema>, public for every checkout", async () => {
    const client = createDbClient("tickets", roleUrl("tickets_test", "tickets_pw"), {
      max: 3,
    });

    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => client.sql<{ search_path: string }[]>`SHOW search_path`),
      );

      for (const rows of results) {
        expect(rows[0]?.search_path).toMatch(/tickets/);
        expect(rows[0]?.search_path).toMatch(/public/);
      }
    } finally {
      await client.close();
    }
  });

  it("blocks the tickets role from reading the auth schema (USAGE not granted)", async () => {
    const tickets = createDbClient("tickets", roleUrl("tickets_test", "tickets_pw"));
    try {
      await tickets.sql`
        INSERT INTO tickets.outbox (subject, payload, event_id)
        VALUES ('tickets.created.v1', ${tickets.sql.json({ ok: true })}, gen_random_uuid())
      `;

      await expect(tickets.sql`SELECT 1 FROM auth.outbox`).rejects.toThrow(/permission denied/i);
    } finally {
      await tickets.close();
    }
  });
});

describe.skipIf(!dockerAvailable)("inbox unique constraint", () => {
  it("rejects a duplicate (event_id, subject) pair", async () => {
    const client = createDbClient("tickets", roleUrl("tickets_test", "tickets_pw"));
    const eventId = randomUUID();
    const subject = "order.created.v1";

    try {
      await client.sql`
        INSERT INTO tickets.inbox (event_id, subject)
        VALUES (${eventId}, ${subject})
      `;

      await expect(
        client.sql`
          INSERT INTO tickets.inbox (event_id, subject)
          VALUES (${eventId}, ${subject})
        `,
      ).rejects.toThrow(/inbox_event_subject_uq|duplicate key/i);
    } finally {
      await client.close();
    }
  });

  it("allows the same event_id under a different subject", async () => {
    const client = createDbClient("tickets", roleUrl("tickets_test", "tickets_pw"));
    const eventId = randomUUID();

    try {
      await client.sql`
        INSERT INTO tickets.inbox (event_id, subject)
        VALUES (${eventId}, 'order.created.v1')
      `;
      await client.sql`
        INSERT INTO tickets.inbox (event_id, subject)
        VALUES (${eventId}, 'order.expired.v1')
      `;

      const rows = await client.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM tickets.inbox WHERE event_id = ${eventId}
      `;

      expect(rows[0]?.count).toBe("2");
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(!dockerAvailable)("bootstrapSchema", () => {
  it("bootstraps outbox + inbox into a fresh schema in under a second", async () => {
    const schemaName = `bench_${randomUUID().replaceAll("-", "_")}`;
    const admin = postgres(adminUrl(), { max: 1 });

    try {
      const started = Date.now();
      await bootstrapSchema(admin, schemaName);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1000);

      const tables = await admin<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${schemaName}
        ORDER BY table_name
      `;

      expect(tables.map((t) => t.table_name)).toEqual(["inbox", "outbox"]);
    } finally {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end({ timeout: 5 });
    }
  });

  it("rejects schema names that are not valid identifiers", async () => {
    const admin = postgres(adminUrl(), { max: 1 });
    try {
      await expect(bootstrapSchema(admin, "tickets; DROP TABLE x;")).rejects.toThrow(
        /invalid schema identifier/,
      );
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
});
