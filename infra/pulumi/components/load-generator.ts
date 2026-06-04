import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Grafana k6, run as a long-lived Deployment (ADR-0010). Pinned remote image, like the
// observability backends — not a kind-loaded `tix-*:dev` image, since there's nothing to
// build. The kind smoke pre-pulls this tag (read straight from this declaration).
const K6_IMAGE = "grafana/k6:0.57.0";

const SCRIPT_DIR = "/scripts";
const SCRIPT_FILE = "loadgen.js";

export type LoadGeneratorArgs = {
  namespace: pulumi.Input<string>;
  // Gateway base URL the script drives, e.g. `http://gateway:4000`. Owned by index.ts.
  gatewayBaseUrl: pulumi.Input<string>;
  // OTLP/gRPC endpoint of the collector, bare host:port (e.g. `otel-collector:4317`).
  otelEndpoint: pulumi.Input<string>;
};

// Dev-only in-cluster load generator (ADR-0010). Drives the gateway's public surface
// (sign-in → browse → reserve → pay) at a steady baseline with periodic induced failures
// (forced reservation races, payment declines) so the saga-funnel + RED dashboards are
// alive and the burn-rate alerts have something to trip on. k6's own load metrics flow
// `k6 → otel-collector → Prometheus` over the experimental OTLP output (the same path
// everything else uses; no Prometheus remote-write).
//
// Gated behind a Pulumi config flag in index.ts so it is dev-only — prod never constructs it.
export class LoadGenerator extends pulumi.ComponentResource {
  readonly script: k8s.core.v1.ConfigMap;
  readonly deployment: k8s.apps.v1.Deployment;
  readonly flashSaleScript: k8s.core.v1.ConfigMap;
  readonly declineWaveScript: k8s.core.v1.ConfigMap;
  readonly expirationStormScript: k8s.core.v1.ConfigMap;

  constructor(name: string, args: LoadGeneratorArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:LoadGenerator", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "loadgen",
      "app.kubernetes.io/component": "loadgen",
    };

    this.script = new k8s.core.v1.ConfigMap(
      `${name}-script`,
      {
        metadata: { name: "loadgen-script", namespace },
        data: { [SCRIPT_FILE]: renderLoadScript() },
      },
      childOpts,
    );

    this.flashSaleScript = new k8s.core.v1.ConfigMap(
      `${name}-flash-sale`,
      { metadata: { name: "loadgen-flash-sale", namespace }, data: { "scenario.js": renderFlashSaleScript() } },
      childOpts,
    );
    this.declineWaveScript = new k8s.core.v1.ConfigMap(
      `${name}-decline-wave`,
      { metadata: { name: "loadgen-decline-wave", namespace }, data: { "scenario.js": renderDeclineWaveScript() } },
      childOpts,
    );
    this.expirationStormScript = new k8s.core.v1.ConfigMap(
      `${name}-expiration-storm`,
      { metadata: { name: "loadgen-expiration-storm", namespace }, data: { "scenario.js": renderExpirationStormScript() } },
      childOpts,
    );

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "loadgen", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "k6",
                  image: K6_IMAGE,
                  command: ["k6", "run", `${SCRIPT_DIR}/${SCRIPT_FILE}`],
                  env: [
                    { name: "GATEWAY_BASE_URL", value: args.gatewayBaseUrl },
                    // k6 experimental OpenTelemetry metrics output → the gateway collector,
                    // which fans it into the existing metrics pipeline → Prometheus. Plaintext
                    // h2c, same as the collector's Tempo exporter. Counters land in Prometheus
                    // with a `_total` suffix; the load-profile board queries them.
                    { name: "K6_OUT", value: "experimental-opentelemetry" },
                    { name: "K6_OTEL_GRPC_EXPORTER_ENDPOINT", value: args.otelEndpoint },
                    { name: "K6_OTEL_GRPC_EXPORTER_INSECURE", value: "true" },
                    { name: "K6_OTEL_METRIC_PREFIX", value: "k6_" },
                  ],
                  volumeMounts: [{ name: "script", mountPath: SCRIPT_DIR, readOnly: true }],
                },
              ],
              volumes: [{ name: "script", configMap: { name: this.script.metadata.name } }],
            },
          },
        },
      },
      childOpts,
    );

    this.registerOutputs({
      script: this.script,
      deployment: this.deployment,
      flashSaleScript: this.flashSaleScript,
      declineWaveScript: this.declineWaveScript,
      expirationStormScript: this.expirationStormScript,
    });
  }
}

