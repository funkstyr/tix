import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { tsPanel } from "./_shared.ts";

// Cluster USE board (ADR-0012 Tier 2), Platform folder. The USE layer beneath the app boards:
// node utilization (node-exporter), per-pod CPU/memory/throttle (cAdvisor, rolled up to pod scope),
// and the object-state signals (restarts, OOMKills) from kube-state-metrics. Answers the incident
// question the app boards can't: "is the code wedged, or did the pod die?"
//
// The per-pod panels read the `tix_cluster_use` RECORDING rules, not raw cAdvisor series — the
// rollup is the cardinality gate that keeps the prod 90d TSDB bounded. The cAdvisor scrape is scoped
// to the tix namespace, so other namespaces deliberately don't appear here.
const DASHBOARD_UID = "cluster-use";

export function clusterUseDashboardJson(): string {
  let dashboard = new DashboardBuilder("Cluster USE")
    .uid(DASHBOARD_UID)
    .description(
      "Node + pod USE (node-exporter / cAdvisor / kube-state-metrics), scoped to the tix namespace (ADR-0012 Tier 2).",
    )
    .tags(["platform", "cluster"])
    .refresh("30s");

  for (const panel of [
    tsPanel("Node utilization (CPU / memory / filesystem)", "percentunit", {
      h: 8,
      w: 12,
      x: 0,
      y: 0,
    }, [
      { expr: "node:cpu_utilization:ratio", legend: "cpu {{node}}" },
      { expr: "node:memory_utilization:ratio", legend: "mem {{node}}" },
      { expr: "node:filesystem_utilization:ratio", legend: "fs {{node}}" },
    ]),
    tsPanel("PVC utilization", "percentunit", { h: 8, w: 12, x: 12, y: 0 }, [
      {
        expr: "kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes",
        legend: "{{persistentvolumeclaim}}",
      },
    ]),
    tsPanel("Pod CPU usage (tix)", "short", { h: 8, w: 12, x: 0, y: 8 }, [
      { expr: "namespace:container_cpu_usage:rate5m", legend: "{{pod}}" },
    ]),
    tsPanel("Pod memory working set (tix)", "bytes", { h: 8, w: 12, x: 12, y: 8 }, [
      { expr: "namespace:container_memory_working_set:bytes", legend: "{{pod}}" },
    ]),
    tsPanel("Pod CPU throttling (tix)", "short", { h: 8, w: 12, x: 0, y: 16 }, [
      { expr: "namespace:container_cpu_throttled:rate5m", legend: "{{pod}}" },
    ]),
    tsPanel("Pod restarts + OOMKills (tix)", "short", { h: 8, w: 12, x: 12, y: 16 }, [
      {
        expr: 'sum(increase(kube_pod_container_status_restarts_total{namespace="tix"}[1h])) by (pod)',
        legend: "restarts/1h {{pod}}",
      },
      {
        expr: 'sum(kube_pod_container_status_last_terminated_reason{reason="OOMKilled",namespace="tix"}) by (pod)',
        legend: "OOMKilled {{pod}}",
      },
    ]),
  ]) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
