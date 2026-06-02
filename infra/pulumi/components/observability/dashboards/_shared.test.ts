import { describe, expect, it } from "vitest";

import { statPanel, tsPanel } from "./_shared.ts";

const GRID = { h: 8, w: 12, x: 0, y: 0 };

describe("tsPanel", () => {
  it("wires each series as a target on the provisioned prometheus datasource", () => {
    const json = JSON.stringify(
      tsPanel("Rate", "reqps", GRID, [
        { expr: "sum(rate(foo_total[$__rate_interval]))", legend: "foo" },
        { expr: "sum(rate(bar_total[$__rate_interval]))", legend: "bar" },
      ]).build(),
    );

    expect(json).toContain('"uid":"prometheus"');
    expect(json).toContain("foo_total");
    expect(json).toContain("bar_total");
  });

  it("leaves targets as range queries — not instant", () => {
    const json = JSON.stringify(
      tsPanel("Rate", "reqps", GRID, [{ expr: "up", legend: "up" }]).build(),
    );

    expect(json).not.toContain("instant");
  });
});

describe("statPanel", () => {
  it("marks every target instant so the stat renders a single current value", () => {
    const json = JSON.stringify(
      statPanel("Total", "short", GRID, [{ expr: "sum(foo_total)", legend: "foo" }]).build(),
    );

    expect(json).toContain('"uid":"prometheus"');
    expect(json).toContain('"instant":true');
  });
});