// Auth + rpc helpers shared by every on-demand scenario script. String-concatenated (no template
// literals) so the outer template literal never tries to interpolate a `${}`.
const SCENARIO_PRELUDE = [
  'import http from "k6/http";',
  'import { sleep } from "k6";',
  'const GATEWAY = __ENV.GATEWAY_BASE_URL || "http://gateway:4000";',
  'const PASSWORD = "correct-horse-battery";',
  'function authToken(res) { return res.headers["Set-Auth-Token"]; }',
  'function signUp(email, name) {',
  '  const res = http.post(GATEWAY + "/api/auth/sign-up/email",',
  '    JSON.stringify({ email: email, password: PASSWORD, name: name }),',
  '    { headers: { "Content-Type": "application/json" }, tags: { op: "auth.signUp" } });',
  '  return authToken(res);',
  '}',
  'function rpc(path, input) {',
  '  return http.post(GATEWAY + "/rpc/" + path, JSON.stringify({ json: input }),',
  '    { headers: { "Content-Type": "application/json" }, tags: { op: path } });',
  '}',
  'function rpcJson(res) { return JSON.parse(res.body).json; }',
].join("\n");

// Flash sale: a burst of buyers all reserving the same hot ticket -> reservation-conflict spike,
// saga-funnel drop-off, latency climb. Bounded (~80s), then the Job exits.
function renderFlashSaleScript(): string {
  return SCENARIO_PRELUDE + "\n" + [
    "export const options = { scenarios: { flash: {",
    '  executor: "ramping-arrival-rate", startRate: 5, timeUnit: "1s",',
    '  preAllocatedVUs: 50, stages: [',
    '    { duration: "20s", target: 60 }, { duration: "40s", target: 60 }, { duration: "20s", target: 0 },',
    "  ] } } };",
    "export function setup() {",
    '  const seller = signUp("flash-seller-" + Date.now() + "@tix.test", "Flash Seller");',
    '  const hot = rpcJson(rpc("tickets/create", { token: seller, title: "FLASH SALE drop", quantityTotal: 100000, unitPriceCents: 1500 })).id;',
    "  const buyers = [];",
    '  for (let i = 0; i < 20; i++) buyers.push(signUp("flash-buyer-" + i + "-" + Date.now() + "@tix.test", "Flash Buyer " + i));',
    "  return { hot: hot, buyers: buyers };",
    "}",
    "export default function (data) {",
    "  const reqs = data.buyers.map(function (token) { return {",
    '    method: "POST", url: GATEWAY + "/rpc/orders/create",',
    '    body: JSON.stringify({ json: { token: token, ticketId: data.hot, quantity: 1 } }),',
    '    params: { headers: { "Content-Type": "application/json" }, tags: { op: "orders/create" } } }; });',
    "  http.batch(reqs);",
    "  sleep(1);",
    "}",
  ].join("\n") + "\n";
}

// Decline wave: buyers reserve then pay with the declined test card -> payment error-ratio + saga
// charge-step failures spike. Bounded run.
function renderDeclineWaveScript(): string {
  return SCENARIO_PRELUDE + "\n" + [
    'export const options = { scenarios: { decline: { executor: "constant-arrival-rate",',
    '  rate: 8, timeUnit: "1s", duration: "60s", preAllocatedVUs: 20 } } };',
    'const CARD_DECLINE = "pm_card_chargeDeclined";',
    "export function setup() {",
    '  const seller = signUp("decline-seller-" + Date.now() + "@tix.test", "Decline Seller");',
    '  const ticket = rpcJson(rpc("tickets/create", { token: seller, title: "Decline-wave GA", quantityTotal: 100000, unitPriceCents: 3000 })).id;',
    '  const buyer = signUp("decline-buyer-" + Date.now() + "@tix.test", "Decline Buyer");',
    "  return { ticket: ticket, buyer: buyer };",
    "}",
    "export default function (data) {",
    '  const order = rpc("orders/create", { token: data.buyer, ticketId: data.ticket, quantity: 1 });',
    "  if (order.status === 200) {",
    '    rpc("payments/create", { token: data.buyer, orderId: rpcJson(order).id, paymentMethodId: CARD_DECLINE });',
    "  }",
    "}",
  ].join("\n") + "\n";
}

