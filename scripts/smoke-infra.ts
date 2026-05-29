// Pings each backing service in `docker-compose.yml` so we can verify the stack
// is healthy without booting any tix service. Reads connection strings from
// process.env with defaults that match `.env.example`, so a vanilla
// `docker compose up -d` followed by `pnpm tsx scripts/smoke-infra.ts` works.

import { connect as connectNats } from "nats";
import { connect as connectSocket } from "node:net";
import process from "node:process";
import postgres from "postgres";

type Check = { name: string; run: () => Promise<void> };

const POSTGRES_ROLES = [
  [
    "auth",
    "AUTH_DATABASE_URL",
    "postgres://auth_user:auth_dev@localhost:5432/tix?search_path=auth",
  ],
  [
    "tickets",
    "TICKETS_DATABASE_URL",
    "postgres://tickets_user:tickets_dev@localhost:5432/tix?search_path=tickets",
  ],
  [
    "orders",
    "ORDERS_DATABASE_URL",
    "postgres://orders_user:orders_dev@localhost:5432/tix?search_path=orders",
  ],
  [
    "payments",
    "PAYMENTS_DATABASE_URL",
    "postgres://payments_user:payments_dev@localhost:5432/tix?search_path=payments",
  ],
  [
    "expiration",
    "EXPIRATION_DATABASE_URL",
    "postgres://expiration_user:expiration_dev@localhost:5432/tix?search_path=expiration",
  ],
] as const;

const REQUIRED_STREAMS = ["TICKETS", "ORDERS"] as const;

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

async function checkPostgresRole(schema: string, url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 1 });

  try {
    const rows = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`;
    const got = rows[0]?.schema;
    if (got !== schema) {
      throw new Error(`expected search_path schema "${schema}", got "${got ?? "<none>"}"`);
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function checkNatsStreams(url: string): Promise<void> {
  const nc = await connectNats({ servers: url });

  try {
    const jsm = await nc.jetstreamManager();
    const present = new Set<string>();
    for await (const info of jsm.streams.list()) {
      present.add(info.config.name);
    }

    for (const name of REQUIRED_STREAMS) {
      if (!present.has(name)) throw new Error(`JetStream stream "${name}" not found`);
    }
  } finally {
    await nc.drain();
  }
}

async function checkRedisPing(url: string): Promise<void> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || "6379");

  await new Promise<void>((resolve, reject) => {
    const sock = connectSocket({ host, port });
    sock.setTimeout(2000);

    sock.once("connect", () => sock.write("*1\r\n$4\r\nPING\r\n"));
    sock.once("data", (buf) => {
      sock.end();
      const reply = buf.toString().trim();
      if (reply === "+PONG") resolve();
      else reject(new Error(`unexpected Redis reply: ${reply}`));
    });
    sock.once("timeout", () => {
      sock.destroy();
      reject(new Error("Redis ping timed out after 2s"));
    });
    sock.once("error", reject);
  });
}

const checks: Check[] = [
  ...POSTGRES_ROLES.map(([schema, key, fallback]) => ({
    name: `postgres[${schema}]`,
    run: () => checkPostgresRole(schema, envOr(key, fallback)),
  })),
  {
    name: "nats[streams]",
    run: () => checkNatsStreams(envOr("NATS_URL", "nats://localhost:4222")),
  },
  {
    name: "redis[ping]",
    run: () => checkRedisPing(envOr("REDIS_URL", "redis://localhost:6379")),
  },
];

async function main(): Promise<void> {
  const results = await Promise.allSettled(checks.map((c) => c.run()));

  let failed = false;
  results.forEach((result, i) => {
    const check = checks[i];
    if (check === undefined) return;
    if (result.status === "fulfilled") {
      console.log(`ok    ${check.name}`);
    } else {
      failed = true;
      const reason = result.reason;
      const message =
        reason instanceof Error
          ? reason.message || reason.name || reason.constructor.name
          : String(reason);
      console.error(`FAIL  ${check.name}: ${message}`);
    }
  });

  if (failed) process.exit(1);
}

await main();
