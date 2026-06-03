import { integrationPreset } from "@tix/config/vitest";

// These suites construct full Pulumi component graphs and resolve async Outputs (via promiseOf) —
// integration-grade setup, not pure-unit. Under loaded-CI fork contention the first Output
// resolution after a heavy construction (e.g. the three-variant ObservabilityStack beforeAll)
// outgrows the default 5s test / 10s hook budgets, so use the 30s integration ceilings.
export default integrationPreset();
