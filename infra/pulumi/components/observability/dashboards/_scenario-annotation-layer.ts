// A dashboard annotation layer drawing demo-scenario markers (the flash-sale / decline-wave /
// expiration-storm Tilt buttons POST a `scenario`-tagged annotation). Sibling of
// _deploy-annotation-layer.ts — same Grafana built-in annotation datasource + tag-target shape, a
// different tag + color so scenario markers read distinctly from deploy markers on the same axis.

import type { Builder, Dataquery } from "@grafana/grafana-foundation-sdk/cog";
import {
  AnnotationQueryBuilder,
  AnnotationTargetBuilder,
} from "@grafana/grafana-foundation-sdk/dashboard";

// The built-in Grafana annotation datasource — serves tag-filtered annotations from its store.
const GRAFANA_BUILTIN = { type: "grafana", uid: "-- Grafana --" } as const;

export function scenarioAnnotationLayer(): AnnotationQueryBuilder {
  return (
    new AnnotationQueryBuilder()
      .name("Scenarios")
      .datasource(GRAFANA_BUILTIN)
      .enable(true)
      .hide(false)
      .iconColor("orange")
      // `.target()` is typed `Builder<Dataquery>`, but the grafana built-in datasource's target is
      // an AnnotationTarget — the SDK's own codegen never branded it as a Dataquery variant (the
      // `_implementsDataqueryVariant` marker), so the intended builder doesn't structurally satisfy
      // the param type. The runtime just calls `.build()` and assigns, so this cast is sound.
      .target(scenarioTagTarget() as unknown as Builder<Dataquery>)
  );
}

// Tag filter lives on the annotation *target* (AnnotationTargetBuilder.tags), not the query.
function scenarioTagTarget(): AnnotationTargetBuilder {
  return new AnnotationTargetBuilder().tags(["scenario"]).matchAny(false).type("dashboard");
}
