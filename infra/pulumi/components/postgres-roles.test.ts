import { describe, expect, it } from "vitest";

import { PostgresRoles } from "./postgres-roles.ts";
import { promiseOf } from "./pulumi-mocks.ts";

function build(): PostgresRoles {
  return new PostgresRoles("postgres-roles", {
    namespace: "tix",
    postgresHost: "postgres",
    postgresPort: 5432,
    database: "tix",
    adminUser: "postgres",
    adminPassword: { name: "postgres-credentials", key: "POSTGRES_PASSWORD" },
    roles: [
      { schema: "auth", password: { name: "auth-credentials", key: "AUTH_PASSWORD" } },
      {
        monitor: "prometheus_exporter",
        password: { name: "prometheus-exporter-credentials", key: "PROMETHEUS_EXPORTER_PASSWORD" },
      },
    ],
  });
}

async function bootstrapSql(roles: PostgresRoles): Promise<string> {
  const data = await promiseOf(roles.configMap.data as Parameters<typeof promiseOf>[0]);
  return (data as Record<string, string>)["bootstrap.sql"] ?? "";
}

describe("PostgresRoles service role", () => {
  it("creates a schema-owning <schema>_user with a DDL grant", async () => {
    const sql = await bootstrapSql(build());
    expect(sql).toContain("CREATE ROLE auth_user WITH LOGIN PASSWORD");
    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION auth_user");
    expect(sql).toContain("GRANT CREATE ON DATABASE tix TO auth_user");
    expect(sql).toContain("ALTER ROLE auth_user SET search_path TO auth, public");
  });
});

describe("PostgresRoles monitor role", () => {
  it("creates a read-only pg_monitor role with no schema and no DDL grant", async () => {
    const sql = await bootstrapSql(build());
    expect(sql).toContain("CREATE ROLE prometheus_exporter WITH LOGIN PASSWORD");
    expect(sql).toContain("GRANT pg_monitor TO prometheus_exporter");

    // The monitor role must NOT own a schema, get CREATE on the database, or a search_path —
    // pg_monitor is read-only-stats access and nothing more.
    expect(sql).not.toContain("CREATE SCHEMA IF NOT EXISTS prometheus_exporter");
    expect(sql).not.toContain("GRANT CREATE ON DATABASE tix TO prometheus_exporter");
    expect(sql).not.toContain("prometheus_exporter SET search_path");
  });

  it("sources the monitor role password from its own env var", async () => {
    const roles = build();

    const spec = await promiseOf(roles.job.spec);
    const env = spec.template.spec?.containers[0]?.env ?? [];
    const pw = env.find((e) => e.name === "PROMETHEUS_EXPORTER_PASSWORD");
    expect(pw?.valueFrom?.secretKeyRef).toMatchObject({
      name: "prometheus-exporter-credentials",
      key: "PROMETHEUS_EXPORTER_PASSWORD",
    });
  });
});
