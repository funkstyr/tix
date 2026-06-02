import { runbook } from "./_shared.ts";
import { alertRule } from "./alert-rule.ts";

// cluster_use (ADR-0012 Tier 2): the USE layer beneath the apps. node-exporter + kube-state-metrics +
// cAdvisor make a pod OOMKill, a CrashLoop, a filling PVC, or a node under memory pressure visible —
// so "the saga stalled" can be told apart from "the worker got OOMKilled". All series are scoped to
// the tix namespace (the cAdvisor cardinality gate) or are node-level (bounded by node count).
export function clusterAlertRules(): Array<Record<string, unknown>> {
  return [oomKilled(), podRestartSpike(), pvcNearlyFull(), nodeMemoryPressure()];
}

// OOMKill: a tix container's last termination was OOMKilled — it hit its memory limit and died.
// Pages: an OOMKilled worker is the exact failure that masquerades as "the saga stalled".
function oomKilled(): Record<string, unknown> {
  return alertRule({
    uid: "pod-oomkilled",
    title: "Pod OOMKilled",
    expr: 'kube_pod_container_status_last_terminated_reason{reason="OOMKilled",namespace="tix"}',
    threshold: 0,
    condition: "gt",
    pending: "1m",
    severity: "page",
    summary: "A tix container was OOMKilled ({{ $labels.pod }}) — it hit its memory limit and died.",
    runbookUrl: runbook("pod-oomkilled.md"),
    dashboardUid: "cluster-use",
  });
}

// Pod-restart spike: repeated restarts in a short window — a CrashLoop, a bad deploy, a failing
// dependency probe. Warning; the board shows which pod and the OOM panel says whether it's memory.
function podRestartSpike(): Record<string, unknown> {
  return alertRule({
    uid: "pod-restart-spike",
    title: "Pod restart spike",
    expr: 'sum(increase(kube_pod_container_status_restarts_total{namespace="tix"}[15m])) by (pod)',
    threshold: 3,
    condition: "gt",
    pending: "5m",
    severity: "warning",
    summary: "A tix pod ({{ $labels.pod }}) restarted >3 times in 15m — likely CrashLooping.",
    runbookUrl: runbook("pod-restart-spike.md"),
    dashboardUid: "cluster-use",
  });
}

// PVC nearly full: a persistent volume past 85% used. Postgres/NATS/Prometheus all run on PVCs; a
// full one means write failures and a wedged StatefulSet. Tickets — there's time to expand or prune.
function pvcNearlyFull(): Record<string, unknown> {
  return alertRule({
    uid: "pvc-nearly-full",
    title: "PersistentVolumeClaim nearly full",
    expr: "kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes",
    threshold: 0.85,
    condition: "gt",
    pending: "10m",
    severity: "ticket",
    summary: "A PVC ({{ $labels.persistentvolumeclaim }}) is >85% full — expand or prune before it wedges.",
    runbookUrl: runbook("pvc-nearly-full.md"),
    dashboardUid: "cluster-use",
  });
}

// Node MemoryPressure: the kubelet has flagged the node low on memory and will start evicting pods.
// Pages — eviction is imminent and indiscriminate.
function nodeMemoryPressure(): Record<string, unknown> {
  return alertRule({
    uid: "node-memory-pressure",
    title: "Node under memory pressure",
    expr: 'kube_node_status_condition{condition="MemoryPressure",status="true"}',
    threshold: 0,
    condition: "gt",
    pending: "5m",
    severity: "page",
    summary: "Node {{ $labels.node }} reports MemoryPressure — the kubelet will start evicting pods.",
    runbookUrl: runbook("node-memory-pressure.md"),
    dashboardUid: "cluster-use",
  });
}
