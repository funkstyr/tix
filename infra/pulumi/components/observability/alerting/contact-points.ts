// Grafana contact point + notification policy provisioned as-code (ADR-0010), rendered to JSON
// and mounted at /etc/grafana/provisioning/alerting. The single contact point is a webhook
// pointed at the in-cluster log sink (alert-log-sink.ts), so a firing alert's payload shows up
// in `kubectl logs` — the full notification path, self-contained, no external account. The
// root notification policy routes every alert to it.

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
    // Root policy: everything routes to the log sink. Grouping by folder + alertname keeps the
    // webhook from being hammered per-series while still showing each distinct alert promptly.
    policies: [
      {
        orgId: 1,
        receiver: "log-sink",
        group_by: ["grafana_folder", "alertname"],
        group_wait: "10s",
        group_interval: "30s",
        repeat_interval: "1h",
      },
    ],
  };

  return JSON.stringify(config, null, 2);
}
