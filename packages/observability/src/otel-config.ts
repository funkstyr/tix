import { Config } from "effect";

export type OtelConfig = {
  readonly baseUrl: string;
  readonly serviceName: string;
};

export const otelConfig: Config.Config<OtelConfig> = Config.all({
  baseUrl: Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
    Config.withDefault("http://otel-collector:4318"),
  ),
  serviceName: Config.string("OTEL_SERVICE_NAME"),
});
