import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import { DataqueryBuilder } from "@grafana/grafana-foundation-sdk/prometheus";
import * as stat from "@grafana/grafana-foundation-sdk/stat";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

// Auth deep-dive board (ADR-0010), Services folder. auth sits on the request path of every
// authenticated call via `requireSession`, so the rate of session validations and how many
// resolve to a live session (vs a rejected token) is a high-value business signal that RED
// can't see — a rejected token is a normal, non-error path. `auth_session_validations_total`
// is tagged `result=valid|invalid`.

const DASHBOARD_UID = "auth-deep-dive";

// Stable UID of the Prometheus datasource provisioned by GrafanaBackend.
const PROMETHEUS = { type: "prometheus", uid: "prometheus" } as const;

const VALID = `sum(rate(auth_session_validations_total{result="valid"}[$__rate_interval]))`;
const INVALID = `sum(rate(auth_session_validations_total{result="invalid"}[$__rate_interval]))`;

export function authDeepDiveDashboardJson(): string {
  const dashboard = new DashboardBuilder("Auth Deep Dive")
    .uid(DASHBOARD_UID)
    .description(
      "Session-validation throughput and accept rate (auth_session_validations_total{result}) — the non-error rejection signal RED cannot show (ADR-0010).",
    )
    .tags(["services", "auth"])
    .refresh("30s")
    .withPanel(validationRate())
    .withPanel(validRatio())
    .build();

  return JSON.stringify(dashboard, null, 2);
}

function validationRate(): timeseries.PanelBuilder {
  return new timeseries.PanelBuilder()
    .title("Session validations")
    .datasource(PROMETHEUS)
    .unit("reqps")
    .gridPos({ h: 8, w: 16, x: 0, y: 0 })
    .withTarget(new DataqueryBuilder().expr(VALID).legendFormat("valid"))
    .withTarget(new DataqueryBuilder().expr(INVALID).legendFormat("invalid"));
}

function validRatio(): stat.PanelBuilder {
  const expr = `${VALID} / clamp_min(${VALID} + ${INVALID}, 1)`;
  return new stat.PanelBuilder()
    .title("Valid session ratio")
    .datasource(PROMETHEUS)
    .unit("percentunit")
    .gridPos({ h: 8, w: 8, x: 16, y: 0 })
    .withTarget(new DataqueryBuilder().expr(expr).legendFormat("valid ratio"));
}
