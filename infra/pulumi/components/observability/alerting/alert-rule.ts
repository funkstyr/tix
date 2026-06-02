// One reviewed factory for a Grafana provisioned alert rule (provisioning apiVersion 1,
// ADR-0010). Every tix alert has the same shape: a single Prometheus instant query (refId A)
// feeding a server-side threshold expression (refId C, the rule's condition). The instant read
// collapses the recording-rule / range result to its latest value; the threshold turns that
// value into the firing boolean. Authoring the rules as one function keeps the verbose
// Grafana JSON from drifting across nine hand-written blobs — a metric or threshold change
// touches the spec, not the schema.

// Datasource UIDs match the ones provisioned in grafana-backend.ts. `__expr__` is Grafana's
// built-in server-side expression datasource.
const PROMETHEUS_UID = "prometheus";
const EXPR_UID = "__expr__";

// `gt` for "too high" alerts (error ratios, conflict/duplicate rates); `lt` for backend-down
// (`up` falls below 1).
export type AlertCondition = "gt" | "lt";

// Severity drives nothing in the dev log-sink path (everything routes to the one webhook), but
// it labels the payload so the lesson — page vs ticket vs warning — is legible in the logs. The
// notification policy (contact-points.ts) routes `page`/`ticket`/`warning` explicitly; `watchdog`
// (ADR-0012 Tier 1's dead-man's-switch heartbeat) intentionally falls through to the root catch-all,
// which re-notifies hourly — exactly the cadence an external "heartbeat absent" check expects.
export type AlertSeverity = "page" | "ticket" | "warning" | "watchdog";

export type AlertRuleSpec = {
  readonly uid: string;
  readonly title: string;
  // PromQL whose latest value the threshold tests. Reads a recording rule where one exists.
  readonly expr: string;
  readonly threshold: number;
  readonly condition: AlertCondition;
  // Grafana `for`: how long the condition must hold before firing (e.g. "5m").
  readonly pending: string;
  readonly severity: AlertSeverity;
  // Annotation shown on the alert; may use Grafana's `{{ $labels.x }}` templating.
  readonly summary: string;
  // Deep link to the runbook for this alert; surfaced as Grafana's `runbook_url` annotation so
  // the firing notification carries "what to do" alongside "what fired".
  readonly runbookUrl?: string;
  // Grafana provisioning convention (apiVersion 1): the `__dashboardUid__` / `__panelId__`
  // annotations link the rule back to the board (and panel) it watches, so an operator can jump
  // from the alert to the live graph. Panel is optional — our foundation-SDK boards don't assign
  // stable panel ids, so most rules wire only the board-level `dashboardUid`.
  readonly dashboardUid?: string;
  readonly panelId?: number;
};

export function alertRule(spec: AlertRuleSpec): Record<string, unknown> {
  return {
    uid: spec.uid,
    title: spec.title,
    condition: "C",
    for: spec.pending,
    labels: { severity: spec.severity },
    annotations: {
      summary: spec.summary,
      ...(spec.runbookUrl ? { runbook_url: spec.runbookUrl } : {}),
      ...(spec.dashboardUid ? { __dashboardUid__: spec.dashboardUid } : {}),
      ...(spec.panelId !== undefined ? { __panelId__: String(spec.panelId) } : {}),
    },
    // No data → treat as healthy: the `and`-gated burn queries and `up`-based backend check
    // both yield no series in the normal case, which must not page.
    noDataState: "OK",
    execErrState: "Error",
    data: [
      {
        refId: "A",
        relativeTimeRange: { from: 3600, to: 0 },
        datasourceUid: PROMETHEUS_UID,
        model: {
          refId: "A",
          datasource: { type: "prometheus", uid: PROMETHEUS_UID },
          expr: spec.expr,
          instant: true,
          intervalMs: 1000,
          maxDataPoints: 43200,
        },
      },
      {
        refId: "C",
        relativeTimeRange: { from: 0, to: 0 },
        datasourceUid: EXPR_UID,
        model: {
          refId: "C",
          datasource: { type: "__expr__", uid: EXPR_UID },
          type: "threshold",
          expression: "A",
          conditions: [{ evaluator: { type: spec.condition, params: [spec.threshold] } }],
        },
      },
    ],
  };
}
