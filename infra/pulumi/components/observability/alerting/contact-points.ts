// Grafana contact point + notification policy provisioned as-code (ADR-0010), rendered to JSON
// and mounted at /etc/grafana/provisioning/alerting. The single contact point is a webhook
// pointed at the in-cluster log sink (alert-log-sink.ts), so a firing alert's payload shows up
// in `kubectl logs` — the full notification path, self-contained, no external account. The
// notification policy is a routing tree: a catch-all root with per-severity children.

export function contactPointsJson(webhookUrl: string): string {
  const config = {
    apiVersion: 1,
    contactPoints: [
      {
        orgId: 1,
        name: "log-sink",
        receivers: [
          {
            uid: "log-sink-webhook",
            type: "webhook",
            settings: { url: webhookUrl, httpMethod: "POST" },
            // Send a follow-up when an alert resolves, so the log shows the full firing→clear
            // lifecycle rather than only the trip.
            disableResolveMessage: false,
          },
        ],
      },
    ],
    // Routing tree. The root is the catch-all/fallback (anything not matching a child below still
    // lands at the log sink); grouping by folder + alertname keeps the webhook from being hammered
    // per-series. The severity children — keyed on the `severity` label `alert-rules.ts` sets —
    // tier delivery: a `page` fires immediately (group_wait 0s) and re-notifies often (30m), a
    // `ticket` waits a little and re-notifies hourly-ish (4h), a `warning` is the loosest (1m / 12h).
    // In dev every leaf is still `log-sink`; prod swaps leaf receivers (PagerDuty / Slack / email)
    // without touching this tree structure.
    policies: [
      {
        orgId: 1,
        receiver: "log-sink",
        group_by: ["grafana_folder", "alertname"],
        group_wait: "10s",
        group_interval: "30s",
        repeat_interval: "1h",
        routes: [
          {
            receiver: "log-sink",
            object_matchers: [["severity", "=", "page"]],
            group_wait: "0s",
            repeat_interval: "30m",
          },
          {
            receiver: "log-sink",
            object_matchers: [["severity", "=", "ticket"]],
            group_wait: "30s",
            repeat_interval: "4h",
          },
          {
            receiver: "log-sink",
            object_matchers: [["severity", "=", "warning"]],
            group_wait: "1m",
            repeat_interval: "12h",
          },
        ],
      },
    ],
  };

  return JSON.stringify(config, null, 2);
}
