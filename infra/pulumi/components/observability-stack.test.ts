import { beforeAll, describe, expect, it } from "vitest";

import { ObservabilityStack } from "./observability-stack.ts";
import { promiseOf } from "./pulumi-mocks.ts";

const ACCESS_KEY = "GKa1b2c3d4e5f60718293a4b5c";

function build(args?: { alertingEnabled?: boolean; gitSha?: string }): ObservabilityStack {
  return new ObservabilityStack("test", {
    namespace: "tix",
    env: "dev",
    grafanaRootUrl: "http://localhost/grafana",
    garageRpcSecret: "deadbeef",
    garageAdminToken: "admintoken",
    garageS3AccessKey: ACCESS_KEY,
    garageS3SecretKey: "0".repeat(64),
    traceSamplingPercent: 100,
    metricsRetention: "15d",
    tracesRetention: "360h",
    logsRetention: "360h",
    ...args,
  });
}

describe("ObservabilityStack", () => {
  // Building the full stack (7 backends + 8 synthesized dashboards) is the heavy part, so we do
  // it once per arg-variant and share the instances across the read-only assertions below.
  // Rebuilding per `it` made each test body race the 5s timeout under CI fork-contention; the
  // construction now lives in beforeAll and runs three times (default / alerting / gitSha
  // variants), not once per `it`. Three full stacks (each ~8 backends + the synthesized
  // dashboards) outgrow the default 10s hook budget on a loaded CI runner, so this hook gets the
  // 30s ceiling the integration preset uses for heavy setup.
  let stack: ObservabilityStack;
  let alertingStack: ObservabilityStack;
  let shaStack: ObservabilityStack;

  beforeAll(() => {
    stack = build();
    alertingStack = build({ alertingEnabled: true });
    shaStack = build({ gitSha: "abc1234" });
  }, 30_000);

  it("exposes the gateway collector as the OTLP ingress", async () => {
    const meta = await promiseOf(stack.collector.service.metadata);
    expect(meta.name).toBe("otel-collector");

    const spec = await promiseOf(stack.collector.service.spec);
    // 4317 = gRPC OTLP, 4318 = HTTP OTLP, 8888 = internal telemetry/metrics port scraped by Prometheus (ADR-0010),
    // 8090 = Faro receiver for browser RUM proxied through the gateway (ADR-0013)
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([4317, 4318, 8888, 8090]);
  });

  it("exposes Grafana as the UI service the ingress routes to", async () => {
    const meta = await promiseOf(stack.grafana.service.metadata);
    expect(meta.name).toBe("grafana");
  });

  it("wires the collector to fan out to the discrete backends", async () => {
    const data = await promiseOf(stack.collector.config.data);
    const config = data?.["config.yaml"] ?? "";
    expect(config).toContain("endpoint: tempo:4317");
    expect(config).toContain("loki:3100/otlp/v1/logs");
    expect(config).toContain("prometheus:9090/api/v1/otlp/v1/metrics");
  });

  it("threads one S3 access key through Garage, the bucket bootstrap, Tempo, and Loki", async () => {
    // The configured access key lands in the single Garage credentials Secret...
    const secret = await promiseOf(stack.garage.credentialsSecret.stringData);
    expect(secret?.["GARAGE_S3_ACCESS_KEY"]).toBe(ACCESS_KEY);
    const secretName = (await promiseOf(stack.garage.credentialsSecret.metadata)).name;
    expect(secretName).toBe("garage-credentials");

    // ...and every consumer authenticates against that same Secret, so they
    // cannot drift onto a different key.
    const bucketsSpec = await promiseOf(stack.buckets.job.spec);
    expect(bucketsSpec.template.spec?.containers[0]?.envFrom?.[0]?.secretRef?.name).toBe(
      secretName,
    );

    const tempoSpec = await promiseOf(stack.tempo.statefulSet.spec);
    expect(tempoSpec.template.spec?.containers[0]?.envFrom?.[0]?.secretRef?.name).toBe(secretName);

    const lokiSpec = await promiseOf(stack.loki.deployment.spec);
    expect(lokiSpec.template.spec?.containers[0]?.envFrom?.[0]?.secretRef?.name).toBe(secretName);

    const pyroscopeSpec = await promiseOf(stack.pyroscope.deployment.spec);
    expect(pyroscopeSpec.template.spec?.containers[0]?.envFrom?.[0]?.secretRef?.name).toBe(
      secretName,
    );
  });

  it("creates the Pyroscope Garage bucket in the bootstrap Job", async () => {
    // The buckets list is a literal passed into GarageBuckets, surfaced in the rendered init
    // script (one grant block per bucket). Asserting on the script proves the Job actually
    // creates + grants the pyroscope bucket, not just that the type permits the name.
    const data = await promiseOf(stack.buckets.configMap.data);
    const script = data?.["garage-init.sh"] ?? "";
    expect(script).toContain("create_or_get_bucket pyroscope");
  });

  it("stands up Pyroscope on its own Garage bucket", async () => {
    const spec = await promiseOf(stack.pyroscope.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toContain(4040);
  });

  it("stands up the log sink and provisions Grafana alerting when alerting is enabled", async () => {
    expect(alertingStack.logSink).toBeDefined();
    const meta = await promiseOf(alertingStack.logSink!.service.metadata);
    expect(meta.name).toBe("alert-log-sink");

    expect(alertingStack.grafana.alerting).toBeDefined();
    const data = await promiseOf(alertingStack.grafana.alerting!.data);
    const contacts = JSON.parse(data?.["contact-points.json"] ?? "{}");
    expect(contacts.contactPoints[0].receivers[0].settings.url).toBe("http://alert-log-sink:8080/");
  });

  it("omits the log sink and alerting provisioning by default", () => {
    expect(stack.logSink).toBeUndefined();
    expect(stack.grafana.alerting).toBeUndefined();
  });

  it("emits a deploy annotation when a git SHA is supplied", async () => {
    expect(shaStack.deployAnnotation).toBeDefined();
    const meta = await promiseOf(shaStack.deployAnnotation!.job.metadata);
    expect(meta.name).toBe("deploy-annotation-abc1234");

    // The Job pulls its Grafana basic-auth creds from a sibling `grafana-annotation` Secret via
    // envFrom. That Secret is a constructor-local (not a named field), and the Job carries
    // `pulumi.com/skipAwait`, so a renamed/broken Secret would fail silently at deploy time —
    // lock in the wiring by asserting the secretRef name the envFrom resolves to.
    const jobSpec = await promiseOf(shaStack.deployAnnotation!.job.spec);
    expect(jobSpec.template.spec?.containers[0]?.envFrom?.[0]?.secretRef?.name).toBe(
      "grafana-annotation",
    );
  });

  it("omits the deploy annotation when no SHA is supplied", () => {
    expect(stack.deployAnnotation).toBeUndefined();
  });
});