// Expiration storm: buyers reserve and never pay -> the expiration worker auto-cancels a wave.
function renderExpirationStormScript(): string {
  return SCENARIO_PRELUDE + "\n" + [
    'export const options = { scenarios: { storm: { executor: "shared-iterations",',
    '  vus: 20, iterations: 300, maxDuration: "90s" } } };',
    "export function setup() {",
    '  const seller = signUp("storm-seller-" + Date.now() + "@tix.test", "Storm Seller");',
    '  const ticket = rpcJson(rpc("tickets/create", { token: seller, title: "Expiration-storm GA", quantityTotal: 100000, unitPriceCents: 2500 })).id;',
    '  const buyer = signUp("storm-buyer-" + Date.now() + "@tix.test", "Storm Buyer");',
    "  return { ticket: ticket, buyer: buyer };",
    "}",
    "export default function (data) {",
    '  rpc("orders/create", { token: data.buyer, ticketId: data.ticket, quantity: 1 });',
    "}",
  ].join("\n") + "\n";
}

// The k6 script, embedded verbatim into the script ConfigMap. Written with string
// concatenation (no template literals) so it carries no `${}` that the outer template would
// try to interpolate.
//
// Two wire protocols, both spoken as raw HTTP against the gateway (ADR-0010 accepts the
// drift risk — the script holds literal `/rpc/...` paths and arktype field names, and drift
// surfaces as failed checks, a useful canary):
//   - oRPC RPC calls: POST {gateway}/rpc/<seg>/<seg> with body {"json": <input>}; downstream
//     services read the session `token` from the input, not a header.
//   - better-auth (bearer plugin): POST {gateway}/api/auth/sign-{up,in}/email; the session
//     token comes back in the `Set-Auth-Token` response header.
function renderLoadScript(): string {
  return `// Generated by tix:infra:LoadGenerator (ADR-0010). Dev-only k6 load generator.
import http from "k6/http";
import { check, sleep } from "k6";

const GATEWAY = __ENV.GATEWAY_BASE_URL || "http://gateway:4000";

const PASSWORD = "correct-horse-battery";
const BUYER_POOL = 8;
const NORMAL_TICKETS = 4;

// Stripe test cards (real sk_test_ key required in the cluster, see infra CLAUDE.md):
// pm_card_visa clears; pm_card_chargeDeclined is declined.
const CARD_OK = "pm_card_visa";
const CARD_DECLINE = "pm_card_chargeDeclined";

// Every Nth iteration induces a failure so the burn-rate alerts can trip on demand: the
// even multiples force a reservation race, the odd ones force a payment decline.
const INJECT_EVERY = 5;

export const options = {
  // baseline: a repeating diurnal ramp (trough -> peak -> trough on a ~3min loop) so RED/saga
  // boards breathe instead of droning. churn: a slow trickle of new listings + abandoned reserves
  // so expirations tick over ambiently on top of the stable curated anchors. Thresholds omitted on
  // purpose — induced failures must not abort the run.
  scenarios: {
    baseline: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "60s", target: 8 },
        { duration: "30s", target: 8 },
        { duration: "60s", target: 1 },
        { duration: "30s", target: 1 },
      ],
      gracefulRampDown: "5s",
    },
    churn: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 100000,
      maxDuration: "9999h",
      exec: "churn",
    },
  },
};

function authToken(res) {
  return res.headers["Set-Auth-Token"];
}

function signUp(email, name) {
  const res = http.post(
    GATEWAY + "/api/auth/sign-up/email",
    JSON.stringify({ email: email, password: PASSWORD, name: name }),
    { headers: { "Content-Type": "application/json" }, tags: { op: "auth.signUp" } },
  );
  return authToken(res);
}

function rpc(path, input) {
  return http.post(GATEWAY + "/rpc/" + path, JSON.stringify({ json: input }), {
    headers: { "Content-Type": "application/json" },
    tags: { op: path },
  });
}

function rpcJson(res) {
  return JSON.parse(res.body).json;
}

// setup() runs once; its return is shared to every VU. Self-seeds so the generator is
// self-contained on a fresh cluster: one seller, a few normal tickets, one high-stock
// "race" ticket for contention, and a fixed pool of buyers (reused so the DB doesn't grow
// unbounded under sustained load).
export function setup() {
  const stamp = Date.now();
  const sellerToken = signUp("loadgen-seller-" + stamp + "@tix.test", "Loadgen Seller");

  const ticketIds = [];
  for (let i = 0; i < NORMAL_TICKETS; i++) {
    const res = rpc("tickets/create", {
      token: sellerToken,
      title: "Loadgen GA " + i,
      quantityTotal: 1000,
      unitPriceCents: 5000,
    });
    ticketIds.push(rpcJson(res).id);
  }

  // High stock on purpose: concurrent reserves contend on the same inventory row and exhaust
  // the optimistic-version retry budget (a conflict) without ever selling out, so the race
  // keeps producing conflicts under sustained load.
  const raceRes = rpc("tickets/create", {
    token: sellerToken,
    title: "Loadgen Race",
    quantityTotal: 100000,
    unitPriceCents: 1000,
  });
  const raceTicketId = rpcJson(raceRes).id;

  const buyerTokens = [];
  for (let i = 0; i < BUYER_POOL; i++) {
    buyerTokens.push(signUp("loadgen-buyer-" + i + "-" + stamp + "@tix.test", "Loadgen Buyer " + i));
  }

  // Discover the curated anchor catalog (seeded by synthetic-catalog-seed) so the baseline drives
  // believable demo data, not just self-seeded rows. Best-effort: if the seed hasn't landed yet the
  // list is just the self-seeded tickets, and the baseline still runs.
  const listed = rpcJson(rpc("tickets/list", { limit: 200 }));
  const anchorTicketIds = (listed.items || [])
    .filter(function (t) { return t.quantityAvailable > 0; })
    .map(function (t) { return t.id; });

  return {
    buyerTokens: buyerTokens,
    ticketIds: ticketIds,
    raceTicketId: raceTicketId,
    anchorTicketIds: anchorTicketIds,
    sellerToken: sellerToken,
  };
}

// Fire concurrent reserves at the hot ticket so they contend — the forced reservation race.
function injectRace(buyerTokens, raceTicketId) {
  const reqs = buyerTokens.map(function (token) {
    return {
      method: "POST",
      url: GATEWAY + "/rpc/orders/create",
      body: JSON.stringify({ json: { token: token, ticketId: raceTicketId, quantity: 1 } }),
      params: { headers: { "Content-Type": "application/json" }, tags: { op: "orders/create" } },
    };
  });
  http.batch(reqs);
}

// Ambient churn: occasionally list a new throwaway ticket and abandon a reserve (never pay), so the
// expiration worker has a steady trickle to auto-cancel on top of the stable anchors.
export function churn(data) {
  const token = data.buyerTokens[__ITER % data.buyerTokens.length];

  if (__ITER % 4 === 0) {
    rpc("tickets/create", {
      token: data.sellerToken,
      title: "Churn drop " + __ITER,
      quantityTotal: 10,
      unitPriceCents: 2000,
    });
  }

  // Abandon: reserve and never pay -> the order expires.
  const pool = data.anchorTicketIds.length > 0 ? data.anchorTicketIds : data.ticketIds;
  rpc("orders/create", { token: token, ticketId: pool[__ITER % pool.length], quantity: 1 });
  sleep(3);
}

export default function (data) {
  const token = data.buyerTokens[__VU % data.buyerTokens.length];

  // browse
  rpc("tickets/list", { limit: 50 });

  const inject = __ITER % INJECT_EVERY === 0;

  if (inject && __ITER % (INJECT_EVERY * 2) === 0) {
    injectRace(data.buyerTokens, data.raceTicketId);
    sleep(1);
    return;
  }

  // reserve — prefer a curated anchor (believable on the boards) and fall back to a self-seeded row.
  const pool = data.anchorTicketIds.length > 0 ? data.anchorTicketIds : data.ticketIds;
  const ticketId = pool[__ITER % pool.length];
  const orderRes = rpc("orders/create", { token: token, ticketId: ticketId, quantity: 1 });
  check(orderRes, { "reserve ok": function (r) { return r.status === 200; } });

  if (orderRes.status === 200) {
    // pay — a decline (induced) is an expected non-2xx, so only the baseline path is checked.
    const orderId = rpcJson(orderRes).id;
    const card = inject ? CARD_DECLINE : CARD_OK;
    const payRes = rpc("payments/create", {
      token: token,
      orderId: orderId,
      paymentMethodId: card,
    });
    if (!inject) check(payRes, { "pay ok": function (r) { return r.status === 200; } });
  }

  sleep(1);
}
`;
}
