# Runbook: Node under memory pressure

Alert: `node-memory-pressure` (page). Dashboard: **cluster-use**.

## Symptom

`kube_node_status_condition{condition="MemoryPressure",status="true"} > 0` — the kubelet has flagged
a node low on available memory. Once under pressure the kubelet starts **evicting pods**
indiscriminately (by QoS class), so any tix pod on that node can be killed regardless of its own
limits.

## Likely cause

- The node is oversubscribed: the sum of pod usage exceeds physical memory.
- A pod without a memory limit ballooning and starving the node.
- Too many replicas scheduled onto one node (no anti-affinity / on kind, the single node).

## Checks

- **cluster-use** board: "Node utilization" (memory) panel — which node, how close to 1.0.
- `kubectl describe node <node>` — `MemoryPressure` condition, allocatable vs requested, and which
  pods it's about to evict.
- `kubectl top nodes` / `kubectl top pods -n tix` for the live consumers.

## Remediation

- Identify and cap the memory hog (set/lower a limit, fix a leak).
- Reschedule or scale down replicas to relieve the node; add a node in a real cluster.
- On kind (single node) this usually means the dev box itself is out of RAM — free memory or lower
  the stack's footprint.
- Confirm the MemoryPressure condition clears.
