// A dashboard annotation layer that draws deploy markers (ADR-0011 follow-up). The Grafana
// built-in annotation datasource (uid `-- Grafana --`) surfaces annotations tagged `deploy`
// — written by the DeployAnnotation Job — as vertical lines on every panel's time axis, so a
// metric shift can be read against the deploy that caused it. Tag filtering lives on the
// annotation *target* (AnnotationTargetBuilder.tags), not the query, per the foundation-sdk
// shape; the query attaches it via `.target()`.

import type { Builder, Dataquery } from "@grafana/grafana-foundation-sdk/cog";
import {
  AnnotationQueryBuilder,
  AnnotationTargetBuilder,
} from "@grafana/grafana-foundation-sdk/dashboard";

// The built-in Grafana annotation datasource — serves tag-filtered annotations from its store.
const GRAFANA_BUILTIN = { type: "grafana", uid: "-- Grafana --" } as const;

export function deployAnnotationLayer(): AnnotationQueryBuilder {
  return (
    new AnnotationQueryBuilder()
      .name("Deploys")
      .datasource(GRAFANA_BUILTIN)
      .enable(true)
      .hide(false)
      .iconColor("purple")
      // `.target()` is typed `Builder<Dataquery>`, but the grafana built-in datasource's target is
      // an AnnotationTarget — the SDK's own codegen never branded it as a Dataquery variant (the
      // `_implementsDataqueryVariant` marker), so the intended builder doesn't structurally satisfy
      // the param type. The runtime just calls `.build()` and assigns, so this cast is sound.
      .target(deployTagTarget() as unknown as Builder<Dataquery>)
  );
}

// Tag filter lives on the annotation *target* (AnnotationTargetBuilder.tags), not the query.
function deployTagTarget(): AnnotationTargetBuilder {
  return new AnnotationTargetBuilder().tags(["deploy"]).matchAny(false).type("dashboard");
}
