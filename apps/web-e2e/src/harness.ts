import { startCanaryStack } from "gateway/canary-stack";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStripePaymentIntentClient } from "payments/stripe-payment-intent";
import Stripe from "stripe";
import { GenericContainer, Wait } from "testcontainers";

import { WEB_PORT } from "./ports.ts";
import { resolveStripePublishableKey } from "./stripe-keys.ts";

const webRoot = fileURLToPath(new URL("../../web", import.meta.url));

export type Harness = {
  webUrl: string;
  gatewayBaseUrl: string;
  shutdown: () => Promise<void>;
};

export async function startHarness(): Promise<Harness> {
  // The Buyer flow needs a real Stripe sandbox (the gateway confirms a
  // PaymentIntent server-side and the browser tokenizes a card against
  // Stripe's CDN). The Seller flow doesn't. When the key is missing we still
  // boot the stack with a stub PaymentIntent client so the Seller spec runs
  // locally; the Buyer spec skips itself when it sees `STRIPE_TEST_KEY` unset.
  const stripeSecretKey = process.env["STRIPE_TEST_KEY"];
  // The publishable key is exposed to the browser; pull it from the environment
  // or fall back to Stripe's docs sample key. Empty is treated as absent — CI
  // injects an unset secret as "" (see resolveStripePublishableKey).
  const stripePublishableKey = resolveStripePublishableKey(
    process.env["STRIPE_TEST_PUBLISHABLE_KEY"],
  );

  const pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "web_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/web_e2e`;
  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;

  const webUrl = `http://localhost:${WEB_PORT}`;

  const paymentIntentClient =
    stripeSecretKey === undefined || stripeSecretKey.length === 0
      ? undefined
      : createStripePaymentIntentClient(new Stripe(stripeSecretKey));

  const stack = await startCanaryStack(pgUrl, natsUrl, {
    ...(paymentIntentClient === undefined ? {} : { paymentIntentClient }),
    webOrigin: webUrl,
    // 5 minutes — long enough that the buyer flow has ample time to fill the
    // Stripe iframe and submit, but short enough that an accidentally
    // abandoned test never holds reservations open.
    reservationTtlMs: 5 * 60 * 1000,
  });

  // The browser loads the SPA from `localhost` (Playwright `baseURL`) while the
  // canary stack reports its gateway as `127.0.0.1`. For cookies those are
  // different sites, so better-auth's `SameSite=Lax` session cookie is withheld
  // on the cross-site `getSession()` that runs after a hard reload — the header
  // renders signed-out and "My tickets" never appears. Hand the browser a
  // same-site `localhost` gateway URL so the cookie flows on rehydration. The
  // Node-side in-process clients keep the `127.0.0.1` URL (undici can be flaky
  // resolving `localhost` to IPv6 against an IPv4-bound server).
  const browserGatewayUrl = stack.gatewayBaseUrl.replace("127.0.0.1", "localhost");

  const vite = await startVite({
    webUrl,
    gatewayUrl: browserGatewayUrl,
    stripePublishableKey,
  });

  return {
    webUrl,
    gatewayBaseUrl: stack.gatewayBaseUrl,
    shutdown: async () => {
      await stopVite(vite);
      await stack.shutdown();
      await natsContainer.stop();
      await pgContainer.stop();
    },
  };
}

type ViteHandle = {
  child: ChildProcess;
};

async function startVite(args: {
  webUrl: string;
  gatewayUrl: string;
  stripePublishableKey: string;
}): Promise<ViteHandle> {
  // Spawning Vite directly (instead of leaning on Playwright's `webServer`
  // option) means we can inject `VITE_*` env vars discovered AFTER the
  // backend stack is up — the gateway port is dynamic, so we can't bake the
  // URL into a static .env file.
  const child = spawn(
    "pnpm",
    ["exec", "vite", "--port", String(WEB_PORT), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        VITE_GATEWAY_URL: args.gatewayUrl,
        VITE_STRIPE_PK: args.stripePublishableKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.on("data", (buf: Buffer) => {
    process.stdout.write(`[vite] ${buf.toString()}`);
  });
  child.stderr?.on("data", (buf: Buffer) => {
    process.stderr.write(`[vite] ${buf.toString()}`);
  });

  await waitForUrl(args.webUrl, 60_000);

  return { child };
}

async function stopVite(handle: ViteHandle): Promise<void> {
  if (handle.child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    handle.child.once("exit", () => {
      resolve();
    });
    handle.child.kill("SIGTERM");
  });
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- polling is inherently sequential
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    // eslint-disable-next-line no-await-in-loop -- backoff before next poll
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite dev server did not become ready: ${url}`);
}
